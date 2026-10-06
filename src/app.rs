//! The application shell: header, and the layout area beneath it.

use leptos::prelude::*;

use crate::layout::view::LayoutView;
use crate::panels;
use crate::state::{AppState, EngineStatus, SourceStatus};

#[component]
pub fn App() -> impl IntoView {
    let state = AppState::new();
    provide_context(state);

    // One liveness check on start, so the Console and the header badge can say
    // whether the engine is actually present before the first report is tried.
    Effect::new(move |_| state.check_engine());

    view! {
        <div class="app">
            <Header />
            <LayoutView />
        </div>
    }
}

#[component]
fn Header() -> impl IntoView {
    let state = expect_context::<AppState>();

    let engine_class = move || match state.engine_status.get() {
        EngineStatus::Ready { .. } => "header-chip header-chip-ready",
        EngineStatus::Unavailable(_) | EngineStatus::Error(_) => "header-chip header-chip-error",
        EngineStatus::Unknown | EngineStatus::Checking => "header-chip",
    };

    let engine_text = move || match state.engine_status.get() {
        EngineStatus::Unknown => "engine: ?".to_string(),
        EngineStatus::Checking => "engine: checking…".to_string(),
        EngineStatus::Ready { version } => match version {
            // hledger prints "hledger 1.52.4, linux-x86_64"; the first line is
            // what identifies the build.
            Some(version) => version,
            None => "engine: ready".to_string(),
        },
        EngineStatus::Unavailable(_) => "engine: missing".to_string(),
        EngineStatus::Error(_) => "engine: error".to_string(),
    };

    let source_text = move || match state.source.get() {
        SourceStatus::Idle => "no journal".to_string(),
        SourceStatus::Loading => "loading…".to_string(),
        SourceStatus::Ready { files, main, .. } => format!("{files} file(s) · {main}"),
        SourceStatus::Error(_) => "journal error".to_string(),
    };

    view! {
        <header class="app-header">
            <span class="app-title">"hledger-anywhere"</span>
            <span class="app-subtitle">"client-side hledger analytics"</span>

            <span class=engine_class title="Which hledger build the reports run on">
                {engine_text}
            </span>
            <span class="header-chip">{source_text}</span>

            <span class="app-spacer"></span>

            <div class="app-menu">
                <button
                    class="gl-btn"
                    on:click=move |_| state.add_menu_open.update(|open| *open = !*open)
                >
                    "＋ Panel"
                </button>
                <Show when=move || state.add_menu_open.get()>
                    <div class="gl-dropdown">
                        {panels::PANELS
                            .iter()
                            .map(|def| {
                                let kind = def.kind;
                                view! {
                                    <button
                                        class="gl-dropdown-item"
                                        on:click=move |_| state.add_panel(kind)
                                    >
                                        <span class="gl-dropdown-icon">{def.icon}</span>
                                        <span class="gl-dropdown-text">
                                            <span class="gl-dropdown-title">{def.title}</span>
                                            <span class="gl-dropdown-summary">{def.summary}</span>
                                        </span>
                                    </button>
                                }
                            })
                            .collect_view()}
                    </div>
                </Show>
            </div>

            <button class="gl-btn" on:click=move |_| state.reset_layout()>
                "Reset layout"
            </button>
        </header>
    }
}
