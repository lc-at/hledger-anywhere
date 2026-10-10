//! hledger-anywhere, a terminal for hledger, running entirely in the browser.
//!
//! # Module layout
//!
//! The crate is split along a wasm boundary, enforced by `cfg` rather than by
//! convention, so a `web_sys` import cannot leak into logic that should be testable
//! on the host.
//!
//! **Pure modules**, covered by `cargo test`:
//!
//! * [`terminal`], the line editor, the vocabulary, and the text printed around
//!   output.
//! * [`journal`], which loaded file hledger should read.
//! * [`chart`], drawing a report, used by the chart plugin.
//! * [`plugins`], the plugin contract and the bundled plugins.
//! * [`remote`], remoteStorage paths, listings and the library glue.
//! * [`hledger_info`], which engine this is, and [`hledger`]'s request types.
//!
//! **Browser modules**: [`app`], which wires everything together and decides what a
//! keystroke means, [`terminal::view`] (xterm.js), [`upload`] (the file picker),
//! [`store`] (the IndexedDB cache), [`remote::client`] (the remoteStorage library)
//! and `hledger::bridge`.
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
mod journal;
mod plugins;
mod remote;
mod settings;
mod terminal;
mod theme;

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
