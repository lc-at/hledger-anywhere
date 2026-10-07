//! Transactions panel: the journal itself, transaction by transaction.
//!
//! Decoded from `print -O json` rather than parsed from hledger's text output,
//! so amounts keep their exact mantissa/scale and their commodity style. Rows
//! are shown one per posting, with the date and description only on a
//! transaction's first posting — the shape hledger's own register uses.

use leptos::prelude::*;

use crate::hledger::report::ReportSpec;
use crate::journal;
use crate::layout::model::PanelId;
use crate::panels::{error_panel, message_panel, report_view};
use crate::state::AppState;

/// How many transactions are rendered before the user asks for more.
///
/// Rendering is client-side, and a busy journal can hold tens of thousands of
/// transactions; without a cap the first paint would block for seconds.
const PAGE_SIZE: usize = 50;

/// How much of the journal to fetch, and the hledger query that selects it.
///
/// This is a *fetch* bound, not a display bound, and it matters more than it
/// looks: `print -O json` has no "first N" option, so the whole selection is
/// decoded whether or not it is displayed. On a real journal holding ten
/// thousand transactions the full report is around 29 MB and takes over half a
/// minute, against about 4 MB and a fifth of that for a single year — and the
/// engine re-parses the entire journal for every invocation, so this is the
/// difference between a usable panel and one that appears to hang.
///
/// A year is the default because it is a period people actually think in, and
/// because "everything" stays available for when it is wanted.
const PERIODS: [(&str, Option<&str>); 4] = [
    ("this year", Some("date:thisyear")),
    ("last year", Some("date:lastyear")),
    ("this month", Some("date:thismonth")),
    ("all", None),
];

pub fn view(id: PanelId) -> AnyView {
    let state = expect_context::<AppState>();
    let limit = RwSignal::new(PAGE_SIZE);
    let period = RwSignal::new(0usize);

    Effect::new(move |_| {
        let _ = state.generation.get();
        let _ = state.refresh.get();
        // Keep the page reset when the selection changes, or widening the period
        // would leave the "show more" counter somewhere unrelated.
        let _ = period.get();
        // Let the focused pane load first; see `AppState::may_load`.
        if !state.may_load(id) {
            return;
        }

        let mut spec = ReportSpec::json("print");
        // The bridge accepts no query arguments; asking anyway would silently
        // return the whole journal while the control claimed otherwise.
        if state.flavor.get().supports_report_options() {
            if let Some(Some(query)) = PERIODS.get(period.get()).map(|(_, query)| *query) {
                spec = spec.arg(query);
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
                <label>
                    "period"
                    <select on:change=move |event| {
                        if let Ok(index) = event_target_value(&event).parse::<usize>() {
                            limit.set(PAGE_SIZE);
                            period.set(index);
                        }
                    }>
                        {PERIODS
                            .iter()
                            .enumerate()
                            .map(|(index, (label, _))| {
                                let selected = index == period.get();
                                view! {
                                    <option value=index.to_string() selected=selected>
                                        {*label}
                                    </option>
                                }
                            })
                            .collect_view()}
                    </select>
                </label>
            </div>
        }
        .into_any()
    };

    view! {
        <div class="panel panel-transactions">
            {controls}
            {report_view(state, id, move |output| {
                match journal::model::parse_transactions(&output.stdout) {
                    Ok(transactions) if transactions.is_empty() => {
                        message_panel("This journal has no transactions.")
                    }
                    Ok(transactions) => {
                        let total = transactions.len();
                        let shown = limit.get();
                        let mut rows: Vec<AnyView> = Vec::new();

                        for transaction in transactions.iter().take(shown) {
                            let date = match &transaction.date2 {
                                Some(second) => format!("{} → {}", transaction.date, second),
                                None => transaction.date.clone(),
                            };
                            let marker = transaction.status_marker().to_string();
                            // Code, comment and tags are not columns of their
                            // own (they are usually empty), but they are the
                            // detail behind a transaction and belong on hover.
                            let mut details: Vec<String> = Vec::new();
                            if !transaction.code.is_empty() {
                                details.push(format!("({})", transaction.code));
                            }
                            if !transaction.comment.is_empty() {
                                details.push(transaction.comment.clone());
                            }
                            for tag in &transaction.tags {
                                details.push(match &tag.value {
                                    Some(value) => format!("{}: {value}", tag.name),
                                    None => tag.name.clone(),
                                });
                            }
                            let details = details.join(" · ");

                            if transaction.postings.is_empty() {
                                // A transaction with no postings is unusual but
                                // legal (it may carry only a comment), and it must
                                // not vanish from the list.
                                rows.push(
                                    view! {
                                        <tr>
                                            <td class="date">{date}</td>
                                            <td class="status">{marker}</td>
                                            <td class="desc" title=details.clone()>
                                                {transaction.description.clone()}
                                            </td>
                                            <td class="account"></td>
                                            <td class="num"></td>
                                        </tr>
                                    }
                                    .into_any(),
                                );
                                continue;
                            }

                            for (index, posting) in transaction.postings.iter().enumerate() {
                                let first = index == 0;
                                let row_date = if first { date.clone() } else { String::new() };
                                // A posting can carry its own status, so the
                                // marker only repeats the transaction's on the
                                // first row.
                                let row_marker = if first {
                                    marker.clone()
                                } else {
                                    posting.status_marker().to_string()
                                };
                                let description = if first {
                                    transaction.description.clone()
                                } else {
                                    String::new()
                                };
                                // A posting's own comment and tags are detail,
                                // not columns: they belong on hover.
                                let mut posting_details: Vec<String> = Vec::new();
                                if !posting.comment.is_empty() {
                                    posting_details.push(posting.comment.clone());
                                }
                                for tag in &posting.tags {
                                    posting_details.push(match &tag.value {
                                        Some(value) => format!("{}: {value}", tag.name),
                                        None => tag.name.clone(),
                                    });
                                }
                                let posting_details = posting_details.join(" · ");
                                rows.push(
                                    view! {
                                        <tr class:panel-row-first=first>
                                            <td class="date">{row_date}</td>
                                            <td class="status">{row_marker}</td>
                                            <td class="desc" title=details.clone()>{description}</td>
                                            <td class="account" title=posting_details>
                                                {posting.account.clone()}
                                            </td>
                                            <td class="num">{posting.amounts_display()}</td>
                                        </tr>
                                    }
                                    .into_any(),
                                );
                            }
                        }

                        let body = rows.into_iter().collect_view();
                        // Name the selection, so a count is never mistaken for
                        // the whole journal.
                        let scope = PERIODS
                            .get(period.get())
                            .map(|(label, _)| *label)
                            .unwrap_or("all");

                        view! {
                            <div class="panel-count">
                                {if shown < total {
                                    format!("showing {shown} of {total} transaction(s) — {scope}")
                                } else {
                                    format!("{total} transaction(s) — {scope}")
                                }}
                            </div>
                            <table class="panel-table">
                                <thead>
                                    <tr>
                                        <th>"Date"</th>
                                        <th>"St"</th>
                                        <th>"Description"</th>
                                        <th>"Account"</th>
                                        <th class="num">"Amount"</th>
                                    </tr>
                                </thead>
                                <tbody>{body}</tbody>
                            </table>
                            <Show when=move || limit.get() < total>
                                <div class="panel-more">
                                    <button
                                        class="gl-btn"
                                        on:click=move |_| limit.update(|value| *value += PAGE_SIZE)
                                    >
                                        "Show more"
                                    </button>
                                </div>
                            </Show>
                        }
                        .into_any()
                    }
                    Err(error) => error_panel(&format!(
                        "Could not decode the transaction list: {error}"
                    )),
                }
            })}
        </div>
    }
    .into_any()
}
