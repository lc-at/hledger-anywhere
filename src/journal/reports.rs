//! Decoding hledger's multi-period (and budget) JSON reports.
//!
//! These are the reports whose columns are periods rather than accounts:
//!
//! * `balance --monthly|--weekly|--quarterly|--yearly [--historical|--cumulative|--change] -O json`
//!   produces a [`PeriodicReport`];
//! * `balancesheet`, `balancesheetequity` and `incomestatement` produce a
//!   [`CompoundPeriodicReport`], several periodic reports plus an overall total;
//! * `balance --budget[=DESCPAT] [--monthly] -O json` is *also* a periodic
//!   report, but every cell is a `[actual, goal]` pair, so it decodes into a
//!   separate [`BudgetReport`].
//!
//! The authoritative definitions live in the vendored hledger 1.52.4:
//! `Hledger/Reports/ReportTypes.hs` (`PeriodicReport`, `PeriodicReportRow`,
//! `CompoundPeriodicReport`) and `Hledger/Reports/BudgetReport.hs`
//! (`BudgetCell = (Maybe Change, Maybe BudgetGoal)`).
//!
//! Two wire quirks are handled explicitly:
//!
//! * A data row's `prrName` is a string, but the grand-totals row's name is the
//!   JSON value `[]`, because Aeson encodes the unit type `()` as an empty
//!   array. [`RowName`] accepts both.
//! * A [`DateSpan`] is a two-element array of nullable `EFDay`s, and a `DateSpan`
//!   end is *exclusive* (it equals the next period's start), which is why
//!   [`DateSpan::label`] reads the month from the start.

// Consumers are the wasm-only panels, plus the tests; see the longer note in
// `journal::model`. A couple of accessors here exist for completeness of the
// report model rather than for a current caller.
#![allow(dead_code)]

use rust_decimal::Decimal;
use serde::{Deserialize, Deserializer};

use super::model::JournalError;
use super::money::Amount;

/// hledger's `MixedAmount`: a list of amounts, one per commodity.
pub type MixedAmount = Vec<Amount>;

/// The empty string hledger shows for a span that covers everything.
const NO_PERIOD: &str = "—";

/// A row name: a real account name on a data row, or the grand-totals marker.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub enum RowName {
    /// A data row, named by its (usually full) account name.
    Named(String),
    /// The report's grand-totals row. Aeson encodes its `()` name as `[]`.
    #[default]
    Totals,
}

impl RowName {
    /// The account name, if this is a data row.
    pub fn as_str(&self) -> Option<&str> {
        match self {
            RowName::Named(name) => Some(name),
            RowName::Totals => None,
        }
    }

    /// Whether this is the grand-totals row.
    pub fn is_totals(&self) -> bool {
        matches!(self, RowName::Totals)
    }

    /// Whether this is hledger's synthetic `<unbudgeted>` row in a budget report.
    pub fn is_unbudgeted(&self) -> bool {
        matches!(self, RowName::Named(name) if name == UNBUDGETED)
    }
}

impl<'de> Deserialize<'de> for RowName {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        use serde::de::Error as _;

        let value = serde_json::Value::deserialize(deserializer)?;
        match value {
            serde_json::Value::String(name) => Ok(RowName::Named(name)),
            // `()` — the totals row's name — is encoded as an empty array.
            serde_json::Value::Array(items) if items.is_empty() => Ok(RowName::Totals),
            other => Err(D::Error::custom(format!(
                "unexpected periodic report row name: {other}"
            ))),
        }
    }
}

/// The name of hledger's synthetic row holding unbudgeted spending.
pub const UNBUDGETED: &str = "<unbudgeted>";

/// How an `EFDay` bounds a date span. `Exact` is the usual case; `Inclusive`
/// appears for user-supplied periods and is only relevant to filtering.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum EFKind {
    #[default]
    Exact,
    Inclusive,
}

/// A span endpoint: a day, tagged `Exact` or `Inclusive`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct EFDay {
    /// The date, as `YYYY-MM-DD`.
    pub date: String,
    pub kind: EFKind,
}

impl EFDay {
    /// The date text, as hledger wrote it.
    pub fn text(&self) -> &str {
        &self.date
    }
}

impl<'de> Deserialize<'de> for EFDay {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        use serde::de::Error as _;

        // hledger emits `{"tag":"Exact","contents":"2024-01-01"}`. A bare date
        // string is accepted too, so a simpler encoder cannot break dates.
        let value = serde_json::Value::deserialize(deserializer)?;
        match value {
            serde_json::Value::String(date) => Ok(EFDay {
                date,
                kind: EFKind::Exact,
            }),
            serde_json::Value::Object(fields) => {
                let date = fields
                    .get("contents")
                    .and_then(serde_json::Value::as_str)
                    .unwrap_or_default()
                    .to_string();
                let kind = match fields.get("tag").and_then(serde_json::Value::as_str) {
                    Some("Inclusive") => EFKind::Inclusive,
                    // Unknown tags are treated as the default rather than
                    // failing a whole report over a date decoration.
                    _ => EFKind::Exact,
                };
                Ok(EFDay { date, kind })
            }
            other => Err(D::Error::custom(format!("unexpected EFDay: {other}"))),
        }
    }
}

/// One report column's date span: `[start|null, end|null]`, end exclusive.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DateSpan {
    pub start: Option<EFDay>,
    pub end: Option<EFDay>,
}

impl<'de> Deserialize<'de> for DateSpan {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        let (start, end) = <(Option<EFDay>, Option<EFDay>)>::deserialize(deserializer)?;
        Ok(DateSpan { start, end })
    }
}

impl DateSpan {
    /// A compact label for the period, e.g. `2024-01` for a month or
    /// `2024-01-08` for a week.
    ///
    /// Monthly and coarser periods start on the first of a month, so the label
    /// is the year and month. Anything else keeps the full start date. A span
    /// that has only an end (an ending-balance report) is labelled by the month
    /// that end closes.
    pub fn label(&self) -> String {
        if let Some(start) = &self.start {
            return month_label(&start.date).unwrap_or_else(|| start.date.clone());
        }
        if let Some(end) = &self.end {
            if let Some(month) = month_label(&end.date) {
                return previous_month(&month);
            }
            return end.date.clone();
        }
        NO_PERIOD.to_string()
    }
}

/// `"YYYY-MM"` when `date` is the first of a month, else `None`.
fn month_label(date: &str) -> Option<String> {
    let mut parts = date.split('-');
    let year = parts.next()?;
    let month = parts.next()?;
    let day = parts.next()?;
    if parts.next().is_some() || year.len() != 4 || month.len() != 2 || day != "01" {
        return None;
    }
    if !year.bytes().all(|b| b.is_ascii_digit()) || !month.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    Some(format!("{year}-{month}"))
}

/// The month before `"YYYY-MM"`, or the input unchanged if it is malformed.
fn previous_month(month: &str) -> String {
    let Some((year, month)) = month.split_once('-') else {
        return month.to_string();
    };
    let (Ok(year), Ok(month)) = (year.parse::<i32>(), month.parse::<u32>()) else {
        return month.to_string();
    };
    if month <= 1 {
        format!("{:04}-12", year - 1)
    } else {
        format!("{year:04}-{:02}", month - 1)
    }
}

/// One row of a [`PeriodicReport`].
#[derive(Clone, Debug, Default, Deserialize)]
pub struct PeriodicReportRow {
    #[serde(default, rename = "prrName")]
    pub name: RowName,
    /// One mixed amount per report column.
    #[serde(default, rename = "prrAmounts")]
    pub amounts: Vec<MixedAmount>,
    /// The row's total across all columns.
    #[serde(default, rename = "prrTotal")]
    pub total: MixedAmount,
    /// The row's column average.
    #[serde(default, rename = "prrAverage")]
    pub average: MixedAmount,
}

impl PeriodicReportRow {
    /// The account name, if this is a data row.
    pub fn account(&self) -> Option<&str> {
        self.name.as_str()
    }
}

/// `balance --monthly` and friends: columns are periods, rows are accounts.
#[derive(Clone, Debug, Default, Deserialize)]
pub struct PeriodicReport {
    #[serde(default, rename = "prDates")]
    pub dates: Vec<DateSpan>,
    #[serde(default, rename = "prRows")]
    pub rows: Vec<PeriodicReportRow>,
    #[serde(default, rename = "prTotals")]
    pub totals: PeriodicReportRow,
}

impl PeriodicReport {
    /// One label per column, e.g. `["2024-01", "2024-02"]`.
    pub fn labels(&self) -> Vec<String> {
        self.dates.iter().map(DateSpan::label).collect()
    }

    /// The data row for `account`, matched on its full name.
    pub fn row(&self, account: &str) -> Option<&PeriodicReportRow> {
        self.rows.iter().find(|row| row.account() == Some(account))
    }

    /// The report's per-column grand totals, as values in one commodity.
    ///
    /// This is what a "balance over time" line chart plots. Columns whose total
    /// has no amount in the chosen commodity contribute zero, so the result is
    /// always one value per column.
    pub fn grand_total_values(&self, commodity: Option<&str>) -> Vec<Decimal> {
        row_values(&self.totals, commodity)
    }

    /// The single overall grand total, as an amount in one commodity.
    pub fn grand_total(&self, commodity: Option<&str>) -> Option<&Amount> {
        pick_amount(&self.totals.total, commodity)
    }
}

/// One subreport of a [`CompoundPeriodicReport`]: a title, the report, and
/// whether it increases the overall total.
#[derive(Clone, Debug)]
pub struct CompoundSubreport {
    pub title: String,
    pub report: PeriodicReport,
    /// Assets normally increase the total; liabilities and equity decrease it.
    pub increases_total: bool,
}

impl<'de> Deserialize<'de> for CompoundSubreport {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        let (title, report, increases_total) =
            <(String, PeriodicReport, bool)>::deserialize(deserializer)?;
        Ok(CompoundSubreport {
            title,
            report,
            increases_total,
        })
    }
}

/// `balancesheet`, `balancesheetequity`, `incomestatement`: several periodic
/// reports plus their combined totals.
///
/// The net assets / net income figure is [`Self::net_total`] — the `cbrTotals`
/// row. There is no "Net:" label in the JSON; that label is text-mode only.
#[derive(Clone, Debug, Default, Deserialize)]
pub struct CompoundPeriodicReport {
    #[serde(default, rename = "cbrTitle")]
    pub title: String,
    #[serde(default, rename = "cbrDates")]
    pub dates: Vec<DateSpan>,
    #[serde(default, rename = "cbrSubreports")]
    pub subreports: Vec<CompoundSubreport>,
    #[serde(default, rename = "cbrTotals")]
    pub totals: PeriodicReportRow,
}

impl CompoundPeriodicReport {
    /// One label per column, e.g. `["2024-01"]`.
    pub fn labels(&self) -> Vec<String> {
        self.dates.iter().map(DateSpan::label).collect()
    }

    /// The subreport with this exact title, e.g. `"Assets"`.
    pub fn subreport(&self, title: &str) -> Option<&CompoundSubreport> {
        self.subreports.iter().find(|sub| sub.title == title)
    }

    /// The combined totals row, whose `prrTotal` is the net assets/income figure.
    pub fn net_total(&self, commodity: Option<&str>) -> Option<&Amount> {
        pick_amount(&self.totals.total, commodity)
    }

    /// The combined per-column totals, as values in one commodity.
    pub fn net_values(&self, commodity: Option<&str>) -> Vec<Decimal> {
        row_values(&self.totals, commodity)
    }
}

/// One cell of a budget report: the actual change and the goal, either of which
/// may be absent.
///
/// hledger's `BudgetCell = (Maybe Change, Maybe BudgetGoal)`, encoded as a
/// two-element array `[actual, goal]`.
#[derive(Clone, Debug, Default)]
pub struct BudgetCell {
    pub actual: Option<MixedAmount>,
    pub goal: Option<MixedAmount>,
}

impl<'de> Deserialize<'de> for BudgetCell {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        let (actual, goal) =
            <(Option<MixedAmount>, Option<MixedAmount>)>::deserialize(deserializer)?;
        Ok(BudgetCell { actual, goal })
    }
}

impl BudgetCell {
    /// The actual amounts, or an empty slice.
    pub fn actual(&self) -> &[Amount] {
        self.actual.as_deref().unwrap_or_default()
    }

    /// The goal amounts, or an empty slice when there is no budget for the cell.
    pub fn goal(&self) -> &[Amount] {
        self.goal.as_deref().unwrap_or_default()
    }

    /// Whether this cell has a budget goal at all.
    pub fn has_goal(&self) -> bool {
        self.goal.is_some()
    }

    /// Actual minus goal, in one commodity, when both sides have an amount.
    ///
    /// Positive means over budget for an expense.
    pub fn variance(&self, commodity: Option<&str>) -> Option<Decimal> {
        let actual = pick_amount(self.actual(), commodity)?.quantity.0;
        let goal = pick_amount(self.goal(), commodity)?.quantity.0;
        Some(actual - goal)
    }
}

/// One row of a [`BudgetReport`]; amounts are `[actual, goal]` cells.
#[derive(Clone, Debug, Default, Deserialize)]
pub struct BudgetReportRow {
    #[serde(default, rename = "prrName")]
    pub name: RowName,
    /// One budget cell per report column.
    #[serde(default, rename = "prrAmounts")]
    pub cells: Vec<BudgetCell>,
    #[serde(default, rename = "prrTotal")]
    pub total: BudgetCell,
    #[serde(default, rename = "prrAverage")]
    pub average: BudgetCell,
}

impl BudgetReportRow {
    /// The account name, if this is not the totals row.
    pub fn account(&self) -> Option<&str> {
        self.name.as_str()
    }

    /// The actual per-column values in one commodity.
    pub fn actual_values(&self, commodity: Option<&str>) -> Vec<Decimal> {
        self.cells
            .iter()
            .map(|cell| pick_amount(cell.actual(), commodity).map_or(Decimal::ZERO, |a| a.quantity.0))
            .collect()
    }

    /// The goal per-column values in one commodity (zero where there is none).
    pub fn goal_values(&self, commodity: Option<&str>) -> Vec<Decimal> {
        self.cells
            .iter()
            .map(|cell| pick_amount(cell.goal(), commodity).map_or(Decimal::ZERO, |a| a.quantity.0))
            .collect()
    }
}

/// `balance --budget [--monthly] -O json`: a periodic report whose cells carry
/// an actual and a budget goal.
#[derive(Clone, Debug, Default, Deserialize)]
pub struct BudgetReport {
    #[serde(default, rename = "prDates")]
    pub dates: Vec<DateSpan>,
    #[serde(default, rename = "prRows")]
    pub rows: Vec<BudgetReportRow>,
    #[serde(default, rename = "prTotals")]
    pub totals: BudgetReportRow,
}

impl BudgetReport {
    /// One label per column.
    pub fn labels(&self) -> Vec<String> {
        self.dates.iter().map(DateSpan::label).collect()
    }

    /// Whether any row or total actually carries a budget goal.
    ///
    /// A journal with no `~ monthly` budget rules still produces a report
    /// (every goal is null), and a panel should say "no budget defined" rather
    /// than show an empty table.
    pub fn has_budget(&self) -> bool {
        self.rows
            .iter()
            .chain(std::iter::once(&self.totals))
            .any(|row| {
                row.cells.iter().any(BudgetCell::has_goal)
                    || row.total.has_goal()
                    || row.average.has_goal()
            })
    }

    /// The data row for `account`, matched on its full name.
    pub fn row(&self, account: &str) -> Option<&BudgetReportRow> {
        self.rows.iter().find(|row| row.account() == Some(account))
    }

    /// hledger's synthetic row for spending without a budget, if present.
    pub fn unbudgeted(&self) -> Option<&BudgetReportRow> {
        self.rows.iter().find(|row| row.name.is_unbudgeted())
    }
}

/// The amount in `commodity`, or the first amount present when no commodity is
/// requested or the requested one is absent from this particular cell.
///
/// This is how a panel picks the value to plot when the user has set a main
/// currency: the requested commodity wins, and a mixed amount without it is
/// treated as zero for that series.
pub fn pick_amount<'a>(amounts: &'a [Amount], commodity: Option<&str>) -> Option<&'a Amount> {
    match commodity {
        Some(wanted) => amounts.iter().find(|amount| amount.commodity == wanted),
        None => amounts.first(),
    }
}

/// A row's per-column values in one commodity, zero where a column has none.
pub fn row_values(row: &PeriodicReportRow, commodity: Option<&str>) -> Vec<Decimal> {
    row.amounts
        .iter()
        .map(|amounts| {
            pick_amount(amounts, commodity).map_or(Decimal::ZERO, |amount| amount.quantity.0)
        })
        .collect()
}

/// Decode the output of a periodic `balance` report.
pub fn parse_periodic_report(json: &str) -> Result<PeriodicReport, JournalError> {
    decode(json)
}

/// Decode the output of `balancesheet`, `balancesheetequity` or `incomestatement`.
pub fn parse_compound_periodic_report(json: &str) -> Result<CompoundPeriodicReport, JournalError> {
    decode(json)
}

/// Decode the output of `balance --budget`.
pub fn parse_budget_report(json: &str) -> Result<BudgetReport, JournalError> {
    decode(json)
}

/// Empty output is an error rather than an empty report, matching the other
/// decoders: a bridge that fails silently must not look like an empty journal.
fn decode<T: serde::de::DeserializeOwned>(json: &str) -> Result<T, JournalError> {
    if json.trim().is_empty() {
        return Err(JournalError::Empty);
    }
    Ok(serde_json::from_str(json)?)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn dollars(text: &str) -> String {
        format!(
            r#"{{"acommodity":"$","aquantity":{{"decimalMantissa":{},"decimalPlaces":2}}}}"#,
            text.parse::<i64>().expect("test literal is a number")
        )
    }

    fn periodic_monthly() -> String {
        format!(
            r#"{{
              "prDates": [
                [{{"tag":"Exact","contents":"2024-01-01"}},{{"tag":"Exact","contents":"2024-02-01"}}],
                [{{"tag":"Exact","contents":"2024-02-01"}},{{"tag":"Exact","contents":"2024-03-01"}}]
              ],
              "prRows": [
                {{"prrName":"assets:bank",
                 "prrAmounts":[[{}],[{}]],
                 "prrTotal":[{}],
                 "prrAverage":[{}]}}
              ],
              "prTotals": {{"prrName":[], "prrAmounts":[[{}],[{}]], "prrTotal":[{}], "prrAverage":[{}]}}
            }}"#,
            dollars("10000"),
            dollars("20000"),
            dollars("30000"),
            dollars("15000"),
            dollars("30000"),
            dollars("40000"),
            dollars("70000"),
            dollars("35000"),
        )
    }

    #[test]
    fn decodes_a_periodic_report_and_its_totals_row() {
        let report = parse_periodic_report(&periodic_monthly()).expect("decode");
        assert_eq!(report.labels(), vec!["2024-01", "2024-02"]);
        assert_eq!(report.rows.len(), 1);
        assert_eq!(report.rows[0].account(), Some("assets:bank"));
        assert!(!report.rows[0].name.is_totals());

        // The grand-totals row's name is the JSON value [], not a string.
        assert!(report.totals.name.is_totals());
        assert_eq!(report.totals.account(), None);
        assert_eq!(report.totals.amounts.len(), 2);

        assert_eq!(
            report.grand_total(Some("$")).unwrap().quantity.0.to_string(),
            "700.00"
        );
        assert_eq!(
            report.grand_total_values(Some("$")),
            vec![
                Decimal::new(30000, 2),
                Decimal::new(40000, 2)
            ]
        );
        assert!(report.row("assets:bank").is_some());
        assert!(report.row("nope").is_none());
    }

    #[test]
    fn monthly_labels_come_from_the_span_start() {
        // Weekly and daily spans are not month-aligned, so they keep their date.
        let weekly = DateSpan {
            start: Some(EFDay {
                date: "2024-01-08".into(),
                kind: EFKind::Exact,
            }),
            end: Some(EFDay {
                date: "2024-01-15".into(),
                kind: EFKind::Exact,
            }),
        };
        assert_eq!(weekly.label(), "2024-01-08");

        // An ending-balance column has only an end, whose month it closes.
        let ending = DateSpan {
            start: None,
            end: Some(EFDay {
                date: "2024-02-01".into(),
                kind: EFKind::Exact,
            }),
        };
        assert_eq!(ending.label(), "2024-01");

        // A fully open span has nothing to label it with.
        assert_eq!(DateSpan { start: None, end: None }.label(), NO_PERIOD);

        // January rolls back a year.
        assert_eq!(previous_month("2024-01"), "2023-12");
        assert_eq!(previous_month("nonsense"), "nonsense");
    }

    #[test]
    fn date_spans_accept_both_efday_encodings() {
        let spans: Vec<DateSpan> = serde_json::from_str(
            r#"[
              [{"tag":"Inclusive","contents":"2024-01-01"}, null],
              ["2024-02-01", null]
            ]"#,
        )
        .expect("decode");
        assert_eq!(spans[0].start.as_ref().unwrap().kind, EFKind::Inclusive);
        assert_eq!(spans[0].start.as_ref().unwrap().text(), "2024-01-01");
        assert!(spans[0].end.is_none());
        // A bare date string is tolerated as an Exact day.
        assert_eq!(spans[1].start.as_ref().unwrap().kind, EFKind::Exact);
    }

    #[test]
    fn decodes_a_compound_periodic_report() {
        let json = format!(
            r#"{{
              "cbrTitle": "Balance Sheet",
              "cbrDates": [
                [{{"tag":"Exact","contents":"2024-01-01"}},{{"tag":"Exact","contents":"2024-02-01"}}]
              ],
              "cbrSubreports": [
                ["Assets", {{
                  "prDates": [[{{"tag":"Exact","contents":"2024-01-01"}},{{"tag":"Exact","contents":"2024-02-01"}}]],
                  "prRows": [{{"prrName":"assets:bank","prrAmounts":[[{}]],"prrTotal":[{}],"prrAverage":[{}]}}],
                  "prTotals": {{"prrName":[],"prrAmounts":[[{}]],"prrTotal":[{}],"prrAverage":[{}]}}
                }}, true],
                ["Liabilities", {{
                  "prDates": [[{{"tag":"Exact","contents":"2024-01-01"}},{{"tag":"Exact","contents":"2024-02-01"}}]],
                  "prRows": [],
                  "prTotals": {{"prrName":[],"prrAmounts":[[]],"prrTotal":[],"prrAverage":[]}}
                }}, false]
              ],
              "cbrTotals": {{"prrName":[],"prrAmounts":[[{}]],"prrTotal":[{}],"prrAverage":[{}]}}
            }}"#,
            dollars("10000"),
            dollars("10000"),
            dollars("10000"),
            dollars("10000"),
            dollars("10000"),
            dollars("10000"),
            dollars("10000"),
            dollars("10000"),
            dollars("10000"),
        );
        let report = parse_compound_periodic_report(&json).expect("decode");
        assert_eq!(report.title, "Balance Sheet");
        assert_eq!(report.labels(), vec!["2024-01"]);
        assert_eq!(report.subreports.len(), 2);
        let assets = report.subreport("Assets").expect("assets subreport");
        assert!(assets.increases_total);
        assert_eq!(assets.report.rows[0].account(), Some("assets:bank"));
        assert!(!report.subreport("Liabilities").unwrap().increases_total);

        // The net figure is cbrTotals, with no "Net:" label anywhere.
        assert!(report.totals.name.is_totals());
        assert_eq!(
            report.net_total(Some("$")).unwrap().quantity.0.to_string(),
            "100.00"
        );
    }

    #[test]
    fn decodes_a_budget_report_with_a_null_goal() {
        let json = format!(
            r#"{{
              "prDates": [
                [{{"tag":"Exact","contents":"2024-01-01"}},{{"tag":"Exact","contents":"2024-02-01"}}]
              ],
              "prRows": [
                {{"prrName":"expenses:food",
                 "prrAmounts":[[[{}],null]],
                 "prrTotal":[[{}],[{}]],
                 "prrAverage":[[{}],[{}]]}},
                {{"prrName":"<unbudgeted>",
                 "prrAmounts":[[[{}],null]],
                 "prrTotal":[[{}],null],
                 "prrAverage":[[],null]}}
              ],
              "prTotals": {{"prrName":[],
                 "prrAmounts":[[[{}],null]],
                 "prrTotal":[[{}],[{}]],
                 "prrAverage":[[],null]}}
            }}"#,
            dollars("12000"),
            dollars("12000"),
            dollars("10000"),
            dollars("12000"),
            dollars("10000"),
            dollars("5000"),
            dollars("5000"),
            dollars("17000"),
            dollars("17000"),
            dollars("10000"),
        );
        let report = parse_budget_report(&json).expect("decode");
        assert_eq!(report.labels(), vec!["2024-01"]);
        assert!(report.has_budget());

        let food = report.row("expenses:food").expect("budgeted row");
        // January has an actual but no goal; the total does have a goal.
        assert!(food.cells[0].goal.is_none());
        assert!(!food.cells[0].has_goal());
        assert_eq!(food.cells[0].actual()[0].quantity.0.to_string(), "120.00");
        assert_eq!(food.total.goal()[0].quantity.0.to_string(), "100.00");
        assert_eq!(
            food.total.variance(Some("$")).unwrap().to_string(),
            "20.00",
            "actual minus goal"
        );
        assert_eq!(food.goal_values(Some("$")), vec![Decimal::ZERO]);
        assert_eq!(food.actual_values(Some("$")), vec![Decimal::new(12000, 2)]);

        // Spending without a budget is reported on its own synthetic row.
        let unbudgeted = report.unbudgeted().expect("unbudgeted row");
        assert!(unbudgeted.name.is_unbudgeted());
        assert!(unbudgeted.average.actual().is_empty());
        assert!(report.totals.name.is_totals());
    }

    #[test]
    fn a_budget_report_without_goals_reports_no_budget() {
        let json = r#"{
          "prDates": [[{"tag":"Exact","contents":"2024-01-01"},{"tag":"Exact","contents":"2024-02-01"}]],
          "prRows": [{"prrName":"expenses:food","prrAmounts":[[[],null]],"prrTotal":[[],null],"prrAverage":[[],null]}],
          "prTotals": {"prrName":[],"prrAmounts":[[[],null]],"prrTotal":[[],null],"prrAverage":[[],null]}
        }"#;
        let report = parse_budget_report(json).expect("decode");
        assert!(!report.has_budget());
        assert!(report.totals.total.variance(Some("$")).is_none());
    }

    #[test]
    fn decodes_an_empty_periodic_report() {
        // A report with no rows is still a valid report, not a decode error.
        let report = parse_periodic_report(
            r#"{"prDates":[],"prRows":[],"prTotals":{"prrName":[],"prrAmounts":[],"prrTotal":[],"prrAverage":[]}}"#,
        )
        .expect("decode");
        assert!(report.rows.is_empty());
        assert!(report.labels().is_empty());
        assert!(report.grand_total(Some("$")).is_none());
    }

    #[test]
    fn empty_or_malformed_output_is_an_error() {
        assert!(matches!(
            parse_periodic_report("  "),
            Err(JournalError::Empty)
        ));
        assert!(matches!(
            parse_budget_report("<html>not json</html>"),
            Err(JournalError::Decode(_))
        ));
        assert!(matches!(
            parse_compound_periodic_report("[1,2]"),
            Err(JournalError::Decode(_))
        ));
    }

    #[test]
    fn row_names_reject_values_that_are_neither_string_nor_empty() {
        assert!(serde_json::from_str::<RowName>(r#""assets""#).is_ok());
        assert_eq!(
            serde_json::from_str::<RowName>("[]").unwrap(),
            RowName::Totals
        );
        assert!(serde_json::from_str::<RowName>(r#"["assets"]"#).is_err());
    }

    #[test]
    fn pick_amount_prefers_the_requested_commodity() {
        let mixed: MixedAmount =
            serde_json::from_str(&format!("[{},{}]", dollars("100"), {
                r#"{"acommodity":"EUR","aquantity":{"decimalMantissa":500,"decimalPlaces":2}}"#
            }))
            .expect("decode");
        assert_eq!(
            pick_amount(&mixed, Some("EUR")).unwrap().commodity,
            "EUR"
        );
        assert_eq!(pick_amount(&mixed, None).unwrap().commodity, "$");
        assert!(pick_amount(&mixed, Some("GBP")).is_none());
    }
}
