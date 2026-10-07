//! Faithful decoding and display of hledger amounts.
//!
//! hledger's JSON encodes a quantity as `{decimalMantissa, decimalPlaces,
//! floatingPoint}`. The first two are exact; `floatingPoint` is a lossy `f64`
//! convenience value. Money must not travel through a binary float, so the
//! decoder uses the mantissa/scale pair and ignores `floatingPoint` entirely.
//!
//! `aquantity` is an *object* in hledger 1.4x-1.5x, which is easy to miss: code
//! that expects a bare JSON number silently fails to deserialize. The decoder
//! below accepts the object form, a bare number and a string, so an hledger
//! version that changes its mind does not break the app.

// Consumers are the wasm-only panels, plus the tests; see the longer note in
// `journal::model`. The cost/cost-basis fields are part of hledger's amount
// encoding and are decoded even where no panel prints them yet.
#![allow(dead_code)]

use rust_decimal::Decimal;
use serde::{Deserialize, Deserializer};

/// An exact decimal quantity.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Quantity(pub Decimal);

impl<'de> Deserialize<'de> for Quantity {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        use serde::de::Error as _;

        #[derive(Deserialize)]
        #[serde(untagged)]
        enum Raw {
            /// hledger's own encoding: mantissa and scale, no rounding.
            Object {
                #[serde(rename = "decimalMantissa")]
                mantissa: i64,
                #[serde(rename = "decimalPlaces")]
                places: u32,
            },
            /// A bare JSON number, as some encoders emit.
            Number(serde_json::Number),
            /// A decimal string, as a last resort.
            Text(String),
        }

        match Raw::deserialize(deserializer)? {
            Raw::Object { mantissa, places } => {
                // Decimal supports at most 28 fractional digits; beyond that we
                // would rather fail loudly than silently lose precision.
                Decimal::try_from_i128_with_scale(mantissa as i128, places)
                    .map(Quantity)
                    .map_err(|_| D::Error::custom(format!(
                        "quantity scale {places} exceeds the supported range"
                    )))
            }
            Raw::Number(number) => number
                .to_string()
                .parse::<Decimal>()
                .map(Quantity)
                .map_err(D::Error::custom),
            Raw::Text(text) => {
                text.trim().parse::<Decimal>().map(Quantity).map_err(D::Error::custom)
            }
        }
    }
}

/// How hledger renders amounts in one commodity, taken from the journal's style
/// declarations and the commodity's own usage.
#[derive(Clone, Debug, Default, Deserialize)]
pub struct AmountStyle {
    /// `"L"` puts the symbol before the number, `"R"` after it.
    #[serde(default, rename = "ascommodityside")]
    pub commodity_side: String,
    /// Whether a space separates the symbol from the number.
    #[serde(default, rename = "ascommodityspaced")]
    pub commodity_spaced: bool,
    #[serde(default, rename = "asdecimalmark")]
    pub decimal_mark: String,
    /// Number of digits after the decimal mark.
    #[serde(default, rename = "asprecision")]
    pub precision: u32,
    /// Digit grouping as `[separator, [sizes...]]`, or null when ungrouped.
    #[serde(default, rename = "asdigitgroups")]
    pub digit_groups: Option<(String, Vec<usize>)>,
    /// How hledger rounded this amount (`"NoRounding"`, `"HardRounding"`, …).
    ///
    /// Decoded to document the wire format and so a future display can warn when
    /// a figure was rounded; nothing reads it today, which is why it is
    /// explicitly allowed to be unread rather than silently dropped from the
    /// model.
    #[allow(dead_code)]
    #[serde(default, rename = "asrounding")]
    pub rounding: String,
}

/// The transacted cost (or selling price) recorded on an amount, i.e. the `@`
/// or `@@` annotation in the journal.
///
/// hledger encodes this as a tagged object, `{"tag":"UnitCost"|"TotalCost",
/// "contents":<Amount>}`. The variant was called `UnitPrice`/`TotalPrice` and
/// the JSON field `aprice` before hledger 1.33; both spellings are accepted so
/// an older engine still decodes.
#[derive(Clone, Debug, Deserialize)]
#[serde(tag = "tag", content = "contents")]
pub enum AmountCost {
    /// `@`, a cost per unit of the amount.
    #[serde(alias = "UnitPrice")]
    UnitCost(Box<Amount>),
    /// `@@`, a cost for the whole amount.
    #[serde(alias = "TotalPrice")]
    TotalCost(Box<Amount>),
}

impl AmountCost {
    /// The cost amount itself, whichever form it takes.
    pub fn amount(&self) -> &Amount {
        match self {
            AmountCost::UnitCost(amount) | AmountCost::TotalCost(amount) => amount,
        }
    }

    /// Whether this is a per-unit cost (`@`) rather than a total cost (`@@`).
    pub fn is_unit(&self) -> bool {
        matches!(self, AmountCost::UnitCost(_))
    }
}

/// The acquisition cost basis of an investment lot, added to hledger's JSON in
/// 1.52 as `acostbasis`.
///
/// Every field is optional on the wire. `cbDate` is a `Day`, which hledger
/// encodes as the string `"YYYY-MM-DD"`.
#[derive(Clone, Debug, Default, Deserialize)]
pub struct CostBasis {
    /// Nominal acquisition cost, always stored per-unit.
    #[serde(default, rename = "cbCost")]
    pub cost: Option<Box<Amount>>,
    /// Nominal acquisition date, as `YYYY-MM-DD`.
    #[serde(default, rename = "cbDate")]
    pub date: Option<String>,
    /// A short label used to distinguish otherwise identical lots.
    #[serde(default, rename = "cbLabel")]
    pub label: Option<String>,
}

/// One amount: a commodity plus a quantity and the style to show it in.
///
/// In hledger 1.52 the cost fields are `acost` (renamed from `aprice` in 1.33)
/// and `acostbasis` (new in 1.52). Both are decoded tolerantly: absent or `null`
/// means there is no cost, which is the common case.
#[derive(Clone, Debug, Deserialize)]
pub struct Amount {
    #[serde(default, rename = "acommodity")]
    pub commodity: String,
    #[serde(rename = "aquantity")]
    pub quantity: Quantity,
    #[serde(default, rename = "astyle")]
    pub style: Option<AmountStyle>,
    /// Transacted cost/price (`@`/`@@`); `aprice` is the pre-1.33 name.
    #[serde(default, rename = "acost", alias = "aprice")]
    pub cost: Option<AmountCost>,
    /// The cost basis of an investment lot, if any.
    #[serde(default, rename = "acostbasis")]
    pub cost_basis: Option<CostBasis>,
}

impl Amount {
    /// Render the amount the way hledger would: symbol side, spacing, fixed
    /// precision and digit grouping all come from the journal's own style.
    pub fn display(&self) -> String {
        let style = self.style.clone().unwrap_or_default();

        // `rescale` sets the scale as well as rounding, so Display then emits
        // exactly `precision` fractional digits rather than trimming zeros.
        let mut value = self.quantity.0;
        value.rescale(style.precision);

        let text = value.to_string();
        let (sign, digits) = match text.strip_prefix('-') {
            Some(rest) => ("-", rest.to_string()),
            None => ("", text),
        };
        let (integer, fraction) = match digits.split_once('.') {
            Some((i, f)) => (i.to_string(), Some(f.to_string())),
            None => (digits, None),
        };

        let integer = match &style.digit_groups {
            Some((separator, sizes)) if !sizes.is_empty() => {
                group_digits(&integer, sizes, separator)
            }
            _ => integer,
        };

        let decimal_mark = if style.decimal_mark.is_empty() {
            "."
        } else {
            &style.decimal_mark
        };
        let number = match fraction {
            Some(fraction) => format!("{sign}{integer}{decimal_mark}{fraction}"),
            None => format!("{sign}{integer}"),
        };

        let gap = if style.commodity_spaced { " " } else { "" };
        if style.commodity_side == "R" {
            format!("{number}{gap}{}", self.commodity)
        } else {
            format!("{}{gap}{number}", self.commodity)
        }
    }
}

/// Consolidate a mixed amount the way hledger's own reports do.
///
/// hledger's `-O json` emits one entry per contribution, so a single balance row
/// can carry twenty amounts across six commodities — several of them for the
/// *same* commodity. Its text output shows one figure per commodity instead.
/// Joining the raw entries is what produced balances reading
/// `39,516,604.73 IDR, 694,825.00 IDR, 936,388.00 IDR`: three spellings of one
/// number, presented as if they were three numbers.
///
/// Commodities come back alphabetically, which is the order hledger prints them
/// in, so a column does not reshuffle between runs.
pub fn sum_by_commodity(amounts: &[Amount]) -> Vec<Amount> {
    let mut groups: Vec<(String, Decimal, Option<AmountStyle>)> = Vec::new();

    for amount in amounts {
        match groups
            .iter_mut()
            .find(|(commodity, _, _)| *commodity == amount.commodity)
        {
            Some((_, total, style)) => {
                *total += amount.quantity.0;
                // Keep the most precise style seen. Rounding a total to a
                // coarser precision than its own parts would hide real digits.
                if let Some(candidate) = &amount.style {
                    let more_precise = style
                        .as_ref()
                        .is_none_or(|current| candidate.precision > current.precision);
                    if more_precise {
                        *style = Some(candidate.clone());
                    }
                }
            }
            None => groups.push((
                amount.commodity.clone(),
                amount.quantity.0,
                amount.style.clone(),
            )),
        }
    }

    groups.sort_by(|a, b| a.0.cmp(&b.0));
    groups
        .into_iter()
        .map(|(commodity, total, style)| Amount {
            commodity,
            quantity: Quantity(total),
            style,
            // A consolidated figure is a sum, not a transacted amount, so it
            // carries no cost annotation of its own.
            cost: None,
            cost_basis: None,
        })
        .collect()
}

/// A mixed amount as one line of text: consolidated per commodity, like
/// hledger's own reports.
///
/// Commodities that come to nothing are dropped, but a mixed amount that is
/// *entirely* zero keeps one figure so it still reads as `0 IDR` rather than
/// vanishing. An empty mixed amount is the app's long-standing em dash.
pub fn mixed_display(amounts: &[Amount]) -> String {
    if amounts.is_empty() {
        return "—".to_string();
    }

    let mut consolidated = sum_by_commodity(amounts);
    if consolidated.iter().any(|amount| !amount.quantity.0.is_zero()) {
        consolidated.retain(|amount| !amount.quantity.0.is_zero());
    }

    consolidated
        .iter()
        .map(Amount::display)
        .collect::<Vec<_>>()
        .join(", ")
}

/// Insert `separator` every `sizes` digits from the right.
///
/// hledger's grouping is a list of group sizes; the last size repeats, which is
/// what makes Indian-style `[3, 2]` grouping come out right.
fn group_digits(digits: &str, sizes: &[usize], separator: &str) -> String {
    let chars: Vec<char> = digits.chars().collect();
    let last = sizes.last().copied().filter(|s| *s > 0).unwrap_or(3);
    let mut groups: Vec<String> = Vec::new();
    let mut end = chars.len();
    let mut index = 0;
    while end > 0 {
        let size = sizes.get(index).copied().filter(|s| *s > 0).unwrap_or(last);
        let start = end.saturating_sub(size);
        groups.push(chars[start..end].iter().collect());
        end = start;
        index += 1;
    }
    groups.reverse();
    groups.join(separator)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn amount(json: &str) -> Amount {
        serde_json::from_str(json).expect("should decode")
    }

    #[test]
    fn decodes_hledgers_mantissa_and_scale_exactly() {
        // 223475 at 2 places is 2234.75, and it must not be 2234.7500000001.
        let a = amount(
            r#"{"acommodity":"$","aquantity":{"decimalMantissa":223475,"decimalPlaces":2,"floatingPoint":2234.75}}"#,
        );
        assert_eq!(a.quantity.0.to_string(), "2234.75");
        assert_eq!(a.commodity, "$");
    }

    #[test]
    fn ignores_the_lossy_floating_point_field() {
        // A deliberately wrong floatingPoint must not influence the result.
        let a = amount(
            r#"{"acommodity":"$","aquantity":{"decimalMantissa":1,"decimalPlaces":2,"floatingPoint":999}}"#,
        );
        assert_eq!(a.quantity.0.to_string(), "0.01");
    }

    #[test]
    fn accepts_float_and_string_and_missing_style() {
        // Style is optional: an amount without it must still decode.
        let float = amount(r#"{"acommodity":"$","aquantity":1234.5}"#);
        assert_eq!(float.quantity.0.to_string(), "1234.5");
        assert!(float.style.is_none());

        let text = amount(r#"{"acommodity":"€","aquantity":"-42.125"}"#);
        assert_eq!(text.quantity.0.to_string(), "-42.125");
    }

    #[test]
    fn rejects_a_malformed_quantity_instead_of_defaulting_to_zero() {
        // A missing aquantity, or a shape we do not understand, must be an
        // error: silently showing a zero balance is the worst possible outcome.
        assert!(serde_json::from_str::<Amount>(r#"{"acommodity":"$"}"#).is_err());
        assert!(
            serde_json::from_str::<Amount>(r#"{"acommodity":"$","aquantity":{"nope":1}}"#).is_err()
        );
    }

    #[test]
    fn displays_left_symbols_with_grouping_and_fixed_precision() {
        let a = amount(
            r#"{"acommodity":"$","aquantity":{"decimalMantissa":100000,"decimalPlaces":2},
                "astyle":{"ascommodityside":"L","ascommodityspaced":false,"asdecimalmark":".",
                          "asdigitgroups":[",",[3]],"asprecision":2}}"#,
        );
        assert_eq!(a.display(), "$1,000.00");
    }

    #[test]
    fn displays_right_symbols_with_a_space() {
        let a = amount(
            r#"{"acommodity":"EUR","aquantity":{"decimalMantissa":50000,"decimalPlaces":2},
                "astyle":{"ascommodityside":"R","ascommodityspaced":true,"asdecimalmark":".",
                          "asdigitgroups":null,"asprecision":2}}"#,
        );
        assert_eq!(a.display(), "500.00 EUR");
    }

    #[test]
    fn precision_pads_and_rounds_zeros() {
        let mut a = amount(
            r#"{"acommodity":"$","aquantity":{"decimalMantissa":5,"decimalPlaces":0},
                "astyle":{"ascommodityside":"L","ascommodityspaced":false,"asdecimalmark":".",
                          "asdigitgroups":null,"asprecision":2}}"#,
        );
        assert_eq!(a.display(), "$5.00");

        a.quantity = Quantity(Decimal::new(-1234, 2));
        assert_eq!(a.display(), "$-12.34");
    }

    #[test]
    fn displays_a_decimal_comma_style() {
        let a = amount(
            r#"{"acommodity":"€","aquantity":{"decimalMantissa":123456,"decimalPlaces":2},
                "astyle":{"ascommodityside":"R","ascommodityspaced":true,"asdecimalmark":",",
                          "asdigitgroups":[".",[3]],"asprecision":2}}"#,
        );
        assert_eq!(a.display(), "1.234,56 €");
    }

    #[test]
    fn null_and_absent_costs_mean_no_cost() {
        // hledger 1.52 always emits the keys, with null when there is no cost.
        let a = amount(
            r#"{"acommodity":"$","aquantity":{"decimalMantissa":100,"decimalPlaces":2},
                "astyle":null,"acost":null,"acostbasis":null}"#,
        );
        assert!(a.cost.is_none());
        assert!(a.cost_basis.is_none());

        // An older/leaner encoder may omit them entirely.
        let b = amount(r#"{"acommodity":"$","aquantity":{"decimalMantissa":100,"decimalPlaces":2}}"#);
        assert!(b.cost.is_none());
        assert!(b.cost_basis.is_none());
    }

    #[test]
    fn decodes_a_tagged_unit_cost() {
        let a = amount(
            r#"{"acommodity":"EUR","aquantity":{"decimalMantissa":10000,"decimalPlaces":2},
                "acost":{"tag":"UnitCost","contents":{
                    "acommodity":"$","aquantity":{"decimalMantissa":110,"decimalPlaces":2},
                    "astyle":{"ascommodityside":"L","ascommodityspaced":false,"asdecimalmark":".",
                              "asdigitgroups":null,"asprecision":2}}},
                "acostbasis":null}"#,
        );
        let cost = a.cost.as_ref().expect("unit cost should decode");
        assert!(cost.is_unit());
        assert_eq!(cost.amount().commodity, "$");
        assert_eq!(cost.amount().display(), "$1.10");
    }

    #[test]
    fn decodes_a_tagged_total_cost() {
        let a = amount(
            r#"{"acommodity":"EUR","aquantity":{"decimalMantissa":10000,"decimalPlaces":2},
                "acost":{"tag":"TotalCost","contents":{
                    "acommodity":"$","aquantity":{"decimalMantissa":11000,"decimalPlaces":2}}}}"#,
        );
        let cost = a.cost.as_ref().expect("total cost should decode");
        assert!(!cost.is_unit());
        // The quantity is exact even though there is no style to round it to.
        assert_eq!(cost.amount().quantity.0.to_string(), "110.00");
    }

    #[test]
    fn accepts_the_pre_1_33_aprice_name_and_tags() {
        // The captured 1.32 fixture uses `aprice`; the build in progress uses
        // `acost`. Both must decode, and the old UnitPrice tag maps onto the new
        // UnitCost variant.
        let old = amount(
            r#"{"acommodity":"$","aquantity":{"decimalMantissa":223475,"decimalPlaces":2},
                "aprice":null}"#,
        );
        assert!(old.cost.is_none(), "the fixture's null aprice is not a cost");

        let priced = amount(
            r#"{"acommodity":"A","aquantity":{"decimalMantissa":1,"decimalPlaces":0},
                "aprice":{"tag":"UnitPrice","contents":{
                    "acommodity":"$","aquantity":{"decimalMantissa":500,"decimalPlaces":2},
                    "astyle":{"ascommodityside":"L","ascommodityspaced":false,"asdecimalmark":".",
                              "asdigitgroups":null,"asprecision":2}}}}"#,
        );
        let cost = priced.cost.as_ref().expect("aprice should decode");
        assert!(cost.is_unit());
        assert_eq!(cost.amount().display(), "$5.00");
    }

    #[test]
    fn decodes_an_acostbasis_lot() {
        let a = amount(
            r#"{"acommodity":"AAPL","aquantity":{"decimalMantissa":10,"decimalPlaces":0},
                "acostbasis":{"cbCost":{"acommodity":"$","aquantity":{"decimalMantissa":15000,"decimalPlaces":2}},
                              "cbDate":"2024-01-05","cbLabel":"lot-a"}}"#,
        );
        let basis = a.cost_basis.as_ref().expect("cost basis should decode");
        assert_eq!(basis.date.as_deref(), Some("2024-01-05"));
        assert_eq!(basis.label.as_deref(), Some("lot-a"));
        assert_eq!(basis.cost.as_ref().unwrap().quantity.0.to_string(), "150.00");
    }

    #[test]
    fn a_partial_acostbasis_still_decodes() {
        // Only a date, as a matcher-style basis might be written.
        let a = amount(
            r#"{"acommodity":"AAPL","aquantity":{"decimalMantissa":10,"decimalPlaces":0},
                "acostbasis":{"cbDate":"2024-01-05"}}"#,
        );
        let basis = a.cost_basis.as_ref().expect("cost basis should decode");
        assert_eq!(basis.date.as_deref(), Some("2024-01-05"));
        assert!(basis.cost.is_none());
        assert!(basis.label.is_none());
    }

    #[test]
    fn grouping_repeats_the_last_size_for_indian_style() {
        assert_eq!(group_digits("12345678", &[3], ","), "12,345,678");
        assert_eq!(group_digits("12345678", &[3, 2], ","), "1,23,45,678");
        assert_eq!(group_digits("123", &[3], ","), "123");
        assert_eq!(group_digits("", &[3], ","), "");
        // A degenerate size of zero falls back to grouping by three rather than
        // looping forever.
        assert_eq!(group_digits("1234", &[0], ","), "1,234");
    }

    // -- mixed-amount consolidation ----------------------------------------

    /// An amount with an explicit display style, as hledger sends it.
    ///
    /// `IDR 500.00` is written the way the journal writes it: symbol on the
    /// right, spaced from the number, grouped by threes.
    fn styled(commodity: &str, value: &str, precision: u32) -> Amount {
        Amount {
            commodity: commodity.to_string(),
            quantity: Quantity(value.parse().expect("test value is a decimal")),
            style: Some(AmountStyle {
                commodity_side: "R".to_string(),
                commodity_spaced: true,
                precision,
                digit_groups: Some((",".to_string(), vec![3])),
                ..AmountStyle::default()
            }),
            cost: None,
            cost_basis: None,
        }
    }

    #[test]
    fn one_commodity_reported_many_times_collapses_to_one_figure() {
        // The shape a real journal produced: hledger's JSON emits one entry per
        // contribution, all in the same commodity, which read as three separate
        // balances ("39,516,604.73 IDR, 694,825.00 IDR, 936,388.00 IDR").
        let amounts = [
            styled("IDR", "39516604.73", 2),
            styled("IDR", "694825.00", 2),
            styled("IDR", "936388.00", 2),
        ];

        assert_eq!(mixed_display(&amounts), "41,147,817.73 IDR");
        assert_eq!(sum_by_commodity(&amounts).len(), 1);
    }

    #[test]
    fn consolidation_is_per_commodity_and_alphabetical() {
        // Deliberately out of order, and interleaved, so both the grouping and
        // the ordering are actually exercised.
        let amounts = [
            styled("USD", "10.00", 2),
            styled("IDR", "1000.00", 2),
            styled("USD", "5.00", 2),
            styled("EUR", "1.00", 2),
        ];

        assert_eq!(mixed_display(&amounts), "1.00 EUR, 1,000.00 IDR, 15.00 USD");
    }

    #[test]
    fn negation_across_entries_cancels() {
        // Sums must respect sign, or a row that nets to nothing would look like
        // it had a balance.
        let amounts = [styled("IDR", "500.00", 2), styled("IDR", "-500.00", 2)];
        assert_eq!(mixed_display(&amounts), "0.00 IDR");
    }

    #[test]
    fn commodities_that_come_to_nothing_are_dropped() {
        let amounts = [
            styled("IDR", "500.00", 2),
            styled("EUR", "100.00", 2),
            styled("EUR", "-100.00", 2),
        ];

        assert_eq!(
            mixed_display(&amounts),
            "500.00 IDR",
            "a zero commodity is noise next to a real balance"
        );
    }

    #[test]
    fn the_most_precise_style_of_a_group_is_kept() {
        // Taking the first style would round 0.125 BTC away entirely.
        let amounts = [styled("BTC", "0.125", 3), styled("BTC", "1", 0)];
        assert_eq!(mixed_display(&amounts), "1.125 BTC");
    }

    #[test]
    fn an_empty_mixed_amount_is_a_dash() {
        assert_eq!(mixed_display(&[]), "—");
        assert!(sum_by_commodity(&[]).is_empty());
    }

    #[test]
    fn a_consolidated_amount_carries_no_cost_annotation() {
        // A summed figure is not a transacted amount, so an `@` price from one
        // of its parts must not survive onto the total.
        let mut costed = styled("IDR", "100.00", 2);
        costed.cost = Some(AmountCost::UnitCost(Box::new(styled("USD", "0.0001", 4))));
        let consolidated = sum_by_commodity(&[costed, styled("IDR", "100.00", 2)]);

        assert_eq!(consolidated.len(), 1);
        assert!(consolidated[0].cost.is_none());
        assert_eq!(consolidated[0].quantity.0.to_string(), "200.00");
    }
}
