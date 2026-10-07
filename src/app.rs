//! The application shell: header, and the layout area beneath it.

use leptos::prelude::*;
use wasm_bindgen::{closure::Closure, JsCast};

use crate::layout::view::LayoutView;
use crate::panels;
use crate::settings::{self, Theme};
use crate::state::{AppState, EngineStatus, SourceStatus};

/// Close a header menu when the user clicks anywhere outside it.
///
/// A menu that only closes via its own button sits on top of the panels while
/// the user tries to work in them, and the first click is wasted dismissing it.
/// The menu container stops clicks from reaching the document, so anything that
/// *does* reach it happened somewhere else and the menu should get out of the
/// way.
///
/// The listener is leaked on purpose, exactly as the drag guards are: one per
/// menu, for the life of the page, with no teardown to get wrong.
fn close_on_outside_click(open: RwSignal<bool>) {
    let Some(document) = web_sys::window().and_then(|window| window.document()) else {
        return;
    };
    let listener = Closure::<dyn FnMut()>::new(move || open.set(false));
    let _ = document.add_event_listener_with_callback("click", listener.as_ref().unchecked_ref());
    listener.forget();
}

#[component]
pub fn App() -> impl IntoView {
    let state = AppState::new();
    provide_context(state);

    // One liveness check on start, so the Console and the header badge can say
    // whether the engine is actually present before the first report is tried.
    Effect::new(move |_| state.check_engine());

    // Offer to reopen the last session, if this browser cached one. Read once,
    // on start: it is an offer, not state that changes under the user.
    Effect::new(move |_| state.load_last_session());

    // Repaint whenever the chosen theme changes. `apply_theme` resolves System
    // itself, so this covers all three choices with one call.
    //
    // The index.html pre-paint script has already set the attribute from
    // localStorage, so this is a re-application rather than the first one: it
    // exists for the case where the choice changes, and to keep the resolved
    // attribute in step with the OS for `Theme::System`.
    Effect::new(move |_| {
        let theme = state.settings.get().theme;
        settings::apply_theme(theme);
    });

    // Follow the operating system while (and only while) the user is on
    // `System`. Installed once: the callback reads the current choice untracked
    // so that switching to an explicit theme stops it from doing anything.
    Effect::new(move |_| {
        settings::watch_system_theme(move |_| {
            if state.settings.get_untracked().theme == Theme::System {
                settings::apply_theme(Theme::System);
            }
        });
    });

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

    // Once, for the life of the page: see `close_on_outside_click`.
    Effect::new(move |_| close_on_outside_click(state.add_menu_open));

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

            <div class="app-menu" on:click=move |ev: web_sys::MouseEvent| ev.stop_propagation()>
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

            <SettingsMenu />

            <button class="gl-btn" on:click=move |_| state.reset_layout()>
                "Reset layout"
            </button>
        </header>
    }
}

/// The theme and main-currency controls.
///
/// A dropdown rather than a panel: these are rarely-changed global preferences,
/// and giving them a tab would mean the user has to find layout space for a
/// panel they do not want to look at.
#[component]
fn SettingsMenu() -> impl IntoView {
    let state = expect_context::<AppState>();
    let open = RwSignal::new(false);

    // Once, for the life of the page: see `close_on_outside_click`.
    Effect::new(move |_| close_on_outside_click(open));

    let currency = move || {
        // The bridge accepts no report options at all, so choosing a currency
        // there would be saved and then silently ignored. Hide the control
        // instead — the same rule the report panels follow.
        if !state.flavor.get().supports_report_options() {
            return ().into_any();
        }

        let chosen = state.settings.get().main_currency;
        let choices = state.commodities.get();
        view! {
            <div class="gl-settings-group">
                <span class="gl-settings-label">"Main currency"</span>
                <select
                    class="gl-settings-select"
                    on:change=move |event| {
                        let value = event_target_value(&event);
                        state.set_main_currency((!value.is_empty()).then_some(value));
                    }
                >
                    <option value="" selected=chosen.is_none()>
                        "(none — amounts as written)"
                    </option>
                    {choices
                        .into_iter()
                        .map(|name| {
                            let is_chosen = chosen.as_deref() == Some(name.as_str());
                            let value = name.clone();
                            view! { <option value=value selected=is_chosen>{name}</option> }
                        })
                        .collect_view()}
                </select>
            </div>
        }
        .into_any()
    };

    view! {
        <div class="app-menu" on:click=move |ev: web_sys::MouseEvent| ev.stop_propagation()>
            <button
                class="gl-btn"
                on:click=move |_| open.update(|is_open| *is_open = !*is_open)
            >
                "⚙ Settings"
            </button>
            <Show when=move || open.get()>
                <div class="gl-dropdown gl-settings">
                    <div class="gl-settings-group">
                        <span class="gl-settings-label">"Theme"</span>
                        <div class="gl-settings-choices">
                            {[Theme::System, Theme::Dark, Theme::Light]
                                .into_iter()
                                .map(|theme| {
                                    view! {
                                        <button
                                            class="gl-choice"
                                            class:gl-choice-active=move || {
                                                state.settings.get().theme == theme
                                            }
                                            on:click=move |_| state.set_theme(theme)
                                        >
                                            {theme.as_str()}
                                        </button>
                                    }
                                })
                                .collect_view()}
                        </div>
                    </div>
                    {currency}
                </div>
            </Show>
        </div>
    }
}
