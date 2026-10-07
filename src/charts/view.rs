//! The SVG chart views (wasm-only).
//!
//! Only the horizontal bar chart lives here now: it is a static, single-shot
//! figure that SVG renders without help. The line chart moved to
//! [`super::uplot`], which drives uPlot through `js_sys`.
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
const MARGIN_RIGHT: f64 = 16.0;
const MARGIN_TOP: f64 = 14.0;
const MARGIN_BOTTOM: f64 = 34.0;

const BAR_ROW_HEIGHT: f64 = 26.0;
const BAR_HEIGHT: f64 = 15.0;
const BAR_LABEL_WIDTH: f64 = 150.0;
const BAR_LABEL_CHARS: usize = 22;

/// Format a pixel coordinate compactly. Only geometry goes through `f64`.
fn coord(value: f64) -> String {
    format!("{value:.2}")
}

/// The neutral "nothing to chart" state: a message, never a malformed `<svg>`.
///
/// Shared with [`super::uplot`], which renders it for an empty series.
pub(super) fn no_data(message: &str) -> AnyView {
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
