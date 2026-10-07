//! The uPlot-backed line chart (wasm-only).
//!
//! The hand-rolled SVG line chart was replaced with [uPlot], a small, focused
//! time-series library. The component here owns the whole browser boundary: it
//! mounts a container, constructs the chart through `js_sys`/`wasm-bindgen`,
//! keeps it sized to its panel with a `ResizeObserver`, keeps it themed with a
//! `MutationObserver` on `<html data-theme>`, and destroys it on cleanup.
//!
//! Everything numeric lives in [`super::data`] and [`super::scale`], which stay
//! natively testable; this file is only glue.
//!
//! [uPlot]: https://github.com/leeoniya/uPlot

use leptos::html::Div;
use leptos::prelude::*;
use rust_decimal::Decimal;
use wasm_bindgen::JsCast;
use wasm_bindgen::prelude::*;
use web_sys::{HtmlElement, MutationObserver, MutationObserverInit, ResizeObserver};

use super::data::{self, Columns};
use super::scale;

/// Height of the plot, including its axes, in CSS pixels. Fixed on purpose: a
/// height that followed the container would feed uPlot's own root height back
/// into the observer and grow without bound. Only the width follows the panel.
const CHART_HEIGHT: f64 = 260.0;

/// Never size the canvas below this: a panel that is hidden or not yet laid out
/// reports a width of zero.
const MIN_CHART_WIDTH: f64 = 160.0;

/// At most this many x-axis labels, so period labels never collide.
const X_LABEL_LIMIT: usize = 6;

/// Round y-axis ticks to this many decimals before formatting. uPlot's splits
/// are `f64` even when they name round values (`0.1` is not exact in binary),
/// and money labels must not show the noise.
const TICK_DECIMALS: u32 = 8;

/// A line (with a filled area under it) over time.
///
/// `data` is `(period label, amount)` in chronological order. An empty series
/// renders the neutral "no data" message rather than an empty chart.
pub fn line_chart(data: &[(String, Decimal)]) -> AnyView {
    if data.is_empty() {
        return super::view::no_data("No data to chart yet.");
    }
    let columns = data::columns(data);
    view! { <UplotLine columns=columns /> }.into_any()
}

/// The Leptos component that owns one uPlot instance.
#[component]
fn UplotLine(columns: Columns) -> impl IntoView {
    let container = NodeRef::<Div>::new();
    let plot = StoredValue::new(None::<PlotHandle>);

    Effect::new(move |_| {
        let Some(element) = container.get() else {
            return;
        };
        // A re-run replaces the chart, so dispose the previous instance first.
        if let Some(previous) = plot.get_value() {
            previous.destroy();
        }
        match PlotHandle::mount(&element, &columns) {
            Ok(handle) => plot.set_value(Some(handle)),
            Err(error) => {
                leptos::logging::error!("uPlot could not be mounted: {}", js_error_text(&error))
            }
        }
    });

    // Destroy on unmount so re-rendering a panel does not leak chart instances
    // (each holds canvases, observers and event listeners).
    on_cleanup(move || {
        if let Some(handle) = plot.get_value() {
            handle.destroy();
        }
    });

    view! {
        <div
            class="chart chart-line"
            style=format!(
                "height: {CHART_HEIGHT}px; background: var(--gl-panel-bg);",
            )
            role="img"
            aria-label="Time series chart"
            node_ref=container
        ></div>
    }
}

/// A live uPlot instance and everything keeping it alive.
#[derive(Clone)]
struct PlotHandle {
    instance: JsValue,
    /// The JS functions handed to uPlot and the observers. uPlot holds its own
    /// references, but keeping ours too guarantees the Rust closures backing
    /// them are not dropped while JS can still call them.
    _keepalive: Vec<JsValue>,
    resize_observer: Option<ResizeObserver>,
    theme_observer: Option<MutationObserver>,
}

impl PlotHandle {
    /// Construct a chart inside `element`.
    fn mount(element: &HtmlElement, columns: &Columns) -> Result<Self, JsValue> {
        let window = web_sys::window().ok_or_else(|| JsValue::from_str("no browser window"))?;
        let constructor = js_sys::Reflect::get(&window, &JsValue::from_str("uPlot"))?;
        let constructor: js_sys::Function = constructor.dyn_into().map_err(|_| {
            JsValue::from_str("uPlot is not loaded; expected /js/vendor/uplot/uplot-global.js")
        })?;

        let mut keepalive: Vec<JsValue> = Vec::new();
        let options = object();

        let width = plot_width(element);
        set(&options, "width", &JsValue::from_f64(width))?;
        set(&options, "height", &JsValue::from_f64(CHART_HEIGHT))?;

        // The x series carries the point count; its label is only used if a
        // legend is ever re-enabled.
        let x_series = object();
        set(&x_series, "label", &JsValue::from_str("Period"))?;

        let y_series = object();
        set(&y_series, "label", &JsValue::from_str("Balance"))?;
        set(&y_series, "width", &JsValue::from_f64(2.0))?;
        let points = object();
        set(&points, "size", &JsValue::from_f64(6.0))?;
        set(&y_series, "points", &points)?;

        let series = js_sys::Array::new();
        series.push(&x_series);
        series.push(&y_series);
        set(&options, "series", &series)?;

        set(&options, "scales", &scales(columns, &mut keepalive)?)?;
        set(&options, "axes", &axes(columns, &mut keepalive)?)?;

        // No legend: the panel already carries a table of the same figures, and
        // a one-series legend is noise. The vertical cursor still works.
        let legend = object();
        set(&legend, "show", &JsValue::FALSE)?;
        set(&options, "legend", &legend)?;
        let cursor = object();
        set(&cursor, "y", &JsValue::FALSE)?;
        set(&options, "cursor", &cursor)?;

        let data = js_sys::Array::new();
        let xs = js_sys::Array::new();
        for value in &columns.xs {
            xs.push(&JsValue::from_f64(*value));
        }
        let ys = js_sys::Array::new();
        for value in &columns.ys {
            ys.push(&JsValue::from_f64(*value));
        }
        data.push(&xs);
        data.push(&ys);

        let arguments = js_sys::Array::new();
        arguments.push(&options);
        arguments.push(&data);
        arguments.push(element.unchecked_ref::<JsValue>());
        let instance = js_sys::Reflect::construct(&constructor, &arguments)?;

        // Colours are a separate pass so the initial paint and the theme
        // observer reuse exactly one code path.
        apply_theme(&instance);

        let resize_observer = watch_resize(&instance, element, &mut keepalive).ok();
        let theme_observer = watch_theme(&instance, &window, &mut keepalive).ok();

        Ok(Self {
            instance,
            _keepalive: keepalive,
            resize_observer,
            theme_observer,
        })
    }

    /// Tear the chart down and stop observing.
    fn destroy(&self) {
        if let Some(observer) = &self.resize_observer {
            observer.disconnect();
        }
        if let Some(observer) = &self.theme_observer {
            observer.disconnect();
        }
        if let Ok(destroy) = js_sys::Reflect::get(&self.instance, &JsValue::from_str("destroy"))
            && let Some(destroy) = destroy.dyn_ref::<js_sys::Function>()
        {
            let _ = destroy.call0(&self.instance);
        }
    }
}

/// The `scales` option: a numeric x axis (the point index) and a y axis that
/// always includes zero, so a balance chart has an honest baseline.
fn scales(columns: &Columns, keepalive: &mut Vec<JsValue>) -> Result<JsValue, JsValue> {
    let scales = object();

    let x = object();
    set(&x, "time", &JsValue::FALSE)?;
    if columns.len() <= 1 {
        // A single point leaves the auto range degenerate; centre it.
        let range = js_sys::Array::new();
        range.push(&JsValue::from_f64(-0.5));
        range.push(&JsValue::from_f64(0.5));
        set(&x, "range", &range)?;
    }
    set(&scales, "x", &x)?;

    let y = object();
    let include_zero =
        Closure::<dyn Fn(JsValue, JsValue, JsValue) -> JsValue>::new(|_self, min, max| {
            let low = number_or(&min, 0.0).min(0.0);
            let high = number_or(&max, 0.0).max(0.0);
            let high = if high <= low { low + 1.0 } else { high };
            let range = js_sys::Array::new();
            range.push(&JsValue::from_f64(low));
            range.push(&JsValue::from_f64(high));
            range.into()
        });
    set(&y, "range", include_zero.as_ref().unchecked_ref())?;
    keepalive.push(include_zero.into_js_value());
    set(&scales, "y", &y)?;

    Ok(scales)
}

/// The `axes` option: index-based x labels plus y labels formatted with
/// [`scale::format_tick`], so money text never goes through an invented digit.
fn axes(columns: &Columns, keepalive: &mut Vec<JsValue>) -> Result<JsValue, JsValue> {
    let axes = js_sys::Array::new();

    let x = axis("x", 30.0)?;
    let count = columns.len();
    let splits = Closure::<dyn Fn(JsValue, JsValue, f64, f64, f64, f64) -> JsValue>::new(
        move |plot: JsValue, _axis, min, max, _incr, _space| {
            // The label budget follows the chart's width, so a narrow panel
            // drops labels instead of overlapping them.
            let width = js_sys::Reflect::get(&plot, &JsValue::from_str("width"))
                .ok()
                .and_then(|value| value.as_f64())
                .unwrap_or(0.0);
            let out = js_sys::Array::new();
            for index in data::x_tick_indices(count, data::x_label_budget(width, X_LABEL_LIMIT)) {
                let position = index as f64;
                if position >= min && position <= max {
                    out.push(&JsValue::from_f64(position));
                }
            }
            out.into()
        },
    );
    set(&x, "splits", splits.as_ref().unchecked_ref())?;
    keepalive.push(splits.into_js_value());

    let labels = columns.labels.clone();
    let values = Closure::<dyn Fn(JsValue, js_sys::Array) -> JsValue>::new(
        move |_self: JsValue, splits: js_sys::Array| {
            let out = js_sys::Array::new();
            for split in splits.iter() {
                let index = split.as_f64().unwrap_or(0.0).round().max(0.0) as usize;
                let label = labels.get(index).map(String::as_str).unwrap_or("");
                out.push(&JsValue::from_str(label));
            }
            out.into()
        },
    );
    set(&x, "values", values.as_ref().unchecked_ref())?;
    keepalive.push(values.into_js_value());
    axes.push(&x);

    let y = axis("y", 52.0)?;
    let values = Closure::<dyn Fn(JsValue, js_sys::Array) -> JsValue>::new(
        move |_self: JsValue, splits: js_sys::Array| {
            let out = js_sys::Array::new();
            for split in splits.iter() {
                let text = match split.as_f64() {
                    Some(value) => scale::format_tick(tick_decimal(value)),
                    None => String::new(),
                };
                out.push(&JsValue::from_str(&text));
            }
            out.into()
        },
    );
    set(&y, "values", values.as_ref().unchecked_ref())?;
    keepalive.push(values.into_js_value());
    axes.push(&y);

    Ok(axes.into())
}

/// One axis with the shared geometry options. Colours are applied later by
/// [`apply_theme`]; `size` is the space reserved for tick labels, so the y axis
/// needs room for a formatted amount.
fn axis(scale_key: &str, size: f64) -> Result<JsValue, JsValue> {
    let axis = object();
    set(&axis, "scale", &JsValue::from_str(scale_key))?;
    set(&axis, "size", &JsValue::from_f64(size))?;
    set(&axis, "gap", &JsValue::from_f64(6.0))?;
    let grid = object();
    set(&grid, "width", &JsValue::from_f64(1.0))?;
    set(&axis, "grid", &grid)?;
    let ticks = object();
    set(&ticks, "width", &JsValue::from_f64(1.0))?;
    set(&ticks, "size", &JsValue::from_f64(4.0))?;
    set(&axis, "ticks", &ticks)?;
    Ok(axis)
}

/// Re-read the theme's CSS custom properties and push them into a live chart.
///
/// uPlot stores `stroke`/`fill` as functions after its own initialisation, so
/// re-theming means replacing those functions and redrawing rather than
/// rebuilding the chart.
fn apply_theme(instance: &JsValue) {
    let Some(window) = web_sys::window() else {
        return;
    };
    let theme = Theme::read(&window);

    if let Ok(series) = js_sys::Reflect::get(instance, &JsValue::from_str("series"))
        && let Ok(series) = series.dyn_into::<js_sys::Array>()
    {
        let data_series = series.get(1);
        if data_series.is_object() {
            let _ = set(&data_series, "stroke", &constant_color(&theme.series));
            let _ = set(&data_series, "fill", &constant_color(&theme.fill));
            if let Ok(points) = js_sys::Reflect::get(&data_series, &JsValue::from_str("points"))
                && points.is_object()
            {
                let _ = set(&points, "stroke", &constant_color(&theme.series));
            }
        }
    }

    if let Ok(axes) = js_sys::Reflect::get(instance, &JsValue::from_str("axes"))
        && let Ok(axes) = axes.dyn_into::<js_sys::Array>()
    {
        for axis in axes.iter() {
            if !axis.is_object() {
                continue;
            }
            let _ = set(&axis, "stroke", &constant_color(&theme.text_dim));
            if let Ok(grid) = js_sys::Reflect::get(&axis, &JsValue::from_str("grid"))
                && grid.is_object()
            {
                let _ = set(&grid, "stroke", &constant_color(&theme.border));
            }
            if let Ok(ticks) = js_sys::Reflect::get(&axis, &JsValue::from_str("ticks"))
                && ticks.is_object()
            {
                let _ = set(&ticks, "stroke", &constant_color(&theme.border));
            }
        }
    }

    if let Ok(redraw) = js_sys::Reflect::get(instance, &JsValue::from_str("redraw"))
        && let Some(redraw) = redraw.dyn_ref::<js_sys::Function>()
    {
        // `redraw(false)` repaints without re-setting the x scale. The no-arg
        // form calls setScale('x', scales.x.min, scales.x.max), and an auto x
        // scale reports null/null, which would collapse the chart to its first
        // point.
        let _ = redraw.call1(instance, &JsValue::FALSE);
    }
}

/// Watch the container and ask uPlot to re-fit when its width changes. uPlot
/// only listens for window `resize`, which panel drags never fire.
fn watch_resize(
    instance: &JsValue,
    element: &HtmlElement,
    keepalive: &mut Vec<JsValue>,
) -> Result<ResizeObserver, JsValue> {
    let callback = {
        let instance = instance.clone();
        let element = element.clone();
        Closure::<dyn FnMut()>::new(move || {
            let width = plot_width(&element);
            if let Ok(set_size) = js_sys::Reflect::get(&instance, &JsValue::from_str("setSize"))
                && let Some(set_size) = set_size.dyn_ref::<js_sys::Function>()
            {
                let options = object();
                set(&options, "width", &JsValue::from_f64(width)).ok();
                set(&options, "height", &JsValue::from_f64(CHART_HEIGHT)).ok();
                let _ = set_size.call1(&instance, &options);
            }
        })
    };
    let observer = ResizeObserver::new(callback.as_ref().unchecked_ref())?;
    observer.observe(element.unchecked_ref::<web_sys::Element>());
    keepalive.push(callback.into_js_value());
    Ok(observer)
}

/// Watch `<html data-theme>` and re-theme in place. The theme is applied with a
/// DOM attribute and pure CSS, so a switch does not re-render any panel.
fn watch_theme(
    instance: &JsValue,
    window: &web_sys::Window,
    keepalive: &mut Vec<JsValue>,
) -> Result<MutationObserver, JsValue> {
    let callback = {
        let instance = instance.clone();
        Closure::<dyn FnMut()>::new(move || apply_theme(&instance))
    };
    let observer = MutationObserver::new(callback.as_ref().unchecked_ref())?;
    if let Some(root) = window
        .document()
        .and_then(|document| document.document_element())
    {
        let options = MutationObserverInit::new();
        options.set_attributes(true);
        let filter =
            js_sys::Array::of1(&JsValue::from_str("data-theme")).unchecked_into::<JsValue>();
        options.set_attribute_filter(&filter);
        observer.observe_with_options(root.unchecked_ref::<web_sys::Node>(), &options)?;
    }
    keepalive.push(callback.into_js_value());
    Ok(observer)
}

/// The colours the chart needs, read from the app's CSS custom properties.
struct Theme {
    series: String,
    fill: String,
    text_dim: String,
    border: String,
}

impl Theme {
    /// Read every colour from `<html>`'s computed style.
    fn read(window: &web_sys::Window) -> Self {
        let series = css_color(window, "--gl-series-1", "#fb4934");
        let accent = css_color(window, "--gl-accent", "#458588");
        Self {
            fill: data::with_alpha(&accent, 0.15),
            series,
            text_dim: css_color(window, "--gl-text-dim", "#a89984"),
            border: css_color(window, "--gl-border", "#1d2021"),
        }
    }
}

/// One CSS custom property from the document root, or `fallback` when it is
/// missing (a non-browser or unstyled page).
fn css_color(window: &web_sys::Window, name: &str, fallback: &str) -> String {
    let Some(root) = window
        .document()
        .and_then(|document| document.document_element())
    else {
        return fallback.to_string();
    };
    let Ok(Some(styles)) = window.get_computed_style(&root) else {
        return fallback.to_string();
    };
    let Ok(value) = styles.get_property_value(name) else {
        return fallback.to_string();
    };
    let value = value.trim();
    if value.is_empty() {
        fallback.to_string()
    } else {
        value.to_string()
    }
}

/// A JS function returning a constant colour, the shape uPlot calls for a
/// series or axis colour. Ownership is handed to JS, which keeps it as long as
/// the chart references it.
fn constant_color(color: &str) -> JsValue {
    let color = color.to_string();
    Closure::<dyn Fn() -> JsValue>::new(move || JsValue::from_str(&color)).into_js_value()
}

/// The width to draw at: the container's, floored so a hidden panel still
/// produces a valid canvas.
fn plot_width(element: &HtmlElement) -> f64 {
    f64::from(element.unchecked_ref::<web_sys::Element>().client_width()).max(MIN_CHART_WIDTH)
}

/// Format a uPlot y split as exact decimal text.
fn tick_decimal(value: f64) -> Decimal {
    Decimal::from_f64_retain(value)
        .unwrap_or(Decimal::ZERO)
        .round_dp(TICK_DECIMALS)
}

/// A `JsValue` as an `f64`, or `fallback` for `null`/`undefined`/non-numbers.
fn number_or(value: &JsValue, fallback: f64) -> f64 {
    value.as_f64().unwrap_or(fallback)
}

/// A fresh plain object as a `JsValue`.
fn object() -> JsValue {
    js_sys::Object::new().unchecked_into()
}

/// `Reflect.set`, discarding the boolean it returns.
fn set(target: &JsValue, key: &str, value: &JsValue) -> Result<(), JsValue> {
    js_sys::Reflect::set(target, &JsValue::from_str(key), value)?;
    Ok(())
}

/// Render a JS error value as text for logging.
fn js_error_text(error: &JsValue) -> String {
    error
        .as_string()
        .or_else(|| {
            js_sys::JSON::stringify(error)
                .ok()
                .and_then(|text| text.as_string())
        })
        .unwrap_or_else(|| "unknown error".to_string())
}
