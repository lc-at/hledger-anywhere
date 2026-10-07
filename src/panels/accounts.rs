//! Accounts panel: the chart of accounts found in the journal.
//!
//! Uses the `accounts` command rather than deriving names from `print` JSON:
//! hledger's account list honours the journal's account declarations and
//! directives, so it is the engine's answer, not this app's guess.

use leptos::prelude::*;

use crate::hledger::report::ReportSpec;
use crate::journal;
use crate::layout::model::PanelId;
use crate::panels::{argv_line, message_panel, report_view};
use crate::state::AppState;

pub fn view(id: PanelId) -> AnyView {
    let state = expect_context::<AppState>();

    Effect::new(move |_| {
        // Re-run when the journal changes or the user asks for a refresh.
        let _ = state.generation.get();
        let _ = state.refresh.get();
        // Let the focused pane load first; see `AppState::may_load`.
        if !state.may_load(id) {
            return;
        }
        state.report_for(id, ReportSpec::text("accounts"));
    });

    view! {
        <div class="panel panel-accounts">
            {argv_line(state, id)}
            {report_view(state, id, |output| {
                let accounts = journal::model::parse_line_list(&output.stdout);
                if accounts.is_empty() {
                    return message_panel("This journal declares no accounts.");
                }
                view! {
                    <div class="panel-count">
                        {format!("{} account(s)", accounts.len())}
                    </div>
                    <ul class="account-tree">
                        {accounts
                            .into_iter()
                            .map(|account| {
                                // Indent by hierarchy depth, which is what makes a
                                // flat list read as the account tree.
                                let depth = account.matches(':').count();
                                let style = format!("padding-left: {}px", 8 + depth * 14);
                                view! { <li style=style>{account}</li> }
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
