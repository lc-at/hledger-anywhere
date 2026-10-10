//! Plugins: commands that are not the core's.
//!
//! The core of this app is a terminal, a set of loaded files, and a way to run
//! hledger on them. Anything beyond that is a plugin's business, and `chart` is the
//! first one: it used to be a command in the core, with its own word in the
//! vocabulary, its own branch in the dispatch, its own note, and its own finish. It
//! is now a plugin that says what it wants and does its own showing.
//!
//! A plugin is deliberately small. It declares a word, how it reads in the help,
//! what it adds to completion, what to do with the text typed after the name, and
//! how to present output if it wants it presented differently. It never touches the
//! app, so a plugin can be tested on its own, and adding one is adding a file and a
//! line in [`bundled`].

// The plugin contract is an extension point with nothing behind it yet: no plugin is
// bundled, so nothing in a build constructs these types until one is added or the
// registry is filled at runtime. The tests exercise every part of it.
#![allow(dead_code)]

use crate::terminal;

/// What a plugin wants to happen.
///
/// A plugin does not run anything: it describes, and the app carries it out. That is
/// what keeps a plugin testable, and what keeps the app's own machinery in one place.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Plan {
    /// Run this hledger command line.
    Run { command: String },
    /// Say this, and stop.
    Say(String),
}

/// A command the app does not implement itself.
pub trait Plugin: Sync {
    /// The word that invokes it.
    fn name(&self) -> &'static str;

    /// The help section it belongs in.
    fn group(&self) -> &'static str;

    /// One line for the help.
    fn summary(&self) -> &'static str;

    /// Extra words this plugin contributes to completion.
    fn completes(&self) -> &'static [&'static str] {
        &[]
    }

    /// What to do with the text typed after the name.
    fn plan(&self, arguments: &str) -> Plan;

    /// How to show output caused by this plugin's plan, or `None` to let the app
    /// print it the way hledger wrote it.
    ///
    /// This is the whole of "the app can draw things": a plugin that wants to draw
    /// returns the lines to draw, and one that does not gets the ordinary terminal.
    /// Nothing in the app knows what a chart is.
    fn present(&self, _output: &str, _width: usize, _height: usize) -> Option<Vec<String>> {
        None
    }

    /// The line printed above presented output, if any.
    fn note(&self, _command: &str) -> String {
        String::new()
    }
}

/// The bundled plugins, in the order the help lists them.
///
/// Bundled means built in and always available, not part of the core: nothing outside
/// this module knows what they do. Nothing is bundled today. `chart` was the first
/// one, and the tool it drew is gone; the list is empty until a plugin is added, and
/// the machinery stays because it is what a plugin plugs into.
pub fn bundled() -> &'static [&'static dyn Plugin] {
    &[]
}

/// The plugin that answers to `name`, if one does.
pub fn find(name: &str) -> Option<&'static dyn Plugin> {
    bundled()
        .iter()
        .copied()
        .find(|plugin| plugin.name() == name)
}

/// The plugin that owns the first word of `line`, if one does.
pub fn owner(line: &str) -> Option<&'static dyn Plugin> {
    let (head, _) = terminal::split_first_token(line);
    find(&head)
}

/// A plugin's line in the help: group, form, and what it does.
pub fn help_entries() -> Vec<(&'static str, &'static str, &'static str)> {
    bundled()
        .iter()
        .map(|plugin| (plugin.group(), plugin.name(), plugin.summary()))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A plugin that does nothing but what the trait defaults do, so the defaults
    /// are exercised rather than assumed.
    struct Plain;

    impl Plugin for Plain {
        fn name(&self) -> &'static str {
            "plain"
        }
        fn group(&self) -> &'static str {
            "Reports"
        }
        fn summary(&self) -> &'static str {
            "do the ordinary thing"
        }
        fn plan(&self, arguments: &str) -> Plan {
            Plan::Run {
                command: format!("balance {arguments}").trim_end().to_string(),
            }
        }
    }

    #[test]
    fn every_bundled_plugin_says_what_it_is_for() {
        for plugin in bundled() {
            assert!(!plugin.name().is_empty(), "a plugin with no name");
            assert!(
                !plugin.name().contains(char::is_whitespace),
                "{} is more than one word",
                plugin.name()
            );
            assert!(!plugin.group().is_empty(), "{} has no help group", plugin.name());
            assert!(!plugin.summary().is_empty(), "{} has no summary", plugin.name());
        }
    }

    #[test]
    fn nothing_is_bundled_and_the_registry_says_so() {
        assert!(bundled().is_empty(), "a plugin is bundled: {}", bundled().len());
        // With nothing bundled, nothing is claimed, and looking one up is not a
        // panic: this is the state the app starts in.
        assert!(find("chart").is_none());
        assert!(owner("chart balance expenses -M").is_none());
        assert!(owner("balance").is_none());
        assert!(help_entries().is_empty());
    }

    #[test]
    fn the_help_lists_every_plugin() {
        let entries = help_entries();
        assert_eq!(entries.len(), bundled().len());
        for plugin in bundled() {
            assert!(
                entries.iter().any(|(_, name, _)| *name == plugin.name()),
                "{} is missing from the help",
                plugin.name()
            );
        }
    }

    #[test]
    fn a_plugin_that_does_not_ask_to_present_gets_the_ordinary_terminal() {
        // The defaults are the contract for a plugin that only wants to run
        // something: no drawing, no note, and no completion of its own.
        assert!(Plain.present("anything", 80, 24).is_none());
        assert!(Plain.note("balance").is_empty());
        assert!(Plain.completes().is_empty());

        let plan = Plain.plan("expenses -M");
        match plan {
            Plan::Run { command } => assert_eq!(command, "balance expenses -M"),
            other => panic!("{other:?}"),
        }
    }

    /// A plugin that presents its own output, so that half of the contract is
    /// exercised even while nothing is bundled.
    struct Drawn;

    impl Plugin for Drawn {
        fn name(&self) -> &'static str {
            "drawn"
        }
        fn group(&self) -> &'static str {
            "Reports"
        }
        fn summary(&self) -> &'static str {
            "present output itself"
        }
        fn plan(&self, arguments: &str) -> Plan {
            Plan::Run {
                command: format!("balance {arguments}").trim_end().to_string(),
            }
        }
        fn present(&self, output: &str, _width: usize, _height: usize) -> Option<Vec<String>> {
            let lines: Vec<String> = output.lines().map(|line| line.to_string()).collect();
            (!lines.is_empty()).then_some(lines)
        }
        fn note(&self, command: &str) -> String {
            format!("[{command}]")
        }
    }

    #[test]
    fn a_plugin_that_presents_its_own_output_says_how() {
        match Drawn.plan("expenses") {
            Plan::Run { command } => assert_eq!(command, "balance expenses"),
            other => panic!("{other:?}"),
        }
        // Something to show is shown; nothing to show is reported by the app.
        assert_eq!(
            Drawn.present("a\nb\n", 80, 24),
            Some(vec!["a".to_string(), "b".to_string()])
        );
        assert!(Drawn.present("", 80, 24).is_none());
        assert_eq!(Drawn.note("balance"), "[balance]");
    }
}
