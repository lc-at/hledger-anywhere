//! The compound periodic reports: balance sheet, income statement, cash flow.
//!
//! hledger calls these "compound" reports — several named subreports plus one
//! combined totals row — and they all decode to the same type. They therefore
//! share one renderer instead of three near-copies, because a section table is a
//! section table.
//!
//! The headline figure is that combined totals row. hledger prints it as a `Net:`
//! line in text mode but does **not** label it in JSON, so it is read from
//! [`CompoundPeriodicReport::net_total`] rather than guessed at from a row name.
//!
//! None of these commands exist on the interim bridge, so on that flavor the
//! panel says so rather than rendering the bridge's `Unknown command` failure as
//! an empty report.

use leptos::prelude::*;

use crate::hledger::report::ReportSpec;
use crate::journal::money::Amount;
use crate::journal::reports::{
    CompoundPeriodicReport, CompoundSubreport, default_commodity, parse_compound_periodic_report,
    pick_amount,
};
use crate::layout::model::PanelId;
use crate::panels::table::QueryField;
use crate::panels::{argv_line, error_panel, message_panel, report_view};
use crate::query;
use crate::state::AppState;

/// One compound report, described as a panel.
pub struct CompoundPanel {
    /// The hledger command that produces it.
    pub command: &'static str,
    /// Panel class suffix: `net-assets` becomes `.panel-net-assets`.
    pub class: &'static str,
    /// What the headline figure is called.
    pub headline: &'static str,
    /// The subreport titles to render, in display order.
    ///
    /// Naming them, rather than rendering whatever arrives, keeps the panel's
    /// output stable if hledger ever adds another section to a report.
    pub sections: &'static [&'static str],
}

/// Shown instead of a report when the engine cannot run the command.
const NEEDS_ENGINE: &str = "This report needs the full hledger engine: the interim \
     hledger-wasm bridge cannot run it. Build and serve the full CLI \
     (scripts/build-hledger-wasm.sh) to see this panel.";

/// The balance sheet, and the net assets it implies.
pub const NET_ASSETS: CompoundPanel = CompoundPanel {
    command: "balancesheetequity",
    class: "net-assets",
    headline: "Net assets",
    sections: &["Assets", "Liabilities", "Equity"],
};

/// Revenue against expenses, and the net income between them.
pub const INCOME_STATEMENT: CompoundPanel = CompoundPanel {
    command: "incomestatement",
    class: "income-statement",
    headline: "Net income",
    sections: &["Revenues", "Expenses"],
};

/// Where cash came from and where it went.
pub const CASH_FLOW: CompoundPanel = CompoundPanel {
    command: "cashflow",
    class: "cash-flow",
    headline: "Net cash flow",
    sections: &["Cash flows"],
};

/// The three panels, in registry-friendly form.
pub fn net_assets(id: PanelId) -> AnyView {
    view(id, &NET_ASSETS)
}

pub fn income_statement(id: PanelId) -> AnyView {
    view(id, &INCOME_STATEMENT)
}

pub fn cash_flow(id: PanelId) -> AnyView {
    view(id, &CASH_FLOW)
}

fn view(id: PanelId, panel: &'static CompoundPanel) -> AnyView {
    let state = expect_context::<AppState>();
    let command = panel.command;
    // A date range is the query these reports are most often narrowed by
    // (`date:2024`, `date:thismonth`), but any hledger query works.
    let query = RwSignal::new(String::new());

    Effect::new(move |_| {
        let _ = state.generation.get();
        let _ = state.refresh.get();
        // Tracked, so committing a new query re-runs the report.
        let requested = query.get();
        // Let the focused pane load first; see `AppState::may_load`.
        if !state.may_load(id) {
            return;
        }

        // The bridge has none of these commands. Asking anyway would record a
        // failure that the panel deliberately never shows, so the request is
        // skipped on that flavor entirely.
        if state.flavor.get().supports_report_options() {
            let mut spec = ReportSpec::json(command);
            for argument in query::query_args(&requested) {
                spec = spec.arg(argument);
            }
            state.report_for(id, spec);
        }
    });

    let class = format!("panel panel-{}", panel.class);

    view! {
        <div class=class>
            {move || {
                if !state.flavor.get().supports_report_options() {
                    return ().into_any();
                }
                view! {
                    <div class="panel-controls">
                        <QueryField
                            applied=query
                            placeholder="query, e.g. date:2024 — Enter applies"
                        />
                    </div>
                }
                .into_any()
            }}
            {argv_line(state, id)}
            {move || {
                if !state.flavor.get().supports_report_options() {
                    return error_panel(NEEDS_ENGINE);
                }
                report_view(state, id, move |output| {
                    match parse_compound_periodic_report(&output.stdout) {
                        Ok(report) => compound_view(state, id, &report, panel),
                        Err(error) => error_panel(
                            &format!("Could not decode the report: {error}"),
                        ),
                    }
                })
            }}
        </div>
    }
    .into_any()
}

/// The whole report: the headline figure, then one table per subreport.
fn compound_view(
    state: AppState,
    id: PanelId,
    report: &CompoundPeriodicReport,
    panel: &'static CompoundPanel,
) -> AnyView {
    let commodity = preference(state, report);

    let headline = report
        .net_total(commodity.as_deref())
        .map(Amount::display)
        .unwrap_or_else(|| "—".to_string());

    let mut sections: Vec<AnyView> = Vec::new();
    for title in panel.sections {
        let Some(subreport) = report.subreport(title) else {
            continue;
        };
        // An all-zero section still has rows; only a genuinely absent one is
        // skipped, so a balance sheet with no liabilities does not vanish.
        if subreport.report.rows.is_empty() && subreport.report.labels().is_empty() {
            continue;
        }
        sections.push(subreport_table(state, id, title, subreport, commodity.as_deref()));
    }

    if sections.is_empty() {
        return message_panel("This journal has nothing to report here.");
    }

    let periods = report.labels().len();
    let headline_label = panel.headline;
    let sections = sections.into_iter().collect_view();

    view! {
        <div class="panel-figure">
            <span class="panel-figure-label">{headline_label}</span>
            <span class="panel-figure-value">{headline}</span>
        </div>
        <div class="panel-count">{crate::format::count_of(periods, "period")}</div>
        {sections}
    }
    .into_any()
}

/// One subreport as an account-row table, one column per period.
fn subreport_table(
    state: AppState,
    id: PanelId,
    title: &str,
    subreport: &CompoundSubreport,
    commodity: Option<&str>,
) -> AnyView {
    let header = subreport
        .report
        .labels()
        .iter()
        .map(|label| view! { <th class="num">{label.clone()}</th> })
        .collect_view();

    let body = subreport
        .report
        .rows
        .iter()
        .map(|row| {
            let name = row.account().unwrap_or_default().to_string();
            let target = name.clone();
            let title = format!("{name} — open its register");
            let cells = row
                .amounts
                .iter()
                .map(|amounts| cell_text(amounts, commodity))
                .map(|text| view! { <td class="num">{text}</td> })
                .collect_view();
            view! {
                <tr>
                    <td class="account">
                        <button
                            class="account-link"
                            title=title
                            on:click=move |_| state.drill_into(id, target.clone())
                        >
                            {name}
                        </button>
                    </td>
                    {cells}
                </tr>
            }
        })
        .collect_view();

    let totals = subreport
        .report
        .totals
        .amounts
        .iter()
        .map(|amounts| cell_text(amounts, commodity))
        .map(|text| view! { <td class="num">{text}</td> })
        .collect_view();

    view! {
        <h3>{title.to_string()}</h3>
        <table class="panel-table">
            <thead>
                <tr>
                    <th>"Account"</th>
                    {header}
                </tr>
            </thead>
            <tbody>{body}</tbody>
            <tfoot>
                <tr>
                    <td>"Total"</td>
                    {totals}
                </tr>
            </tfoot>
        </table>
    }
    .into_any()
}

/// One cell: the amount in the preferred commodity, or a dash.
fn cell_text(amounts: &[Amount], commodity: Option<&str>) -> String {
    pick_amount(amounts, commodity)
        .map(Amount::display)
        .unwrap_or_else(|| "—".to_string())
}

/// The commodity to show figures in: the user's main currency when one is set,
/// otherwise the report's most-used money-like commodity.
fn preference(state: AppState, report: &CompoundPeriodicReport) -> Option<String> {
    state
        .settings
        .get_untracked()
        .main_currency
        .or_else(|| {
            default_commodity(
                report
                    .totals
                    .amounts
                    .iter()
                    .flatten()
                    .chain(
                        report
                            .subreports
                            .iter()
                            .flat_map(|subreport| subreport.report.rows.iter())
                            .flat_map(|row| row.amounts.iter())
                            .flatten(),
                    ),
            )
        })
}
