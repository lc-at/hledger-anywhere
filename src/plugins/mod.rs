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

// Natively this module exists for its tests: the only code that drives it is
// wasm-gated, so its items look unused to `cargo test`'s build.
#![cfg_attr(not(target_arch = "wasm32"), allow(dead_code))]

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
/// Bundled means built in and always available, not part of the core: nothing
/// outside this module knows what they do.
pub fn bundled() -> &'static [&'static dyn Plugin] {
    &[&chart::Chart]
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

pub mod chart;

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
    fn a_plugin_is_found_by_its_word_and_by_the_line_that_uses_it() {
        let chart = find("chart").expect("chart is bundled");
        assert_eq!(chart.name(), "chart");
        assert!(find("no-such-plugin").is_none());

        // The whole line, not just a name: this is how the app decides.
        assert!(owner("chart balance expenses -M").is_some());
        assert!(owner("  chart").is_some());
        assert!(owner("balance").is_none());
        // A word that merely starts the same is a different word.
        assert!(owner("charting").is_none());
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

    #[test]
    fn a_plan_is_what_the_app_needs_to_carry_it_out() {
        let chart = find("chart").expect("chart is bundled");
        match chart.plan("balance expenses -M") {
            Plan::Run { command } => assert!(command.starts_with("balance expenses -M"), "{command}"),
            other => panic!("{other:?}"),
        }
        // A report with something in it is presented; a header with no rows is not,
        // and the app says so rather than showing blank space.
        assert!(
            chart
                .present("account,balance\n\"assets:bank\",\"$100.00\"\n", 80, 24)
                .is_some()
        );
        assert!(chart.present("account,balance\n", 80, 24).is_none());
    }
}
