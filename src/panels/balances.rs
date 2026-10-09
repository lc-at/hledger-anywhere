//! Balances panel: the balance report, with its report options.
//!
//! This is the panel that proves the full-CLI engine is worth its build: `--tree`
//! gives real parent sub-totals and indentation, and `--depth` collapses the
//! tree, neither of which the interim bridge could do. The options are hidden
//! when the engine cannot honour them, rather than being shown and ignored.

use leptos::prelude::*;
use rust_decimal::Decimal;

use crate::controls;
use crate::hledger::report::ReportSpec;
use crate::journal;
use crate::journal::model::BalanceRow;
use crate::layout::model::PanelId;
use crate::panels::table::{QueryField, sort_header};
use crate::panels::{argv_line, empty_report_view, error_panel, message_panel, report_view};
use crate::query::{self, SortDir};
use crate::state::AppState;

/// The columns this table can be ordered by.
#[derive(Clone, Copy, PartialEq, Eq)]
enum SortKey {
    Account,
    Amount,
}

impl SortKey {
    /// Which way a first click on this column sorts.
    ///
    /// Accounts read naturally A–Z; amounts are almost always looked at
    /// biggest-first, so asking for that twice would be a wasted click.
    fn first_direction(self) -> SortDir {
        match self {
            SortKey::Account => SortDir::Ascending,
            SortKey::Amount => SortDir::Descending,
        }
    }
}

/// The value a row sorts by.
///
/// A mixed-commodity row has no single value; this takes the row's first
/// commodity, which is the one it displays first. Ordering rows is a reading aid
/// rather than accounting, so an approximation across unlike commodities is fine
/// as long as it is predictable.
fn amount_key(row: &BalanceRow) -> Decimal {
    row.amounts
        .first()
        .map(|amount| amount.quantity.0)
        .unwrap_or_default()
}

pub fn view(id: PanelId) -> AnyView {
    let state = expect_context::<AppState>();

    // Controls come back as they were left; the panel's own value is the
    // default, not the rule. See `AppState::remember`.
    let tree = RwSignal::new(state.recalled_flag(id, controls::TREE).unwrap_or(true));
    let depth = RwSignal::new(state.recalled_text(id, controls::DEPTH).unwrap_or_default());
    let sort = RwSignal::new(None::<(SortKey, SortDir)>);
    let query = RwSignal::new(state.recalled_text(id, controls::QUERY).unwrap_or_default());

    Effect::new(move |_| {
        let _ = state.generation.get();
        let _ = state.refresh.get();
        // Let the focused pane load first; see `AppState::may_load`.
        if !state.may_load(id) {
            return;
        }

        let mut spec = ReportSpec::json("balance");
        if state.flavor.get().supports_report_options() {
            spec = spec.arg(if tree.get() { "--tree" } else { "--flat" });
            let requested = depth.get();
            if !requested.is_empty() {
                spec = spec.arg("--depth").arg(requested);
            }
            // A normal hledger query, so `date:thismonth`, `exp:food`, `not:...`
            // all work. Committed on Enter, not per keystroke: see `QueryField`.
            for argument in query::query_args(&query.get()) {
                spec = spec.arg(argument);
            }
        }
        state.report_for(id, spec);
    });

    let toggle = move |key: SortKey| {
        sort.update(|current| {
            *current = match *current {
                Some((active, direction)) if active == key => {
                    Some((key, direction.flipped()))
                }
                _ => Some((key, key.first_direction())),
            };
        });
    };
    let direction_of = move |key: SortKey| {
        sort.get()
            .filter(|(active, _)| *active == key)
            .map(|(_, direction)| direction)
    };

    let controls = move || {
        // With the interim bridge these options do nothing, so they are not
        // offered — a silently ignored option is worse than an absent one.
        if !state.flavor.get().supports_report_options() {
            return ().into_any();
        }
        view! {
            <div class="panel-controls">
                <label>
                    <input
                        type="checkbox"
                        prop:checked=move || tree.get()
                        on:change=move |_| {
                            tree.update(|value| *value = !*value);
                            state.remember(id, controls::TREE, tree.get_untracked().into());
                        }
                    />
                    "tree"
                </label>
                <label>
                    "depth"
                    <select
                        on:change=move |event| {
                            let value = event_target_value(&event);
                            state.remember(id, controls::DEPTH, value.clone().into());
                            depth.set(value);
                        }
                    >
                        <option value="">"all"</option>
                        <option value="1">"1"</option>
                        <option value="2">"2"</option>
                        <option value="3">"3"</option>
                        <option value="4">"4"</option>
                    </select>
                </label>
                <QueryField
                panel=id
                    applied=query
                    placeholder="query, e.g. date:thismonth exp:food — Enter applies"
                />
            </div>
        }
        .into_any()
    };

    view! {
        <div class="panel panel-balances">
            {controls}
            {argv_line(state, id)}
            {report_view(state, id, move |output| {
                match journal::model::parse_balance(&output.stdout) {
                    Ok(report) if report.rows.is_empty() => {
                        let text = query.get();
                        // A filtered-out report is not an empty journal. Saying
                        // "no balances to report" when a query is what emptied it
                        // sends the reader looking for a problem with their
                        // journal.
                        if text.trim().is_empty() {
                            message_panel("This journal has no balances to report.")
                        } else {
                            empty_report_view(None, &text, query)
                        }
                    }
                    Ok(report) => {
                        // Sorted here rather than by hledger: the report's own
                        // order is the account tree, which is what the rows come
                        // back in and what the user wants by default.
                        let mut rows: Vec<&BalanceRow> = report.rows.iter().collect();
                        if let Some((key, direction)) = sort.get() {
                            query::sort_by_cmp(
                                &mut rows,
                                |left, right| match key {
                                    SortKey::Account => left.full_name.cmp(&right.full_name),
                                    SortKey::Amount => amount_key(left).cmp(&amount_key(right)),
                                },
                                direction,
                            );
                        }
                        view! {
                        <table class="panel-table">
                            <thead>
                                <tr>
                                    {sort_header(
                                        "Account",
                                        false,
                                        direction_of(SortKey::Account),
                                        move || toggle(SortKey::Account),
                                    )}
                                    {sort_header(
                                        "Balance",
                                        true,
                                        direction_of(SortKey::Amount),
                                        move || toggle(SortKey::Amount),
                                    )}
                                </tr>
                            </thead>
                            <tbody>
                                {rows
                                    .iter()
                                    .map(|row| {
                                        let style = format!(
                                            "padding-left: {}px",
                                            8 + row.depth * 16,
                                        );
                                        let name = row.display_name.clone();
                                        // A display name can be elided by
                                        // hledger's own options, so the full
                                        // account name is always available as a
                                        // tooltip.
                                        let full = row.full_name.clone();
                                        let title = format!("{full} — open its register");
                                        // The full name, not the display name:
                                        // the drill is a query, and an elided
                                        // name is not one.
                                        let target = full.clone();
                                        let amounts = row.amounts_display();
                                        let zero = row.amounts.iter().all(|amount| {
                                            amount.quantity.0.is_zero()
                                        });
                                        view! {
                                            <tr class:panel-row-zero=zero>
                                                <td style=style>
                                                    <button
                                                        class="account-link"
                                                        title=title
                                                        on:click=move |_| {
                                                            state.drill_into(id, target.clone())
                                                        }
                                                    >
                                                        {name}
                                                    </button>
                                                </td>
                                                <td class="num">{amounts}</td>
                                            </tr>
                                        }
                                    })
                                    .collect_view()}
                            </tbody>
                            <tfoot>
                                <tr>
                                    <td>"Total"</td>
                                    <td class="num">{report.totals_display()}</td>
                                </tr>
                            </tfoot>
                        </table>
                        }
                        .into_any()
                    }
                    Err(error) => error_panel(&format!(
                        "Could not decode the balance report: {error}"
                    )),
                }
            })}
        </div>
    }
    .into_any()
}
