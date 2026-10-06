//! Terminal panel: an interactive hledger command line.
//!
//! Unlike the report panels, this one does not go through a [`ReportSpec`]:
//! hledger's command name is a `&'static str` there, and the whole point of a
//! terminal is that the user may type anything. The argv is therefore built here
//! and handed to [`Engine::run`] through [`HledgerRequest`], reproducing the
//! same journal mounting (`-f /data/<file>`, plus a generated include-root when
//! one is in use) that [`AppState::run`] performs.
//!
//! Output is shown verbatim: stdout in a monospace block, stderr in the error
//! style, and the exit status underneath. A bridge "Unknown command: X" arrives
//! as exit 0 with empty stdout, so the status uses [`HledgerOutput::is_failure`]
//! rather than the exit code alone.
//!
//! [`ReportSpec`]: crate::hledger::report::ReportSpec
//! [`Engine::run`]: crate::hledger::Engine::run
//! [`AppState::run`]: crate::state::AppState::run

use leptos::ev::KeyboardEvent;
use leptos::prelude::*;
use wasm_bindgen_futures::spawn_local;

use crate::hledger::report::{DATA_DIR, Flavor, ReportSpec};
use crate::hledger::{HledgerRequest, JournalFile};
use crate::journal::model::parse_line_list;
use crate::layout::model::PanelId;
use crate::panels::message_panel;
use crate::state::AppState;

/// `localStorage` key for the command history, versioned like the other keys.
const HISTORY_KEY: &str = "hledger-anywhere.terminal.history.v1";

/// How many history entries are kept, and how many scrollback lines.
const MAX_HISTORY: usize = 100;
const MAX_SCROLLBACK: usize = 400;

/// hledger's commands, for tab completion. Not exhaustive — completion is a
/// convenience, and anything missing can still be typed out.
const COMMANDS: [&str; 34] = [
    "accounts",
    "activity",
    "add",
    "aregister",
    "balance",
    "balancesheet",
    "balancesheetequity",
    "cashflow",
    "check",
    "close",
    "codes",
    "commodities",
    "descriptions",
    "diff",
    "edit",
    "expenses",
    "files",
    "help",
    "import",
    "incomestatement",
    "journal",
    "payees",
    "prices",
    "print",
    "print-unique",
    "register",
    "rewrite",
    "roi",
    "stats",
    "tags",
    "test",
    "ui",
    "equity",
    "notes",
];

/// Common report and query flags, for tab completion.
const FLAGS: [&str; 32] = [
    "-O",
    "--output-format",
    "--tree",
    "--flat",
    "--depth",
    "--monthly",
    "--weekly",
    "--quarterly",
    "--yearly",
    "--daily",
    "--historical",
    "--cumulative",
    "--change",
    "--budget",
    "--value",
    "--no-total",
    "--begin",
    "--end",
    "--period",
    "--account",
    "--real",
    "--cleared",
    "--pending",
    "--unmarked",
    "--sort",
    "--invert",
    "--related",
    "--forecast",
    "--infer-market-prices",
    "--no-elide",
    "--help",
    "--version",
];

/// One line of the scrollback.
#[derive(Clone, Debug)]
enum TerminalLine {
    /// The command the user ran, echoed before its output.
    Command(String),
    /// A note from the panel itself, never from the engine.
    Info(String),
    Stdout(String),
    Stderr(String),
    Status {
        argv: String,
        exit_code: i32,
        ms: f64,
        failed: bool,
    },
}

pub fn view(_id: PanelId) -> AnyView {
    let state = expect_context::<AppState>();

    let input = RwSignal::new(String::new());
    let scrollback: RwSignal<Vec<TerminalLine>> = RwSignal::new(Vec::new());
    let history: RwSignal<Vec<String>> = RwSignal::new(load_history());
    let history_index: RwSignal<Option<usize>> = RwSignal::new(None);
    let json = RwSignal::new(false);
    // The account list is expensive to ask for, so it is fetched once per
    // journal and reused for every completion.
    let accounts: RwSignal<Vec<String>> = RwSignal::new(Vec::new());

    Effect::new(move |_| {
        let _ = state.generation.get();
        let _ = state.refresh.get();
        spawn_local(async move {
            let Ok(output) = state.run(ReportSpec::text("accounts")).await else {
                return;
            };
            if !output.is_failure() {
                accounts.set(parse_line_list(&output.stdout));
            }
        });
    });

    let submit = move || {
        let command = input.get_untracked().trim().to_string();
        if command.is_empty() {
            return;
        }
        input.set(String::new());
        history_index.set(None);

        if history.get_untracked().last() != Some(&command) {
            history.update(|list| {
                list.push(command.clone());
                let excess = list.len().saturating_sub(MAX_HISTORY);
                if excess > 0 {
                    list.drain(0..excess);
                }
            });
            save_history(&history.get_untracked());
        }

        scrollback.update(|lines| {
            lines.push(TerminalLine::Command(command.clone()));
            trim(lines);
        });

        match build_request(state, &command, json.get_untracked()) {
            Ok(request) => spawn_local(async move {
                let result = state.engine.run(request).await;
                scrollback.update(|lines| {
                    match result {
                        Ok(output) => {
                            let stdout = output.stdout.trim().to_string();
                            let stderr = output.stderr.trim().to_string();
                            if !stdout.is_empty() {
                                lines.push(TerminalLine::Stdout(stdout));
                            }
                            if !stderr.is_empty() {
                                lines.push(TerminalLine::Stderr(stderr));
                            }
                            if output.stdout.trim().is_empty() && output.stderr.trim().is_empty() {
                                lines.push(TerminalLine::Info("(no output)".to_string()));
                            }
                            lines.push(TerminalLine::Status {
                                argv: output.argv.join(" "),
                                exit_code: output.exit_code,
                                ms: output.ms,
                                failed: output.is_failure(),
                            });
                        }
                        Err(error) => {
                            lines.push(TerminalLine::Stderr(error.to_string()));
                        }
                    }
                    trim(lines);
                });
            }),
            Err(message) => scrollback.update(|lines| {
                lines.push(TerminalLine::Info(message));
                trim(lines);
            }),
        }
    };

    let recall_up = move || {
        let list = history.get_untracked();
        if list.is_empty() {
            return;
        }
        let next = match history_index.get_untracked() {
            None => list.len() - 1,
            Some(0) => 0,
            Some(current) => current - 1,
        };
        history_index.set(Some(next));
        input.set(list[next].clone());
    };

    let recall_down = move || {
        let list = history.get_untracked();
        match history_index.get_untracked() {
            None => {}
            Some(current) if current + 1 < list.len() => {
                history_index.set(Some(current + 1));
                input.set(list[current + 1].clone());
            }
            Some(_) => {
                history_index.set(None);
                input.set(String::new());
            }
        }
    };

    let autocomplete = move || {
        let line = input.get_untracked();
        let token = current_token(&line).to_string();

        let mut candidates: Vec<String> = Vec::new();
        candidates.extend(COMMANDS.iter().map(|command| (*command).to_string()));
        candidates.extend(FLAGS.iter().map(|flag| (*flag).to_string()));
        candidates.extend(accounts.get_untracked());
        candidates.extend(
            state
                .files
                .get_untracked()
                .iter()
                .map(|file| file.path.clone()),
        );

        let matches = matches_for(&token, &candidates);
        match matches.as_slice() {
            [] => {}
            [only] => input.set(replace_token(&line, &format!("{only} "))),
            many => {
                let prefix = common_prefix(many);
                if prefix.len() > token.len() {
                    input.set(replace_token(&line, &prefix));
                } else {
                    let listing = many.join("  ");
                    scrollback.update(|lines| {
                        lines.push(TerminalLine::Info(listing));
                        trim(lines);
                    });
                }
            }
        }
    };

    // The toggle asks for JSON on the full CLI. The bridge always emits JSON and
    // ignores `-O`, so the control is hidden there rather than shown and lost.
    let json_toggle = move || {
        if !state.flavor.get().supports_report_options() {
            return ().into_any();
        }
        view! {
            <label>
                <input
                    type="checkbox"
                    prop:checked=move || json.get()
                    on:change=move |_| json.update(|value| *value = !*value)
                />
                "JSON"
            </label>
        }
        .into_any()
    };

    view! {
        <div class="panel panel-terminal">
            <div class="panel-toolbar">
                <button class="gl-btn" on:click=move |_| submit()>
                    "Run"
                </button>
                <button
                    class="gl-btn"
                    on:click=move |_| {
                        scrollback.set(Vec::new());
                    }
                >
                    "Clear"
                </button>
                {json_toggle}
            </div>

            <div class="console-log">
                {move || {
                    let lines = scrollback.get();
                    if lines.is_empty() {
                        return message_panel(
                            "Type an hledger command: `balancesheet`, `balance assets --tree`, \
                             or `print -O json`.",
                        );
                    }
                    lines.into_iter().map(line_view).collect_view().into_any()
                }}
            </div>

            <div class="panel-controls">
                <input
                    type="text"
                    style="flex: 1; min-width: 0;"
                    placeholder="hledger command…  (Tab completes, ↑/↓ recalls history)"
                    prop:value=move || input.get()
                    on:input=move |event| input.set(event_target_value(&event))
                    on:keydown=move |event: KeyboardEvent| {
                        match event.key().as_str() {
                            "Enter" => {
                                event.prevent_default();
                                submit();
                            }
                            "ArrowUp" => {
                                event.prevent_default();
                                recall_up();
                            }
                            "ArrowDown" => {
                                event.prevent_default();
                                recall_down();
                            }
                            "Tab" => {
                                event.prevent_default();
                                autocomplete();
                            }
                            _ => {}
                        }
                    }
                />
            </div>
        </div>
    }
    .into_any()
}

/// Render one scrollback line, reusing the Console panel's classes.
fn line_view(line: TerminalLine) -> AnyView {
    match line {
        TerminalLine::Command(command) => view! {
            <div class="console-entry-head">
                <span class="console-status-ok">"$"</span>
                <code class="console-argv">{command}</code>
            </div>
        }
        .into_any(),
        TerminalLine::Info(text) => view! { <div class="panel-count">{text}</div> }.into_any(),
        TerminalLine::Stdout(text) => view! { <pre class="console-pre">{text}</pre> }.into_any(),
        TerminalLine::Stderr(text) => {
            view! { <pre class="console-pre console-pre-err">{text}</pre> }.into_any()
        }
        TerminalLine::Status {
            argv,
            exit_code,
            ms,
            failed,
        } => {
            let class = if failed {
                "console-status console-status-fail"
            } else {
                "console-status console-status-ok"
            };
            let mark = if failed { "✗" } else { "✓" };
            view! {
                <div class="console-entry-summary">
                    <span class=class>{mark}</span>
                    {format!(" exit {exit_code} · {ms:.0} ms · {argv}")}
                </div>
            }
            .into_any()
        }
    }
}

/// Keep the scrollback bounded; the oldest lines are the least useful.
fn trim(lines: &mut Vec<TerminalLine>) {
    let excess = lines.len().saturating_sub(MAX_SCROLLBACK);
    if excess > 0 {
        lines.drain(0..excess);
    }
}

/// Build the argv a command line should run against the current journal.
///
/// This mirrors [`AppState::run`]'s mounting rules — the picked files plus the
/// generated include-root when there is one — but not its declaration of the
/// command, which is the whole reason the terminal cannot use a `ReportSpec`.
///
/// [`AppState::run`]: crate::state::AppState::run
fn build_request(state: AppState, command: &str, json: bool) -> Result<HledgerRequest, String> {
    let journal = state
        .main_journal
        .get_untracked()
        .ok_or_else(|| "Load a journal before running hledger.".to_string())?;

    let mut parts: Vec<String> = command.split_whitespace().map(str::to_string).collect();
    // Accept a leading program name, since that is how the command looks in a
    // shell and users paste commands.
    if parts.first().is_some_and(|first| first == "hledger" || first == "hledger-wasm") {
        parts.remove(0);
    }
    if parts.is_empty() {
        return Err("Type an hledger command first.".to_string());
    }

    let mut files = state.files.get_untracked().clone();
    if let Some((path, contents)) = journal.extra_file() {
        files.push(JournalFile::new(path, contents));
    }
    let path = format!("{DATA_DIR}/{}", journal.path().trim_start_matches('/'));

    let mut argv = Vec::new();
    match state.flavor.get_untracked() {
        Flavor::HledgerCli => {
            argv.push("hledger".to_string());
            argv.push("-f".to_string());
            argv.push(path);
            argv.extend(parts);
            if json {
                argv.push("-O".to_string());
                argv.push("json".to_string());
            }
        }
        Flavor::WasmBridge => {
            // The bridge's dialect is `<command> <file> [args...]`.
            argv.push("hledger-wasm".to_string());
            argv.push(parts.remove(0));
            argv.push(path);
            argv.extend(parts);
        }
    }

    Ok(HledgerRequest { argv, files })
}

// -- pure completion logic --------------------------------------------------

/// The token being completed: the text after the last whitespace.
fn current_token(input: &str) -> &str {
    match input.rfind(|character: char| character.is_whitespace()) {
        Some(index) => &input[index + 1..],
        None => input,
    }
}

/// Candidates that begin with `token`, sorted and deduplicated.
fn matches_for<'a>(token: &str, candidates: &'a [String]) -> Vec<&'a str> {
    let mut matches: Vec<&str> = candidates
        .iter()
        .map(String::as_str)
        .filter(|candidate| candidate.starts_with(token))
        .collect();
    matches.sort_unstable();
    matches.dedup();
    matches
}

/// The longest prefix every value shares.
fn common_prefix(values: &[&str]) -> String {
    let mut iter = values.iter();
    let Some(first) = iter.next() else {
        return String::new();
    };
    let mut prefix = (*first).to_string();
    for value in iter {
        while !value.starts_with(prefix.as_str()) {
            if prefix.pop().is_none() {
                return prefix;
            }
        }
    }
    prefix
}

/// Replace the token under the cursor with `replacement`.
fn replace_token(input: &str, replacement: &str) -> String {
    let token = current_token(input);
    let head = &input[..input.len() - token.len()];
    format!("{head}{replacement}")
}

// -- history persistence ----------------------------------------------------

/// The browser's `localStorage`, or `None` when it is unavailable.
///
/// Private browsing, a disabled store and a storage quota all land here. The
/// caller ignores the absence: history is a convenience, never a source of
/// truth, and this function must not panic.
fn storage() -> Option<web_sys::Storage> {
    web_sys::window()?.local_storage().ok()?
}

/// Read the persisted command history, degrading to empty on any failure.
fn load_history() -> Vec<String> {
    let Some(storage) = storage() else {
        return Vec::new();
    };
    let Ok(Some(raw)) = storage.get_item(HISTORY_KEY) else {
        return Vec::new();
    };
    serde_json::from_str(&raw).unwrap_or_default()
}

/// Persist the command history, ignoring every failure.
fn save_history(history: &[String]) {
    let Some(storage) = storage() else {
        return;
    };
    if let Ok(json) = serde_json::to_string(history) {
        let _ = storage.set_item(HISTORY_KEY, &json);
    }
}
