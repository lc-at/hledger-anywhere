//! Pure chart maths: axis ranges, "nice" ticks and value-to-pixel scales.
//!
//! Everything here is exact-decimal logic with no browser dependency, so it is
//! compiled and unit-tested natively (see the module layout note in
//! `src/main.rs`).
//!
//! The one inviolable rule: **money never goes through a float to become
//! text.** Ticks are rounded and labelled as [`Decimal`]s, because the app
//! elsewhere displays amounts through [`Amount::display`], which honours the
//! journal's own commodity style ([`Amount::display`]: crate::journal::money).
//! `f64` appears only where the result is a pixel coordinate, where the
//! precision of the screen is all that matters.

// Consumers are the wasm-only chart views, plus the tests. On the host nothing
// uses it at all, and a couple of the helpers are part of a coherent axis API
// rather than something the current charts call, so the allowance is deliberate.
#![allow(dead_code)]
use rust_decimal::Decimal;

/// A closed interval of exact decimal values, normalised so `min <= max`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Range {
    pub min: Decimal,
    pub max: Decimal,
}

impl Range {
    /// The interval between two values, in either order.
    pub fn new(a: Decimal, b: Decimal) -> Self {
        if a <= b {
            Self { min: a, max: b }
        } else {
            Self { min: b, max: a }
        }
    }

    /// The degenerate interval `[0, 0]`.
    pub fn zero() -> Self {
        Self {
            min: Decimal::ZERO,
            max: Decimal::ZERO,
        }
    }

    /// `max - min`, never negative.
    pub fn span(&self) -> Decimal {
        self.max - self.min
    }

    /// Whether the interval contains a single value.
    pub fn is_zero(&self) -> bool {
        self.min == self.max
    }

    /// Whether `value` lies inside the interval (inclusive).
    pub fn contains(&self, value: Decimal) -> bool {
        value >= self.min && value <= self.max
    }
}

impl Default for Range {
    fn default() -> Self {
        Self::zero()
    }
}

/// The smallest and largest value in `values`, or `None` when it is empty.
pub fn extent(values: &[Decimal]) -> Option<Range> {
    let mut iter = values.iter().copied();
    let first = iter.next()?;
    let mut range = Range {
        min: first,
        max: first,
    };
    for value in iter {
        if value < range.min {
            range.min = value;
        }
        if value > range.max {
            range.max = value;
        }
    }
    Some(range)
}

/// Round an approximate step up to the nearest "nice" number: 1, 2 or 5 times a
/// power of ten.
///
/// A non-positive input — which is what a zero-span data range produces — falls
/// back to `1`, so the caller always gets a usable step.
pub fn nice_step(raw: Decimal) -> Decimal {
    if raw <= Decimal::ZERO {
        return Decimal::ONE;
    }

    // Find the power of ten `p` with `p <= raw < p * 10` without ever touching a
    // float. The guard cannot be hit for representable decimals (28 digits) but
    // keeps a pathological input from spinning forever.
    let mut power = Decimal::ONE;
    let mut guard = 0;
    if raw >= Decimal::ONE {
        while power * Decimal::TEN <= raw && guard < 40 {
            power *= Decimal::TEN;
            guard += 1;
        }
    } else {
        while power > raw && guard < 40 {
            power /= Decimal::TEN;
            guard += 1;
        }
    }

    let fraction = raw / power;
    let nice = if fraction <= Decimal::ONE {
        Decimal::ONE
    } else if fraction <= Decimal::from(2u64) {
        Decimal::from(2u64)
    } else if fraction <= Decimal::from(5u64) {
        Decimal::from(5u64)
    } else {
        Decimal::TEN
    };
    nice * power
}

/// The round tick values between `start` and `end`, inclusive, stepping by
/// `step`.
///
/// Callers normally get ticks via [`y_axis`]; this is public so a panel can
/// build a second axis in the same round units. A non-positive step yields no
/// ticks rather than looping forever.
pub fn nice_ticks(start: Decimal, end: Decimal, step: Decimal) -> Vec<Decimal> {
    let mut ticks = Vec::new();
    if step <= Decimal::ZERO {
        return ticks;
    }
    let range = Range::new(start, end);
    let mut tick = range.min;
    // A sane step produces a handful of ticks; the guard bounds a corrupt range.
    while tick <= range.max && ticks.len() < 1024 {
        ticks.push(tick);
        tick += step;
    }
    ticks
}

/// An axis: the padded value range plus the round tick values inside it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Axis {
    pub range: Range,
    pub ticks: Vec<Decimal>,
}

impl Axis {
    /// A unit axis, used when there is nothing to chart.
    pub fn empty() -> Self {
        Self {
            range: Range::new(Decimal::ZERO, Decimal::ONE),
            ticks: vec![Decimal::ZERO, Decimal::ONE],
        }
    }
}

/// Build a nice y-axis for `values`.
///
/// The axis always includes zero, so a chart of a balance or a net figure has an
/// honest baseline and negative values read naturally. Degenerate inputs are
/// handled rather than special-cased by the caller:
///
/// * empty — a unit axis (the views do not draw a chart for empty data anyway);
/// * all values equal (including all zero) — expanded to a unit step;
/// * a single point — zero plus that point.
///
/// `target_ticks` is approximate: the result is the round-tick sequence that
/// covers the data, typically 2-6 entries.
pub fn y_axis(values: &[Decimal], target_ticks: usize) -> Axis {
    let Some(data) = extent(values) else {
        return Axis::empty();
    };

    // Zero is part of every financial axis.
    let low = data.min.min(Decimal::ZERO);
    let high = data.max.max(Decimal::ZERO);
    let span = high - low;
    let target = Decimal::from(target_ticks.max(1) as u64);
    let step = if span.is_zero() {
        Decimal::ONE
    } else {
        nice_step(span / target)
    };

    let nice_min = (low / step).floor() * step;
    let mut nice_max = (high / step).ceil() * step;
    if nice_max <= nice_min {
        nice_max = nice_min + step;
    }

    Axis {
        range: Range::new(nice_min, nice_max),
        ticks: nice_ticks(nice_min, nice_max, step),
    }
}

/// A linear map from a data range onto pixel positions.
///
/// The pixel range may be given in either order: the y axis passes
/// `(bottom, top)` so that larger values land higher on screen.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct LinearScale {
    data: Range,
    pixel_min: f64,
    pixel_max: f64,
}

impl LinearScale {
    pub fn new(data: Range, pixel_min: f64, pixel_max: f64) -> Self {
        Self {
            data,
            pixel_min,
            pixel_max,
        }
    }

    /// Map a value to a pixel coordinate. Values outside `data` are not clamped;
    /// the axis is always padded to contain the data.
    pub fn position(&self, value: Decimal) -> f64 {
        let span = (self.data.max - self.data.min).as_f64();
        if span == 0.0 {
            return (self.pixel_min + self.pixel_max) / 2.0;
        }
        let offset = (value - self.data.min).as_f64();
        self.pixel_min + offset / span * (self.pixel_max - self.pixel_min)
    }
}

/// How long a bar should be, as a fraction of the longest bar.
///
/// Uses the absolute value so a negative figure is drawn with the same length as
/// its magnitude; the sign belongs in the label and tooltip. The result is
/// clamped to `0..=1`, and a non-positive maximum yields zero.
pub fn magnitude_fraction(value: Decimal, max_magnitude: Decimal) -> f64 {
    if max_magnitude <= Decimal::ZERO {
        return 0.0;
    }
    let magnitude = value.abs().as_f64();
    let maximum = max_magnitude.as_f64();
    if maximum <= 0.0 {
        return 0.0;
    }
    (magnitude / maximum).clamp(0.0, 1.0)
}

/// Render an exact decimal for an axis label.
///
/// Trailing zeros are dropped (`500.00` becomes `500`) but no float is involved,
/// so no digit is ever invented or lost. Scientific notation is not used at any
/// magnitude, which matters because axis labels are read literally.
pub fn format_tick(value: Decimal) -> String {
    if value.is_zero() {
        return "0".to_string();
    }
    value.normalize().to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn dec(mantissa: i64, scale: u32) -> Decimal {
        Decimal::new(mantissa, scale)
    }

    fn close(a: f64, b: f64) -> bool {
        (a - b).abs() < 1e-9
    }

    #[test]
    fn nice_step_snaps_to_one_two_or_five() {
        assert_eq!(nice_step(Decimal::from(1u64)), Decimal::ONE);
        assert_eq!(nice_step(Decimal::from(2u64)), Decimal::from(2u64));
        assert_eq!(nice_step(Decimal::from(3u64)), Decimal::from(5u64));
        assert_eq!(nice_step(Decimal::from(250u64)), Decimal::from(500u64));
        assert_eq!(nice_step(Decimal::from(125u64)), Decimal::from(200u64));
        assert_eq!(nice_step(dec(3, 2)), dec(5, 2));
        // An already-nice step is returned unchanged, and just above one snaps up.
        assert_eq!(nice_step(dec(1, 1)), dec(1, 1));
        assert_eq!(nice_step(dec(15, 2)), dec(2, 1));
        // A zero or negative raw step cannot produce a zero step.
        assert_eq!(nice_step(Decimal::ZERO), Decimal::ONE);
        assert_eq!(nice_step(Decimal::from(-5i64)), Decimal::ONE);
    }

    #[test]
    fn nice_ticks_steps_inclusively_and_rejects_a_zero_step() {
        assert_eq!(
            nice_ticks(Decimal::ZERO, Decimal::from(10u64), Decimal::from(5u64)),
            vec![Decimal::ZERO, Decimal::from(5u64), Decimal::from(10u64)]
        );
        assert!(nice_ticks(Decimal::ZERO, Decimal::ONE, Decimal::ZERO).is_empty());
    }

    #[test]
    fn format_tick_drops_trailing_zeros_without_a_float() {        assert_eq!(format_tick(Decimal::ZERO), "0");
        assert_eq!(format_tick(dec(-0, 2)), "0");
        assert_eq!(format_tick(dec(50000, 2)), "500");
        assert_eq!(format_tick(dec(12345, 2)), "123.45");
        assert_eq!(format_tick(Decimal::from(-2000i64)), "-2000");
    }

    #[test]
    fn extent_handles_empty_and_single_values() {
        assert_eq!(extent(&[]), None);
        assert_eq!(
            extent(&[Decimal::from(7u64)]),
            Some(Range::new(Decimal::from(7u64), Decimal::from(7u64)))
        );
        assert_eq!(
            extent(&[dec(3, 1), dec(-15, 1), dec(12, 1)]),
            Some(Range::new(dec(-15, 1), dec(12, 1)))
        );
    }

    #[test]
    fn y_axis_of_zeros_is_a_unit_axis() {
        let axis = y_axis(&[Decimal::ZERO, Decimal::ZERO], 4);
        assert_eq!(axis.range, Range::new(Decimal::ZERO, Decimal::ONE));
        assert_eq!(axis.ticks, vec![Decimal::ZERO, Decimal::ONE]);
    }

    #[test]
    fn y_axis_of_an_empty_slice_is_usable() {
        assert_eq!(y_axis(&[], 4), Axis::empty());
    }

    #[test]
    fn y_axis_always_contains_zero_and_the_data() {
        for values in [
            vec![Decimal::from(1000u64)],
            vec![Decimal::from(42u64), Decimal::from(42u64)],
            vec![dec(-500, 1), dec(-300, 1)],
            vec![dec(-25, 1), dec(80, 1)],
        ] {
            let axis = y_axis(&values, 4);
            assert!(axis.range.contains(Decimal::ZERO), "{axis:?}");
            for value in &values {
                assert!(axis.range.contains(*value), "{value} not in {axis:?}");
            }
            assert!(!axis.ticks.is_empty());
        }
    }

    #[test]
    fn y_axis_min_equals_max_still_spans() {
        // All values equal and non-zero: the range must not collapse.
        let axis = y_axis(&[Decimal::from(5u64); 3], 4);
        assert!(axis.range.span() > Decimal::ZERO);
        assert!(axis.range.contains(Decimal::from(5u64)));
    }

    #[test]
    fn y_axis_ticks_are_round_and_ordered() {
        let axis = y_axis(&[dec(9875, 2)], 4);
        assert!(axis.ticks.windows(2).all(|pair| pair[0] < pair[1]));
        // Every gap is the same, and that step is itself a "nice" number.
        let step = axis.ticks[1] - axis.ticks[0];
        assert!(axis.ticks.windows(2).all(|pair| pair[1] - pair[0] == step));
        assert_eq!(nice_step(step), step);
    }

    #[test]
    fn y_axis_handles_negative_only_data() {
        let axis = y_axis(&[dec(-500, 1), dec(-300, 1)], 4);
        assert!(axis.range.contains(dec(-500, 1)));
        assert!(axis.range.contains(Decimal::ZERO));
        assert!(axis.range.min < Decimal::ZERO || axis.range.min == dec(-600, 1));
    }

    #[test]
    fn linear_scale_maps_and_inverts() {
        let scale = LinearScale::new(Range::new(Decimal::ZERO, Decimal::from(100u64)), 50.0, 0.0);
        assert!(close(scale.position(Decimal::ZERO), 50.0));
        assert!(close(scale.position(Decimal::from(50u64)), 25.0));
        assert!(close(scale.position(Decimal::from(100u64)), 0.0));
    }

    #[test]
    fn linear_scale_of_a_zero_span_sits_in_the_middle() {
        let scale = LinearScale::new(
            Range::new(Decimal::from(5u64), Decimal::from(5u64)),
            0.0,
            100.0,
        );
        assert!(close(scale.position(Decimal::from(5u64)), 50.0));
    }

    #[test]
    fn magnitude_fraction_uses_absolute_values() {
        let max = Decimal::from(200u64);
        assert!(close(magnitude_fraction(Decimal::from(200u64), max), 1.0));
        assert!(close(magnitude_fraction(Decimal::from(50u64), max), 0.25));
        assert!(close(magnitude_fraction(Decimal::from(-100i64), max), 0.5));
        // Never negative, never above one, and safe at a zero maximum.
        assert!(close(magnitude_fraction(Decimal::from(300u64), max), 1.0));
        assert!(close(magnitude_fraction(Decimal::from(5u64), Decimal::ZERO), 0.0));
    }
}
