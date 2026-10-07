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
use crate::panels::{argv_line, error_panel, message_panel, report_view};
use crate::state::AppState;

/// How many rows the bar chart is allowed to draw.
///
/// A tree report can hold dozens of accounts; past a dozen bars the labels
/// collide and the chart stops being readable. The table below it always shows
/// every row, so nothing is hidden — it is only the chart that is capped.
const CHART_ROWS: usize = 12;

pub fn view(id: PanelId) -> AnyView {
    let state = expect_context::<AppState>();
    let depth = RwSignal::new("2".to_string());

    Effect::new(move |_| {
        let _ = state.generation.get();
        let _ = state.refresh.get();
        // Let the focused pane load first; see `AppState::may_load`.
        if !state.may_load(id) {
            return;
        }

        let mut spec = ReportSpec::json("balance").arg("expenses");
        if state.flavor.get().supports_report_options() {
            spec = spec.arg("--tree");
            let requested = depth.get();
            if !requested.is_empty() {
                spec = spec.arg("--depth").arg(requested);
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
                    Ok(report) => expenses_view(state, &report),
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
fn expenses_view(state: AppState, report: &BalanceReport) -> AnyView {
    if report.rows.is_empty() {
        return message_panel("This journal has no expenses to report.");
    }

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

    let rows = report
        .rows
        .iter()
        .map(|row| {
            let style = format!("padding-left: {}px", 8 + row.depth * 16);
            let name = row.display_name.clone();
            let full = row.full_name.clone();
            let amounts = row.amounts_display();
            let zero = row
                .amounts
                .iter()
                .all(|amount| amount.quantity.0.is_zero());
            view! {
                <tr class:panel-row-zero=zero>
                    <td style=style title=full>{name}</td>
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
                    <th>"Account"</th>
                    <th class="num">"Amount"</th>
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
