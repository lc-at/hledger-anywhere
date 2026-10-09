//! Shared table chrome: sortable column headers and the query field.

use leptos::prelude::*;
use web_sys::KeyboardEvent;

use crate::controls;
use crate::layout::model::PanelId;
use crate::query::SortDir;
use crate::state::AppState;

/// A clickable column header.
///
/// The whole header is the button, so the click target is the column label rather
/// than a hidden arrow, and the arrow appears only on the column actually sorted
/// — a header that always shows one gives no clue which is active.
pub fn sort_header(
    label: &'static str,
    numeric: bool,
    active: Option<SortDir>,
    on_click: impl Fn() + 'static,
) -> AnyView {
    // A sorted column's arrow is part of the label, so a screen reader announces
    // the direction rather than reading a lone triangle.
    let title = match active {
        Some(SortDir::Ascending) => "sorted ascending — click for descending",
        Some(SortDir::Descending) => "sorted descending — click for ascending",
        None => "click to sort",
    };
    view! {
        <th class=if numeric { "num" } else { "" }>
            <button
                class="panel-sort"
                title=title
                on:click=move |_| on_click()
            >
                {label}
                <span class="panel-sort-arrow">
                    {active.map(SortDir::glyph).unwrap_or_default()}
                </span>
            </button>
        </th>
    }
    .into_any()
}

/// A field for a normal hledger query, applied when the user commits it.
///
/// Committed on Enter or on blur, *not* on every keystroke. That is not a
/// stylistic choice: each applied query is a whole engine invocation, and a large
/// journal takes ten seconds to re-parse, so applying per character would queue a
/// dozen ten-second reports while the user typed one word.
///
/// `applied` is the committed query the report runs with; the draft lives here.
#[component]
pub fn QueryField(
    /// The panel this field belongs to, so the query can be remembered for next
    /// time. Restoring it is the panel's job, at the point it creates the signal
    /// the report runs from — restoring it here would run the report twice, once
    /// against the default and once against what was remembered.
    panel: PanelId,
    applied: RwSignal<String>,
    placeholder: &'static str,
) -> impl IntoView {
    let state = expect_context::<AppState>();
    let draft = RwSignal::new(applied.get_untracked());

    // The committed value can change from outside the field — another panel can
    // point this one at an account (see `AppState::drill_into`) — so the draft
    // follows it. Without this the field would show the old query while the
    // report ran the new one, and the next keystroke would put the stale text
    // back. Typing does not loop: the draft is written here but never read.
    Effect::new(move |_| {
        draft.set(applied.get());
    });

    let commit = move || {
        let next = draft.get_untracked();
        if next != applied.get_untracked() {
            state.remember(panel, controls::QUERY, next.clone().into());
            applied.set(next);
        }
    };

    view! {
        <label class="panel-query">
            "query"
            <input
                type="text"
                // The hint about Enter belongs in the placeholder, where it is
                // read exactly when someone is wondering why nothing happened.
                placeholder=placeholder
                prop:value=move || draft.get()
                on:input=move |event| draft.set(event_target_value(&event))
                on:keydown=move |event: KeyboardEvent| {
                    if event.key() == "Enter" {
                        commit();
                    }
                }
                on:blur=move |_| commit()
            />
        </label>
    }
}
