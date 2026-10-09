//! Overview panel: what the loaded journal is.
//!
//! `stats` is the one report that describes the journal rather than reporting on
//! it — the period it covers, how many transactions and accounts it holds, which
//! commodities it uses, and how stale its newest entry is. Every other panel
//! answers a question about the money; this one answers "what am I looking at?",
//! which is the question a reader has first.
//!
//! It has no JSON form, but needs no parsing beyond the first colon — see
//! [`journal::model::parse_stats`].
//!
//! Deliberately not a query panel. `stats` describes the whole journal, so a
//! query would either be ignored or, worse, quietly narrow the counts while the
//! heading claimed otherwise. The same reason the file loader has no query field.

use leptos::prelude::*;

use crate::hledger::report::ReportSpec;
use crate::journal;
use crate::layout::model::PanelId;
use crate::panels::{argv_line, message_panel, report_view};
use crate::state::AppState;

pub fn view(id: PanelId) -> AnyView {
    let state = expect_context::<AppState>();

    Effect::new(move |_| {
        let _ = state.generation.get();
        let _ = state.refresh.get();
        // Let the focused pane load first; see `AppState::may_load`.
        if !state.may_load(id) {
            return;
        }
        state.report_for(id, ReportSpec::text("stats"));
    });

    view! {
        <div class="panel panel-overview">
            {argv_line(state, id)}
            {report_view(state, id, move |output| {
                let rows = journal::model::parse_stats(&output.stdout);
                if rows.is_empty() {
                    return message_panel("This journal has no summary to show.");
                }
                let body = rows
                    .into_iter()
                    .map(|(label, value)| {
                        view! {
                            <tr>
                                <td class="overview-label">{label}</td>
                                <td class="overview-value">{value}</td>
                            </tr>
                        }
                    })
                    .collect_view();
                view! {
                    <table class="panel-table overview-table">
                        <tbody>{body}</tbody>
                    </table>
                }
                .into_any()
            })}
        </div>
    }
    .into_any()
}
