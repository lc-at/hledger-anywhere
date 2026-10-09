//! Journals panel: choosing and loading the journal files to analyse.

use leptos::prelude::*;

use crate::journal;
use crate::layout::model::PanelId;
use crate::state::{AppState, SourceStatus};

pub fn view(_id: PanelId) -> AnyView {
    let state = expect_context::<AppState>();

    // Only journal-shaped files are selectable as the main journal; the other
    // loaded files still matter (they may be included, or be `.rules`/CSV
    // inputs) but they are not a report target.
    let candidates = move || {
        state
            .files
            .get()
            .into_iter()
            .map(|file| file.path)
            .filter(|path| journal::is_journal_path(path))
            .collect::<Vec<_>>()
    };

    let current_main = move || {
        state
            .main_journal
            .get()
            .map(|main| main.path().to_string())
            .unwrap_or_default()
    };

    let status = move || match state.source.get() {
        SourceStatus::Idle => "No journal loaded yet.".to_string(),
        SourceStatus::Loading => "Reading directory…".to_string(),
        SourceStatus::Ready {
            files,
            skipped,
            main,
        } => {
            let mut text = format!("{files} file(s) loaded — analysing {main}");
            if skipped > 0 {
                text.push_str(&format!(" ({skipped} file(s) skipped)"));
            }
            text
        }
        SourceStatus::Error(message) => message,
    };

    let status_class = move || match state.source.get() {
        SourceStatus::Error(_) => "panel-status panel-status-error",
        _ => "panel-status",
    };

    // Offered only while there is nothing loaded: once a journal is on screen
    // the same button would be a way to *replace* it, which is what
    // "Load directory…" is for, and having two buttons that do that is worse
    // than having one.
    let reopen = move || {
        let Some(meta) = state.last_session.get() else {
            return ().into_any();
        };
        if matches!(state.source.get(), SourceStatus::Ready { .. }) {
            return ().into_any();
        }
        let label = format!(
            "Reopen last session — {} file(s), {}, {}",
            meta.file_count,
            meta.main_journal,
            crate::format::describe_age(meta.saved_at_ms, js_sys::Date::now())
        );
        view! {
            <button
                class="gl-btn"
                title="Reload the journal this browser cached, without a directory pick"
                on:click=move |_| state.restore_last_session()
            >
                {label}
            </button>
        }
        .into_any()
    };

    view! {
        <div class="panel panel-journals">
            <div class="panel-toolbar">
                <button class="gl-btn" on:click=move |_| state.pick_directory()>
                    "Load directory…"
                </button>
                <button class="gl-btn" on:click=move |_| state.load_demo()>
                    "Load demo journal"
                </button>
                <button
                    class="gl-btn"
                    title="Re-run every report against the loaded journal"
                    on:click=move |_| state.refresh_all()
                >
                    "Refresh reports"
                </button>
                {reopen}
            </div>

            <p class=status_class>{status}</p>

            {move || {
                // Reports all failing means the journal the engine was handed is
                // not one it can read, and this is the panel that speaks for the
                // journal. On a phone it is the only panel on screen at first, so
                // without this "1 file(s) loaded" would be the whole story.
                let Some(message) = state.report_failure.get() else {
                    return ().into_any();
                };
                if !matches!(state.source.get(), SourceStatus::Ready { .. }) {
                    return ().into_any();
                }
                // hledger's parse errors are several lines of source excerpt; the
                // first line carries the file, line and column, and the whole
                // message stays available as a tooltip.
                let summary = message
                    .lines()
                    .map(str::trim)
                    .find(|line| !line.is_empty())
                    .unwrap_or("the engine could not run a report")
                    .to_string();
                view! {
                    <p class="panel-error" title=message>
                        {format!("Reports are failing: {summary}")}
                    </p>
                }
                .into_any()
            }}

            <div class="panel-field">
                <label for="main-journal">"Main journal"</label>
                <select
                    id="main-journal"
                    prop:value=current_main
                    on:change=move |event| {
                        let path = event_target_value(&event);
                        state.set_main_journal(path);
                    }
                >
                    {move || {
                        candidates()
                            .into_iter()
                            .map(|path| {
                                let is_current = current_main() == path;
                                // Separate bindings: `value` and the label both
                                // take ownership when the view is built.
                                let value = path.clone();
                                view! {
                                    <option value=value selected=is_current>
                                        {path}
                                    </option>
                                }
                            })
                            .collect_view()
                    }}
                </select>
            </div>

            <ul class="panel-list">
                {move || {
                    state
                        .files
                        .get()
                        .into_iter()
                        .map(|file| {
                            let is_main = current_main() == file.path;
                            let meta = format!("{} bytes", file.contents.len());
                            view! {
                                <li class:panel-list-main=is_main>
                                    <span class="panel-list-path">{file.path}</span>
                                    <span class="panel-list-meta">{meta}</span>
                                </li>
                            }
                        })
                        .collect_view()
                }}
            </ul>
        </div>
    }
    .into_any()
}
