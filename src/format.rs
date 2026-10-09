//! Small pure formatting helpers shared across the UI.
//!
//! Pure so that `cargo test` covers them: the panels that use these are wasm-only,
//! and a `#[cfg(test)]` block inside a wasm-gated module never runs natively —
//! which makes it decoration rather than a test.

// The consumers are the wasm-only panels; see the same note in `journal`.
#![cfg_attr(not(target_arch = "wasm32"), allow(dead_code))]

/// A short, human description of how long ago something was saved.
///
/// Relative rather than absolute on purpose: it answers the question the user
/// actually has — "is this recent?" — without a date library, a locale, or the
/// browser's timezone.
pub fn describe_age(saved_at_ms: f64, now_ms: f64) -> String {
    // Clamped, because a clock that moved backwards (or a value stored by a
    // machine whose clock was ahead) must not read as "in -3 minutes".
    let seconds = ((now_ms - saved_at_ms) / 1000.0).max(0.0);
    if seconds < 90.0 {
        "just now".to_string()
    } else if seconds < 5400.0 {
        format!("{} minutes ago", (seconds / 60.0).round() as i64)
    } else if seconds < 172_800.0 {
        format!("{} hours ago", (seconds / 3600.0).round() as i64)
    } else {
        format!("{} days ago", (seconds / 86_400.0).round() as i64)
    }
}

#[cfg(test)]
mod tests {
    use super::describe_age;

    const MINUTE: f64 = 60_000.0;

    #[test]
    fn ages_read_naturally_at_each_scale() {
        assert_eq!(describe_age(0.0, 5_000.0), "just now");
        assert_eq!(describe_age(0.0, 10.0 * MINUTE), "10 minutes ago");
        assert_eq!(describe_age(0.0, 300.0 * MINUTE), "5 hours ago");
        assert_eq!(describe_age(0.0, 4320.0 * MINUTE), "3 days ago");
    }

    #[test]
    fn a_future_timestamp_does_not_read_as_negative() {
        // Clock skew, or a stored value from a machine whose clock was ahead.
        assert_eq!(describe_age(60_000.0, 0.0), "just now");
    }

    #[test]
    fn the_boundaries_between_units_are_where_they_should_be() {
        // 89s is still "just now"; 91s has crossed into minutes.
        assert_eq!(describe_age(0.0, 89_000.0), "just now");
        assert_eq!(describe_age(0.0, 91_000.0), "2 minutes ago");

        // Just under the 90-minute mark it is still counted in minutes; just
        // over, in hours. The value rounds within its unit, so the figures are
        // approximate on purpose.
        assert_eq!(describe_age(0.0, 5_399_000.0), "90 minutes ago");
        assert_eq!(describe_age(0.0, 5_401_000.0), "2 hours ago");

        // The same just inside and just outside the two-day mark.
        assert_eq!(describe_age(0.0, 172_700_000.0), "48 hours ago");
        assert_eq!(describe_age(0.0, 172_900_000.0), "2 days ago");
    }
}

/// A count with its noun, pluralised when there is more than one.
///
/// Every panel counts something, and each was doing it its own way — "4 payee(s)",
/// "8 account(s)", "4 account row(s)" — which reads like a form letter rather than
/// a report. The nouns here are all regular, so this is the whole rule.
pub fn count_of(count: usize, noun: &str) -> String {
    if count == 1 {
        format!("1 {noun}")
    } else {
        format!("{count} {noun}s")
    }
}

#[cfg(test)]
mod count_tests {
    use super::count_of;

    #[test]
    fn one_is_singular_and_the_rest_are_not() {
        assert_eq!(count_of(0, "payee"), "0 payees");
        assert_eq!(count_of(1, "payee"), "1 payee");
        assert_eq!(count_of(2, "payee"), "2 payees");
        assert_eq!(count_of(1, "posting"), "1 posting");
        assert_eq!(count_of(1500, "transaction"), "1500 transactions");
    }
}

/// The most recent year mentioned as a date in a journal, in any of the forms
/// hledger accepts.
///
/// Used to tell whether a journal's data reaches into the current year, which is
/// what decides whether a date-bounded default window has anything to show. A
/// scan rather than a parse: it only has to be right about the newest year, and
/// the alternative is asking the engine — a whole journal parse to answer a
/// question about four characters.
pub fn latest_year(text: &str) -> Option<i32> {
    let bytes = text.as_bytes();
    let mut latest = None;
    let mut index = 0;
    while index + 10 <= bytes.len() {
        let window = &bytes[index..index + 10];
        let shaped = window[0..4].iter().all(u8::is_ascii_digit)
            && matches!(window[4], b'-' | b'/' | b'.')
            && window[5..7].iter().all(u8::is_ascii_digit)
            && matches!(window[7], b'-' | b'/' | b'.')
            && window[8..10].iter().all(u8::is_ascii_digit);
        if shaped {
            let year = text[index..index + 4].parse::<i32>().ok();
            if let Some(year) = year {
                latest = Some(latest.map_or(year, |current: i32| current.max(year)));
            }
            index += 10;
        } else {
            index += 1;
        }
    }
    latest
}

#[cfg(test)]
mod latest_year_tests {
    use super::latest_year;

    #[test]
    fn finds_the_newest_year_among_mixed_forms() {
        let text = "2024-01-01 opening\n2026/03/14 bank\n2025.07.02 fx\n";
        assert_eq!(latest_year(text), Some(2026));
    }

    #[test]
    fn a_date_shaped_run_of_digits_needs_its_separators() {
        // 20240101 is not a date, and neither is a time or a long number.
        assert_eq!(latest_year("20240101 12345678"), None);
        assert_eq!(latest_year("no dates here"), None);
        assert_eq!(latest_year(""), None);
    }

    #[test]
    fn reads_the_year_from_every_occurrence() {
        assert_eq!(latest_year("x 1999-12-31 y 2001-01-01 z"), Some(2001));
    }
}
