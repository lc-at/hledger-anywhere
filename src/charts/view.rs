//! The SVG chart views (wasm-only).
//!
//! Hand-rolled SVG: one `<svg viewBox>`, plain elements, and a native `<title>`
//! child on every mark. The `<title>` is the entire tooltip mechanism — it needs
//! no JavaScript, no event listeners and no positioning logic, and it works on
//! hover in every browser.
//!
//! Colours are CSS custom properties (`var(--gl-*)`), never literals, so the
//! charts follow the Gruvbox dark/light switch without knowing the theme exists.
//!
//! The components are plain functions over plain values. A panel reads its
//! signals, snapshots the data into a `Vec`, and passes a slice in — the same
//! pattern `panels::balances` uses when it builds a table from a decoded report.


use leptos::prelude::*;
use rust_decimal::Decimal;

use super::scale;

/// Chart canvas, in viewBox units. The SVG scales to its container, so these are
/// a coordinate system rather than pixels.
const WIDTH: f64 = 640.0;
const LINE_HEIGHT: f64 = 240.0;
const MARGIN_LEFT: f64 = 72.0;
const MARGIN_RIGHT: f64 = 16.0;
const MARGIN_TOP: f64 = 14.0;
const MARGIN_BOTTOM: f64 = 34.0;
const POINT_RADIUS: f64 = 3.0;
/// At most this many x-axis labels, so period labels never collide.
const X_LABEL_LIMIT: usize = 6;

const BAR_ROW_HEIGHT: f64 = 26.0;
const BAR_HEIGHT: f64 = 15.0;
const BAR_LABEL_WIDTH: f64 = 150.0;
const BAR_LABEL_CHARS: usize = 22;

/// Format a pixel coordinate compactly. Only geometry goes through `f64`.
fn coord(value: f64) -> String {
    format!("{value:.2}")
}

/// The neutral "nothing to chart" state: a message, never a malformed `<svg>`.
fn no_data(message: &str) -> AnyView {
    let message = message.to_string();
    view! {
        <div class="chart-empty" style="padding: 1rem; text-align: center; color: var(--gl-text-dim);">
            {message}
        </div>
    }
    .into_any()
}

/// One of the eight themed series colours, cycling for categorical breakdowns.
fn series_color(index: usize) -> &'static str {
    match index % 8 {
        0 => "var(--gl-series-1)",
        1 => "var(--gl-series-2)",
        2 => "var(--gl-series-3)",
        3 => "var(--gl-series-4)",
        4 => "var(--gl-series-5)",
        5 => "var(--gl-series-6)",
        6 => "var(--gl-series-7)",
        _ => "var(--gl-series-8)",
    }
}

/// A mark's colour: negative values read as errors, everything else takes a
/// series colour.
fn mark_color(value: Decimal, index: usize) -> &'static str {
    if value < Decimal::ZERO {
        "var(--gl-error)"
    } else {
        series_color(index)
    }
}

/// Shorten a label to `max_chars` characters, marking the elision.
fn truncate(text: &str, max_chars: usize) -> String {
    let mut out = String::new();
    for (index, character) in text.chars().enumerate() {
        if index >= max_chars {
            out.push('…');
            break;
        }
        out.push(character);
    }
    out
}

/// A line (with a filled area under it) over time.
///
/// `data` is `(period label, amount)` in chronological order.
pub fn line_chart(data: &[(String, Decimal)]) -> AnyView {
    if data.is_empty() {
        return no_data("No data to chart yet.");
    }

    let values: Vec<Decimal> = data.iter().map(|(_, value)| *value).collect();
    let axis = scale::y_axis(&values, 4);

    let plot_left = MARGIN_LEFT;
    let plot_right = WIDTH - MARGIN_RIGHT;
    let plot_top = MARGIN_TOP;
    let plot_bottom = LINE_HEIGHT - MARGIN_BOTTOM;
    // y grows downward in SVG, so the largest value maps to the top pixel.
    let y = scale::LinearScale::new(axis.range, plot_bottom, plot_top);

    let count = data.len();
    let x_at = |index: usize| -> f64 {
        if count <= 1 {
            (plot_left + plot_right) / 2.0
        } else {
            plot_left + (plot_right - plot_left) * index as f64 / (count - 1) as f64
        }
    };

    let mut line = String::new();
    let mut area = String::new();
    for (index, (_, value)) in data.iter().enumerate() {
        let px = coord(x_at(index));
        let py = coord(y.position(*value));
        if index == 0 {
            line.push_str(&format!("M{px} {py}"));
            area.push_str(&format!("M{px} {} L{px} {py}", coord(plot_bottom)));
        } else {
            line.push_str(&format!(" L{px} {py}"));
            area.push_str(&format!(" L{px} {py}"));
        }
    }
    if count > 1 {
        area.push_str(&format!(
            " L{} {} Z",
            coord(x_at(count - 1)),
            coord(plot_bottom)
        ));
    }

    let gridlines = axis
        .ticks
        .iter()
        .map(|tick| {
            let py = coord(y.position(*tick));
            let label = scale::format_tick(*tick);
            view! {
                <line
                    x1=coord(plot_left)
                    x2=coord(plot_right)
                    y1=coord(y.position(*tick))
                    y2=coord(y.position(*tick))
                    stroke="var(--gl-border)"
                    stroke-width="1"
                ></line>
                <text
                    x=coord(plot_left - 8.0)
                    y=py
                    text-anchor="end"
                    fill="var(--gl-text-dim)"
                    font-size="11"
                >
                    {label}
                </text>
            }
        })
        .collect_view();

    // The zero baseline is called out, because "above or below zero" is the
    // question a financial chart actually answers.
    let zero_line = if axis.range.contains(Decimal::ZERO) {
        view! {
            <line
                x1=coord(plot_left)
                x2=coord(plot_right)
                y1=coord(y.position(Decimal::ZERO))
                y2=coord(y.position(Decimal::ZERO))
                stroke="var(--gl-text-dim)"
                stroke-width="1"
                stroke-dasharray="3 3"
                opacity="0.6"
            ></line>
        }
        .into_any()
    } else {
        ().into_any()
    };

    let area_view = if count > 1 {
        view! {
            <path d=area fill="var(--gl-accent)" fill-opacity="0.15" stroke="none"></path>
        }
        .into_any()
    } else {
        ().into_any()
    };

    let points = data
        .iter()
        .enumerate()
        .map(|(index, (label, value))| {
            let tooltip = format!("{label}: {}", scale::format_tick(*value));
            view! {
                <circle
                    cx=coord(x_at(index))
                    cy=coord(y.position(*value))
                    r=coord(POINT_RADIUS)
                    fill="var(--gl-accent)"
                >
                    <title>{tooltip}</title>
                </circle>
            }
        })
        .collect_view();

    // Evenly spaced labels including both ends; a finer stride would collide.
    let label_stride = count.div_ceil(X_LABEL_LIMIT);
    let x_labels = data
        .iter()
        .enumerate()
        .filter(|(index, _)| index % label_stride == 0 || *index == count - 1)
        .map(|(index, (label, _))| {
            view! {
                <text
                    x=coord(x_at(index))
                    y=coord(LINE_HEIGHT - 10.0)
                    text-anchor="middle"
                    fill="var(--gl-text-dim)"
                    font-size="11"
                >
                    {truncate(label, 14)}
                </text>
            }
        })
        .collect_view();

    view! {
        <div class="chart chart-line">
            <svg
                viewBox=format!("0 0 {WIDTH} {LINE_HEIGHT}")
                style="display: block; width: 100%; height: auto;"
                role="img"
                aria-label="Time series chart"
            >
                {gridlines}
                // The x axis, drawn after the gridlines so the baseline reads as
                // the frame rather than as just another gridline.
                <line
                    x1=coord(plot_left)
                    x2=coord(plot_right)
                    y1=coord(plot_bottom)
                    y2=coord(plot_bottom)
                    stroke="var(--gl-border)"
                    stroke-width="1"
                ></line>
                {zero_line}
                {area_view}
                <path
                    d=line
                    fill="none"
                    stroke="var(--gl-series-1)"
                    stroke-width="2"
                    stroke-linejoin="round"
                    stroke-linecap="round"
                ></path>
                {points}
                {x_labels}
            </svg>
        </div>
    }
    .into_any()
}

/// A horizontal bar chart for a categorical breakdown.
///
/// `data` is `(category label, amount)`; rows are re-sorted by descending
/// magnitude so the biggest category is always at the top. Negative values keep
/// the length of their magnitude and take the error colour, with the sign in the
/// label and tooltip.
pub fn bar_chart(data: &[(String, Decimal)]) -> AnyView {
    if data.is_empty() {
        return no_data("No data to chart yet.");
    }

    let mut rows: Vec<(&str, Decimal)> = data
        .iter()
        .map(|(label, value)| (label.as_str(), *value))
        .collect();
    rows.sort_by_key(|(_, value)| std::cmp::Reverse(value.abs()));

    let max_magnitude = rows
        .iter()
        .map(|(_, value)| value.abs())
        .max()
        .unwrap_or(Decimal::ZERO);

    let height = MARGIN_TOP + MARGIN_BOTTOM + rows.len() as f64 * BAR_ROW_HEIGHT;
    let track_left = BAR_LABEL_WIDTH;
    let track_width = (WIDTH - MARGIN_RIGHT) - track_left;

    let bars = rows
        .iter()
        .enumerate()
        .map(|(index, (label, value))| {
            let row_top = MARGIN_TOP + index as f64 * BAR_ROW_HEIGHT;
            let bar_top = row_top + (BAR_ROW_HEIGHT - BAR_HEIGHT) / 2.0;
            let baseline = row_top + BAR_ROW_HEIGHT / 2.0 + 4.0;
            // A zero amount still gets a sliver, so its tooltip is reachable.
            let width = (scale::magnitude_fraction(*value, max_magnitude) * track_width).max(1.0);
            let text = scale::format_tick(*value);
            let tooltip = format!("{label}: {text}");

            view! {
                <g>
                    <text
                        x=coord(track_left - 10.0)
                        y=coord(baseline)
                        text-anchor="end"
                        fill="var(--gl-text)"
                        font-size="12"
                    >
                        {truncate(label, BAR_LABEL_CHARS)}
                    </text>
                    <rect
                        x=coord(track_left)
                        y=coord(bar_top)
                        width=coord(width)
                        height=coord(BAR_HEIGHT)
                        rx="2"
                        fill=mark_color(*value, index)
                    >
                        <title>{tooltip}</title>
                    </rect>
                    <text
                        x=coord(track_left + width + 6.0)
                        y=coord(baseline)
                        fill="var(--gl-text-dim)"
                        font-size="11"
                    >
                        {text}
                    </text>
                </g>
            }
        })
        .collect_view();

    view! {
        <div class="chart chart-bar">
            <svg
                viewBox=format!("0 0 {WIDTH} {height}")
                style="display: block; width: 100%; height: auto;"
                role="img"
                aria-label="Category breakdown"
            >
                {bars}
            </svg>
        </div>
    }
    .into_any()
}
