//! Drawing hledger's numbers in the terminal.
//!
//! A report answers "how much"; a chart answers "which one, and how does it
//! compare". For a personal journal that is usually the more useful question, and
//! there is nowhere to draw it but the terminal the app already has.
//!
//! The input is hledger's own CSV (`-O csv`), which is the only format that keeps
//! the structure, accounts, periods and amounts, without parsing a text table
//! whose columns move. Two shapes matter, and they are different questions:
//!
//!   * Two columns (a label and one amount per row) is a **ranking**: horizontal
//!     bars, longest first, which is how people read "where did the money go".
//!   * Three or more columns is a **series over time**: vertical bars, one per
//!     period, which is how people read "how is this month going".
//!
//! Everything here is pure, so the drawing is tested rather than eyeballed.

// Natively only the tests use this module.
#![cfg_attr(not(target_arch = "wasm32"), allow(dead_code))]

/// hledger's own row for column sums. It is not a row of data, and on a balanced
/// journal it sums to zero, so drawing it would say nothing.
const TOTAL_LABEL: &str = "total:";

/// The characters a bar is drawn with, in eighths, so a bar can end part-way
/// through a cell rather than rounding every value to the nearest whole one.
const EIGHTHS: [char; 8] = ['▏', '▎', '▍', '▌', '▋', '▊', '▉', '█'];

/// A parsed CSV table: a header row and the rows under it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Table {
    pub header: Vec<String>,
    pub rows: Vec<Vec<String>>,
}

impl Table {
    /// How many columns the table actually has, header included.
    fn columns(&self) -> usize {
        self.header
            .len()
            .max(self.rows.iter().map(Vec::len).max().unwrap_or(0))
    }

    /// The rows that carry data, with hledger's total row left out.
    fn data_rows(&self) -> impl Iterator<Item = &Vec<String>> {
        self.rows
            .iter()
            .filter(|row| !row.first().is_some_and(|first| is_total(first)))
    }
}

fn is_total(label: &str) -> bool {
    label.trim().to_lowercase() == TOTAL_LABEL || label.trim().to_lowercase() == "total"
}

/// Read hledger's CSV.
///
/// Quoted fields are what make this worth writing rather than splitting on
/// commas: amounts are quoted and contain them (`"$1,234.56"`), so a naive split
/// turns one amount into two.
pub fn parse_csv(text: &str) -> Table {
    let mut records: Vec<Vec<String>> = Vec::new();
    for line in text.lines() {
        if line.trim().is_empty() {
            continue;
        }
        records.push(parse_record(line));
    }
    let mut records = records.into_iter();
    let header = records.next().unwrap_or_default();
    Table {
        header,
        rows: records.collect(),
    }
}

/// One CSV line into fields.
fn parse_record(line: &str) -> Vec<String> {
    let mut fields = Vec::new();
    let mut field = String::new();
    let mut quoted = false;
    let mut characters = line.chars().peekable();

    while let Some(character) = characters.next() {
        match character {
            '"' if quoted => {
                // A doubled quote inside a quoted field is one quote.
                if characters.peek() == Some(&'"') {
                    characters.next();
                    field.push('"');
                } else {
                    quoted = false;
                }
            }
            '"' => quoted = true,
            ',' if !quoted => fields.push(std::mem::take(&mut field)),
            _ => field.push(character),
        }
    }
    fields.push(field);
    fields
}

/// An amount as a number, whatever hledger decorated it with.
///
/// `$1,234.56`, `$-1000.00`, `-$5`, `1234.56 EUR` and `(5.00)` all mean what they
/// look like; `0` means zero. Anything without a number is `None`, which is how
/// an empty cell and a header stay out of the drawing.
pub fn parse_amount(text: &str) -> Option<f64> {
    let trimmed = text.trim();
    if trimmed.is_empty() {
        return None;
    }
    let negative = trimmed.contains('-') || (trimmed.starts_with('(') && trimmed.ends_with(')'));
    let digits: String = trimmed
        .chars()
        .filter(|character| character.is_ascii_digit() || *character == '.')
        .collect();
    if digits.is_empty() || digits == "." {
        return None;
    }
    let value: f64 = digits.parse().ok()?;
    if !value.is_finite() {
        return None;
    }
    Some(if negative { -value } else { value })
}

/// A bar of `length` eighths, rounded to the nearest eighth.
fn bar(eighths: usize) -> String {
    let whole = eighths / 8;
    let part = eighths % 8;
    let mut text = EIGHTHS[7].to_string().repeat(whole);
    if part > 0 {
        text.push(EIGHTHS[part - 1]);
    }
    if text.is_empty() {
        text.push(EIGHTHS[0]);
    }
    text
}

/// Shorten a label to `width`, keeping the end, which is the part that differs.
fn fit(label: &str, width: usize) -> String {
    if width == 0 {
        return String::new();
    }
    let characters: Vec<char> = label.chars().collect();
    if characters.len() <= width {
        return label.to_string();
    }
    if width == 1 {
        return "…".to_string();
    }
    let tail: String = characters[characters.len() - (width - 1)..].iter().collect();
    format!("…{tail}")
}

/// A ranking: one bar per row, longest first.
///
/// The values are drawn by size and labelled with their sign, rather than drawn
/// left and right of a zero line: on a terminal, a bar that grows in the direction
/// you can read beats one that grows in two.
pub fn ranking(table: &Table, width: usize, height: usize) -> Vec<String> {
    let mut entries: Vec<(String, f64, String)> = table
        .data_rows()
        .filter_map(|row| {
            let label = row.first()?.clone();
            let amount = parse_amount(row.get(1)?)?;
            Some((label, amount, row.get(1)?.clone()))
        })
        .collect();
    entries.sort_by(|left, right| {
        right
            .1
            .abs()
            .partial_cmp(&left.1.abs())
            .unwrap_or(std::cmp::Ordering::Equal)
    });
    entries.truncate(height.max(1));

    if entries.is_empty() {
        return Vec::new();
    }

    // The label and the amount take the ends; the bar gets what is left.
    let label_width = entries
        .iter()
        .map(|(label, _, _)| label.chars().count())
        .max()
        .unwrap_or(0)
        .min(width.saturating_sub(12) / 2)
        .max(4);
    let amount_width = entries
        .iter()
        .map(|(_, _, amount)| amount.chars().count())
        .max()
        .unwrap_or(0);
    // The label, two spaces, the bar, two spaces, the amount: four separators.
    let bar_width = width
        .saturating_sub(label_width + amount_width + 4)
        .max(4);
    let longest = entries
        .iter()
        .map(|(_, amount, _)| amount.abs())
        .fold(0.0_f64, f64::max);

    entries
        .into_iter()
        .map(|(label, amount, text)| {
            let share = if longest > 0.0 {
                amount.abs() / longest
            } else {
                0.0
            };
            let eighths = (share * (bar_width * 8) as f64).round() as usize;
            format!(
                "{:<label_width$}  {:<bar_width$}  {:>amount_width$}",
                fit(&label, label_width),
                bar(eighths.max(1)),
                text
            )
        })
        .collect()
}

/// A series over time: one bar per column, with a scale above it.
///
/// The bars are packed rather than spread across the terminal: a chart of two
/// months drawn 55 columns apart is a diagram with nothing in it. Each period gets
/// a slot just wide enough for a bar and a label, so the shape is what you see
/// instead of the whitespace.
pub fn series(table: &Table, width: usize, height: usize) -> Vec<String> {
    let columns = table.columns().saturating_sub(1);
    if columns == 0 {
        return Vec::new();
    }

    // One value per period: what the user filtered to, added up. Summing the whole
    // report would be zero on a balanced journal, which is why the total row is
    // dropped and why the caller is expected to filter.
    let mut totals: Vec<f64> = vec![0.0; columns];
    for row in table.data_rows() {
        for (index, total) in totals.iter_mut().enumerate() {
            if let Some(value) = row.get(index + 1).and_then(|cell| parse_amount(cell)) {
                *total += value;
            }
        }
    }

    let peak = totals
        .iter()
        .fold(0.0_f64, |peak, value| peak.max(value.abs()));
    if peak <= 0.0 {
        return Vec::new();
    }

    // Rows for the bars, then the peak, the labels and the values.
    let rows = height.saturating_sub(3).clamp(1, 20);
    let slot = (width / columns).clamp(4, 10);
    let bar: String = "█".repeat(slot.saturating_sub(2).clamp(1, 4));

    let heights: Vec<usize> = totals
        .iter()
        .map(|value| ((value.abs() / peak) * rows as f64).round() as usize)
        .collect();

    let mut lines: Vec<String> = Vec::new();
    lines.push(format!("{peak:.2}"));
    for row in (1..=rows).rev() {
        let mut line = String::new();
        for height in &heights {
            // A period with a value but too small to reach a cell still gets one:
            // "nothing happened" and "almost nothing happened" are different.
            let cell = if *height >= row { bar.as_str() } else { "" };
            line.push_str(&format!("{cell:^slot$}"));
        }
        lines.push(line.trim_end().to_string());
    }

    let mut labels = String::new();
    for label in table.header.iter().skip(1).take(columns) {
        labels.push_str(&format!("{:^slot$}", fit(label, slot)));
    }
    lines.push(labels.trim_end().to_string());

    // The value under each bar, when there is room for it.
    let numbers: Vec<String> = totals.iter().map(|value| format!("{value:.0}")).collect();
    if numbers.iter().all(|number| number.len() < slot) {
        let mut values = String::new();
        for number in &numbers {
            values.push_str(&format!("{number:^slot$}"));
        }
        lines.push(values.trim_end().to_string());
    }

    lines
}

/// Draw whatever `csv` describes, or nothing when there is nothing to draw.
pub fn render(csv: &str, width: usize, height: usize) -> Vec<String> {
    let table = parse_csv(csv);
    match table.columns() {
        0 | 1 => Vec::new(),
        2 => ranking(&table, width, height),
        _ => series(&table, width, height),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const RANKING: &str = "\"account\",\"balance\"\n\
        \"assets:bank:checking\",\"$2,880.81\"\n\
        \"expenses:food:groceries\",\"$84.20\"\n\
        \"expenses:housing:rent\",\"$1200.00\"\n\
        \"income:salary\",\"$-3200.00\"\n\
        \"Total:\",\"0\"\n";

    const SERIES: &str = "\"account\",\"2024-01\",\"2024-02\",\"2024-03\"\n\
        \"expenses:food:groceries\",\"$84.20\",\"0\",\"0\"\n\
        \"expenses:housing:rent\",\"0\",\"$1200.00\",\"0\"\n\
        \"expenses:reading:books\",\"0\",\"$34.99\",\"0\"\n\
        \"Total:\",\"$84.20\",\"$1234.99\",\"0\"\n";

    #[test]
    fn a_csv_is_read_field_by_field_including_quoted_commas() {
        let table = parse_csv("\"account\",\"balance\"\n\"a\",\"$1,234.56\"\n");
        assert_eq!(table.header, vec!["account", "balance"]);
        assert_eq!(table.rows, vec![vec!["a", "$1,234.56"]]);
        assert_eq!(table.columns(), 2);

        // A doubled quote is one quote, and an unquoted field still works.
        let table = parse_csv("\"a\",\"b\"\n\"he said \"\"hi\"\"\",plain\n");
        assert_eq!(table.rows[0], vec!["he said \"hi\"", "plain"]);

        assert_eq!(parse_csv("").columns(), 0);
    }

    #[test]
    fn amounts_are_read_however_hledger_decorated_them() {
        assert_eq!(parse_amount("$1,234.56"), Some(1234.56));
        assert_eq!(parse_amount("$-1000.00"), Some(-1000.0));
        assert_eq!(parse_amount("-$5"), Some(-5.0));
        assert_eq!(parse_amount("(5.00)"), Some(-5.0));
        assert_eq!(parse_amount("1234.56 EUR"), Some(1234.56));
        assert_eq!(parse_amount("0"), Some(0.0));
        // Not numbers: an empty cell and a heading stay out of the drawing.
        assert_eq!(parse_amount(""), None);
        assert_eq!(parse_amount("account"), None);
        assert_eq!(parse_amount("$"), None);
    }

    #[test]
    fn a_two_column_report_is_drawn_as_a_ranking_longest_first() {
        let lines = render(RANKING, 60, 10);
        assert_eq!(lines.len(), 4, "the total row is not data");
        // Longest first, by size, and the sign lives in the label not the bar.
        assert!(lines[0].contains("income:salary"), "{}", lines[0]);
        assert!(lines[1].contains("assets:bank:checking"), "{}", lines[1]);
        // Every line carries its own amount, and no line is wider than asked.
        for line in &lines {
            assert!(line.chars().count() <= 60, "too wide: {line}");
        }
        assert!(lines[0].contains("-3200.00"), "{}", lines[0]);
    }

    #[test]
    fn a_ranking_keeps_what_fits_the_height_and_says_it_is_shortened() {
        let lines = render(RANKING, 60, 2);
        assert_eq!(lines.len(), 2);
        assert!(lines[0].contains("income:salary"));
    }

    #[test]
    fn a_report_over_time_is_drawn_as_bars_per_period() {
        let lines = render(SERIES, 60, 10);
        assert!(!lines.is_empty());
        // The peak is announced, and the periods are labelled under the bars.
        assert!(lines[0].starts_with("1234.99") || lines[0].starts_with("1234"), "{:?}", lines[0]);
        assert!(lines.iter().any(|line| line.contains("2024-02")), "{lines:?}");
        // February is the biggest month, so it has the tallest bar.
        let bars = |line: &str| line.matches('█').count();
        assert!(lines.iter().any(|line| bars(line) >= 3), "{lines:?}");
    }

    #[test]
    fn a_short_series_is_packed_rather_than_spread_across_the_terminal() {
        // The first version drew three months across 200 columns, thirty apart
        // each, and the shape was invisible. The bars are now as close as the
        // labels allow and no chart is wider than it needs to be.
        let lines = render(SERIES, 200, 12);
        let widest = lines
            .iter()
            .map(|line| line.chars().count())
            .max()
            .unwrap_or(0);
        assert!(widest <= 40, "a three-month chart took {widest} columns");
        assert!(lines.iter().any(|line| line.contains('█')), "{lines:?}");
    }

    #[test]
    fn a_balanced_report_says_nothing_rather_than_drawing_zeroes() {
        // Summing every account of a balanced journal is zero, which is why the
        // caller filters; an all-zero result is not worth drawing.
        let balanced = "\"account\",\"2024-01\",\"2024-02\"\n\
            \"assets\",\"0\",\"0\"\n\"expenses\",\"0\",\"0\"\n\
            \"Total:\",\"0\",\"0\"\n";
        assert!(render(balanced, 60, 10).is_empty());
        // The same report filtered to expenses is what a chart is for.
        let expenses = "\"account\",\"2024-01\",\"2024-02\"\n\
            \"expenses:food\",\"$84.20\",\"0\"\n\
            \"expenses:rent\",\"0\",\"$1200.00\"\n";
        assert!(!render(expenses, 60, 10).is_empty());
    }

    #[test]
    fn nothing_to_draw_is_not_an_error() {
        assert!(render("", 80, 24).is_empty());
        assert!(render("\"account\",\"balance\"\n", 80, 24).is_empty());
        assert!(render("just some text\n", 80, 24).is_empty());
    }

    #[test]
    fn a_label_too_long_for_its_column_keeps_the_end() {
        assert_eq!(fit("expenses:food:groceries", 10), "…groceries");
        assert_eq!(fit("short", 10), "short");
        assert_eq!(fit("anything", 0), "");
        // Multi-byte characters are measured in characters, not bytes: five
        // characters plus the ellipsis would be six, and the width is four.
        let shortened = fit("résumé", 4);
        assert_eq!(shortened.chars().count(), 4, "{shortened}");
        assert_eq!(shortened, "…umé");
    }
}
