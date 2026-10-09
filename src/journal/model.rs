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
// browser build. Allowing dead code here is deliberate rather than an oversight:
// this module is hledger's *wire format*, and not every part of it has a panel
// yet — the `aregister` decoder, for instance, is exercised only by tests,
// because nothing in the UI displays that report. Keeping it (and `money`'s cost
// and cost-basis fields) means a version change to those shapes is caught by a
// unit test rather than by a user.
#![allow(dead_code)]

use serde::{Deserialize, Deserializer};
use thiserror::Error;

use std::collections::HashMap;

use super::money::{self, Amount};

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
    ///
    /// Consolidated per commodity, because hledger's JSON emits one entry per
    /// contribution rather than one per commodity.
    pub fn amounts_display(&self) -> String {
        money::mixed_display(&self.amounts)
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

/// One row of a balance report.
///
/// hledger-lib models this as `(AccountName, AccountName, Int, MixedAmount)` and
/// documents the fields as: the **full** account name, then the Ledger-style
/// **elided short** name used for display. The wire order is therefore
/// `[full name, display name, depth, amounts]` — see `Hledger.Reports.BalanceReport`.
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

        // Field order follows hledger-lib: full name first, display name second.
        let Raw(full_name, display_name, depth, amounts) = Raw::deserialize(deserializer)?;
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
    ///
    /// Consolidated per commodity: a balance row can carry many raw entries for
    /// one commodity, and showing them all reads as several different numbers.
    pub fn amounts_display(&self) -> String {
        money::mixed_display(&self.amounts)
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
        money::mixed_display(&self.totals)
    }
}

/// One line of `aregister -O json`, a transaction viewed from one account.
///
/// hledger-lib types this as a six-tuple
/// `(Transaction, Transaction, Bool, [AccountName], MixedAmount, MixedAmount)`:
/// the transaction unmodified, the transaction filtered to the report's account,
/// whether it is a split, the other accounts involved, the amount posted to the
/// account, and the running (or historical) balance after it. See
/// `Hledger.Reports.AccountTransactionsReport`.
///
/// The fourth element is an **array of full account names** in 1.52. The interim
/// wasm bridge emitted a pre-joined display string instead, so both are accepted
/// and a joined string becomes a single-element list.
#[derive(Clone, Debug)]
pub struct AccountTransaction {
    /// The transaction, unmodified.
    pub transaction: Transaction,
    /// The transaction as seen from the report's account.
    pub account_transaction: Transaction,
    /// Whether more than one other account is involved.
    pub is_split: bool,
    /// The other accounts, by full name.
    pub other_accounts: Vec<String>,
    /// The amount posted to the reported account(s).
    pub amount: Vec<Amount>,
    /// The register's running or historical balance after this transaction.
    pub balance: Vec<Amount>,
}

/// The fourth `aregister` field: an array of names in 1.52, a joined string in
/// the bridge.
#[derive(Deserialize)]
#[serde(untagged)]
enum OtherAccounts {
    Names(Vec<String>),
    Joined(String),
}

impl From<OtherAccounts> for Vec<String> {
    fn from(raw: OtherAccounts) -> Self {
        match raw {
            OtherAccounts::Names(names) => names,
            OtherAccounts::Joined(joined) => {
                if joined.trim().is_empty() {
                    Vec::new()
                } else {
                    vec![joined]
                }
            }
        }
    }
}

impl<'de> Deserialize<'de> for AccountTransaction {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        #[derive(Deserialize)]
        struct Raw(
            Transaction,
            Transaction,
            bool,
            OtherAccounts,
            Vec<Amount>,
            Vec<Amount>,
        );

        let Raw(
            transaction,
            account_transaction,
            is_split,
            other_accounts,
            amount,
            balance,
        ) = Raw::deserialize(deserializer)?;
        Ok(AccountTransaction {
            transaction,
            account_transaction,
            is_split,
            other_accounts: other_accounts.into(),
            amount,
            balance,
        })
    }
}

impl AccountTransaction {
    /// The amount posted to the account, as one display string.
    pub fn amount_display(&self) -> String {
        display_amounts(&self.amount)
    }

    /// The running balance after this transaction, as one display string.
    pub fn balance_display(&self) -> String {
        display_amounts(&self.balance)
    }
}

/// Render a mixed amount the way hledger's reports do: one figure per
/// commodity, consolidated.
fn display_amounts(amounts: &[Amount]) -> String {
    money::mixed_display(amounts)
}

/// One line of `register -O json`: a posting, and the total after it.
///
/// hledger types this as a five-tuple
/// `(Maybe Day, Maybe Period, Maybe String, Posting, MixedAmount)`. The period is
/// an object whose only content is the interval the row belongs to, which this
/// app derives from the report's own columns instead, so it is decoded and
/// dropped rather than modelled.
#[derive(Clone, Debug)]
pub struct RegisterEntry {
    /// The posting's date, absent only when the engine omitted it.
    pub date: Option<String>,
    /// The transaction description.
    pub description: Option<String>,
    /// The posting itself: account, amount, status, comment and tags.
    pub posting: Posting,
    /// The running total of everything reported so far, after this posting.
    pub total: Vec<Amount>,
}

impl<'de> Deserialize<'de> for RegisterEntry {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        #[derive(Deserialize)]
        struct Raw(
            Option<String>,
            Option<serde_json::Value>,
            Option<String>,
            Posting,
            Vec<Amount>,
        );

        let Raw(date, _period, description, posting, total) = Raw::deserialize(deserializer)?;
        Ok(RegisterEntry {
            date,
            description,
            posting,
            total,
        })
    }
}

impl RegisterEntry {
    /// The amount this posting moved, as one display string.
    pub fn amount_display(&self) -> String {
        self.posting.amounts_display()
    }

    /// The running total after this posting, as one display string.
    pub fn total_display(&self) -> String {
        display_amounts(&self.total)
    }
}

/// Decode `hledger stats`, which is a two-column text table.
///
/// The report has no JSON form, but it needs no parsing beyond the first colon:
/// every line is a label, some padding, and a value. Splitting on the *first*
/// colon rather than the last is what keeps a value containing one — a Windows
/// path, a time — whole.
pub fn parse_stats(text: &str) -> Vec<(String, String)> {
    text.lines()
        .filter_map(|line| {
            let (label, value) = line.split_once(':')?;
            let label = label.trim();
            let value = value.trim();
            if label.is_empty() || value.is_empty() {
                return None;
            }
            Some((label.to_string(), value.to_string()))
        })
        .collect()
}

/// Shorten each account name against its nearest ancestor in the same list.
///
/// `hledger accounts` prints full names in sorted order, so a list of them reads
/// as a wall of repeated prefixes: `assets`, `assets:bank`, `assets:bank:x`.
/// Showing only the part below the ancestor — with the caller's indentation doing
/// the rest — turns the same data into a tree. Names with no ancestor in the list
/// are returned whole.
pub fn tree_display_names<'a, I>(accounts: I) -> Vec<String>
where
    I: IntoIterator<Item = &'a str>,
{
    let names: Vec<&str> = accounts.into_iter().collect();
    names
        .iter()
        .enumerate()
        .map(|(index, name)| {
            // The nearest earlier account that is an ancestor of this one, so a
            // name is shown against the most specific parent available rather
            // than the first one.
            let parent = names[..index]
                .iter()
                .filter(|candidate| {
                    name.len() > candidate.len() + 1
                        && name.starts_with(**candidate)
                        && name.as_bytes()[candidate.len()] == b':'
                })
                .max_by_key(|candidate| candidate.len());
            match parent {
                Some(parent) => name[parent.len() + 1..].to_string(),
                None => (*name).to_string(),
            }
        })
        .collect()
}

/// One name from a pivoted register, and everything posted to it.
#[derive(Clone, Debug)]
pub struct PayeeTotal {
    /// The pivot value: a payee, once `--pivot payee` has been used.
    pub payee: String,
    /// What was posted to it, one figure per commodity.
    pub amounts: Vec<Amount>,
    /// How many postings it took.
    pub postings: usize,
}

impl PayeeTotal {
    /// The summed amounts as one display string.
    pub fn amounts_display(&self) -> String {
        display_amounts(&self.amounts)
    }
}

/// Sum a register's postings by the account they name.
///
/// After `--pivot payee` a posting's account *is* the payee, so this is what
/// turns a register into a per-payee breakdown. It is the only way to get one:
/// `balance --pivot payee` returns an empty report in this engine, while
/// `register --pivot payee` works — so the grouping has to happen here rather
/// than in the engine.
///
/// Names come back in the order they first appear, so the result is stable and
/// the caller decides how to rank them. A posting with no payee is grouped under
/// "(no payee)" rather than dropped: it is still spending.
pub fn total_by_payee(entries: &[RegisterEntry]) -> Vec<PayeeTotal> {
    let mut order: Vec<String> = Vec::new();
    let mut grouped: HashMap<String, (Vec<Amount>, usize)> = HashMap::new();

    for entry in entries {
        let name = entry.posting.account.trim();
        let name = if name.is_empty() { "(no payee)" } else { name };
        let slot = grouped.entry(name.to_string()).or_insert_with(|| {
            order.push(name.to_string());
            (Vec::new(), 0)
        });
        slot.0.extend(entry.posting.amounts.iter().cloned());
        slot.1 += 1;
    }

    order
        .into_iter()
        .filter_map(|payee| {
            let (amounts, postings) = grouped.remove(&payee)?;
            Some(PayeeTotal {
                payee,
                amounts: money::sum_by_commodity(&amounts),
                postings,
            })
        })
        .collect()
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

/// Decode the output of `aregister -O json`.
pub fn parse_aregister(json: &str) -> Result<Vec<AccountTransaction>, JournalError> {
    if json.trim().is_empty() {
        return Err(JournalError::Empty);
    }
    Ok(serde_json::from_str(json)?)
}

/// Decode the output of `register -O json`.
pub fn parse_register(json: &str) -> Result<Vec<RegisterEntry>, JournalError> {
    if json.trim().is_empty() {
        return Err(JournalError::Empty);
    }
    Ok(serde_json::from_str(json)?)
}

/// Decode the one-name-per-line output of `accounts` and friends.
///
/// Blank lines are dropped so the result can be used directly as a list.
///
/// These list commands — `accounts`, `commodities`, `payees`, `tags`,
/// `descriptions`, `prices` — are **text-only** in hledger: they reject
/// `-O json`, so there is deliberately no JSON decoder for them. `prices` is
/// tabular (one price per line, columns separated by whitespace) but still
/// plain text, and callers that need the columns split the line themselves.
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
            .find(|row| row.full_name == "assets:bank")
            .expect("parent row present");
        let child = report
            .rows
            .iter()
            .find(|row| row.full_name == "assets:bank:checking")
            .expect("child row present");
        assert_eq!(parent.depth, 0, "the parent is a top-level account");
        assert_eq!(child.depth, 1, "the child is indented under it");
        // The second field is the elided Ledger-style short name.
        assert_eq!(parent.display_name, "assets:bank");
        assert_eq!(child.display_name, "checking");
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
    fn balance_rows_keep_full_and_display_names_apart() {
        // hledger-lib's row is (full name, elided display name, depth, amounts).
        // The demo journal happens not to elide anything, so a hand-written row
        // is the only way to pin the field order down.
        let report = parse_balance(
            r#"[ [ ["assets:bank:checking", "checking", 2, []] ], [] ]"#,
        )
        .expect("decode");
        assert_eq!(report.rows[0].full_name, "assets:bank:checking");
        assert_eq!(report.rows[0].display_name, "checking");
        assert_eq!(report.rows[0].depth, 2);
    }

    #[test]
    fn decodes_aregister_with_an_array_of_other_accounts() {
        // 1.52 emits the other accounts as [AccountName].
        let json = r#"[
          [
            {"tdate":"2024-01-05","tdescription":"Groceries"},
            {"tdate":"2024-01-05","tdescription":"Groceries"},
            true,
            ["expenses:food","assets:cash"],
            [{"acommodity":"$","aquantity":{"decimalMantissa":4500,"decimalPlaces":2},
              "astyle":{"ascommodityside":"L","ascommodityspaced":false,"asdecimalmark":".",
                        "asdigitgroups":[",",[3]],"asprecision":2}}],
            [{"acommodity":"$","aquantity":{"decimalMantissa":95500,"decimalPlaces":2},
              "astyle":{"ascommodityside":"L","ascommodityspaced":false,"asdecimalmark":".",
                        "asdigitgroups":[",",[3]],"asprecision":2}}]
          ],
          [
            {"tdate":"2024-01-03","tdescription":"Salary"},
            {"tdate":"2024-01-03","tdescription":"Salary"},
            false,
            ["income:salary"],
            [{"acommodity":"$","aquantity":{"decimalMantissa":100000,"decimalPlaces":2}}],
            [{"acommodity":"$","aquantity":{"decimalMantissa":90500,"decimalPlaces":2}}]
          ]
        ]"#;
        let items = parse_aregister(json).expect("aregister should decode");
        assert_eq!(items.len(), 2);
        assert!(items[0].is_split);
        assert_eq!(
            items[0].other_accounts,
            vec!["expenses:food".to_string(), "assets:cash".to_string()]
        );
        assert_eq!(items[0].transaction.description, "Groceries");
        assert_eq!(items[0].amount_display(), "$45.00");
        assert_eq!(items[0].balance_display(), "$955.00");
        assert!(!items[1].is_split);
        assert_eq!(items[1].other_accounts, vec!["income:salary".to_string()]);
    }

    #[test]
    fn decodes_a_register_with_running_totals() {
        // The five-tuple is (date, period, description, posting, running total).
        // The period is null here, which is the normal case for a plain register.
        let json = r#"[
          ["2024-01-01", null, "Opening",
           {"paccount":"assets:bank","pamount":[
             {"acommodity":"$","aquantity":{"decimalMantissa":100000,"decimalPlaces":2},
              "astyle":{"ascommodityside":"L","ascommodityspaced":false,"asdecimalmark":".",
                        "asdigitgroups":[",",[3]],"asprecision":2}}],
            "pstatus":"Unmarked","pcomment":"","ptags":[],"ptype":"RegularPosting"},
           [{"acommodity":"$","aquantity":{"decimalMantissa":100000,"decimalPlaces":2},
             "astyle":{"ascommodityside":"L","ascommodityspaced":false,"asdecimalmark":".",
                       "asdigitgroups":[",",[3]],"asprecision":2}}]],
          ["2024-01-05", null, "Groceries",
           {"paccount":"assets:bank","pamount":[
             {"acommodity":"$","aquantity":{"decimalMantissa":-4500,"decimalPlaces":2},
              "astyle":{"ascommodityside":"L","ascommodityspaced":false,"asdecimalmark":".",
                        "asdigitgroups":[",",[3]],"asprecision":2}}],
            "pstatus":"Unmarked","pcomment":"","ptags":[],"ptype":"RegularPosting"},
           [{"acommodity":"$","aquantity":{"decimalMantissa":95500,"decimalPlaces":2},
             "astyle":{"ascommodityside":"L","ascommodityspaced":false,"asdecimalmark":".",
                       "asdigitgroups":[",",[3]],"asprecision":2}}]]
        ]"#;

        let rows = parse_register(json).expect("register should decode");
        assert_eq!(rows.len(), 2);

        assert_eq!(rows[0].date.as_deref(), Some("2024-01-01"));
        assert_eq!(rows[0].description.as_deref(), Some("Opening"));
        assert_eq!(rows[0].posting.account, "assets:bank");
        assert_eq!(rows[0].amount_display(), "$1,000.00");
        assert_eq!(rows[0].total_display(), "$1,000.00");

        // The second row's total is the running figure, not its own amount.
        //
        // The sign sits *after* a left-hand symbol — `$-45.00`, not `-$45.00` —
        // because that is what hledger itself prints (`$-1,000.00`) for a
        // symbol-side style, while a right-hand symbol keeps the sign in front
        // of the number (`-500.00 EUR`). The two conventions are hledger's.
        assert_eq!(rows[1].amount_display(), "$-45.00");
        assert_eq!(rows[1].total_display(), "$955.00");
    }

    #[test]
    fn register_tolerates_a_null_date_and_a_period_object() {
        // Rows can carry a period object (a `register --monthly` column) instead
        // of a null, and it must not stop the row decoding.
        let json = r#"[
          [null, {"contents":["2024-01-01","2024-01-08"]}, null,
           {"paccount":"a","pamount":[],"pcomment":"","ptags":[]},
           []]
        ]"#;
        let rows = parse_register(json).expect("register should decode");
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].date, None);
        assert_eq!(rows[0].description, None);
        assert_eq!(rows[0].total_display(), "—");
    }

    #[test]
    fn aregister_tolerates_the_bridges_joined_account_string() {
        // The interim bridge pre-joined the other accounts into one string.
        let json = r#"[
          [
            {"tdate":"2024-01-05","tdescription":"x"},
            {"tdate":"2024-01-05","tdescription":"x"},
            false,
            "expenses:food, assets:cash",
            [],
            []
          ]
        ]"#;
        let items = parse_aregister(json).expect("the bridge shape should decode");
        assert_eq!(
            items[0].other_accounts,
            vec!["expenses:food, assets:cash".to_string()]
        );
        assert_eq!(items[0].amount_display(), "—");
    }

    #[test]
    fn aregister_rejects_output_that_is_not_json() {
        assert!(matches!(parse_aregister(""), Err(JournalError::Empty)));
        assert!(matches!(
            parse_aregister("<html>not json</html>"),
            Err(JournalError::Decode(_))
        ));
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

    #[test]
    fn stats_lines_split_on_the_first_colon_only() {
        let text = "Main file           : .../hledger.journal\n\
                    Txns                : 6 (0.1 per day)\n\
                    \n\
                    not a stats line\n\
                    Runtime stats       : 0.11 s elapsed, 54 txns/s\n";
        let rows = parse_stats(text);
        assert_eq!(
            rows,
            vec![
                ("Main file".to_string(), ".../hledger.journal".to_string()),
                ("Txns".to_string(), "6 (0.1 per day)".to_string()),
                ("Runtime stats".to_string(), "0.11 s elapsed, 54 txns/s".to_string()),
            ]
        );
    }

    #[test]
    fn a_value_may_contain_a_colon() {
        assert_eq!(
            parse_stats("Last txn            : 2024-04-02 12:30"),
            vec![("Last txn".to_string(), "2024-04-02 12:30".to_string())]
        );
    }

    #[test]
    fn account_names_are_shortened_against_their_nearest_ancestor() {
        let names = [
            "assets",
            "assets:bank",
            "assets:bank:checking",
            "assets:bank:savings",
            "expenses:food",
            "income",
        ];
        assert_eq!(
            tree_display_names(names),
            vec!["assets", "bank", "checking", "savings", "expenses:food", "income"]
        );
    }

    #[test]
    fn a_parent_needs_the_separator_after_the_prefix() {
        // "a:banking" merely starts with "a:b"; it is not a child of it. The
        // character after a prefix has to be the separator, or a name gets
        // shortened against something that only looks like its parent.
        assert_eq!(tree_display_names(["a:b", "a:banking"]), vec!["a:b", "a:banking"]);
        // It is a child of "a", though, which is what it is shortened against.
        assert_eq!(tree_display_names(["a", "a:banking"]), vec!["a", "banking"]);
    }

    #[test]
    fn shortening_finds_the_most_specific_parent_and_ignores_order() {
        assert_eq!(
            tree_display_names(["a", "a:b", "a:b:c"]),
            vec!["a", "b", "c"]
        );
        // A name whose parent comes later in the list is left whole: the list is
        // sorted, so a parent is always behind its children.
        assert_eq!(tree_display_names(["a:b:c", "a:b"]), vec!["a:b:c", "a:b"]);
    }

    #[test]
    fn a_pivoted_register_totals_by_payee() {
        // After `--pivot payee` a posting's account *is* the payee, so grouping
        // by account is grouping by payee.
        let json = r#"[
          ["2024-01-01", null, "a",
           {"paccount":"Grocery Store","pamount":[
             {"acommodity":"$","aquantity":{"decimalMantissa":4000,"decimalPlaces":2}}],
            "pcomment":"","ptags":[]}, []],
          ["2024-01-02", null, "b",
           {"paccount":"Grocery Store","pamount":[
             {"acommodity":"$","aquantity":{"decimalMantissa":1500,"decimalPlaces":2}}],
            "pcomment":"","ptags":[]}, []],
          ["2024-01-03", null, "c",
           {"paccount":"Shell","pamount":[
             {"acommodity":"$","aquantity":{"decimalMantissa":6000,"decimalPlaces":2}}],
            "pcomment":"","ptags":[]}, []]
        ]"#;
        let entries = parse_register(json).expect("register should decode");
        let totals = total_by_payee(&entries);

        assert_eq!(totals.len(), 2, "two payees");
        // First-appearance order, so the caller decides how to rank them.
        assert_eq!(totals[0].payee, "Grocery Store");
        assert_eq!(totals[0].postings, 2);
        // 40 + 15. The fixtures carry no `astyle`, which is where decimal
        // places come from, so the sum is formatted with none.
        assert_eq!(totals[0].amounts_display(), "$55");
        assert_eq!(totals[1].payee, "Shell");
        assert_eq!(totals[1].postings, 1);
        assert_eq!(totals[1].amounts_display(), "$60");
    }

    #[test]
    fn payee_totals_keep_commodities_apart_and_name_the_nameless() {
        let json = r#"[
          ["2024-01-01", null, null,
           {"paccount":"","pamount":[
             {"acommodity":"IDR","aquantity":{"decimalMantissa":1000,"decimalPlaces":0}}],
            "pcomment":"","ptags":[]}, []],
          ["2024-01-02", null, null,
           {"paccount":"   ","pamount":[
             {"acommodity":"EUR","aquantity":{"decimalMantissa":500,"decimalPlaces":2}}],
            "pcomment":"","ptags":[]}, []]
        ]"#;
        let entries = parse_register(json).expect("register should decode");
        let totals = total_by_payee(&entries);

        // A posting with no payee is still spending, so it is named rather than
        // dropped, and whitespace-only names count as nameless.
        assert_eq!(totals.len(), 1);
        assert_eq!(totals[0].payee, "(no payee)");
        assert_eq!(totals[0].postings, 2);
        assert_eq!(totals[0].amounts.len(), 2, "two commodities, not one sum");
    }
}
