//! What each panel's controls were left at.
//!
//! The layout already survives a reload, which means panel *identity* survives —
//! so this is what makes the panels themselves come back as they were. Without
//! it, closing the laptop and coming back the next day loses every query anyone
//! typed, and a query is the one thing in a panel that represents thought.
//!
//! Keyed by panel id rather than by panel kind: two Balances panels can be open
//! at once and are deliberately independent. Ids are stable across reloads
//! because they live in the persisted layout; they are *not* stable across a
//! layout reset, so that clears this (see `AppState::reset_layout`).
//!
//! The model is pure: `Controls` is a plain serde type with no browser in it, so
//! `cargo test` covers the part that would otherwise fail silently — a control
//! that comes back as the wrong type looks like the app forgetting a setting.
//! The browser half ([`load`], [`save`]) is wasm-gated and never panics, exactly
//! as `settings` is.

// Natively this module exists for its tests: the panels that use the control
// names are wasm-only, so the names look unused to `cargo test`'s build. The same
// allowance the other pure modules carry.
#![cfg_attr(not(target_arch = "wasm32"), allow(dead_code))]

use std::collections::{BTreeMap, HashMap};

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::layout::model::PanelId;

/// `localStorage` key for the remembered controls.
pub const CONTROLS_KEY: &str = "hledger-anywhere.controls.v1";

/// The control names panels remember, in one place so a panel and the store
/// cannot drift apart over a string literal.
pub const QUERY: &str = "query";
pub const PERIOD: &str = "period";
pub const DEPTH: &str = "depth";
pub const TREE: &str = "tree";
pub const INTERVAL: &str = "interval";

/// Every panel's remembered controls.
///
/// The inner map is ordered so the stored JSON is stable: a diff of two saves
/// should show what changed, not how a hash map felt that day.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct Controls(HashMap<PanelId, BTreeMap<String, Value>>);

impl Controls {
    fn get(&self, panel: PanelId, key: &str) -> Option<&Value> {
        self.0.get(&panel)?.get(key)
    }

    /// Remember one control.
    pub fn set(&mut self, panel: PanelId, key: &str, value: Value) {
        self.0
            .entry(panel)
            .or_default()
            .insert(key.to_string(), value);
    }

    /// A text control, if it was remembered as text.
    ///
    /// Each accessor checks the type rather than coercing: a value stored by an
    /// older build with a different shape is then ignored, and the panel keeps
    /// its own default instead of acquiring something nonsense.
    pub fn text(&self, panel: PanelId, key: &str) -> Option<String> {
        self.get(panel, key)?.as_str().map(str::to_string)
    }

    /// A dropdown index, if it was remembered as one.
    pub fn index(&self, panel: PanelId, key: &str) -> Option<usize> {
        self.get(panel, key)?.as_u64().map(|value| value as usize)
    }

    /// A tick box, if it was remembered as one.
    pub fn flag(&self, panel: PanelId, key: &str) -> Option<bool> {
        self.get(panel, key)?.as_bool()
    }

    /// Drop everything belonging to panels that are no longer in the layout.
    ///
    /// Called on save rather than on close, so it cannot be forgotten at one of
    /// the several places a panel can go away.
    pub fn retain(&mut self, live: &[PanelId]) {
        self.0.retain(|panel, _| live.contains(panel));
    }

    /// How many panels have something remembered.
    #[cfg(test)]
    fn panels(&self) -> usize {
        self.0.len()
    }
}

// -- browser half -----------------------------------------------------------

#[cfg(target_arch = "wasm32")]
fn local_storage() -> Option<web_sys::Storage> {
    web_sys::window()?.local_storage().ok()?
}

/// Read what was remembered, falling back to nothing remembered.
///
/// Missing storage, a missing key and a corrupt value are all the same outcome:
/// every panel keeps its own default. Controls are a convenience, never a source
/// of truth.
#[cfg(target_arch = "wasm32")]
pub fn load() -> Controls {
    local_storage()
        .and_then(|storage| storage.get_item(CONTROLS_KEY).ok().flatten())
        .and_then(|raw| serde_json::from_str(&raw).ok())
        .unwrap_or_default()
}

/// Persist the controls. Every failure is deliberately ignored.
#[cfg(target_arch = "wasm32")]
pub fn save(controls: &Controls) {
    let Some(storage) = local_storage() else {
        return;
    };
    if let Ok(json) = serde_json::to_string(controls) {
        let _ = storage.set_item(CONTROLS_KEY, &json);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn controls_round_trip_through_json() {
        let mut controls = Controls::default();
        controls.set(3, "query", json!("date:thismonth exp:food"));
        controls.set(3, "period", json!(2usize));
        controls.set(7, "flat", json!(true));

        let json = serde_json::to_string(&controls).expect("controls serialize");
        let back: Controls = serde_json::from_str(&json).expect("controls deserialize");
        assert_eq!(back, controls, "a round trip must not lose a control");
        assert_eq!(
            back.text(3, "query").as_deref(),
            Some("date:thismonth exp:food")
        );
        assert_eq!(back.index(3, "period"), Some(2));
        assert_eq!(back.flag(7, "flat"), Some(true));
    }

    #[test]
    fn a_control_remembered_as_one_type_is_not_read_as_another() {
        let mut controls = Controls::default();
        controls.set(1, "period", json!("not a number"));
        assert_eq!(controls.index(1, "period"), None);
        assert_eq!(controls.text(1, "period").as_deref(), Some("not a number"));

        controls.set(1, "query", json!(5));
        assert_eq!(controls.text(1, "query"), None);
        assert_eq!(controls.flag(1, "query"), None);
    }

    #[test]
    fn unknown_panels_and_keys_are_absent_rather_than_wrong() {
        let mut controls = Controls::default();
        controls.set(1, "query", json!("x"));
        assert_eq!(controls.text(2, "query"), None);
        assert_eq!(controls.text(1, "nothing"), None);
    }

    #[test]
    fn saving_drops_panels_that_have_gone() {
        let mut controls = Controls::default();
        controls.set(1, "query", json!("a"));
        controls.set(2, "query", json!("b"));
        controls.retain(&[2]);
        assert_eq!(controls.panels(), 1);
        assert_eq!(controls.text(1, "query"), None);
        assert_eq!(controls.text(2, "query").as_deref(), Some("b"));
    }

    #[test]
    fn corrupt_json_is_rejected_by_the_parser() {
        // `load` maps a parse failure to `Controls::default()`, so all the parser
        // has to guarantee is that it fails rather than producing nonsense.
        assert!(serde_json::from_str::<Controls>("not json").is_err());
    }

    #[test]
    fn a_control_key_is_namespaced_and_versioned() {
        assert_eq!(CONTROLS_KEY, "hledger-anywhere.controls.v1");
    }
}
