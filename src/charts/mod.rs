//! Charts, drawn as SVG.
//!
//! Declared unconditionally so [`scale`] stays natively testable; the Leptos
//! view components live in the wasm-gated `view` submodule and are re-exported,
//! mirroring how `layout` splits `model` from `view`.
//!
//! Two hard constraints shape everything here:
//!
//! * **No charting dependency.** One `<svg viewBox>`, plain elements and a
//!   native `<title>` child per mark for tooltips. A `<title>` needs no
//!   JavaScript and works on hover in every browser.
//! * **Theme through CSS custom properties only.** The charts name
//!   `var(--gl-*)` tokens rather than owning colours, so the Gruvbox
//!   dark/light switch applies to them for free.
//!
//! The components take plain values (a slice of label/amount pairs) and return a
//! static [`AnyView`]. Panels read their signals and pass the snapshot in, the
//! same way `panels::balances` snapshots its report before building the table.
//!
//! [`AnyView`]: leptos::prelude::AnyView

pub mod scale;

#[cfg(target_arch = "wasm32")]
mod view;

// The analytics panels are the consumers.
#[cfg(target_arch = "wasm32")]
pub use view::{bar_chart, line_chart};
