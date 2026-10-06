//! User settings: the values that outlive a session.
//!
//! The model is pure on purpose. [`Theme`] and [`Settings`] are plain serde
//! types with no browser dependency, so `cargo test` covers the part of
//! persistence most likely to break quietly — a wrong default or a lost
//! round-trip looks like the app forgetting a choice rather than like an error.
//!
//! The browser half ([`load`], [`save`], [`apply_theme`], [`watch_system_theme`])
//! is gated behind `cfg(target_arch = "wasm32")` and deliberately never panics:
//! `localStorage` can be missing (private browsing, disabled storage) and a
//! corrupt value must degrade to the defaults rather than take the app down.
//!
//! Owned by the theme/settings workstream. `AppState`/`app.rs` call into this
//! module; it does not depend on Leptos.
#![cfg_attr(not(target_arch = "wasm32"), allow(dead_code))]

use serde::{Deserialize, Serialize};

/// `localStorage` key for the persisted settings.
///
/// Versioned like the layout key in `state.rs`, so a change to the shape can
/// move to a new key instead of trying to migrate whatever is already there.
pub const SETTINGS_KEY: &str = "hledger-anywhere.settings.v1";

/// The `matchMedia` query that decides what `Theme::System` means.
#[cfg(target_arch = "wasm32")]
const SYSTEM_DARK_QUERY: &str = "(prefers-color-scheme: dark)";

/// Which colour scheme the app should draw in.
///
/// `System` follows the operating system and is the default: a first-time
/// visitor gets the palette their desktop already uses.
///
/// The serde name is the lowercase DOM name written to `data-theme`, so the
/// stored value and the attribute stay one string.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Theme {
    #[default]
    System,
    Dark,
    Light,
}

impl Theme {
    /// The lowercase name used for the `data-theme` attribute and storage.
    pub const fn as_str(self) -> &'static str {
        match self {
            Theme::System => "system",
            Theme::Dark => "dark",
            Theme::Light => "light",
        }
    }

    /// Resolve a possibly-`System` theme against a concrete OS preference.
    ///
    /// Split out from [`apply_theme`] so the decision is host-testable: the
    /// browser half only has to find out whether the OS currently prefers dark.
    pub const fn resolve(self, system_is_dark: bool) -> Theme {
        match self {
            Theme::System if system_is_dark => Theme::Dark,
            Theme::System => Theme::Light,
            theme => theme,
        }
    }
}

/// Everything the user can choose that should survive a reload.
///
/// `#[serde(default)]` on the container makes a partial object valid: a stored
/// value from an older build that lacks a field picks up that field's default,
/// and unknown fields from a newer build are ignored rather than rejected.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct Settings {
    /// Dark, light, or follow the operating system.
    pub theme: Theme,
    /// The commodity totals should be reported in when one is available.
    pub main_currency: Option<String>,
}

// -- browser half -----------------------------------------------------------

#[cfg(target_arch = "wasm32")]
use wasm_bindgen::{JsCast, JsValue, closure::Closure};

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

/// Resolve `theme` and write it to `<html data-theme="…">`.
///
/// The stylesheet keys the light palette off `:root[data-theme="light"]`, so
/// this is the single point that changes what the user sees.
#[cfg(target_arch = "wasm32")]
pub fn apply_theme(theme: Theme) {
    let Some(root) = web_sys::window()
        .and_then(|window| window.document())
        .and_then(|document| document.document_element())
    else {
        return;
    };
    let _ = root.set_attribute("data-theme", theme.resolve(system_prefers_dark()).as_str());
}

/// What `Theme::System` currently resolves to, without touching the document.
#[cfg(target_arch = "wasm32")]
pub fn system_theme() -> Theme {
    if system_prefers_dark() {
        Theme::Dark
    } else {
        Theme::Light
    }
}

/// Call `callback` whenever the operating system's colour scheme changes.
///
/// Returns `false` when no `matchMedia` listener could be installed (a browser
/// without `matchMedia`, or a rejected `addEventListener`), so the caller knows
/// it will not be notified and can decide whether to fall back to a one-shot
/// [`apply_theme`]. The listener is leaked on purpose: it lives for the page.
#[cfg(target_arch = "wasm32")]
pub fn watch_system_theme<F>(callback: F) -> bool
where
    F: Fn(Theme) + 'static,
{
    let Some(query) = media_query_list() else {
        return false;
    };
    let Ok(target) = query.dyn_into::<web_sys::EventTarget>() else {
        return false;
    };
    let listener = Closure::<dyn FnMut()>::new(move || callback(system_theme()));
    if target
        .add_event_listener_with_callback("change", listener.as_ref().unchecked_ref())
        .is_err()
    {
        return false;
    }
    listener.forget();
    true
}

#[cfg(target_arch = "wasm32")]
fn local_storage() -> Option<web_sys::Storage> {
    web_sys::window()?.local_storage().ok()?
}

/// The `MediaQueryList` for the OS dark-mode preference.
///
/// Built through `js_sys::Reflect` rather than `Window::match_media` so this
/// module needs no extra `web-sys` features: the whole object is treated as an
/// opaque `JsValue` and only `matches`/`addEventListener` are read off it.
#[cfg(target_arch = "wasm32")]
fn media_query_list() -> Option<JsValue> {
    let window: JsValue = web_sys::window()?.unchecked_into();
    let match_media = js_sys::Reflect::get(&window, &JsValue::from_str("matchMedia")).ok()?;
    let match_media: js_sys::Function = match_media.dyn_into().ok()?;
    match_media
        .call1(&window, &JsValue::from_str(SYSTEM_DARK_QUERY))
        .ok()
}

#[cfg(target_arch = "wasm32")]
fn system_prefers_dark() -> bool {
    media_query_list()
        .and_then(|query| js_sys::Reflect::get(&query, &JsValue::from_str("matches")).ok())
        .and_then(|matches| matches.as_bool())
        .unwrap_or(false)
}

// -- tests ------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn defaults_follow_the_system() {
        assert_eq!(Theme::default(), Theme::System);
        let settings = Settings::default();
        assert_eq!(settings.theme, Theme::System);
        assert_eq!(settings.main_currency, None);
    }

    #[test]
    fn settings_round_trip_through_json() {
        let settings = Settings {
            theme: Theme::Dark,
            main_currency: Some("EUR".to_string()),
        };
        let json = serde_json::to_string(&settings).expect("settings serialize");
        assert!(
            json.contains("\"dark\""),
            "theme keeps its lowercase name: {json}"
        );
        let back: Settings = serde_json::from_str(&json).expect("settings deserialize");
        assert_eq!(back, settings);
    }

    #[test]
    fn theme_names_round_trip_lowercase() {
        for (theme, name) in [
            (Theme::System, "system"),
            (Theme::Dark, "dark"),
            (Theme::Light, "light"),
        ] {
            assert_eq!(theme.as_str(), name);
            let json = serde_json::to_string(&theme).expect("theme serialize");
            assert_eq!(json, format!("\"{name}\""));
            let back: Theme = serde_json::from_str(&json).expect("theme deserialize");
            assert_eq!(back, theme);
        }
    }

    #[test]
    fn partial_json_picks_up_defaults() {
        let settings: Settings = serde_json::from_str("{}").expect("empty object");
        assert_eq!(settings, Settings::default());

        let settings: Settings =
            serde_json::from_str(r#"{"main_currency":"USD"}"#).expect("missing theme");
        assert_eq!(settings.theme, Theme::System);
        assert_eq!(settings.main_currency.as_deref(), Some("USD"));

        let settings: Settings =
            serde_json::from_str(r#"{"theme":"light"}"#).expect("missing currency");
        assert_eq!(settings.theme, Theme::Light);
        assert_eq!(settings.main_currency, None);
    }

    #[test]
    fn unknown_fields_are_ignored() {
        let json = r#"{"theme":"dark","main_currency":"GBP","future_setting":42,"nested":{"a":1}}"#;
        let settings: Settings = serde_json::from_str(json).expect("unknown fields tolerated");
        assert_eq!(settings.theme, Theme::Dark);
        assert_eq!(settings.main_currency.as_deref(), Some("GBP"));
    }

    #[test]
    fn corrupt_json_is_rejected_by_the_parser() {
        // `load` maps a parse failure to `Settings::default()`, so all the
        // parser has to guarantee is that it fails instead of producing a
        // half-applied value.
        assert!(serde_json::from_str::<Settings>("not json").is_err());
        assert!(serde_json::from_str::<Settings>(r#"{"theme":"neon"}"#).is_err());
    }

    #[test]
    fn system_resolves_to_a_concrete_theme() {
        assert_eq!(Theme::System.resolve(true), Theme::Dark);
        assert_eq!(Theme::System.resolve(false), Theme::Light);
        assert_eq!(Theme::Dark.resolve(false), Theme::Dark);
        assert_eq!(Theme::Light.resolve(true), Theme::Light);
    }

    #[test]
    fn settings_key_is_namespaced_and_versioned() {
        assert_eq!(SETTINGS_KEY, "hledger-anywhere.settings.v1");
    }
}
