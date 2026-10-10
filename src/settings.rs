// Natively this module exists for its tests: the app that uses it is wasm-gated, so its
// items look unused to a plain build.
#![cfg_attr(not(target_arch = "wasm32"), allow(dead_code))]

//! What the app remembers between visits, in one record.
//!
//! One record rather than a key per setting, because the point of it is to be moved
//! between instances: exported from one, imported into another, and the same shape in
//! both directions has nothing to get out of step.
//!
//! Import is deliberately forgiving. The file may come from an older or a newer
//! version, or be edited by hand, so a missing field takes its default, an unknown
//! field is ignored rather than refused, and anything unusable is dropped instead of
//! taking the rest of the settings down with it. An import that silently lost a
//! setting would be worse than one that says what it could not use, so [`Import`]
//! reports both what was applied and what was not.

use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

use crate::terminal;

/// The theme the app ships with.
pub const DEFAULT_THEME: &str = "default";

/// A command alias, as a record rather than a pair, so an exported file says what each
/// field is.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Alias {
    pub name: String,
    pub command: String,
}

/// Everything the app remembers.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct Settings {
    /// Terminal font size in pixels.
    pub font: u32,
    /// Whether the terminal's accessibility tree is on.
    pub screen_reader: bool,
    /// The selected colour theme, by name.
    pub theme: String,
    /// Command aliases, in the order they are listed.
    pub aliases: Vec<Alias>,
    /// Plugin repositories, as manifest URLs or paths, in the order they were added.
    pub repositories: Vec<String>,
    /// What each plugin asked to remember, by plugin name and then by key.
    pub plugin: BTreeMap<String, BTreeMap<String, String>>,
}

impl Default for Settings {
    fn default() -> Self {
        Settings {
            font: terminal::DEFAULT_FONT,
            screen_reader: false,
            theme: DEFAULT_THEME.to_string(),
            aliases: Vec::new(),
            repositories: Vec::new(),
            plugin: BTreeMap::new(),
        }
    }
}

/// What an import did, so the app can report it honestly.
#[derive(Clone, Debug, PartialEq)]
pub struct Import {
    /// The settings that came out of the file, sanitised.
    pub settings: Settings,
    /// Fields that were present but unusable, in the words of the report.
    pub dropped: Vec<String>,
}

impl Settings {
    /// The record as the exported file holds it.
    pub fn to_json(&self) -> String {
        // Pretty and sorted: an exported file is something a person may read, diff, or
        // paste into a support thread.
        serde_json::to_string_pretty(self).unwrap_or_else(|_| "{}".to_string())
    }

    /// Read a record from an exported file.
    pub fn from_json(text: &str) -> Result<Import, String> {
        let mut settings: Settings = serde_json::from_str(text)
            .map_err(|error| format!("that file is not settings: {error}"))?;
        let dropped = settings.sanitise();
        Ok(Import { settings, dropped })
    }

    /// Make the record usable, reporting anything that had to go.
    ///
    /// Settings are read from a file that may have been written by another version or
    /// edited by hand, so this is the boundary where a number out of range or a URL
    /// that is not one gets fixed or dropped, rather than propagating.
    pub fn sanitise(&mut self) -> Vec<String> {
        let mut dropped = Vec::new();

        let wanted = self.font;
        self.font = self.font.clamp(terminal::MIN_FONT, terminal::MAX_FONT);
        if self.font != wanted {
            dropped.push(format!(
                "font {wanted} is outside {} to {}, so it became {}",
                terminal::MIN_FONT,
                terminal::MAX_FONT,
                self.font
            ));
        }

        if self.theme.trim().is_empty() {
            self.theme = DEFAULT_THEME.to_string();
        }

        let aliases = std::mem::take(&mut self.aliases);
        for alias in aliases {
            let name = alias.name.trim().to_string();
            let command = alias.command.trim().to_string();
            // An alias the app would refuse to define is one it cannot use.
            if name.is_empty() || name.contains(char::is_whitespace) || command.is_empty() {
                dropped.push(format!("alias {} is not a name and a command", alias.name));
                continue;
            }
            if name == "alias" || name == "unalias" {
                dropped.push(format!("alias {name} would shadow the command that sets it"));
                continue;
            }
            self.aliases.push(Alias { name, command });
        }

        let repositories = std::mem::take(&mut self.repositories);
        for repository in repositories {
            let url = repository.trim().to_string();
            if !looks_like_a_manifest(&url) {
                dropped.push(format!("{repository} is not a manifest URL or path"));
                continue;
            }
            if self.repositories.contains(&url) {
                dropped.push(format!("{url} was listed twice"));
                continue;
            }
            self.repositories.push(url);
        }

        // A plugin's own settings are its business, but an empty name is not a plugin.
        self.plugin.retain(|name, _| !name.trim().is_empty());

        dropped
    }

    /// One plugin's settings.
    pub fn plugin_settings(&self, plugin: &str) -> BTreeMap<String, String> {
        self.plugin.get(plugin).cloned().unwrap_or_default()
    }

    /// Set one plugin setting, and report whether it changed anything.
    pub fn set_plugin_setting(&mut self, plugin: &str, key: &str, value: &str) -> bool {
        let entry = self.plugin.entry(plugin.to_string()).or_default();
        if entry.get(key).map(String::as_str) == Some(value) {
            return false;
        }
        entry.insert(key.to_string(), value.to_string());
        true
    }

    /// Whether a repository is already installed.
    pub fn has_repository(&self, url: &str) -> bool {
        self.repositories.iter().any(|known| known == url.trim())
    }
}

/// Whether a string is something the app can fetch a manifest from.
///
/// A URL, or a path the app's own server serves. Nothing else: a bare word is almost
/// always a typo, and saying so is better than a failed fetch later.
pub fn looks_like_a_manifest(text: &str) -> bool {
    let text = text.trim();
    if text.is_empty() {
        return false;
    }
    text.starts_with("https://")
        || text.starts_with("http://")
        || text.starts_with('/')
        || text.starts_with("./")
        || text.starts_with("../")
        || text.starts_with("plugins/")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_record_survives_the_round_trip_through_a_file() {
        let mut settings = Settings {
            font: 18,
            screen_reader: true,
            theme: "solarized".to_string(),
            ..Settings::default()
        };
        settings.aliases.push(Alias {
            name: "bal".to_string(),
            command: "balance --tree".to_string(),
        });
        settings
            .repositories
            .push("https://example.invalid/plugins.json".to_string());
        settings.set_plugin_setting("chart", "account", "expenses");

        let import = Settings::from_json(&settings.to_json()).expect("its own export");
        assert_eq!(import.settings, settings);
        assert!(import.dropped.is_empty(), "{:?}", import.dropped);
    }

    #[test]
    fn an_import_missing_fields_takes_the_defaults() {
        // Written by hand, or by a version that had fewer settings.
        let import = Settings::from_json("{\"font\": 20}").expect("a partial file");
        assert_eq!(import.settings.font, 20);
        assert_eq!(import.settings.theme, DEFAULT_THEME);
        assert!(!import.settings.screen_reader);
        assert!(import.settings.aliases.is_empty());
        assert!(import.dropped.is_empty(), "{:?}", import.dropped);
    }

    #[test]
    fn an_unknown_field_is_ignored_rather_than_refused() {
        // A file from a newer version must not be a hard error: refusing somebody's
        // settings because they added a plugin is worse than not knowing the field.
        let import = Settings::from_json("{\"font\": 16, \"future_thing\": {\"a\": 1}}")
            .expect("a file with more than this version knows");
        assert_eq!(import.settings.font, 16);
    }

    #[test]
    fn what_cannot_be_used_is_reported_rather_than_applied() {
        let json = r#"{
            "font": 900,
            "aliases": [
                {"name": "bal", "command": "balance"},
                {"name": "two words", "command": "balance"},
                {"name": "", "command": "balance"},
                {"name": "alias", "command": "balance"}
            ],
            "repositories": [
                "https://example.invalid/p.json",
                "https://example.invalid/p.json",
                "not a url",
                ""
            ]
        }"#;
        let import = Settings::from_json(json).expect("it parses");
        assert_eq!(import.settings.font, terminal::MAX_FONT);
        assert_eq!(import.settings.aliases.len(), 1);
        assert_eq!(import.settings.aliases[0].name, "bal");
        assert_eq!(import.settings.repositories.len(), 1);
        // Seven things go: the font, three aliases (two unusable, one shadowing
        // `alias` itself), a duplicate repository, and two that are not manifests.
        assert_eq!(import.dropped.len(), 7, "{:?}", import.dropped);
        assert!(
            import
                .dropped
                .iter()
                .any(|complaint| complaint.contains("font 900")),
            "{:?}",
            import.dropped
        );
        for complaint in &import.dropped {
            assert!(!complaint.is_empty());
        }
    }

    #[test]
    fn a_file_that_is_not_settings_is_refused_with_a_reason() {
        let error = Settings::from_json("not json at all").expect_err("not settings");
        assert!(error.contains("not settings"), "{error}");
        // And valid JSON of the wrong shape is also not settings.
        assert!(Settings::from_json("[1, 2, 3]").is_err());
    }

    #[test]
    fn a_plugin_setting_is_set_only_when_it_changes() {
        let mut settings = Settings::default();
        assert!(settings.set_plugin_setting("chart", "account", "food"));
        assert!(!settings.set_plugin_setting("chart", "account", "food"));
        assert!(settings.set_plugin_setting("chart", "account", "travel"));
        assert_eq!(settings.plugin_settings("chart")["account"], "travel");
        // An unknown plugin has no settings, which is not an error.
        assert!(settings.plugin_settings("nothing").is_empty());
    }

    #[test]
    fn a_repository_is_recognised_by_what_it_is() {
        assert!(looks_like_a_manifest("https://example.invalid/plugins.json"));
        assert!(looks_like_a_manifest("http://localhost:8080/plugins.json"));
        assert!(looks_like_a_manifest("/plugins/bundled.json"));
        assert!(looks_like_a_manifest("./examples/plugins/plugins.json"));
        assert!(looks_like_a_manifest("plugins/mine.json"));
        assert!(!looks_like_a_manifest("mine.json"));
        assert!(!looks_like_a_manifest(""));
        assert!(!looks_like_a_manifest("   "));
    }
}
