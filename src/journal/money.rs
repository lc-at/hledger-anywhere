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

// Consumers are the wasm-only panels; see the same note in `journal::model`.
#![cfg_attr(not(target_arch = "wasm32"), allow(dead_code))]

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

/// One amount: a commodity plus a quantity and the style to show it in.
#[derive(Clone, Debug, Deserialize)]
pub struct Amount {
    #[serde(default, rename = "acommodity")]
    pub commodity: String,
    #[serde(rename = "aquantity")]
    pub quantity: Quantity,
    #[serde(default, rename = "astyle")]
    pub style: Option<AmountStyle>,
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
    fn grouping_repeats_the_last_size_for_indian_style() {
        assert_eq!(group_digits("12345678", &[3], ","), "12,345,678");
        assert_eq!(group_digits("12345678", &[3, 2], ","), "1,23,45,678");
        assert_eq!(group_digits("123", &[3], ","), "123");
        assert_eq!(group_digits("", &[3], ","), "");
        // A degenerate size of zero falls back to grouping by three rather than
        // looping forever.
        assert_eq!(group_digits("1234", &[0], ","), "1,234");
    }
}
