//! The hledger engine boundary.
//!
//! One engine: the real hledger CLI built for wasm32-wasi, pinned by `wasm.lock`
//! and driven through `window.hledgerWasi`. The interim npm "bridge" artifact and
//! the argv dialect it needed are gone, which is why nothing here converts a
//! declarative report into a command line — the user types the command line.
//!
//! The types are plain data and the module compiles natively, so the parts worth
//! testing (what counts as a failure, what a failure says) are covered by
//! `cargo test`. Only [`bridge`] touches the browser.

// Natively this module exists for its tests: the only code that uses it is
// wasm-gated, so its items look unused to `cargo test`'s build.
#![cfg_attr(not(target_arch = "wasm32"), allow(dead_code))]

#[cfg(target_arch = "wasm32")]
pub mod bridge;

use thiserror::Error;

/// Where uploaded files are mounted inside the engine's filesystem.
///
/// Everything the user uploads lands under this directory, at its uploaded
/// relative path, so `include` directives between uploaded files resolve. The
/// preopen is `/`; WASI resolves paths relative to a preopen and rejects absolute
/// paths, which is why the mount point is a directory rather than the root.
pub const DATA_DIR: &str = "/data";

/// One file to make available to the engine, at a path relative to the upload.
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

/// Where the engine will find `path` once the files are mounted.
///
/// This is what `LEDGER_FILE` is set to, which is what lets the user type
/// `hledger balance` with no `-f`.
pub fn mounted_path(path: &str) -> String {
    format!("{DATA_DIR}/{}", path.trim_start_matches('/'))
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
    /// Files the run created or changed in the mounted directory.
    ///
    /// `-o FILE` writes a report instead of printing it, and the mount is
    /// in-memory, so without carrying these back the file would vanish with the
    /// run. hledger can also rewrite a journal in place; that turns up here too.
    pub written: Vec<JournalFile>,
}

impl HledgerOutput {
    /// Whether this run should be treated as a failure.
    ///
    /// A non-zero exit is the obvious case. The subtle one is hledger exiting 0
    /// with something on stderr and nothing on stdout — a warning that is really
    /// the whole story, which the terminal should colour as an error.
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

/// Anything that stops a command from being produced.
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
    /// The user stopped the command. Not a failure, and not worth printing as one.
    #[error("cancelled")]
    Cancelled,
}

/// One invocation: the argv to run, and the files to mount.
#[derive(Clone, Debug, PartialEq)]
pub struct HledgerRequest {
    /// Complete argv, including `argv[0]`.
    pub argv: Vec<String>,
    pub files: Vec<JournalFile>,
}

impl HledgerRequest {
    pub fn new(argv: Vec<String>, files: Vec<JournalFile>) -> Self {
        HledgerRequest { argv, files }
    }
}

/// Compile the module ahead of the first command.
///
/// Optional — a run compiles on demand — but doing it up front means the first
/// command is not the thing that waits for the whole 13 MB download.
#[cfg(target_arch = "wasm32")]
pub async fn init() -> Result<(), EngineError> {
    bridge::init().await
}

/// Set the environment the engine runs in: the journal, and the terminal size.
///
/// `ledger_file` of `None` makes hledger fall back to `$HOME/.hledger.journal`
/// and fail honestly when there is nothing there. The size is what hledger
/// formats reports to; `None` leaves it on its 80-column default.
#[cfg(target_arch = "wasm32")]
pub async fn configure(
    ledger_file: Option<&str>,
    columns: Option<u32>,
    lines: Option<u32>,
) -> Result<(), EngineError> {
    bridge::configure(ledger_file, columns, lines).await
}

/// Run one invocation.
///
/// A failed command is `Ok` with a non-zero exit code: the terminal needs the
/// stderr to display. `Err` is reserved for transport failures and for
/// [`EngineError::Cancelled`].
#[cfg(target_arch = "wasm32")]
pub async fn run(request: HledgerRequest) -> Result<HledgerOutput, EngineError> {
    bridge::run(&request).await
}

/// Stop the command that is running.
///
/// The engine runs one synchronous `_start()` in its worker and cannot be asked
/// to stop, so this throws the worker away. Whoever calls it must configure the
/// engine again afterwards: a new worker knows nothing about the journal or the
/// terminal size.
#[cfg(target_arch = "wasm32")]
pub async fn cancel() -> Result<(), EngineError> {
    bridge::cancel().await
}

#[cfg(not(target_arch = "wasm32"))]
pub async fn init() -> Result<(), EngineError> {
    Err(native_error())
}

#[cfg(not(target_arch = "wasm32"))]
pub async fn configure(
    _ledger_file: Option<&str>,
    _columns: Option<u32>,
    _lines: Option<u32>,
) -> Result<(), EngineError> {
    Err(native_error())
}

#[cfg(not(target_arch = "wasm32"))]
pub async fn run(_request: HledgerRequest) -> Result<HledgerOutput, EngineError> {
    Err(native_error())
}

#[cfg(not(target_arch = "wasm32"))]
pub async fn cancel() -> Result<(), EngineError> {
    Err(native_error())
}

#[cfg(not(target_arch = "wasm32"))]
fn native_error() -> EngineError {
    EngineError::Unsupported("the wasm engine is only available in a browser build".to_string())
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
            written: Vec::new(),
        }
    }

    #[test]
    fn a_clean_run_is_not_a_failure() {
        assert!(!output(0, "some output", "").is_failure());
        // A warning beside real output is still a success.
        assert!(!output(0, "rows", "warning: something").is_failure());
    }

    #[test]
    fn a_nonzero_exit_is_a_failure_even_with_output() {
        assert!(output(2, "partial output", "").is_failure());
    }

    #[test]
    fn exit_zero_with_only_stderr_is_a_failure() {
        // hledger can warn and exit 0 with nothing on stdout. The terminal should
        // colour that as a problem, not print it as the report.
        assert!(output(0, "", "no journal file was specified").is_failure());
    }

    #[test]
    fn a_failure_message_prefers_stderr_and_is_never_empty() {
        assert_eq!(output(1, "", "hledger: parse error").failure_message(), "hledger: parse error");
        assert_eq!(output(3, "", "").failure_message(), "hledger exited with status 3");
        assert_eq!(output(0, "", "").failure_message(), "hledger produced no output");
    }

    #[test]
    fn uploaded_files_are_mounted_under_the_data_directory() {
        assert_eq!(mounted_path("books/2024.journal"), "/data/books/2024.journal");
        assert_eq!(mounted_path("/leading.journal"), "/data/leading.journal");
    }

    #[test]
    fn a_request_carries_its_argv_and_files_unchanged() {
        // Nothing rewrites the user's command any more: what they typed is what
        // runs, which is the whole point of setting LEDGER_FILE instead of
        // injecting -f.
        let files = vec![JournalFile::new("hledger.journal", "")];
        let request = HledgerRequest::new(
            vec!["hledger".to_string(), "balance".to_string(), "--tree".to_string()],
            files.clone(),
        );
        assert_eq!(request.argv, ["hledger", "balance", "--tree"]);
        assert_eq!(request.files, files);
    }

    #[cfg(not(target_arch = "wasm32"))]
    #[test]
    fn the_native_build_reports_clearly_instead_of_pretending() {
        let error = block_on(run(HledgerRequest::new(vec!["hledger".to_string()], Vec::new())))
            .expect_err("must not run natively");
        assert!(matches!(error, EngineError::Unsupported(_)));
    }

    /// Minimal executor so the async API can be tested natively without pulling
    /// in a runtime dependency.
    #[cfg(not(target_arch = "wasm32"))]
    fn block_on<F: std::future::Future>(future: F) -> F::Output {
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
