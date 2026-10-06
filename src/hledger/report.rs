//! Report descriptions and argv construction (pure).
//!
//! A [`ReportSpec`] describes *what* to run, and this module turns that into the
//! argv a particular hledger WASM build expects. Keeping it in one place means
//! the difference between the two artifacts is expressed once, as data, instead
//! of at every call site:
//!
//! | flavor | argv |
//! |---|---|
//! | `hledger-cli` | `hledger -f /data/<journal> <command> -O json [args...]` |
//! | `hledger-wasm-bridge` | `hledger-wasm <command> /data/<journal> [args...]` |
//!
//! The bridge form is not a subset with different flags; it is a different
//! program with a different interface (no `-f`, no output-format option, JSON
//! always, and only five commands). [`Flavor::capabilities`] makes those
//! differences queryable so the UI can degrade honestly rather than pass options
//! that would be silently ignored.

use serde::{Deserialize, Serialize};

/// Where a loaded directory is mounted inside the engine's filesystem.
///
/// The bridge writes the journal to a preopened in-memory directory; mounting it
/// under a stable path is what lets `include` directives resolve.
pub const DATA_DIR: &str = "/data";

/// Which hledger WASM build the app is driving, per `wasm.lock`.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum Flavor {
    /// The real hledger CLI, built by `scripts/build-hledger-wasm.sh`.
    HledgerCli,
    /// The interim `hledger-wasm@0.1.0` bridge, kept as a fallback artifact.
    WasmBridge,
}

/// The `wasm.lock` value for [`Flavor::HledgerCli`].
pub const FLAVOR_HLEDGER_CLI: &str = "hledger-cli";
/// The `wasm.lock` value for [`Flavor::WasmBridge`].
pub const FLAVOR_WASM_BRIDGE: &str = "hledger-wasm-bridge";

impl Flavor {
    /// Parse the `flavor` key from `wasm.lock`.
    pub fn parse(text: &str) -> Option<Self> {
        match text.trim() {
            FLAVOR_HLEDGER_CLI => Some(Flavor::HledgerCli),
            FLAVOR_WASM_BRIDGE => Some(Flavor::WasmBridge),
            _ => None,
        }
    }

    /// The flavor baked in from `wasm.lock` by `build.rs`.
    ///
    /// An unreadable or missing lock file yields an empty string, which falls
    /// back to the full CLI: that is the target state, and it is the flavor whose
    /// failures are the clearest to diagnose.
    pub fn configured() -> Self {
        Flavor::parse(env!("HLEDGER_WASM_FLAVOR")).unwrap_or(Flavor::HledgerCli)
    }

    /// A human-readable name for the UI.
    pub fn label(self) -> &'static str {
        match self {
            Flavor::HledgerCli => "hledger CLI",
            Flavor::WasmBridge => "hledger-wasm bridge (limited)",
        }
    }

    /// Whether report and query options actually do anything.
    ///
    /// The bridge accepts extra arguments and ignores them, which is worse than
    /// rejecting them: the user would see an option silently not take effect.
    pub fn supports_report_options(self) -> bool {
        matches!(self, Flavor::HledgerCli)
    }

    /// Which hledger commands this flavor can run.
    pub fn supports_command(self, command: &str) -> bool {
        match self {
            Flavor::HledgerCli => true,
            // Exactly the command set of the bridge's Main.hs. Anything else
            // prints "Unknown command" and still exits 0.
            Flavor::WasmBridge => matches!(
                command,
                "accounts" | "print" | "balance" | "aregister" | "commodities"
            ),
        }
    }
}

/// A single command to run against one journal.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ReportSpec {
    /// The hledger command, e.g. `balance`.
    pub command: &'static str,
    /// Report options and queries, in the order they should be passed.
    pub args: Vec<String>,
    /// Whether to ask for JSON. Meaningless for the bridge, which always emits
    /// JSON and has no output-format option, so it is dropped there.
    pub json: bool,
    /// The commodity to re-denominate amounts into, if the user chose a main
    /// currency.
    ///
    /// Held as a field rather than pushed into `args` so that the flavor which
    /// cannot honour it (the bridge accepts no options at all) structurally
    /// cannot receive it — an option that is silently ignored is worse than an
    /// absent one, because the user sees a setting that does nothing.
    pub value: Option<String>,
}

impl ReportSpec {
    /// A command whose output is JSON.
    pub fn json(command: &'static str) -> Self {
        ReportSpec {
            command,
            args: Vec::new(),
            json: true,
            value: None,
        }
    }

    /// A command whose output is plain text (an account list, for instance).
    pub fn text(command: &'static str) -> Self {
        ReportSpec {
            command,
            args: Vec::new(),
            json: false,
            value: None,
        }
    }

    /// Append one argument.
    pub fn arg(mut self, argument: impl Into<String>) -> Self {
        self.args.push(argument.into());
        self
    }

    /// Append several arguments.
    pub fn extend_args<I, S>(mut self, arguments: I) -> Self
    where
        I: IntoIterator<Item = S>,
        S: Into<String>,
    {
        self.args.extend(arguments.into_iter().map(Into::into));
        self
    }

    /// Re-denominate every amount into `commodity`, using market prices.
    ///
    /// This is the closest hledger has to "show me everything in my main
    /// currency": `--value=end,COMM` converts each amount at end-of-period
    /// market prices, and `--infer-market-prices` additionally lets it use
    /// prices implied by `@`/`@@` costs rather than only explicit `P` directive
    /// prices. Without the second flag, a journal that records costs inline but
    /// declares no prices converts nothing.
    ///
    /// A blank commodity is ignored, so an unset or empty setting degrades to
    /// "leave the amounts as they are" rather than producing invalid argv.
    ///
    /// Only the full CLI can honour this; see the `value` field for why it is
    /// stored rather than appended here.
    pub fn with_value(mut self, commodity: &str) -> Self {
        let commodity = commodity.trim();
        if !commodity.is_empty() {
            self.value = Some(commodity.to_string());
        }
        self
    }

    /// The full argv, including `argv[0]`, for one flavor and journal path.
    ///
    /// `journal` is a path relative to the loaded directory root; it is mounted
    /// at [`DATA_DIR`].
    pub fn argv(&self, flavor: Flavor, journal: &str) -> Vec<String> {
        let path = format!("{DATA_DIR}/{}", journal.trim_start_matches('/'));
        match flavor {
            Flavor::HledgerCli => {
                // `-f` comes first so the file applies to the command that
                // follows it, matching how hledger is normally invoked.
                let mut argv = vec![
                    "hledger".to_string(),
                    "-f".to_string(),
                    path,
                    self.command.to_string(),
                ];
                if self.json {
                    argv.push("-O".to_string());
                    argv.push("json".to_string());
                }
                // "Show it all in one commodity": convert at end-of-period
                // market prices, and allow prices implied by @/@@ costs as well
                // as explicit `P` directives.
                if let Some(commodity) = &self.value {
                    argv.push(format!("--value=end,{commodity}"));
                    argv.push("--infer-market-prices".to_string());
                }
                argv.extend(self.args.iter().cloned());
                argv
            }
            Flavor::WasmBridge => {
                // The bridge takes the command first, then the file, and has no
                // output-format option at all.
                //
                // `value` is dropped here on purpose: the bridge accepts extra
                // arguments and ignores them, so passing `--value` would leave
                // the user with a main-currency setting that visibly does
                // nothing. The panels hide the control on this flavor instead.
                let mut argv = vec![
                    "hledger-wasm".to_string(),
                    self.command.to_string(),
                    path,
                ];
                argv.extend(self.args.iter().cloned());
                argv
            }
        }
    }

    /// The argv that asks the engine to identify itself, if this flavor can.
    ///
    /// The bridge has no version command — its argv is always
    /// `<command> <file>` — so it can only print its usage line.
    pub fn probe(flavor: Flavor) -> Vec<String> {
        match flavor {
            Flavor::HledgerCli => vec!["hledger".to_string(), "--version".to_string()],
            Flavor::WasmBridge => vec!["hledger-wasm".to_string()],
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn flavor_round_trips_with_wasm_lock_values() {
        assert_eq!(Flavor::parse("hledger-cli"), Some(Flavor::HledgerCli));
        assert_eq!(
            Flavor::parse("  hledger-wasm-bridge\n"),
            Some(Flavor::WasmBridge)
        );
        assert_eq!(Flavor::parse("something-else"), None);
        assert_eq!(Flavor::parse(""), None);
    }

    #[test]
    fn cli_argv_puts_the_journal_first_and_requests_json() {
        let argv = ReportSpec::json("balance")
            .arg("--depth")
            .arg("2")
            .argv(Flavor::HledgerCli, "hledger.journal");
        assert_eq!(
            argv,
            vec![
                "hledger",
                "-f",
                "/data/hledger.journal",
                "balance",
                "-O",
                "json",
                "--depth",
                "2"
            ]
        );
    }

    #[test]
    fn cli_argv_omits_json_for_text_commands() {
        let argv = ReportSpec::text("accounts").argv(Flavor::HledgerCli, "a.journal");
        assert_eq!(argv, vec!["hledger", "-f", "/data/a.journal", "accounts"]);
        assert!(!argv.contains(&"json".to_string()));
    }

    #[test]
    fn bridge_argv_uses_its_own_command_order_and_drops_json() {
        // The bridge's interface is `<command> <file> [args...]`, and it has no
        // -O option: passing one would be ignored rather than rejected.
        let argv = ReportSpec::json("balance").argv(Flavor::WasmBridge, "hledger.journal");
        assert_eq!(argv, vec!["hledger-wasm", "balance", "/data/hledger.journal"]);
        assert!(!argv.contains(&"-O".to_string()));
        assert!(!argv.contains(&"-f".to_string()));
    }

    #[test]
    fn bridge_aregister_passes_the_account_as_a_positional_argument() {
        let argv = ReportSpec::json("aregister")
            .arg("assets:bank")
            .argv(Flavor::WasmBridge, "hledger.journal");
        assert_eq!(
            argv,
            vec![
                "hledger-wasm",
                "aregister",
                "/data/hledger.journal",
                "assets:bank"
            ]
        );
    }

    #[test]
    fn journal_paths_are_normalised_against_the_data_dir() {
        let with_leading_slash =
            ReportSpec::text("accounts").argv(Flavor::HledgerCli, "/sub/a.journal");
        assert_eq!(with_leading_slash[2], "/data/sub/a.journal");

        let nested = ReportSpec::text("accounts").argv(Flavor::HledgerCli, "sub/a.journal");
        assert_eq!(nested[2], "/data/sub/a.journal");
    }

    #[test]
    fn capabilities_describe_the_bridge_honestly() {
        assert!(Flavor::HledgerCli.supports_report_options());
        assert!(Flavor::HledgerCli.supports_command("incomestatement"));

        // The bridge ignores options, so the UI must not offer them.
        assert!(!Flavor::WasmBridge.supports_report_options());
        for command in ["accounts", "print", "balance", "aregister", "commodities"] {
            assert!(Flavor::WasmBridge.supports_command(command), "{command}");
        }
        for command in ["incomestatement", "balancesheet", "register", "roi", "stats"] {
            assert!(!Flavor::WasmBridge.supports_command(command), "{command}");
        }
    }

    #[test]
    fn probes_differ_because_the_bridge_has_no_version_command() {
        assert_eq!(
            ReportSpec::probe(Flavor::HledgerCli),
            vec!["hledger", "--version"]
        );
        // Only a usage line is available from the bridge; the caller is expected
        // to treat that as "flavor known from wasm.lock, version unknown".
        assert_eq!(ReportSpec::probe(Flavor::WasmBridge), vec!["hledger-wasm"]);
    }

    #[test]
    fn extend_args_appends_in_order() {
        let spec = ReportSpec::json("balance").extend_args(["--tree", "--depth", "3"]);
        assert_eq!(spec.args, vec!["--tree", "--depth", "3"]);
    }

    #[test]
    fn a_main_currency_becomes_the_value_and_inferred_market_prices() {
        let argv = ReportSpec::json("balance")
            .with_value("EUR")
            .argv(Flavor::HledgerCli, "a.journal");
        assert!(argv.contains(&"--value=end,EUR".to_string()), "{argv:?}");
        assert!(
            argv.contains(&"--infer-market-prices".to_string()),
            "without this, a journal that records costs inline but declares no \
             prices would convert nothing: {argv:?}"
        );
        // The user's own arguments are still passed, after the valuation.
        let argv = ReportSpec::json("balance")
            .arg("--tree")
            .with_value("EUR")
            .argv(Flavor::HledgerCli, "a.journal");
        assert_eq!(argv.last(), Some(&"--tree".to_string()));
    }

    #[test]
    fn a_blank_main_currency_changes_nothing() {
        // An unset setting must not produce an empty `--value=end,`.
        let plain = ReportSpec::json("balance").argv(Flavor::HledgerCli, "a.journal");
        for blank in ["", "   "] {
            let argv = ReportSpec::json("balance")
                .with_value(blank)
                .argv(Flavor::HledgerCli, "a.journal");
            assert_eq!(argv, plain);
        }
    }

    #[test]
    fn the_bridge_never_receives_the_valuation_option() {
        // The bridge ignores extra arguments, so passing --value would leave the
        // user with a setting that visibly does nothing. It must be dropped.
        let argv = ReportSpec::json("balance")
            .with_value("EUR")
            .argv(Flavor::WasmBridge, "a.journal");
        assert_eq!(argv, vec!["hledger-wasm", "balance", "/data/a.journal"]);
        assert!(!argv.iter().any(|arg| arg.starts_with("--value")));
        assert!(!argv.contains(&"--infer-market-prices".to_string()));
    }

    #[test]
    fn configured_flavor_is_always_valid() {
        // build.rs always writes the variable, even when wasm.lock is missing.
        let flavor = Flavor::configured();
        assert!(matches!(flavor, Flavor::HledgerCli | Flavor::WasmBridge));
    }
}
