//! Console panel: what the engine was asked to do, and what came back.
//!
//! This panel is the debugging surface for the whole platform. Every hledger
//! invocation records its argv, exit code, duration and output sizes, so a
//! report showing the wrong number can be traced to the exact command that
//! produced it — including the arguments the panel chose on the user's behalf.

use leptos::prelude::*;

use crate::layout::model::PanelId;
use crate::panels::message_panel;
use crate::state::{AppState, EngineStatus, LogEntry};

pub fn view(_id: PanelId) -> AnyView {
    let state = expect_context::<AppState>();

    let badge_class = move || match state.engine_status.get() {
        EngineStatus::Ready { .. } => "engine-badge engine-badge-ready",
        EngineStatus::Unavailable(_) | EngineStatus::Error(_) => "engine-badge engine-badge-error",
        EngineStatus::Unknown | EngineStatus::Checking => "engine-badge",
    };

    let badge_text = move || {
        let flavor = state.flavor.get().label();
        match state.engine_status.get() {
            EngineStatus::Unknown => format!("{flavor} — not checked"),
            EngineStatus::Checking => format!("{flavor} — checking…"),
            EngineStatus::Ready { version } => match version {
                Some(version) => format!("{flavor} — {version}"),
                None => format!("{flavor} — ready"),
            },
            EngineStatus::Unavailable(message) => format!("{flavor} — unavailable: {message}"),
            EngineStatus::Error(message) => format!("{flavor} — error: {message}"),
        }
    };

    // A remedy, shown only when there is something the user can do about it.
    let remedy = move || match state.engine_status.get() {
        EngineStatus::Unavailable(message)
            if message.contains("404") || message.contains("load") =>
        {
            Some(
                "hledger.wasm did not load. Run `sh scripts/fetch-hledger-wasm.sh` for the \
                 pinned artifact, or `sh scripts/build-hledger-wasm.sh` to build the full \
                 hledger CLI, then restart `trunk serve` and reload this page.",
            )
        }
        _ => None,
    };

    view! {
        <div class="panel panel-console">
            <div class="panel-toolbar">
                <span class=badge_class>{badge_text}</span>
                <button class="gl-btn" on:click=move |_| state.check_engine()>
                    "Check engine"
                </button>
                <button class="gl-btn" on:click=move |_| state.log.set(Vec::new())>
                    "Clear"
                </button>
            </div>

            {move || {
                remedy()
                    .map(|text| view! { <p class="panel-remedy">{text}</p> }.into_any())
                    .unwrap_or_else(|| ().into_any())
            }}

            <div class="console-log">
                {move || {
                    let entries = state.log.get();
                    if entries.is_empty() {
                        return message_panel("No engine calls yet. Load a journal to begin.");
                    }
                    entries.into_iter().rev().map(entry_view).collect_view().into_any()
                }}
            </div>
        </div>
    }
    .into_any()
}

/// One log entry.
///
/// Everything is built eagerly, with plain `if` expressions rather than `Show`.
/// That is deliberate: each entry is rebuilt whenever the log changes, so
/// per-entry reactivity buys nothing, while nesting `Show` inside a list would
/// require every captured value to be re-cloneable on each reactive re-run.
/// With eager building, the values are simply moved into the view once.
fn entry_view(entry: LogEntry) -> AnyView {
    let failed = entry.failure;
    let argv = entry.argv.join(" ");
    let summary = match &entry.error {
        Some(error) => error.clone(),
        None => format!(
            "exit {} · {:.0} ms · {} B out · {} B err",
            entry.exit_code, entry.ms, entry.stdout_bytes, entry.stderr_bytes,
        ),
    };

    let stderr = entry.stderr;
    let stdout = entry.stdout_preview;
    let has_output = !stderr.is_empty() || !stdout.is_empty();

    let status_class = if failed {
        "console-status console-status-fail"
    } else {
        "console-status console-status-ok"
    };

    let raw = if has_output {
        let stderr_block: AnyView = if stderr.is_empty() {
            ().into_any()
        } else {
            view! { <pre class="console-pre console-pre-err">{stderr}</pre> }.into_any()
        };
        let stdout_block: AnyView = if stdout.is_empty() {
            ().into_any()
        } else {
            view! { <pre class="console-pre">{stdout}</pre> }.into_any()
        };
        view! {
            <details class="console-details">
                <summary>"raw output"</summary>
                {stderr_block}
                {stdout_block}
            </details>
        }
        .into_any()
    } else {
        ().into_any()
    };

    view! {
        <div class="console-entry" class:console-entry-fail=failed>
            <div class="console-entry-head">
                <span class=status_class>{if failed { "✗" } else { "✓" }}</span>
                <code class="console-argv">{argv}</code>
            </div>
            <div class="console-entry-summary">{summary}</div>
            {raw}
        </div>
    }
    .into_any()
}
