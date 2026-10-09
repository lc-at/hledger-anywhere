//! Pure shaping for the uPlot line chart: the numeric columns uPlot consumes,
//! the sparse x-axis tick positions and the tiny bit of colour arithmetic the
//! theme read needs.
//!
//! Like [`super::scale`], this module never touches the browser, so it compiles
//! and is unit-tested on the host. It is declared unconditionally; on the host
//! only the tests use it, hence the allowance.
#![allow(dead_code)]

use rust_decimal::Decimal;

/// One line: a name for the legend and one value per point.
#[derive(Clone, Debug, PartialEq)]
pub struct Line {
    /// The legend entry. Ignored when it is the only line, since a legend of
    /// one says nothing the panel title does not.
    pub label: String,
    /// The value at each point, in x order.
    pub values: Vec<Decimal>,
}

impl Line {
    pub fn new(label: impl Into<String>, values: Vec<Decimal>) -> Self {
        Self {
            label: label.into(),
            values,
        }
    }
}

/// One series in the columnar shape uPlot consumes.
#[derive(Clone, Debug, PartialEq)]
pub struct Series {
    /// The legend entry.
    pub label: String,
    /// y coordinates: the amount as a float.
    pub ys: Vec<f64>,
}

/// Everything uPlot needs: the x labels, their numeric coordinates, and the
/// lines to draw over them.
///
/// uPlot's x values must be **numbers** (its scales are numeric, time or
/// linear), so the point index is the x coordinate and the human label is kept
/// alongside for the axis formatter. Passing `"2024-01"` straight to uPlot as
/// an x value would push `NaN` through every scale calculation.
#[derive(Clone, Debug, PartialEq)]
pub struct Columns {
    /// One display label per point, in x order.
    pub labels: Vec<String>,
    /// x coordinates: the zero-based point index.
    pub xs: Vec<f64>,
    /// The lines to draw, in the order they should be coloured.
    pub series: Vec<Series>,
}

impl Columns {
    /// The number of points along the x axis.
    pub fn len(&self) -> usize {
        self.labels.len()
    }

    /// Whether there is nothing to plot.
    pub fn is_empty(&self) -> bool {
        self.series.is_empty() || self.labels.is_empty()
    }
}

/// Shape `lines` against `labels` into uPlot columns.
///
/// `Decimal::as_f64` is infallible (it is the exact equivalent of
/// `ToPrimitive::to_f64`), and an amount can never exceed `f64`'s much larger
/// range, so no value is dropped.
///
/// Every line is padded to the label count. uPlot wants one value per x per
/// series, and a short line would not merely leave a gap: it would shift every
/// later point of that line onto the wrong period, which is a wrong chart rather
/// than an incomplete one.
pub fn columns(labels: Vec<String>, lines: Vec<Line>) -> Columns {
    let count = labels.len();
    let xs = (0..count).map(|index| index as f64).collect();
    let series = lines
        .into_iter()
        .map(|line| {
            let mut ys: Vec<f64> = line.values.iter().map(Decimal::as_f64).collect();
            ys.resize(count, 0.0);
            Series {
                label: line.label,
                ys,
            }
        })
        .collect();
    Columns { labels, xs, series }
}

/// The x-axis tick positions for a series of `count` points, at most `limit` of
/// them, always including the first and last point.
///
/// The positions are spread evenly across the index range and rounded to whole
/// points, then de-duplicated: naively striding and appending the last point can
/// put two labels on adjacent points, which collide when the chart is narrow.
/// A series of one point ticks at zero.
pub fn x_tick_indices(count: usize, limit: usize) -> Vec<usize> {
    if count == 0 {
        return Vec::new();
    }
    if count == 1 || limit < 2 {
        return vec![0];
    }
    let last = count - 1;
    let slots = (limit - 1).min(last);
    let mut indices: Vec<usize> = Vec::with_capacity(slots + 1);
    for slot in 0..=slots {
        // Round half up to the nearest point index.
        let index = ((slot * last) + slots / 2) / slots;
        if indices.last() != Some(&index) {
            indices.push(index);
        }
    }
    indices
}

/// How many x labels actually fit across a chart `width` CSS pixels wide,
/// clamped to `2..=limit`.
///
/// A period label such as `2024-01-22` is roughly 70 px at uPlot's axis font,
/// and it needs a little room around it. Without this a narrow panel keeps the
/// full label budget and the dates overlap.
pub fn x_label_budget(width: f64, limit: usize) -> usize {
    const PER_LABEL: f64 = 80.0;
    let fits = (width.max(0.0) / PER_LABEL).floor() as usize;
    fits.clamp(2, limit.max(2))
}

/// Append an alpha channel to a CSS colour, returning `#rrggbbaa`.
///
/// The app's Gruvbox palette is authored as hex (`#458588`), which is the case
/// that matters; `rgb(...)` is handled too, and anything unrecognised is
/// returned opaque rather than as an invalid colour. The point is the area fill
/// under the line: uPlot takes a colour string, not an opacity, so the alpha has
/// to be baked into the value.
pub fn with_alpha(color: &str, alpha: f64) -> String {
    let color = color.trim();
    let alpha = (alpha.clamp(0.0, 1.0) * 255.0).round() as u32;
    if let Some(hex) = color.strip_prefix('#') {
        let (red, green, blue) = match hex.len() {
            3 => {
                let Some(red) = hex_byte(&hex[0..1]) else {
                    return color.to_string();
                };
                let Some(green) = hex_byte(&hex[1..2]) else {
                    return color.to_string();
                };
                let Some(blue) = hex_byte(&hex[2..3]) else {
                    return color.to_string();
                };
                (red * 17, green * 17, blue * 17)
            }
            6 => {
                let Some(red) = hex_byte(&hex[0..2]) else {
                    return color.to_string();
                };
                let Some(green) = hex_byte(&hex[2..4]) else {
                    return color.to_string();
                };
                let Some(blue) = hex_byte(&hex[4..6]) else {
                    return color.to_string();
                };
                (red, green, blue)
            }
            _ => return color.to_string(),
        };
        return format!("#{red:02x}{green:02x}{blue:02x}{alpha:02x}");
    }
    if let Some(inner) = color
        .strip_prefix("rgb(")
        .and_then(|rest| rest.strip_suffix(')'))
    {
        let opacity = alpha as f64 / 255.0;
        return format!("rgba({inner},{opacity:.2})");
    }
    color.to_string()
}

/// One or two hex digits as a byte.
fn hex_byte(digits: &str) -> Option<u32> {
    u32::from_str_radix(digits, 16).ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn dec(mantissa: i64, scale: u32) -> Decimal {
        Decimal::new(mantissa, scale)
    }

    #[test]
    fn columns_are_indexed_and_keep_labels_in_order() {
        let labels = vec![
            "2024-01".to_string(),
            "2024-02".to_string(),
            "2024-03".to_string(),
        ];
        let columns = columns(
            labels,
            vec![Line::new(
                "Total",
                vec![dec(125, 2), dec(-50, 2), Decimal::ZERO],
            )],
        );
        assert_eq!(columns.labels, vec!["2024-01", "2024-02", "2024-03"]);
        assert_eq!(columns.xs, vec![0.0, 1.0, 2.0]);
        assert_eq!(columns.series.len(), 1);
        assert_eq!(columns.series[0].label, "Total");
        assert_eq!(columns.series[0].ys, vec![1.25, -0.5, 0.0]);
        assert_eq!(columns.len(), 3);
        assert!(!columns.is_empty());
    }

    #[test]
    fn several_lines_share_one_x_axis() {
        let columns = columns(
            vec!["a".to_string(), "b".to_string()],
            vec![
                Line::new("Assets", vec![dec(10, 0), dec(20, 0)]),
                Line::new("Liabilities", vec![dec(-5, 0), dec(-8, 0)]),
            ],
        );
        assert_eq!(columns.xs, vec![0.0, 1.0]);
        assert_eq!(columns.series.len(), 2);
        assert_eq!(columns.series[1].label, "Liabilities");
        assert_eq!(columns.series[1].ys, vec![-5.0, -8.0]);
    }

    #[test]
    fn a_short_line_is_padded_rather_than_shifting_its_points() {
        // Without padding, this line's second value would be plotted at the
        // *last* point instead of the second — a wrong chart, not a gap.
        let columns = columns(
            vec!["a".to_string(), "b".to_string(), "c".to_string()],
            vec![Line::new("Short", vec![dec(10, 0), dec(20, 0)])],
        );
        assert_eq!(columns.series[0].ys, vec![10.0, 20.0, 0.0]);
        assert_eq!(columns.len(), 3);
    }

    #[test]
    fn columns_of_nothing_are_empty() {
        let empty = columns(Vec::new(), Vec::new());
        assert!(empty.is_empty());
        assert!(empty.labels.is_empty());
        assert!(empty.xs.is_empty());

        // Labels with no lines is also nothing to draw.
        assert!(columns(vec!["a".to_string()], Vec::new()).is_empty());
    }

    #[test]
    fn a_single_point_is_a_zero_index() {
        let columns = columns(
            vec!["2024-01".to_string()],
            vec![Line::new("", vec![dec(-7, 1)])],
        );
        assert_eq!(columns.xs, vec![0.0]);
        assert_eq!(columns.series[0].ys, vec![-0.7]);
    }

    #[test]
    fn tick_indices_name_both_ends_and_respect_the_limit() {
        assert_eq!(x_tick_indices(0, 6), Vec::<usize>::new());
        assert_eq!(x_tick_indices(1, 6), vec![0]);
        assert_eq!(x_tick_indices(2, 6), vec![0, 1]);
        assert_eq!(x_tick_indices(6, 6), vec![0, 1, 2, 3, 4, 5]);
        // 30 points over a 6-label budget: evenly spread, never adjacent.
        assert_eq!(x_tick_indices(30, 6), vec![0, 6, 12, 17, 23, 29]);
        // 14 points would otherwise put the last two labels side by side.
        assert_eq!(x_tick_indices(14, 6), vec![0, 3, 5, 8, 10, 13]);
        // A limit too small to space anything still names the first point.
        assert_eq!(x_tick_indices(9, 1), vec![0]);
    }

    #[test]
    fn tick_indices_never_repeat_the_last_point() {
        for count in 1..64 {
            let indices = x_tick_indices(count, 6);
            assert_eq!(indices.first(), Some(&0));
            assert_eq!(indices.last(), Some(&(count - 1)));
            assert!(indices.windows(2).all(|pair| pair[0] < pair[1]));
        }
    }

    #[test]
    fn label_budget_narrows_with_the_chart() {
        assert_eq!(x_label_budget(800.0, 6), 6);
        assert_eq!(x_label_budget(356.0, 6), 4);
        assert_eq!(x_label_budget(200.0, 6), 2);
        // Never fewer than two labels, never more than the limit.
        assert_eq!(x_label_budget(0.0, 6), 2);
        assert_eq!(x_label_budget(10_000.0, 6), 6);
    }

    #[test]
    fn with_alpha_bakes_opacity_into_hex_and_rgb() {
        // 0.15 * 255 = 38.25, rounded to 38 = 0x26.
        assert_eq!(with_alpha("#458588", 0.15), "#45858826");
        assert_eq!(with_alpha(" #458588 ", 0.15), "#45858826");
        assert_eq!(with_alpha("#fff", 1.0), "#ffffffff");
        assert_eq!(with_alpha("#000", 0.0), "#00000000");
        assert_eq!(
            with_alpha("rgb(69, 133, 136)", 0.5),
            "rgba(69, 133, 136,0.50)"
        );
        // Unknown syntax is returned opaque rather than as an invalid colour.
        assert_eq!(with_alpha("rebeccapurple", 0.5), "rebeccapurple");
        assert_eq!(with_alpha("#12345", 0.5), "#12345");
        assert_eq!(with_alpha("#zzzzzz", 0.5), "#zzzzzz");
    }
}
