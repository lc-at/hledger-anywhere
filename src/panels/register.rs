//! Register panel: postings with the running total after each one.
//!
//! This is hledger's `register`, which is the view a ledger is actually kept
//! for: not just what happened, but what the balance was afterwards. It takes a
//! query rather than a single account, so `assets`, `expenses:food` or
//! `date:thismonth` all work, and the running total is of whatever was selected.
//!
//! Deliberately **not sortable**, unlike the other report tables. The total
//! column is the sum of every row before it, so re-ordering the rows would not
//! re-order the totals — it would just make them wrong.
//!
//! [`register`]: https://hledger.org/1.52/hledger.html#register

use leptos::prelude::*;

use crate::hledger::report::ReportSpec;
use crate::journal;
use crate::journal::model::RegisterEntry;
use crate::layout::model::PanelId;
use crate::panels::table::QueryField;
use crate::panels::{argv_line, error_panel, message_panel, report_view};
use crate::query;
use crate::state::AppState;

/// How many postings are rendered before the user asks for more.
///
/// Rendering is client-side, and a register over a large journal is tens of
/// thousands of rows; without a cap the first paint would block for seconds.
const PAGE_SIZE: usize = 100;

pub fn view(id: PanelId) -> AnyView {
    let state = expect_context::<AppState>();
    let limit = RwSignal::new(PAGE_SIZE);
    // `assets` by default. The running total of an asset query is a *position*,
    // which is what a register is usually opened to watch; a bare `register`
    // totals every posting in the journal, which ends at zero and means little
    // on the way there.
    let query = RwSignal::new("assets".to_string());

    Effect::new(move |_| {
        let _ = state.generation.get();
        let _ = state.refresh.get();
        // Tracked, so committing a new query re-runs the report.
        let requested = query.get();
        // A new report starts paged, whatever the last one was scrolled to.
        limit.set(PAGE_SIZE);

        // Let the focused pane load first; see `AppState::may_load`.
        if !state.may_load(id) {
            return;
        }

        let mut spec = ReportSpec::json("register");
        // The bridge accepts no query arguments, so asking would return the whole
        // journal while the field claimed otherwise.
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
                <QueryField
                    applied=query
                    placeholder="account or query, e.g. assets:bank — Enter applies"
                />
            </div>
        }
        .into_any()
    };

    view! {
        <div class="panel panel-register">
            {controls}
            {argv_line(state, id)}
            {report_view(state, id, move |output| {
                match journal::model::parse_register(&output.stdout) {
                    Ok(entries) if entries.is_empty() => {
                        message_panel("This query matches no postings.")
                    }
                    Ok(entries) => register_table(entries, limit),
                    Err(error) => error_panel(&format!(
                        "Could not decode the register: {error}"
                    )),
                }
            })}
        </div>
    }
    .into_any()
}

/// The register itself: one row per posting, with the running total.
fn register_table(entries: Vec<RegisterEntry>, limit: RwSignal<usize>) -> AnyView {
    let total = entries.len();
    let shown = limit.get().min(total);
    let body = entries
        .iter()
        .take(shown)
        .map(|entry| {
            let date = entry.date.clone().unwrap_or_default();
            let description = entry.description.clone().unwrap_or_default();
            let account = entry.posting.account.clone();
            let comment = entry.posting.comment.clone();
            let change = entry.amount_display();
            let running = entry.total_display();
            // A posting that moved nothing is noise in a register, so it is
            // dimmed rather than hidden: it is still a real posting, and it is
            // exactly what someone looking for a suspected missing transaction
            // wants to see.
            let quiet = entry.posting.amounts.iter().all(|amount| amount.quantity.0.is_zero())
                && !entry.posting.amounts.is_empty();
            view! {
                <tr class:panel-row-zero=quiet>
                    <td class="date">{date}</td>
                    <td title=comment>{description}</td>
                    <td class="account">{account}</td>
                    <td class="num">{change}</td>
                    <td class="num">{running}</td>
                </tr>
            }
        })
        .collect_view();

    let more = (shown < total).then(|| {
        view! {
            <button
                class="gl-btn"
                on:click=move |_| limit.update(|value| *value += PAGE_SIZE)
            >
                {format!("Show {} more", (total - shown).min(PAGE_SIZE))}
            </button>
        }
    });

    view! {
        <div class="panel-count">
            {if shown < total {
                format!("showing {shown} of {total} posting(s)")
            } else {
                format!("{total} posting(s)")
            }}
        </div>
        <table class="panel-table">
            <thead>
                <tr>
                    <th>"Date"</th>
                    <th>"Description"</th>
                    <th>"Account"</th>
                    <th class="num">"Change"</th>
                    <th class="num">"Total"</th>
                </tr>
            </thead>
            <tbody>{body}</tbody>
        </table>
        {more}
    }
    .into_any()
}
