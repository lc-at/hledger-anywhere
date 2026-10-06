//! The hledger engine boundary.
//!
//! `report` is pure: it turns a declarative [`report::ReportSpec`] into the argv
//! a given hledger WASM flavor expects. `bridge` is wasm-only glue that calls
//! into `window.hledgerWasi`, which drives the WASI worker.
//!
//! [`Engine`] is an enum with an inherent `async fn` rather than a trait object,
//! because wasm futures are `!Send` and a boxed `dyn Future` would need
//! `LocalBoxFuture` plumbing for no benefit in a browser-only application. The
//! request and response types are plain data, so a different backend (say, a
//! server running real hledger) remains a drop-in addition.

#![allow(dead_code)]

pub mod report;

#[cfg(target_arch = "wasm32")]
pub mod bridge;

use thiserror::Error;

use report::{Flavor, ReportSpec};

/// The journal used to check that the interim bridge is alive.
///
/// The bridge has no `--version` command and requires a file argument for every
/// invocation, so liveness is proved by actually running a trivial report.
pub const PROBE_JOURNAL: &str = "__probe.journal";

/// Body of [`PROBE_JOURNAL`]: the smallest valid double-entry journal.
const PROBE_JOURNAL_BODY: &str = "2024-01-01 probe\n    assets:probe    1\n    equity:probe   -1\n";

/// One file to make available to the engine.
///
/// `path` is relative to the loaded directory's root; the engine mounts the
/// whole set under `/data`, which is what lets `include` directives resolve.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct JournalFile {
    pub path: String,
    pub contents: String,
}

impl JournalFile {
    pub fn new(path: impl Into<String>, contents: impl Into<String>) -> Self {
        JournalFile {
            path: path.into(),
            contents: contents.into(),
        }
    }
}

/// What the engine produced for one invocation.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct HledgerOutput {
    pub argv: Vec<String>,
    pub stdout: String,
    pub stderr: String,
    pub exit_code: i32,
    /// Wall-clock time inside the worker, including module compile on first use.
    pub ms: f64,
}

impl HledgerOutput {
    /// Whether this run should be treated as a failure.
    ///
    /// A non-zero exit is the obvious case. The subtle one is the interim
    /// bridge, which prints `Unknown command: X` to stderr and then exits **0**:
    /// without this check that would look like a successful report with no rows,
    /// and the UI would claim the journal was empty.
    pub fn is_failure(&self) -> bool {
        self.exit_code != 0 || (!self.stderr.trim().is_empty() && self.stdout.trim().is_empty())
    }

    /// A single message describing the failure, preferring hledger's own stderr.
    pub fn failure_message(&self) -> String {
        let stderr = self.stderr.trim();
        if !stderr.is_empty() {
            return stderr.to_string();
        }
        if self.exit_code != 0 {
            return format!("hledger exited with status {}", self.exit_code);
        }
        "hledger produced no output".to_string()
    }
}

/// Anything that stops a report from being produced.
#[derive(Debug, Error, Clone, PartialEq, Eq)]
pub enum EngineError {
    /// The browser cannot run the engine at all (no module workers).
    #[error("this browser cannot run the hledger engine: {0}")]
    Unsupported(String),
    /// The WebAssembly module or the bridge itself is not available.
    #[error("the hledger engine is not available: {0}")]
    Missing(String),
    /// The bridge was reached but the call failed.
    #[error("the engine bridge failed: {0}")]
    Bridge(String),
}

/// One invocation: the argv to run, and the files to mount.
#[derive(Clone, Debug, PartialEq)]
pub struct HledgerRequest {
    /// Complete argv, including `argv[0]`.
    pub argv: Vec<String>,
    pub files: Vec<JournalFile>,
}

impl HledgerRequest {
    /// A report against one journal.
    pub fn report(
        spec: &ReportSpec,
        flavor: Flavor,
        journal: &str,
        files: Vec<JournalFile>,
    ) -> Self {
        HledgerRequest {
            argv: spec.argv(flavor, journal),
            files,
        }
    }

    /// A liveness check that works for both flavors.
    pub fn probe(flavor: Flavor) -> Self {
        match flavor {
            Flavor::HledgerCli => HledgerRequest {
                argv: ReportSpec::probe(flavor),
                files: Vec::new(),
            },
            Flavor::WasmBridge => HledgerRequest {
                argv: ReportSpec::text("accounts").argv(flavor, PROBE_JOURNAL),
                files: vec![JournalFile::new(PROBE_JOURNAL, PROBE_JOURNAL_BODY)],
            },
        }
    }
}

/// Which engine is in use.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Engine {
    /// The browser engine, with the argv dialect selected by `wasm.lock`.
    Wasm { flavor: Flavor },
    /// A canned engine for tests and for developing the UI without a wasm build.
    Mock,
}

impl Engine {
    /// The engine selected at build time by `wasm.lock`.
    pub fn configured() -> Self {
        Engine::Wasm {
            flavor: Flavor::configured(),
        }
    }

    /// The argv dialect this engine speaks.
    pub fn flavor(&self) -> Flavor {
        match self {
            Engine::Wasm { flavor } => *flavor,
            Engine::Mock => Flavor::HledgerCli,
        }
    }

    /// Run one invocation.
    ///
    /// A failed report is `Ok` with a non-zero exit code: the caller needs the
    /// stderr to display. `Err` is reserved for transport failures, which is the
    /// distinction [`HledgerOutput::is_failure`] does not cover.
    pub async fn run(&self, request: HledgerRequest) -> Result<HledgerOutput, EngineError> {
        match self {
            #[cfg(target_arch = "wasm32")]
            Engine::Wasm { .. } => bridge::run(&request).await,
            #[cfg(not(target_arch = "wasm32"))]
            Engine::Wasm { .. } => Err(EngineError::Unsupported(
                "the wasm engine is only available in a browser build".to_string(),
            )),
            Engine::Mock => Ok(mock_output(&request)),
        }
    }

    /// Check that the engine is present and can run.
    pub async fn probe(&self) -> Result<HledgerOutput, EngineError> {
        self.run(HledgerRequest::probe(self.flavor())).await
    }
}

/// A deterministic stand-in for the real engine, used by tests and by
/// `Engine::Mock`.
fn mock_output(request: &HledgerRequest) -> HledgerOutput {
    HledgerOutput {
        argv: request.argv.clone(),
        stdout: match request.argv.get(3).map(String::as_str) {
            Some("balance") => r#"[[["assets:probe","assets:probe",0,[{"acommodity":"$","aquantity":{"decimalMantissa":100,"decimalPlaces":2}}]]],[{"acommodity":"$","aquantity":{"decimalMantissa":100,"decimalPlaces":2}}]]"#.to_string(),
            Some("print") => "[]".to_string(),
            _ => String::new(),
        },
        stderr: String::new(),
        exit_code: 0,
        ms: 0.0,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn output(exit_code: i32, stdout: &str, stderr: &str) -> HledgerOutput {
        HledgerOutput {
            argv: Vec::new(),
            stdout: stdout.to_string(),
            stderr: stderr.to_string(),
            exit_code,
            ms: 0.0,
        }
    }

    #[test]
    fn a_clean_run_is_not_a_failure() {
        assert!(!output(0, "some output", "").is_failure());
        // Warnings on stderr with real output are still a success.
        assert!(!output(0, "rows", "warning: something").is_failure());
    }

    #[test]
    fn a_nonzero_exit_is_a_failure_even_with_output() {
        assert!(output(2, "partial output", "").is_failure());
    }

    #[test]
    fn exit_zero_with_only_stderr_is_a_failure() {
        // The interim bridge's signature failure: "Unknown command: X" on stderr
        // and exit code 0. Treating that as success would render an empty table.
        let failure = output(0, "", "Unknown command: incomestatement");
        assert!(failure.is_failure());
        assert_eq!(failure.failure_message(), "Unknown command: incomestatement");
    }

    #[test]
    fn failure_messages_prefer_stderr_and_never_are_empty() {
        assert_eq!(output(1, "", "hledger: parse error").failure_message(), "hledger: parse error");
        assert_eq!(output(3, "", "").failure_message(), "hledger exited with status 3");
        assert_eq!(output(0, "", "").failure_message(), "hledger produced no output");
    }

    #[test]
    fn report_requests_use_the_flavor_dialect_and_mount_files() {
        let files = vec![JournalFile::new("hledger.journal", "")];
        let request = HledgerRequest::report(
            &ReportSpec::json("balance"),
            Flavor::HledgerCli,
            "hledger.journal",
            files.clone(),
        );
        assert_eq!(
            request.argv,
            vec!["hledger", "-f", "/data/hledger.journal", "balance", "-O", "json"]
        );
        assert_eq!(request.files, files);
    }

    #[test]
    fn the_bridge_probe_actually_runs_a_report() {
        // With no --version command available, the only honest liveness check is
        // to run a report against a tiny journal.
        let request = HledgerRequest::probe(Flavor::WasmBridge);
        assert_eq!(request.argv[0], "hledger-wasm");
        assert_eq!(request.argv[1], "accounts");
        assert_eq!(request.files.len(), 1);
        assert_eq!(request.files[0].path, PROBE_JOURNAL);

        let cli = HledgerRequest::probe(Flavor::HledgerCli);
        assert_eq!(cli.argv, vec!["hledger", "--version"]);
        assert!(cli.files.is_empty());
    }

    #[cfg(not(target_arch = "wasm32"))]
    #[test]
    fn the_wasm_engine_reports_clearly_when_compiled_natively() {
        let engine = Engine::Wasm {
            flavor: Flavor::HledgerCli,
        };
        let error = futures_lite_block_on(engine.probe()).expect_err("must not run natively");
        assert!(matches!(error, EngineError::Unsupported(_)));
    }

    #[cfg(not(target_arch = "wasm32"))]
    #[test]
    fn the_mock_engine_answers_without_any_browser() {
        let engine = Engine::Mock;
        let request = HledgerRequest::report(
            &ReportSpec::json("balance"),
            Flavor::HledgerCli,
            "hledger.journal",
            Vec::new(),
        );
        let output = futures_lite_block_on(engine.run(request)).expect("mock must succeed");
        assert!(output.stdout.contains("assets:probe"));
        assert!(!output.is_failure());
    }

    /// Minimal executor so the async engine API can be tested natively without
    /// pulling in a runtime dependency.
    #[cfg(not(target_arch = "wasm32"))]
    fn futures_lite_block_on<F: std::future::Future>(future: F) -> F::Output {
        use std::task::{Context, Poll, Waker};

        let mut future = Box::pin(future);
        let mut context = Context::from_waker(Waker::noop());
        loop {
            match future.as_mut().poll(&mut context) {
                Poll::Ready(output) => return output,
                Poll::Pending => std::thread::yield_now(),
            }
        }
    }
}
