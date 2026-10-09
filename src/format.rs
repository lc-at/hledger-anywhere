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

/// The most recent date mentioned in a journal, in any of the forms hledger
/// accepts, normalised to `YYYY-MM-DD`.
///
/// Used to explain an empty report: a period-bounded panel that finds nothing
/// looks broken until it can say that the journal's newest entry is from another
/// year. A scan rather than a parse — it only has to be right about the newest
/// date, and the alternative is asking the engine, which would cost a whole
/// journal parse to answer a question about ten characters.
pub fn latest_date(text: &str) -> Option<String> {
    let bytes = text.as_bytes();
    let mut latest: Option<String> = None;
    let mut index = 0;
    while index + 10 <= bytes.len() {
        let window = &bytes[index..index + 10];
        let shaped = window[0..4].iter().all(u8::is_ascii_digit)
            && matches!(window[4], b'-' | b'/' | b'.')
            && window[5..7].iter().all(u8::is_ascii_digit)
            && matches!(window[7], b'-' | b'/' | b'.')
            && window[8..10].iter().all(u8::is_ascii_digit);
        if shaped {
            // Normalised so dates written three different ways still compare:
            // the separators are irrelevant to which date is the newest.
            let normalized = format!(
                "{}-{}-{}",
                &text[index..index + 4],
                &text[index + 5..index + 7],
                &text[index + 8..index + 10]
            );
            if latest.as_deref().is_none_or(|current| normalized.as_str() > current) {
                latest = Some(normalized);
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
    use super::latest_date;

    #[test]
    fn finds_the_newest_date_among_mixed_forms() {
        let text = "2024-01-01 opening\n2026/03/14 bank\n2025.07.02 fx\n";
        assert_eq!(latest_date(text).as_deref(), Some("2026-03-14"));
    }

    #[test]
    fn a_date_shaped_run_of_digits_needs_its_separators() {
        // 20240101 is not a date, and neither is a time or a long number.
        assert_eq!(latest_date("20240101 12345678"), None);
        assert_eq!(latest_date("no dates here"), None);
        assert_eq!(latest_date(""), None);
    }

    #[test]
    fn reads_every_occurrence_not_just_the_first() {
        assert_eq!(
            latest_date("x 1999-12-31 y 2001-01-01 z").as_deref(),
            Some("2001-01-01")
        );
    }

    #[test]
    fn the_newest_date_comes_back_normalised() {
        // Written three ways; the newest wins and is normalised, so a panel can
        // show it and a person can read it.
        assert_eq!(
            latest_date("2024-01-01 a\n2024/03/14 b\n2022.07.02 c\n").as_deref(),
            Some("2024-03-14")
        );
        // Day and month matter, not just the year: this is what tells a reader
        // that their "this month" window is years behind their journal.
        assert_eq!(
            latest_date("2024-12-31\n2024-02-01").as_deref(),
            Some("2024-12-31")
        );
        assert_eq!(latest_date("no dates"), None);
        assert_eq!(latest_date(""), None);
    }
}
