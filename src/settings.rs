//! User settings: the values that outlive a session.
//!
//! The model is pure on purpose: [`Settings`] is a plain serde type with no
//! browser dependency, so `cargo test` covers the part of persistence most
//! likely to break quietly — a wrong default or a lost round-trip looks like the
//! app forgetting a choice rather than like an error.
//!
//! The browser half ([`load`], [`save`]) is gated behind `cfg(target_arch =
//! "wasm32")` and deliberately never panics: `localStorage` can be missing
//! (private browsing, disabled storage) and a corrupt value must degrade to the
//! defaults rather than take the app down.
//!
//! `AppState` calls into this module; it does not depend on Leptos.
#![cfg_attr(not(target_arch = "wasm32"), allow(dead_code))]

use serde::{Deserialize, Serialize};

/// `localStorage` key for the persisted settings.
///
/// Versioned like the layout key in `state.rs`, so a change to the shape can
/// move to a new key instead of trying to migrate whatever is already there.
pub const SETTINGS_KEY: &str = "hledger-anywhere.settings.v1";

/// Everything the user can choose that should survive a reload.
///
/// Deliberately small. There is no theme setting: the app has one look, and it
/// is the one it ships with. A theme picker is surface area that does not help
/// anyone read their journal, so it is not offered — the palette is a decision,
/// not a preference.
///
/// `#[serde(default)]` keeps a value stored by an older build loadable: that
/// build had a `theme` field, which is now an ignored unknown field, and a
/// missing `main_currency` still picks up its default.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct Settings {
    /// The commodity totals should be reported in when one is available.
    pub main_currency: Option<String>,
}

// -- browser half -----------------------------------------------------------

#[cfg(target_arch = "wasm32")]
fn local_storage() -> Option<web_sys::Storage> {
    web_sys::window()?.local_storage().ok()?
}

/// Read the persisted settings, falling back to the defaults.
///
/// Missing storage, a missing key, an unreadable value and a corrupt value are
/// all the same outcome — the defaults — because settings are a convenience,
/// never a source of truth.
#[cfg(target_arch = "wasm32")]
pub fn load() -> Settings {
    local_storage()
        .and_then(|storage| storage.get_item(SETTINGS_KEY).ok().flatten())
        .and_then(|raw| serde_json::from_str(&raw).ok())
        .unwrap_or_default()
}

/// Persist the settings. Every failure is intentionally ignored (private
/// browsing, quota, disabled storage): losing the choice is not a broken app.
#[cfg(target_arch = "wasm32")]
pub fn save(settings: &Settings) {
    let Some(storage) = local_storage() else {
        return;
    };
    if let Ok(json) = serde_json::to_string(settings) {
        let _ = storage.set_item(SETTINGS_KEY, &json);
    }
}

// -- tests ------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn defaults_have_no_currency() {
        assert_eq!(Settings::default().main_currency, None);
    }

    #[test]
    fn settings_round_trip_through_json() {
        let settings = Settings {
            main_currency: Some("EUR".to_string()),
        };
        let json = serde_json::to_string(&settings).expect("settings serialize");
        let back: Settings = serde_json::from_str(&json).expect("settings deserialize");
        assert_eq!(back, settings);
    }

    #[test]
    fn an_older_builds_theme_field_is_ignored() {
        // Settings used to carry a `theme` field. A value stored by that build
        // must still load, and must not reset the currency.
        let settings: Settings =
            serde_json::from_str(r#"{"theme":"dark","main_currency":"IDR"}"#)
                .expect("legacy value tolerated");
        assert_eq!(settings.main_currency.as_deref(), Some("IDR"));
    }

    #[test]
    fn partial_json_picks_up_defaults() {
        let empty: Settings = serde_json::from_str("{}").expect("empty object");
        assert_eq!(empty, Settings::default());

        let settings: Settings =
            serde_json::from_str(r#"{"main_currency":"USD"}"#).expect("missing field");
        assert_eq!(settings.main_currency.as_deref(), Some("USD"));
    }

    #[test]
    fn unknown_fields_are_ignored() {
        let json = r#"{"main_currency":"GBP","future_setting":42,"nested":{"a":1}}"#;
        let settings: Settings = serde_json::from_str(json).expect("unknown fields tolerated");
        assert_eq!(settings.main_currency.as_deref(), Some("GBP"));
    }

    #[test]
    fn corrupt_json_is_rejected_by_the_parser() {
        // `load` maps a parse failure to `Settings::default()`, so all the parser
        // has to guarantee is that it fails rather than producing a half-applied
        // value.
        assert!(serde_json::from_str::<Settings>("not json").is_err());
    }

    #[test]
    fn settings_key_is_namespaced_and_versioned() {
        assert_eq!(SETTINGS_KEY, "hledger-anywhere.settings.v1");
    }
}
