//! The panel layout tree.
//!
//! `model` is a pure data structure with no DOM dependencies: it is the
//! authoritative description of what is on screen, and it is what gets
//! serialized for persistence. `view` renders it with Leptos and is wasm-only.

pub mod model;

#[cfg(target_arch = "wasm32")]
pub mod view;
