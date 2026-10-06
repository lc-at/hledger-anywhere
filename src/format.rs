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
