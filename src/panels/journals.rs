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
            </div>

            <p class=status_class>{status}</p>

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
