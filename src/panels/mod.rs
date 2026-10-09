//! The panel registry.
//!
//! This table is the *only* place a panel is registered. The layout tree, the
//! tab bar, the "add panel" menu, layout persistence validation and the default
//! layout all read from it, so exposing a new report means adding one entry here
//! and one module beside it — nothing else needs to learn about it.
//!
//! `PANELS` order also drives the default layout: [`Layout::default_with`]
//! places entries 0-1 in the left column, 2 in the middle, 3 on the right, and
//! any further entries across the bottom.
//!
//! [`Layout::default_with`]: crate::layout::model::Layout::default_with

use leptos::prelude::*;

use crate::hledger::HledgerOutput;
use crate::layout::model::PanelId;
use crate::state::{AppState, ReportState};

mod accounts;
mod balance_over_time;
mod balances;
mod budget;
mod compound;
mod console;
mod expenses;
mod journals;
mod payees;
mod register;
mod table;
mod terminal;
mod transactions;

/// One registered panel type.
pub struct PanelDef {
    /// Stable key stored in the layout and in persisted JSON. Renaming this
    /// makes existing panels disappear from a restored layout, which is why
    /// [`Layout::retain_kinds`] drops unknown kinds rather than rendering them.
    ///
    /// [`Layout::retain_kinds`]: crate::layout::model::Layout::retain_kinds
    pub kind: &'static str,
    /// Tab label.
    pub title: &'static str,
    /// A short glyph for the tab and the add-panel menu.
    pub icon: &'static str,
    /// One-line description shown in the add-panel menu.
    pub summary: &'static str,
    /// Renders one instance of this panel. A function pointer (not a closure)
    /// so the registry can stay a `const` table.
    pub view: fn(PanelId) -> AnyView,
}

/// Every panel the application knows how to render.
pub const PANELS: &[PanelDef] = &[
    PanelDef {
        kind: "journals",
        title: "Journals",
        icon: "🗂",
        summary: "Load a directory of journal files and pick the main one",
        view: journals::view,
    },
    PanelDef {
        kind: "accounts",
        title: "Accounts",
        icon: "🌳",
        summary: "Every account name in the journal, as an indented tree",
        view: accounts::view,
    },
    PanelDef {
        kind: "balances",
        title: "Balances",
        icon: "⚖",
        summary: "Balance report with depth, tree/flat and period options",
        view: balances::view,
    },
    PanelDef {
        kind: "transactions",
        title: "Transactions",
        icon: "📄",
        summary: "Every transaction with its postings, sortable and paged",
        view: transactions::view,
    },
    PanelDef {
        kind: "register",
        title: "Register",
        icon: "≡",
        summary: "An account's postings with the running total after each one",
        view: register::view,
    },
    PanelDef {
        kind: "console",
        title: "Console",
        icon: "▤",
        summary: "Engine log: argv, exit codes, timings and raw output",
        view: console::view,
    },
    PanelDef {
        kind: "balance_over_time",
        title: "Over Time",
        icon: "📈",
        summary: "Net worth by year, quarter, month or week; any account total",
        view: balance_over_time::view,
    },
    PanelDef {
        kind: "net_assets",
        title: "Net Assets",
        icon: "◈",
        summary: "Balance sheet: assets, liabilities, equity and the net figure",
        view: compound::net_assets,
    },
    PanelDef {
        kind: "income_statement",
        title: "Profit & Loss",
        icon: "⚖",
        summary: "Income statement: revenue, expenses and the net income between them",
        view: compound::income_statement,
    },
    PanelDef {
        kind: "cash_flow",
        title: "Cash Flow",
        icon: "≋",
        summary: "Cash flow statement: where cash came from and where it went",
        view: compound::cash_flow,
    },
    PanelDef {
        kind: "expenses",
        title: "Expenses",
        icon: "🧾",
        summary: "Where the money went: expenses as a bar chart and a table",
        view: expenses::view,
    },
    PanelDef {
        kind: "payees",
        title: "Payees",
        icon: "🏪",
        summary: "Who the money went to, and how much, from a payee-pivoted register",
        view: payees::view,
    },
    PanelDef {
        kind: "budget",
        title: "Budget",
        icon: "🎯",
        summary: "Actual spending against its monthly budget goals",
        view: budget::view,
    },
    PanelDef {
        kind: "terminal",
        title: "Terminal",
        icon: "⌨",
        summary: "Run any hledger command interactively and see its output",
        view: terminal::view,
    },
];

/// Look up a panel by kind.
pub fn def(kind: &str) -> Option<&'static PanelDef> {
    PANELS.iter().find(|def| def.kind == kind)
}

/// Every known kind, for validating a restored layout.
pub fn kinds() -> Vec<&'static str> {
    PANELS.iter().map(|def| def.kind).collect()
}

/// The panels a fresh layout opens with.
///
/// Deliberately a curated subset rather than every registered kind: the registry
/// is the *menu* of what can be shown, and putting all ten panels in the default
/// layout would open a wall of tabs on a laptop. The analytics and the terminal
/// are one click away in the add-panel menu, and the layout remembers whatever
/// the user settles on.
pub fn default_kinds() -> Vec<&'static str> {
    vec!["journals", "accounts", "balances", "transactions", "console"]
}

/// Tab label for a kind, falling back to the raw key for an unknown panel.
pub fn title_for(kind: &str) -> String {
    def(kind)
        .map(|def| def.title.to_string())
        .unwrap_or_else(|| kind.to_string())
}

/// Tab glyph for a kind.
pub fn icon_for(kind: &str) -> &'static str {
    def(kind).map(|def| def.icon).unwrap_or("▪")
}

/// Placeholder for a panel kind that is no longer registered.
///
/// [`Layout::retain_kinds`] normally removes these before rendering; this is the
/// second line of defence so an unknown kind can never produce a blank tab with
/// no explanation.
///
/// [`Layout::retain_kinds`]: crate::layout::model::Layout::retain_kinds
pub fn unknown_kind(kind: &str) -> AnyView {
    error_panel(&format!(
        "This layout refers to a panel that is not registered: {kind}. \
         Close this tab, or reset the layout."
    ))
}

// -- shared panel chrome ----------------------------------------------------

/// A neutral centred message, used for empty and loading states.
pub(crate) fn message_panel(text: &str) -> AnyView {
    let text = text.to_string();
    view! {
        <div class="panel panel-message">
            <p>{text}</p>
        </div>
    }
    .into_any()
}

/// An error state, deliberately visually distinct from "no data".
pub(crate) fn error_panel(text: &str) -> AnyView {
    let text = text.to_string();
    view! {
        <div class="panel panel-error">
            <p>{text}</p>
        </div>
    }
    .into_any()
}

/// What to say when a report bounded by a period or a query came back empty.
///
/// "No transactions" and "no transactions *in this month*" are different claims,
/// and only one of them is usually true: a journal whose data ends in a past year
/// — a demo, or an archive someone still reads — returns nothing for "this year"
/// while holding thousands of postings. So the empty state names the bound that
/// emptied it and offers the way out, because a report that correctly returns
/// nothing is otherwise indistinguishable from a broken one.
///
/// `bound` names the period that emptied the report, with the signal to widen and
/// the index of that list's "everything" entry; a panel with no period control
/// passes `None` and gets the query-only case.
pub(crate) fn empty_report_view(
    bound: Option<(&str, RwSignal<usize>, usize)>,
    query: &str,
    query_signal: RwSignal<String>,
) -> AnyView {
    let query = query.trim().to_string();
    let period = bound.map(|(_, signal, _)| signal);
    let label = bound.map(|(label, _, _)| label);

    let what = match (label, query.is_empty()) {
        (Some(label), true) => format!("No postings in \u{201c}{label}\u{201d}."),
        (None, false) => format!("No postings match \u{201c}{query}\u{201d}."),
        (Some(label), false) => {
            format!("No postings in \u{201c}{label}\u{201d} match \u{201c}{query}\u{201d}.")
        }
        (None, true) => String::new(),
    };
    if what.is_empty() {
        return message_panel("This journal has no matching postings.");
    }

    let all_index = bound.map(|(_, _, index)| index).unwrap_or_default();
    let clear_query = !query.is_empty();

    view! {
        <p class="panel-remedy">{what}</p>
        <p class="panel-count">
            "The journal may simply have no data in that period."
        </p>
        <div class="panel-controls">
            <Show when=move || period.is_some()>
                <button
                    class="gl-btn"
                    on:click=move |_| {
                        if let Some(period) = period {
                            period.set(all_index);
                        }
                    }
                >
                    "Show everything"
                </button>
            </Show>
            <Show when=move || clear_query>
                <button
                    class="gl-btn"
                    on:click=move |_| query_signal.set(String::new())
                >
                    "Clear the query"
                </button>
            </Show>
        </div>
    }
    .into_any()
}

/// Render the state machine every report panel shares.
///
/// Keeping this in one place is what stops a panel from quietly rendering an
/// empty table when the engine actually failed: `Failed` is its own arm, and it
/// can only be reached from [`crate::state::ReportState::Failed`], which
/// [`AppState::report_for`] derives from the engine's exit code and stderr.
///
/// [`AppState::report_for`]: crate::state::AppState::report_for
pub(crate) fn report_view<F>(state: AppState, id: PanelId, ready: F) -> AnyView
where
    // `Send + Sync` because Leptos type-erases views through `AnyView`, which
    // requires it; signals are `Send + Sync`, so panels satisfy this naturally.
    F: Fn(&HledgerOutput) -> AnyView + Send + Sync + 'static,
{
    (move || match state.report(id) {
        ReportState::Idle => message_panel("Load a journal to see this report."),
        ReportState::Loading => message_panel("Running hledger…"),
        ReportState::Failed { message, .. } => error_panel(&message),
        ReportState::Ready(output) => ready(&output),
    })
    .into_any()
}

/// The command line a panel's report used, shown in its header for traceability.
pub(crate) fn argv_line(state: AppState, id: PanelId) -> AnyView {
    let text = move || match state.report(id) {
        ReportState::Ready(output) | ReportState::Failed { output, .. } => output.argv.join(" "),
        _ => String::new(),
    };
    view! { <div class="panel-argv">{text}</div> }.into_any()
}
