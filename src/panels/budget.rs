//! Budget panel: actual spending against its budget goal, period by period.
//!
//! `balance --budget --monthly -O json` decodes into a [`BudgetReport`] whose
//! every cell is an `[actual, goal]` pair, and hledger's own synthetic
//! `<unbudgeted>` row rides along as an ordinary row. A journal with no budget
//! rules still produces a well-formed report with every goal `null`, so the
//! panel asks [`BudgetReport::has_budget`] before drawing a table and says "no
//! budget defined" instead of showing a grid of dashes.
//!
//! The variance column is `actual − goal`: a negative figure is under budget, a
//! positive one over. Those are the two states worth colouring, and the existing
//! status classes supply that colour without inventing a palette here.

use leptos::prelude::*;
use rust_decimal::Decimal;

use crate::charts::scale;
use crate::controls;
use crate::hledger::report::ReportSpec;
use crate::journal::money::Amount;
use crate::journal::reports::{
    BudgetReport, default_commodity, parse_budget_report, pick_amount,
};
use crate::layout::model::PanelId;
use crate::panels::table::QueryField;
use crate::panels::{argv_line, error_panel, message_panel, report_view};
use crate::query;
use crate::state::AppState;

/// Shown instead of a report when the engine cannot run a budget report.
const NEEDS_ENGINE: &str = "Budgets need the full hledger engine: the interim hledger-wasm \
     bridge cannot run `balance --budget`. Build and serve the full CLI \
     (scripts/build-hledger-wasm.sh) to see this panel.";

pub fn view(id: PanelId) -> AnyView {
    let state = expect_context::<AppState>();
    let query = RwSignal::new(state.recalled_text(id, controls::QUERY).unwrap_or_default());

    Effect::new(move |_| {
        let _ = state.generation.get();
        let _ = state.refresh.get();
        // Tracked, so committing a new query re-runs the report.
        let requested = query.get();
        // Let the focused pane load first; see `AppState::may_load`.
        if !state.may_load(id) {
            return;
        }
        if state.flavor.get().supports_report_options() {
            let mut spec = ReportSpec::json("balance").arg("--budget").arg("--monthly");
            // A query bounds the comparison in time or narrows it to part of the
            // account tree, which is how a yearly budget is read month by month
            // in one place rather than by scrolling a whole span.
            for argument in query::query_args(&requested) {
                spec = spec.arg(argument);
            }
            state.report_for(id, spec);
        }
    });

    let controls = move || {
        if !state.flavor.get().supports_report_options() {
            return ().into_any();
        }
        view! {
            <div class="panel-controls">
                <QueryField
                panel=id
                    applied=query
                    placeholder="query, e.g. date:2024 — Enter applies"
                />
            </div>
        }
        .into_any()
    };

    view! {
        <div class="panel panel-budget">
            {controls}
            {argv_line(state, id)}
            {move || {
                if !state.flavor.get().supports_report_options() {
                    return error_panel(NEEDS_ENGINE);
                }
                report_view(state, id, move |output| {
                    match parse_budget_report(&output.stdout) {
                        Ok(report) => budget_view(state, id, &report),
                        Err(error) => {
                            error_panel(&format!("Could not decode the budget report: {error}"))
                        }
                    }
                })
            }}
        </div>
    }
    .into_any()
}

/// The budget table, one row per `(account, period)`.
fn budget_view(state: AppState, id: PanelId, report: &BudgetReport) -> AnyView {
    if !report.has_budget() {
        return message_panel(
            "No budget defined in this journal. Add `~ monthly` budget rules to a \
             periodic transaction to see a budget report.",
        );
    }

    let commodity = state
        .settings
        .get_untracked()
        .main_currency
        .or_else(|| {
            default_commodity(
                report
                    .totals
                    .cells
                    .iter()
                    .flat_map(|cell| cell.actual().iter().chain(cell.goal().iter()))
                    .chain(report.rows.iter().flat_map(|row| {
                        row.cells
                            .iter()
                            .flat_map(|cell| cell.actual().iter().chain(cell.goal().iter()))
                    })),
            )
        });
    let labels = report.labels();

    let mut rows: Vec<AnyView> = Vec::new();
    for row in &report.rows {
        let unbudgeted = row.name.is_unbudgeted();
        let account = row.account().unwrap_or_default().to_string();
        for (index, label) in labels.iter().enumerate() {
            let cell = row.cells.get(index);
            let actual = cell
                .map(|cell| amounts_text(cell.actual(), commodity.as_deref()))
                .unwrap_or_else(|| "—".to_string());
            let goal = cell
                .map(|cell| amounts_text(cell.goal(), commodity.as_deref()))
                .unwrap_or_else(|| "—".to_string());
            let (variance, variance_class) = match cell
                .and_then(|cell| cell.variance(commodity.as_deref()))
            {
                Some(value) if value < Decimal::ZERO => {
                    (variance_text(value, commodity.as_deref()), "num console-status-fail")
                }
                Some(value) if value > Decimal::ZERO => {
                    (variance_text(value, commodity.as_deref()), "num console-status-ok")
                }
                Some(value) => (variance_text(value, commodity.as_deref()), "num"),
                None => ("—".to_string(), "num"),
            };
            // The unbudgeted row is not an account, so it is not a link to one.
            let account_cell: AnyView = if unbudgeted {
                view! { <td class="account">"spending without a budget"</td> }.into_any()
            } else {
                let target = account.clone();
                let title = format!("{account} — open its register");
                view! {
                    <td class="account">
                        <button
                            class="account-link"
                            title=title
                            on:click=move |_| state.drill_into(id, target.clone())
                        >
                            {account.clone()}
                        </button>
                    </td>
                }
                .into_any()
            };
            rows.push(
                view! {
                    <tr class:panel-row-zero=unbudgeted>
                        {account_cell}
                        <td>{label.clone()}</td>
                        <td class="num">{actual}</td>
                        <td class="num">{goal}</td>
                        <td class=variance_class>{variance}</td>
                    </tr>
                }
                .into_any(),
            );
        }
    }

    // hledger's own totals are worth showing, and they are the one place a
    // budget report answers "am I over or under overall".
    let mut totals: Vec<AnyView> = Vec::new();
    for (index, label) in labels.iter().enumerate() {
        let Some(cell) = report.totals.cells.get(index) else {
            continue;
        };
        let actual = amounts_text(cell.actual(), commodity.as_deref());
        let goal = amounts_text(cell.goal(), commodity.as_deref());
        let variance = cell
            .variance(commodity.as_deref())
            .map(|value| variance_text(value, commodity.as_deref()))
            .unwrap_or_else(|| "—".to_string());
        totals.push(
            view! {
                <tr>
                    <td>"Total"</td>
                    <td>{label.clone()}</td>
                    <td class="num">{actual}</td>
                    <td class="num">{goal}</td>
                    <td class="num">{variance}</td>
                </tr>
            }
            .into_any(),
        );
    }

    let rows = rows.into_iter().collect_view();
    let totals = totals.into_iter().collect_view();
    let periods = labels.len();

    view! {
        <div class="panel-count">
            {format!("{periods} period(s); variance is actual − goal")}
        </div>
        <table class="panel-table">
            <thead>
                <tr>
                    <th>"Account"</th>
                    <th>"Period"</th>
                    <th class="num">"Actual"</th>
                    <th class="num">"Goal"</th>
                    <th class="num">"Variance"</th>
                </tr>
            </thead>
            <tbody>{rows}</tbody>
            <tfoot>{totals}</tfoot>
        </table>
    }
    .into_any()
}

/// A mixed amount as text in one commodity, or a dash when the cell is empty.
fn amounts_text(amounts: &[Amount], commodity: Option<&str>) -> String {
    pick_amount(amounts, commodity)
        .map(Amount::display)
        .unwrap_or_else(|| "—".to_string())
}

/// The variance figure, with the commodity when one is known.
fn variance_text(value: Decimal, commodity: Option<&str>) -> String {
    match commodity {
        Some(commodity) => format!("{} {commodity}", scale::format_tick(value)),
        None => scale::format_tick(value),
    }
}
