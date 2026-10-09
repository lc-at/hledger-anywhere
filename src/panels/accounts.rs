//! Accounts panel: the chart of accounts found in the journal.
//!
//! Uses the `accounts` command rather than deriving names from `print` JSON:
//! hledger's account list honours the journal's account declarations and
//! directives, so it is the engine's answer, not this app's guess.

use leptos::prelude::*;

use crate::hledger::report::ReportSpec;
use crate::journal;
use crate::layout::model::PanelId;
use crate::panels::table::QueryField;
use crate::panels::{argv_line, message_panel, report_view};
use crate::query;
use crate::state::AppState;

pub fn view(id: PanelId) -> AnyView {
    let state = expect_context::<AppState>();
    let query = RwSignal::new(String::new());

    Effect::new(move |_| {
        // Re-run when the journal changes or the user asks for a refresh.
        let _ = state.generation.get();
        let _ = state.refresh.get();
        // Tracked, so committing a new query re-runs the report.
        let requested = query.get();
        // Let the focused pane load first; see `AppState::may_load`.
        if !state.may_load(id) {
            return;
        }
        let mut spec = ReportSpec::text("accounts");
        // A query filters the list — `assets` shows just that subtree, which is
        // how you find an account name in a journal with hundreds of them. The
        // bridge takes no arguments, so it is not asked for one.
        if state.flavor.get().supports_report_options() {
            for argument in query::query_args(&requested) {
                spec = spec.arg(argument);
            }
        }
        state.report_for(id, spec);
    });

    let controls = move || {
        if !state.flavor.get().supports_report_options() {
            return ().into_any();
        }
        view! {
            <div class="panel-controls">
                <QueryField applied=query placeholder="filter, e.g. assets — Enter applies" />
            </div>
        }
        .into_any()
    };

    view! {
        <div class="panel panel-accounts">
            {controls}
            {argv_line(state, id)}
            {report_view(state, id, move |output| {
                let accounts = journal::model::parse_line_list(&output.stdout);
                if accounts.is_empty() {
                    return message_panel("This journal declares no accounts.");
                }
                view! {
                    <div class="panel-count">
                        {crate::format::count_of(accounts.len(), "account")}
                    </div>
                    <ul class="account-tree">
                        {journal::model::tree_display_names(
                                accounts.iter().map(String::as_str),
                            )
                            .into_iter()
                            .zip(accounts.iter())
                            .map(|(display, account)| {
                                // Indent by hierarchy depth, which is what makes a
                                // flat list read as the account tree.
                                let depth = account.matches(':').count();
                                let style = format!("padding-left: {}px", 8 + depth * 14);
                                let target = account.clone();
                                let title = format!("{account} — open its register");
                                view! {
                                    <li style=style>
                                        <button
                                            class="account-link"
                                            title=title
                                            on:click=move |_| {
                                                state.drill_into(id, target.clone())
                                            }
                                        >
                                            {display}
                                        </button>
                                    </li>
                                }
                            })
                            .collect_view()}
                    </ul>
                }
                .into_any()
            })}
        </div>
    }
    .into_any()
}
