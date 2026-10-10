//! Plugins: commands the app does not implement itself, loaded at runtime.
//!
//! A plugin is not compiled in. A **repository** is a manifest, fetched by URL or path,
//! listing plugins with the words they answer to, how they read in the help, what they
//! add to completion, and the module that implements them. The module is imported the
//! first time one of its commands is run, so a repository that is installed but unused
//! costs nothing and runs no code.
//!
//! The manifest is authoritative for everything the app needs before running anything:
//!
//! ```json
//! {
//!   "manifest": 1,
//!   "name": "examples",
//!   "plugins": [
//!     {
//!       "name": "chart",
//!       "group": "Reports",
//!       "summary": "open a balance chart in a window",
//!       "completes": ["balance", "expenses"],
//!       "module": "./chart.js",
//!       "themes": [
//!         {"name": "midnight", "colors": {"background": "#0b1021", "accent": "#7aa2f7"}}
//!       ]
//!     }
//!   ]
//! }
//! ```
//!
//! A plugin module exports `run(arguments, host)`, where `host` is the app's own API:
//! `host.hledger(command)` to run a read-only hledger command, `host.say(text)` to
//! print, `host.window(title)` to open a window before an `await`, `host.setting(key)`
//! and `host.remember(key, value)` for its own settings. See `docs/plugins.md`.
//!
//! What this module holds is the registry: what is installed, what it claims, and the
//! rules that keep the answers honest. Fetching, importing and running live in
//! [`loader`], which is the wasm side of the same thing.

// Themes are parsed and held from the moment a repository is installed, but selecting
// one is the next piece of work, along with the shadowing note in the listing. The tests
// exercise all of it in the meantime.
#![allow(dead_code)]

use serde::Deserialize;
use std::collections::BTreeMap;

use crate::terminal;

/// Where a plugin is filed in the help when it does not say.
const DEFAULT_GROUP: &str = "Plugins";

/// A colour theme a plugin offers.
#[derive(Clone, Debug, PartialEq, Eq, Deserialize)]
pub struct ThemeInfo {
    pub name: String,
    /// Colours by role: `background`, `foreground`, `cursor`, `accent`, `dim`.
    /// A colour the app does not recognise is ignored rather than refused, so a theme
    /// written for a later version still applies what it can.
    #[serde(default)]
    pub colors: BTreeMap<String, String>,
}

/// What a plugin says about itself, from its repository's manifest.
#[derive(Clone, Debug, PartialEq, Eq, Deserialize)]
pub struct PluginInfo {
    /// The word that invokes it.
    pub name: String,
    #[serde(default)]
    pub group: String,
    #[serde(default)]
    pub summary: String,
    /// Extra words it adds to completion, such as the arguments it expects.
    #[serde(default)]
    pub completes: Vec<String>,
    /// Themes it contributes.
    #[serde(default)]
    pub themes: Vec<ThemeInfo>,
    /// The module that implements it, as the manifest named it.
    #[serde(default)]
    pub module: String,
    /// The repository it came from, filled in when the manifest is installed.
    #[serde(default)]
    pub repository: String,
}

impl PluginInfo {
    /// The help section it belongs to.
    pub fn group_or_default(&self) -> &str {
        if self.group.trim().is_empty() {
            DEFAULT_GROUP
        } else {
            self.group.trim()
        }
    }
}

/// A repository's manifest, as far as the app reads it.
#[derive(Clone, Debug, Deserialize)]
pub struct Manifest {
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub plugins: Vec<PluginInfo>,
}

/// What happened when a manifest was installed.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Installed {
    /// The plugin names that are now available.
    pub registered: Vec<String>,
    /// Plugins that could not be used, and why. One bad entry in a manifest does not cost
    /// the user the rest of the repository.
    pub refused: Vec<String>,
}

/// The plugins available this session, in the order they were registered.
#[derive(Debug, Default)]
pub struct Registry {
    plugins: Vec<PluginInfo>,
}

impl Registry {
    /// Read a manifest and take the plugins it offers.
    ///
    /// A manifest that is not readable is an error, because the user named that
    /// repository and deserves to know it is not one. A plugin inside a readable manifest
    /// that cannot be used is refused with a reason, and does not stop the rest.
    pub fn install(&mut self, manifest_json: &str, repository: &str) -> Result<Installed, String> {
        let manifest: Manifest = serde_json::from_str(manifest_json)
            .map_err(|error| format!("that is not a plugin manifest: {error}"))?;

        if manifest.plugins.is_empty() {
            return Err(format!("the manifest at {repository} lists no plugins"));
        }

        let mut installed = Installed::default();
        for mut plugin in manifest.plugins {
            plugin.repository = repository.to_string();
            if let Err(reason) = self.check(&plugin) {
                installed.refused.push(format!("{}: {reason}", plugin.name));
                continue;
            }
            installed.registered.push(plugin.name.clone());
            self.plugins.push(plugin);
        }
        Ok(installed)
    }

    /// Why a plugin cannot be registered, if it cannot.
    ///
    /// The rules exist because a plugin's word is a word the user types: it has to be one
    /// word, it cannot be a word the app answers to itself, and nothing can be claimed
    /// twice. Shadowing one of hledger's commands is allowed, since that is a plugin's
    /// business, and [`Registry::shadowed`] reports it so the listing can say so.
    fn check(&self, plugin: &PluginInfo) -> Result<(), String> {
        let name = plugin.name.trim();
        if name.is_empty() {
            return Err("it has no name".to_string());
        }
        if name.contains(char::is_whitespace) {
            return Err(format!("{name} is more than one word"));
        }
        if plugin.summary.trim().is_empty() {
            return Err(format!("{name} has no summary for the help"));
        }
        if terminal::COMMANDS.contains(&name) {
            return Err(format!("{name} is one of the app's own commands"));
        }
        if self.find(name).is_some() {
            return Err(format!("{name} is already provided by another plugin"));
        }
        Ok(())
    }

    /// The plugin that answers to `name`, if one does.
    pub fn find(&self, name: &str) -> Option<&PluginInfo> {
        self.plugins.iter().find(|plugin| plugin.name == name)
    }

    /// The plugin that owns the first word of `line`, if one does.
    pub fn owner(&self, line: &str) -> Option<&PluginInfo> {
        let (head, _) = terminal::split_first_token(line);
        self.find(&head)
    }

    /// Forget everything that came from a repository.
    pub fn remove_repository(&mut self, repository: &str) -> usize {
        let before = self.plugins.len();
        self.plugins.retain(|plugin| plugin.repository != repository);
        before - self.plugins.len()
    }

    /// The repositories that have plugins registered.
    pub fn repositories(&self) -> Vec<&str> {
        let mut seen: Vec<&str> = Vec::new();
        for plugin in &self.plugins {
            if !plugin.repository.is_empty() && !seen.contains(&plugin.repository.as_str()) {
                seen.push(plugin.repository.as_str());
            }
        }
        seen
    }

    /// Each plugin as the listing shows it: name, summary, and where it came from.
    pub fn listing(&self) -> Vec<(&str, &str, &str)> {
        self.plugins
            .iter()
            .map(|plugin| {
                (
                    plugin.name.as_str(),
                    plugin.summary.as_str(),
                    plugin.repository.as_str(),
                )
            })
            .collect()
    }

    /// The words plugins add to completion.
    pub fn words(&self) -> Vec<String> {
        let mut words = Vec::new();
        for plugin in &self.plugins {
            words.push(plugin.name.clone());
            words.extend(plugin.completes.iter().cloned());
        }
        words
    }

    /// A plugin's line in the help: group, form, and what it does.
    pub fn help_entries(&self) -> Vec<(&str, &str, &str)> {
        self.plugins
            .iter()
            .map(|plugin| {
                (
                    plugin.group_or_default(),
                    plugin.name.as_str(),
                    plugin.summary.as_str(),
                )
            })
            .collect()
    }

    /// Every theme offered, with the plugin that offers it.
    pub fn themes(&self) -> Vec<(&str, &ThemeInfo)> {
        self.plugins
            .iter()
            .flat_map(|plugin| {
                plugin
                    .themes
                    .iter()
                    .map(move |theme| (plugin.name.as_str(), theme))
            })
            .collect()
    }

    /// The theme with this name, if a plugin offers one.
    pub fn theme(&self, name: &str) -> Option<&ThemeInfo> {
        self.themes()
            .into_iter()
            .find(|(_, theme)| theme.name == name)
            .map(|(_, theme)| theme)
    }

    /// Plugins whose word is also one of hledger's, worth saying out loud.
    pub fn shadowed(&self) -> Vec<&str> {
        self.plugins
            .iter()
            .filter(|plugin| terminal::HLEDGER_COMMANDS.contains(&plugin.name.as_str()))
            .map(|plugin| plugin.name.as_str())
            .collect()
    }

    pub fn is_empty(&self) -> bool {
        self.plugins.is_empty()
    }

    pub fn len(&self) -> usize {
        self.plugins.len()
    }
}

pub mod loader;

#[cfg(test)]
mod tests {
    use super::*;

    // A raw string with two hashes: the manifest holds colours like "#0b1021", and
    // `"#` would end a one-hash raw string in the middle of one.
    const EXAMPLE: &str = r##"{
        "manifest": 1,
        "name": "examples",
        "plugins": [
            {
                "name": "chart",
                "group": "Reports",
                "summary": "open a balance chart in a window",
                "completes": ["balance", "expenses"],
                "module": "./chart.js",
                "themes": [
                    {"name": "midnight", "colors": {"background": "#0b1021", "accent": "#7aa2f7"}}
                ]
            }
        ]
    }"##;

    fn registry() -> Registry {
        let mut registry = Registry::default();
        registry
            .install(EXAMPLE, "https://example.invalid/plugins.json")
            .expect("a good manifest");
        registry
    }

    #[test]
    fn a_manifest_installs_the_plugins_it_lists() {
        let registry = registry();
        assert_eq!(registry.len(), 1);

        let chart = registry.find("chart").expect("chart");
        assert_eq!(chart.summary, "open a balance chart in a window");
        assert_eq!(chart.group_or_default(), "Reports");
        assert_eq!(chart.repository, "https://example.invalid/plugins.json");
        assert_eq!(chart.module, "./chart.js");

        // The manifest is authoritative for everything the app needs before running
        // anything: completion, help, and who owns the word.
        assert_eq!(registry.words(), vec!["chart", "balance", "expenses"]);
        assert_eq!(
            registry.help_entries(),
            vec![("Reports", "chart", "open a balance chart in a window")]
        );
        assert_eq!(
            registry
                .owner("chart balance -M")
                .map(|plugin| plugin.name.as_str()),
            Some("chart")
        );
        assert!(registry.owner("charting").is_none());
        assert!(registry.owner("balance").is_none());
        assert_eq!(
            registry.repositories(),
            vec!["https://example.invalid/plugins.json"]
        );
    }

    #[test]
    fn a_plugin_may_offer_themes() {
        let registry = registry();
        assert_eq!(registry.themes().len(), 1);
        assert_eq!(registry.themes()[0].0, "chart");
        let theme = registry.theme("midnight").expect("the theme");
        assert_eq!(theme.colors["background"], "#0b1021");
        assert!(registry.theme("no-such-theme").is_none());
    }

    #[test]
    fn a_plugin_that_cannot_work_is_refused_without_losing_the_rest() {
        let manifest = r#"{
            "plugins": [
                {"name": "good", "summary": "fine"},
                {"name": "", "summary": "nameless"},
                {"name": "two words", "summary": "not a word"},
                {"name": "quiet"},
                {"name": "upload", "summary": "the app owns this one"},
                {"name": "good", "summary": "again"}
            ]
        }"#;
        let mut registry = Registry::default();
        let installed = registry
            .install(manifest, "https://example.invalid/p.json")
            .expect("a readable manifest");
        assert_eq!(installed.registered, vec!["good"]);
        assert_eq!(installed.refused.len(), 5, "{:?}", installed.refused);
        // A plugin with no group is filed under the default rather than nowhere.
        assert_eq!(
            registry.find("good").expect("good").group_or_default(),
            "Plugins"
        );
    }

    #[test]
    fn a_manifest_that_is_not_one_is_an_error() {
        let mut registry = Registry::default();
        let error = registry
            .install("not json", "https://example.invalid/p.json")
            .expect_err("not a manifest");
        assert!(error.contains("not a plugin manifest"), "{error}");
        assert!(registry.is_empty());

        // A readable manifest with nothing in it is not worth installing either.
        let error = registry
            .install("{\"plugins\": []}", "https://example.invalid/p.json")
            .expect_err("nothing to install");
        assert!(error.contains("lists no plugins"), "{error}");
    }

    #[test]
    fn removing_a_repository_takes_its_plugins_with_it() {
        let mut registry = registry();
        registry
            .install(
                r#"{"plugins": [{"name": "other", "summary": "another"}]}"#,
                "https://example.invalid/other.json",
            )
            .expect("a second repository");
        assert_eq!(registry.len(), 2);

        assert_eq!(
            registry.remove_repository("https://example.invalid/other.json"),
            1
        );
        assert_eq!(registry.len(), 1);
        assert!(registry.find("other").is_none());
        assert!(registry.find("chart").is_some());
        // Removing what is not installed changes nothing, and is not an error.
        assert_eq!(
            registry.remove_repository("https://example.invalid/other.json"),
            0
        );
    }

    #[test]
    fn shadowing_one_of_hledgers_commands_is_allowed_and_reported() {
        // A plugin that reimplements `balance` is the plugin's business, but the listing
        // should say so rather than leaving the user to find out.
        let mut registry = Registry::default();
        registry
            .install(
                r#"{"plugins": [{"name": "balance", "summary": "a different balance"}]}"#,
                "https://example.invalid/p.json",
            )
            .expect("a readable manifest");
        assert_eq!(registry.shadowed(), vec!["balance"]);
        assert!(registry.find("balance").is_some());
    }

    #[test]
    fn the_apps_own_words_are_never_a_plugins() {
        let mut registry = Registry::default();
        let installed = registry
            .install(
                r#"{"plugins": [
                    {"name": "upload", "summary": "no"},
                    {"name": "alias", "summary": "no"},
                    {"name": "clear", "summary": "no"}
                ]}"#,
                "https://example.invalid/p.json",
            )
            .expect("a readable manifest");
        assert!(installed.registered.is_empty(), "{:?}", installed.registered);
        assert_eq!(installed.refused.len(), 3);
        assert!(registry.is_empty());
    }
}
