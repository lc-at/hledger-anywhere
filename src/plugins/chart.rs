//! The chart plugin: a report, drawn rather than printed.
//!
//! Everything specific to charts lives here and in [`crate::chart`], which does the
//! drawing. The app knows only that a plugin may want to present output itself.

// Natively this module exists for its tests: the only code that drives it is
// wasm-gated, so its items look unused to `cargo test`'s build.
#![cfg_attr(not(target_arch = "wasm32"), allow(dead_code))]

use super::{Plan, Plugin};
use crate::terminal;

/// What a chart is asked for when nothing is said.
const DEFAULT: &str = "balance -M expenses";

pub struct Chart;

impl Plugin for Chart {
    fn name(&self) -> &'static str {
        "chart"
    }

    fn group(&self) -> &'static str {
        "Reports"
    }

    fn summary(&self) -> &'static str {
        "draw a report instead of printing it"
    }

    fn plan(&self, arguments: &str) -> Plan {
        let arguments = arguments.trim();
        let command = if arguments.is_empty() {
            DEFAULT.to_string()
        } else {
            arguments.to_string()
        };

        // CSV is the only output that keeps accounts, periods and amounts apart
        // without parsing a text table whose columns move, so it is asked for unless
        // the caller named a format of their own.
        let wanted = match terminal::tokenize(&command) {
            Ok(tokens) => !tokens
                .iter()
                .any(|token| token == "-O" || token == "--output-format"),
            Err(complaint) => return Plan::Say(complaint),
        };
        let command = if wanted {
            format!("{command} -O csv")
        } else {
            command
        };

        Plan::Run { command }
    }

    fn present(&self, output: &str, width: usize, height: usize) -> Option<Vec<String>> {
        let lines = crate::chart::render(output, width, height);
        (!lines.is_empty()).then_some(lines)
    }

    fn note(&self, command: &str) -> String {
        format!(
            "[{} {}, {}]",
            terminal::dim("chart of"),
            terminal::bold(command),
            terminal::dim("drawn from hledger's numbers")
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn planned(arguments: &str) -> String {
        match Chart.plan(arguments) {
            Plan::Run { command } => command,
            other => panic!("{other:?}"),
        }
    }

    #[test]
    fn a_chart_asks_hledger_for_csv() {
        assert!(planned("balance expenses -M").ends_with("-O csv"));
    }

    #[test]
    fn with_nothing_to_go_on_it_asks_its_own_question() {
        assert!(planned("").starts_with(DEFAULT), "{}", planned(""));
        assert!(planned("   ").starts_with(DEFAULT));
    }

    #[test]
    fn a_format_the_caller_chose_is_left_alone() {
        // Asking twice would put `-O csv` after their `-O json`, and hledger would
        // take the last one.
        assert_eq!(planned("balance -O json"), "balance -O json");
        assert_eq!(
            planned("balance --output-format tsv"),
            "balance --output-format tsv"
        );
    }

    #[test]
    fn an_unclosed_quote_is_reported_rather_than_run() {
        match Chart.plan("balance -p \"this year") {
            Plan::Say(message) => assert!(message.contains("not closed"), "{message}"),
            other => panic!("{other:?}"),
        }
    }

    #[test]
    fn it_draws_a_report_and_says_nothing_about_one_it_cannot() {
        let drawn = Chart
            .present("account,balance\n\"assets:bank\",\"$100.00\"\n", 80, 20)
            .expect("a ranking to draw");
        assert!(drawn.iter().any(|line| line.contains("assets:bank")), "{drawn:?}");

        // Nothing to draw is reported by the app rather than shown as blank space.
        assert!(Chart.present("", 80, 20).is_none());
        assert!(Chart.present("not a csv at all", 80, 20).is_none());
    }

    #[test]
    fn the_note_says_which_command_was_drawn() {
        let note = terminal::plain(&Chart.note("balance --depth 2"));
        assert!(note.contains("balance --depth 2"), "{note}");
        assert!(note.contains("drawn from hledger's numbers"), "{note}");
    }
}
