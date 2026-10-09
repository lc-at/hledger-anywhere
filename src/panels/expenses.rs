//! Expenses panel: where the money went, as a bar chart and a table.
//!
//! Runs the single-period `balance expenses --tree --depth N` report. The depth
//! control is the report's own option, so what the chart shows is the same
//! account set hledger computed — no summing of rows here. Rows are ordered by
//! magnitude for the chart (the biggest category first), while the table keeps
//! hledger's own tree order so it can be read alongside a balance report.
//!
//! On the interim bridge every option is ignored, so the chart is capped and the
//! depth control is hidden rather than shown and discarded.

use leptos::prelude::*;
use rust_decimal::Decimal;

use crate::charts::bar_chart;
use crate::hledger::report::ReportSpec;
use crate::journal::model::{parse_balance, BalanceReport, BalanceRow};
use crate::journal::reports::{default_commodity, pick_amount};
use crate::layout::model::PanelId;
use crate::panels::table::{QueryField, sort_header};
use crate::panels::{argv_line, error_panel, message_panel, report_view};
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
    fn first_direction(self) -> SortDir {
        match self {
            SortKey::Account => SortDir::Ascending,
            SortKey::Amount => SortDir::Descending,
        }
    }
}

/// How many rows the bar chart is allowed to draw.
///
/// A tree report can hold dozens of accounts; past a dozen bars the labels
/// collide and the chart stops being readable. The table below it always shows
/// every row, so nothing is hidden — it is only the chart that is capped.
const CHART_ROWS: usize = 12;

pub fn view(id: PanelId) -> AnyView {
    let state = expect_context::<AppState>();
    let depth = RwSignal::new("2".to_string());
    let query = RwSignal::new(String::new());
    let sort = RwSignal::new(None::<(SortKey, SortDir)>);

    Effect::new(move |_| {
        let _ = state.generation.get();
        let _ = state.refresh.get();
        // Tracked, so committing a new query re-runs the report.
        let requested_query = query.get();
        // Let the focused pane load first; see `AppState::may_load`.
        if !state.may_load(id) {
            return;
        }

        let mut spec = ReportSpec::json("balance").arg("expenses");
        if state.flavor.get().supports_report_options() {
            spec = spec.arg("--tree");
            let requested_depth = depth.get();
            if !requested_depth.is_empty() {
                spec = spec.arg("--depth").arg(requested_depth);
            }
            // A query narrows the expense subtree, or bounds it in time
            // (`date:thisyear`), which is what makes the chart answer "this
            // year's spending" rather than the journal's whole history.
            for argument in query::query_args(&requested_query) {
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
                <label>
                    "depth"
                    <select
                        prop:value=move || depth.get()
                        on:change=move |event| depth.set(event_target_value(&event))
                    >
                        <option value="">"all"</option>
                        <option value="1">"1"</option>
                        <option value="2">"2"</option>
                        <option value="3">"3"</option>
                        <option value="4">"4"</option>
                    </select>
                </label>
                <QueryField
                    applied=query
                    placeholder="query, e.g. date:thisyear — Enter applies"
                />
            </div>
        }
        .into_any()
    };

    view! {
        <div class="panel panel-expenses">
            {controls}
            {argv_line(state, id)}
            {report_view(state, id, move |output| {
                match parse_balance(&output.stdout) {
                    Ok(report) => expenses_view(state, id, &report, sort),
                    Err(error) => {
                        error_panel(&format!("Could not decode the expenses report: {error}"))
                    }
                }
            })}
        </div>
    }
    .into_any()
}

/// The chart, then the full table.
fn expenses_view(
    state: AppState,
    id: PanelId,
    report: &BalanceReport,
    sort: RwSignal<Option<(SortKey, SortDir)>>,
) -> AnyView {
    if report.rows.is_empty() {
        return message_panel("This journal has no expenses to report.");
    }

    let toggle = move |key: SortKey| {
        sort.update(|current| {
            *current = match *current {
                Some((active, direction)) if active == key => Some((key, direction.flipped())),
                _ => Some((key, key.first_direction())),
            };
        });
    };
    let direction_of = move |key: SortKey| {
        sort.get()
            .filter(|(active, _)| *active == key)
            .map(|(_, direction)| direction)
    };

    let commodity = state
        .settings
        .get_untracked()
        .main_currency
        .or_else(|| {
            default_commodity(
                report
                    .rows
                    .iter()
                    .flat_map(|row| row.amounts.iter())
                    .chain(report.totals.iter()),
            )
        });

    // The chart takes the biggest categories, by absolute value: an expenses
    // report can hold a long tail that would flatten every meaningful bar.
    let mut ranked: Vec<(&BalanceRow, Decimal)> = report
        .rows
        .iter()
        .map(|row| (row, row_value(row, commodity.as_deref())))
        .collect();
    ranked.sort_by_key(|(_, value)| std::cmp::Reverse(value.abs()));

    let data: Vec<(String, Decimal)> = ranked
        .iter()
        .take(CHART_ROWS)
        .map(|(row, value)| (row.display_name.clone(), *value))
        .collect();
    let chart = bar_chart(&data);
    let chart_note = if ranked.len() > CHART_ROWS {
        Some(format!("Charting the top {CHART_ROWS} by magnitude."))
    } else {
        None
    };
    let note_view: AnyView = match chart_note {
        Some(text) => view! { <div class="panel-count">{text}</div> }.into_any(),
        None => ().into_any(),
    };

    // Sorted for reading; hledger's own order is the account tree, which is what
    // the rows come back in and what the user wants by default.
    let mut ordered: Vec<&BalanceRow> = report.rows.iter().collect();
    if let Some((key, direction)) = sort.get() {
        query::sort_by_cmp(
            &mut ordered,
            |left, right| match key {
                SortKey::Account => left.full_name.cmp(&right.full_name),
                SortKey::Amount => row_value(left, commodity.as_deref())
                    .cmp(&row_value(right, commodity.as_deref())),
            },
            direction,
        );
    }

    let rows = ordered
        .iter()
        .map(|row| {
            let style = format!("padding-left: {}px", 8 + row.depth * 16);
            let name = row.display_name.clone();
            let full = row.full_name.clone();
            let title = format!("{full} — open its register");
            // The full name, not the display name: the drill is a query, and an
            // elided name is not one.
            let target = full.clone();
            let amounts = row.amounts_display();
            let zero = row
                .amounts
                .iter()
                .all(|amount| amount.quantity.0.is_zero());
            view! {
                <tr class:panel-row-zero=zero>
                    <td style=style>
                        <button
                            class="account-link"
                            title=title
                            on:click=move |_| state.drill_into(id, target.clone())
                        >
                            {name}
                        </button>
                    </td>
                    <td class="num">{amounts}</td>
                </tr>
            }
        })
        .collect_view();

    let total = report.totals_display();
    let count = report.rows.len();

    view! {
        <div class="panel-count">{format!("{count} account row(s)")}</div>
        {note_view}
        {chart}
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
                        "Amount",
                        true,
                        direction_of(SortKey::Amount),
                        move || toggle(SortKey::Amount),
                    )}
                </tr>
            </thead>
            <tbody>{rows}</tbody>
            <tfoot>
                <tr>
                    <td>"Total"</td>
                    <td class="num">{total}</td>
                </tr>
            </tfoot>
        </table>
    }
    .into_any()
}

/// One row's value in the preferred commodity, or zero.
fn row_value(row: &BalanceRow, commodity: Option<&str>) -> Decimal {
    pick_amount(&row.amounts, commodity)
        .map(|amount| amount.quantity.0)
        .unwrap_or(Decimal::ZERO)
}
