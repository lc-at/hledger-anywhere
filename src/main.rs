//! hledger-anywhere, a terminal for hledger, running entirely in the browser.
//!
//! # Module layout
//!
//! The crate is split along a wasm boundary, enforced by `cfg` rather than by
//! convention so a `web_sys` import cannot leak into logic that should be
//! testable on the host:
//!
//! * **Pure modules**, [`terminal`] (the line editor, the command vocabulary,
//!   the text printed around output), [`journal`] (which uploaded file hledger
//!   should read), and [`hledger`]'s types. These are covered by `cargo test`.
//! * **Browser modules**, [`app`], [`terminal::view`] (xterm.js), [`upload`]
//!   (the file picker), [`store`] (IndexedDB) and `hledger::bridge`.
//!
//! There is one thing in the app: a terminal. The engine is the real hledger CLI
//! built for wasm32-wasi, pinned by `wasm.lock`.

#[cfg(target_arch = "wasm32")]
mod app;
#[cfg(target_arch = "wasm32")]
mod store;
#[cfg(target_arch = "wasm32")]
mod upload;

mod hledger;
mod hledger_info;
mod chart;
mod journal;
mod remote;
mod terminal;

#[cfg(target_arch = "wasm32")]
fn main() {
    console_error_panic_hook::set_once();
    app::start();
}

#[cfg(not(target_arch = "wasm32"))]
fn main() {
    eprintln!(
        "hledger-anywhere is a wasm32 browser application.\n\
         Build it with `trunk build`, serve it with `trunk serve`.\n\
         Run the pure-module tests with `cargo test`."
    );
}
