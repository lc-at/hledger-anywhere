//! Charts.
//!
//! Declared unconditionally so the pure modules ([`scale`], [`data`]) stay
//! natively testable; the Leptos view components live in the wasm-gated
//! submodules and are re-exported, mirroring how `layout` splits `model` from
//! `view`.
//!
//! * [`bar_chart`] is still hand-rolled SVG: one `<svg viewBox>`, plain elements
//!   and a native `<title>` child per mark for tooltips. It is a static,
//!   single-shot figure that needs neither JavaScript nor a charting library.
//! * [`line_chart`] is [uPlot], vendored under `assets/js/vendor/uplot` and
//!   constructed through `js_sys` from [`uplot`]. The line chart was subtle
//!   enough (axis ticks, negative values, resizing, theming) that a maintained
//!   library earns its keep; the bar chart is not.
//!
//! Both theme through CSS custom properties only. The SVG chart names
//! `var(--gl-*)` tokens directly; the uPlot chart reads the same tokens off the
//! document root with `getComputedStyle`, and re-reads them when `data-theme`
//! changes.
//!
//! The components take plain values (a slice of label/amount pairs) and return a
//! static [`AnyView`]. Panels read their signals and pass the snapshot in, the
//! same way `panels::balances` snapshots its report before building the table.
//!
//! [uPlot]: https://github.com/leeoniya/uPlot
//! [`AnyView`]: leptos::prelude::AnyView

pub mod data;
pub mod scale;

#[cfg(target_arch = "wasm32")]
mod uplot;
#[cfg(target_arch = "wasm32")]
mod view;

// The analytics panels are the consumers.
#[cfg(target_arch = "wasm32")]
pub use uplot::line_chart;
#[cfg(target_arch = "wasm32")]
pub use view::{Bar, bar_chart};
