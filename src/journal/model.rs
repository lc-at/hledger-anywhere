//! Decoding hledger's JSON reports into the application's model.
//!
//! Two shapes come out of the engine and both are easy to get wrong:
//!
//! * `print -O json` is a bare **array of transactions**.
//! * `balance -O json` is a **two-element array, `[rows, totals]`** — not a flat
//!   list of rows. `fixtures/hledger-balance.json` is the reference for this.
//!
//! Field names keep hledger's `t`/`p`/`a` prefixes in `#[serde(rename)]` but are
//! spelled out in Rust, so call sites read as domain code rather than wire
//! format. Unknown fields are ignored and almost everything has a default: a
//! future hledger may add fields, and that must not break a report. The
//! exceptions are the fields a report is meaningless without — quantities and
//! balance rows — which fail loudly instead of defaulting to zero.

// The consumers of this model are the report panels, which only exist in the
// browser build. A native (`cargo test`) build therefore sees a deliberately
// wider API surface than it uses, which is not dead code — it is the wire format.
#![cfg_attr(not(target_arch = "wasm32"), allow(dead_code))]

use serde::{Deserialize, Deserializer};
use thiserror::Error;

use super::money::Amount;

/// Anything that can go wrong turning engine output into a report.
#[derive(Debug, Error)]
pub enum JournalError {
    #[error("could not decode hledger output: {0}")]
    Decode(#[from] serde_json::Error),
    #[error("hledger produced no output")]
    Empty,
}

/// A tag on a transaction or posting.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Tag {
    pub name: String,
    /// `None` for a bare tag.
    pub value: Option<String>,
}

/// hledger emits tags as `[["name", "value"]]`, but a valueless tag may appear
/// as `["name"]` and some encoders use a bare string. Accept all three rather
/// than failing a whole report over a decoration.
impl<'de> Deserialize<'de> for Tag {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        let value = serde_json::Value::deserialize(deserializer)?;
        Ok(match value {
            serde_json::Value::String(name) => Tag { name, value: None },
            serde_json::Value::Array(items) => {
                let mut items = items.into_iter();
                let name = items
                    .next()
                    .and_then(|item| item.as_str().map(str::to_string))
                    .unwrap_or_default();
                let value = items
                    .next()
                    .and_then(|item| item.as_str().map(str::to_string))
                    .filter(|text| !text.is_empty());
                Tag { name, value }
            }
            _ => Tag::default(),
        })
    }
}

/// One posting within a transaction.
#[derive(Clone, Debug, Deserialize)]
pub struct Posting {
    #[serde(default, rename = "paccount")]
    pub account: String,
    /// hledger emits a list because a posting can carry several commodities.
    #[serde(default, rename = "pamount")]
    pub amounts: Vec<Amount>,
    #[serde(default, rename = "pstatus")]
    pub status: String,
    #[serde(default, rename = "pcomment")]
    pub comment: String,
    #[serde(default, rename = "ptags")]
    pub tags: Vec<Tag>,
}

impl Posting {
    /// All of this posting's amounts as one display string.
    pub fn amounts_display(&self) -> String {
        self.amounts
            .iter()
            .map(Amount::display)
            .collect::<Vec<_>>()
            .join(", ")
    }

    /// A single character marker for this posting's own status.
    ///
    /// A posting can be marked differently from its transaction, and hledger
    /// reports both; showing them separately is what makes a partially-cleared
    /// transaction legible.
    pub fn status_marker(&self) -> &'static str {
        match self.status.as_str() {
            "Cleared" => "*",
            "Pending" => "!",
            _ => "",
        }
    }
}

/// One transaction, as produced by `print -O json`.
#[derive(Clone, Debug, Deserialize)]
pub struct Transaction {
    #[serde(default, rename = "tdate")]
    pub date: String,
    /// The secondary date, for transactions that span a period.
    #[serde(default, rename = "tdate2")]
    pub date2: Option<String>,
    #[serde(default, rename = "tdescription")]
    pub description: String,
    #[serde(default, rename = "tcode")]
    pub code: String,
    /// `"Unmarked"`, `"Pending"` or `"Cleared"`.
    #[serde(default, rename = "tstatus")]
    pub status: String,
    #[serde(default, rename = "tcomment")]
    pub comment: String,
    #[serde(default, rename = "ttags")]
    pub tags: Vec<Tag>,
    #[serde(default, rename = "tpostings")]
    pub postings: Vec<Posting>,
}

impl Transaction {
    /// A single character marker for the transaction's status, as hledger uses
    /// in its own reports.
    pub fn status_marker(&self) -> &'static str {
        match self.status.as_str() {
            "Cleared" => "*",
            "Pending" => "!",
            _ => "",
        }
    }
}

/// One row of a balance report: `[display name, full name, depth, amounts]`.
#[derive(Clone, Debug)]
pub struct BalanceRow {
    /// The name to show, which may be elided by `--drop`/ellipsis options.
    pub display_name: String,
    /// The full account name, which is what a query should target.
    pub full_name: String,
    /// Indentation level in tree mode; always 0 in flat mode.
    pub depth: usize,
    pub amounts: Vec<Amount>,
}

impl<'de> Deserialize<'de> for BalanceRow {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        // A tuple struct is the natural model for a positional JSON array, and
        // gives a precise error if hledger ever changes the row width.
        #[derive(Deserialize)]
        struct Raw(String, String, i64, Vec<Amount>);

        let Raw(display_name, full_name, depth, amounts) = Raw::deserialize(deserializer)?;
        Ok(BalanceRow {
            display_name,
            full_name,
            depth: depth.max(0) as usize,
            amounts,
        })
    }
}

impl BalanceRow {
    /// The row's amounts as one display string, or a dash when it has none.
    pub fn amounts_display(&self) -> String {
        if self.amounts.is_empty() {
            return "—".to_string();
        }
        self.amounts
            .iter()
            .map(Amount::display)
            .collect::<Vec<_>>()
            .join(", ")
    }
}

/// A whole `balance` report: its account rows plus the report totals.
///
/// Two engines can produce this and they do *not* agree on the shape:
///
/// * the real hledger CLI emits `[rows, totals]`, where each row is
///   `[displayName, fullName, depth, amounts]` — see the module docs and
///   `fixtures/hledger-balance.json`;
/// * the interim `hledger-wasm` bridge encodes hledger-lib's
///   `[(Text, MixedAmount)]`, i.e. `[[accountName, amounts], ...]`, with no
///   depth and no report totals.
///
/// Both are decoded here rather than behind a flavor check, because the shape is
/// a property of the output and not of the caller: a panel should not have to
/// know which engine produced the bytes it is showing. The bridge's naive
/// per-account sum yields no report total, so `totals` is legitimately empty
/// there and the UI shows a dash rather than a fabricated number.
#[derive(Clone, Debug, Default)]
pub struct BalanceReport {
    pub rows: Vec<BalanceRow>,
    pub totals: Vec<Amount>,
}

impl<'de> Deserialize<'de> for BalanceReport {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        use serde::de::Error as _;

        /// The canonical shape, as produced by `hledger balance -O json`.
        #[derive(Deserialize)]
        struct Canonical(Vec<BalanceRow>, Vec<Amount>);

        /// The interim bridge's shape: `[account, amounts]` pairs.
        #[derive(Deserialize)]
        struct LegacyRow(String, Vec<Amount>);

        let value = serde_json::Value::deserialize(deserializer)?;

        if let Ok(Canonical(rows, totals)) = serde_json::from_value::<Canonical>(value.clone()) {
            return Ok(BalanceReport { rows, totals });
        }

        if let Ok(legacy) = serde_json::from_value::<Vec<LegacyRow>>(value.clone()) {
            return Ok(BalanceReport {
                rows: legacy
                    .into_iter()
                    .map(|LegacyRow(name, amounts)| BalanceRow {
                        display_name: name.clone(),
                        full_name: name,
                        // The bridge has no concept of report depth; every row
                        // is flat, which is exactly what it computes.
                        depth: 0,
                        amounts,
                    })
                    .collect(),
                totals: Vec::new(),
            });
        }

        Err(D::Error::custom(
            "unrecognised balance report shape: expected [rows, totals] \
             (hledger CLI) or [[account, amounts], ...] (wasm bridge)",
        ))
    }
}

impl BalanceReport {
    pub fn totals_display(&self) -> String {
        if self.totals.is_empty() {
            return "—".to_string();
        }
        self.totals
            .iter()
            .map(Amount::display)
            .collect::<Vec<_>>()
            .join(", ")
    }
}

/// Decode the output of `print -O json`.
pub fn parse_transactions(json: &str) -> Result<Vec<Transaction>, JournalError> {
    if json.trim().is_empty() {
        return Err(JournalError::Empty);
    }
    Ok(serde_json::from_str(json)?)
}

/// Decode the output of `balance -O json`.
pub fn parse_balance(json: &str) -> Result<BalanceReport, JournalError> {
    if json.trim().is_empty() {
        return Err(JournalError::Empty);
    }
    Ok(serde_json::from_str(json)?)
}

/// Decode the one-name-per-line output of `accounts` and friends.
///
/// Blank lines are dropped so the result can be used directly as a list.
pub fn parse_line_list(text: &str) -> Vec<String> {
    text.lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .map(str::to_string)
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Captured from hledger 1.32.3 against `fixtures/demo`. The shapes are the
    /// same in the 1.5x line, and these fixtures are what keeps that true.
    const PRINT: &str = include_str!("../../fixtures/hledger-print.json");
    const BALANCE: &str = include_str!("../../fixtures/hledger-balance.json");
    const BALANCE_TREE: &str = include_str!("../../fixtures/hledger-balance-tree.json");
    const ACCOUNTS: &str = include_str!("../../fixtures/hledger-accounts.txt");

    #[test]
    fn decodes_the_print_fixture() {
        let transactions = parse_transactions(PRINT).expect("print fixture should decode");
        // Five transactions in the demo journal, plus one from the included file.
        assert_eq!(transactions.len(), 6);

        let first = &transactions[0];
        assert_eq!(first.date, "2024-01-01");
        assert_eq!(first.description, "Opening balances");
        assert_eq!(first.status_marker(), "*");

        // The multi-commodity transaction must keep both postings and both
        // commodities, including the amount-less third posting.
        assert_eq!(first.postings.len(), 3);
        assert_eq!(first.postings[0].amounts[0].commodity, "$");
        assert_eq!(first.postings[0].amounts[0].display(), "$1,000.00");
        assert_eq!(first.postings[1].amounts[0].display(), "500.00 EUR");
    }

    #[test]
    fn print_fixture_postings_balance_for_every_commodity() {
        // A cheap correctness check on the decoding: double-entry means each
        // commodity must sum to zero across a transaction's postings. If the
        // mantissa/scale decoding were wrong this would not hold.
        use std::collections::BTreeMap;
        let transactions = parse_transactions(PRINT).expect("decode");
        for transaction in &transactions {
            let mut totals: BTreeMap<&str, rust_decimal::Decimal> = BTreeMap::new();
            for posting in &transaction.postings {
                for amount in &posting.amounts {
                    *totals.entry(amount.commodity.as_str()).or_default() += amount.quantity.0;
                }
            }
            for (commodity, total) in totals {
                assert!(
                    total.is_zero(),
                    "{} does not balance in {commodity}: {total}",
                    transaction.description
                );
            }
        }
    }

    #[test]
    fn decodes_the_balance_fixture_including_totals() {
        let report = parse_balance(BALANCE).expect("balance fixture should decode");
        assert_eq!(report.rows.len(), 8);
        assert!(!report.totals.is_empty(), "totals must not be dropped");

        let checking = report
            .rows
            .iter()
            .find(|row| row.full_name == "assets:bank:checking")
            .expect("checking account present");
        assert_eq!(checking.amounts_display(), "$2,234.75");
    }

    #[test]
    fn balance_rows_carry_tree_depth() {
        let report = parse_balance(BALANCE_TREE).expect("decode");
        let parent = report
            .rows
            .iter()
            .find(|row| row.display_name == "assets:bank")
            .expect("parent row present");
        let child = report
            .rows
            .iter()
            .find(|row| row.display_name == "assets:bank:checking")
            .expect("child row present");
        assert_eq!(parent.depth, 0, "the parent is a top-level account");
        assert_eq!(child.depth, 1, "the child is indented under it");
    }

    #[test]
    fn line_lists_drop_blanks_and_whitespace() {
        let accounts = parse_line_list(ACCOUNTS);
        assert!(accounts.contains(&"assets:bank:checking".to_string()));
        assert!(accounts.iter().all(|line| !line.trim().is_empty()));

        assert!(parse_line_list("").is_empty());
        assert_eq!(parse_line_list("a\n\n  \nb\n"), vec!["a", "b"]);
    }

    #[test]
    fn empty_output_is_an_error_not_an_empty_report() {
        // The interim bridge exits 0 with no output on failure, so this
        // distinction is what stops a broken run looking like an empty journal.
        assert!(matches!(parse_transactions("   "), Err(JournalError::Empty)));
        assert!(matches!(parse_balance(""), Err(JournalError::Empty)));
    }

    #[test]
    fn decodes_the_interim_bridges_balance_shape() {
        // The bridge encodes hledger-lib's `[(Text, MixedAmount)]`: a flat list
        // of `[account, amounts]` pairs, with no depth and no report total.
        let json = r#"[
            ["assets:bank:checking", [{"acommodity":"$","aquantity":{"decimalMantissa":223475,"decimalPlaces":2}}]],
            ["equity:opening", []]
        ]"#;
        let report = parse_balance(json).expect("the bridge shape should decode");
        assert_eq!(report.rows.len(), 2);
        assert_eq!(report.rows[0].full_name, "assets:bank:checking");
        assert_eq!(report.rows[0].display_name, "assets:bank:checking");
        assert_eq!(report.rows[0].depth, 0, "the bridge has no tree depth");
        assert_eq!(report.rows[1].amounts_display(), "—", "an empty row shows a dash");
        assert!(
            report.totals.is_empty(),
            "the bridge computes no report total, so none may be invented"
        );
        assert_eq!(report.totals_display(), "—");
    }

    #[test]
    fn a_flat_list_of_four_element_rows_is_still_rejected() {
        // Canonical rows, but not wrapped in `[rows, totals]`: that is neither
        // supported shape, and half-decoding it would be worse than failing.
        assert!(parse_balance(r#"[[["a","a",0,[]]]]"#).is_err());
    }

    #[test]
    fn malformed_output_reports_a_decode_error() {
        assert!(matches!(
            parse_transactions("<html>not json</html>"),
            Err(JournalError::Decode(_))
        ));
        // A balance report that is a flat list of rows, rather than
        // `[rows, totals]`, must be rejected rather than half-decoded.
        assert!(parse_balance(r#"[[["a","a",0,[]]]]"#).is_err());
    }

    #[test]
    fn tags_accept_both_wire_shapes() {
        let paired: Vec<Tag> = serde_json::from_str(r#"[["receipt","yes"],["bare"]]"#).unwrap();
        assert_eq!(paired[0].name, "receipt");
        assert_eq!(paired[0].value.as_deref(), Some("yes"));
        assert_eq!(paired[1].name, "bare");
        assert_eq!(paired[1].value, None, "an empty value should mean 'no value'");

        let plain: Vec<Tag> = serde_json::from_str(r#"["solo"]"#).unwrap();
        assert_eq!(plain[0].name, "solo");
    }

    #[test]
    fn transactions_tolerate_missing_optional_fields() {
        // A minimal transaction, as an older hledger might emit it.
        let transactions: Vec<Transaction> =
            serde_json::from_str(r#"[{"tdate":"2024-01-01","tdescription":"x"}]"#).unwrap();
        assert_eq!(transactions.len(), 1);
        assert!(transactions[0].postings.is_empty());
        assert_eq!(transactions[0].status_marker(), "", "unmarked by default");
    }
}
