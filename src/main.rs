//! hledger-anywhere — a client-side, easily extensible hledger analytics platform.
//!
//! # Module layout
//!
//! The crate is deliberately split along a wasm boundary:
//!
//! * **Pure modules** (`journal`, `layout::model`, `hledger::report`) contain the
//!   accounting model, the money type, the analytics, the report-to-argv mapping
//!   and the layout tree. They never touch `web_sys`/`js_sys`, compile for the
//!   host, and are covered by `cargo test`.
//! * **Browser modules** (`app`, `layout::view`, `panels`, `hledger::bridge`,
//!   `fsx`) are gated behind `cfg(target_arch = "wasm32")` and hold every DOM and
//!   worker interaction.
//!
//! Keeping the boundary enforced by `cfg` rather than by convention means a
//! `web_sys` import cannot silently leak into logic that needs to stay testable.

#[cfg(target_arch = "wasm32")]
mod app;
#[cfg(target_arch = "wasm32")]
mod fsx;
#[cfg(target_arch = "wasm32")]
mod panels;
#[cfg(target_arch = "wasm32")]
mod state;

mod hledger;
mod journal;
mod layout;

#[cfg(target_arch = "wasm32")]
fn main() {
    console_error_panic_hook::set_once();
    leptos::mount::mount_to_body(app::App);
}

#[cfg(not(target_arch = "wasm32"))]
fn main() {
    eprintln!(
        "hledger-anywhere is a wasm32 browser application.\n\
         Build it with `trunk build`, serve it with `trunk serve`.\n\
         Run the pure-module tests with `cargo test`."
    );
}
