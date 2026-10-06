//! Net assets panel: the balance sheet, with its headline net figure.
//!
//! `balancesheetequity -O json` is a *compound periodic report*: several
//! subreports plus one combined totals row. The figure this panel is named for
//! is that combined row — hledger's text-mode `Net:` line — and it is
//! deliberately **not** a labelled row in the JSON, so it is read from
//! [`CompoundPeriodicReport::net_total`] rather than guessed at from a row name.
//!
//! The interim bridge cannot run `balancesheetequity` at all (it is not one of
//! its five commands), so on that flavor the panel says so instead of rendering
//! the bridge's `Unknown command` failure as an empty balance sheet.

use leptos::prelude::*;

use crate::hledger::report::ReportSpec;
use crate::journal::reports::{
    pick_amount, parse_compound_periodic_report, CompoundPeriodicReport, CompoundSubreport,
};
use crate::layout::model::PanelId;
use crate::panels::{argv_line, error_panel, message_panel, report_view};
use crate::state::AppState;

/// The subreport titles `balancesheetequity` produces, in display order.
///
/// Looking each one up by name (rather than rendering whatever subreports
/// happen to arrive) keeps the panel's output stable if hledger ever adds
/// another section to the compound report.
const SUBREPORTS: [&str; 3] = ["Assets", "Liabilities", "Equity"];

/// Shown instead of a report when the engine cannot run `balancesheetequity`.
const NEEDS_ENGINE: &str = "Net assets needs the full hledger engine: the interim hledger-wasm \
     bridge cannot run `balancesheetequity`. Build and serve the full CLI \
     (scripts/build-hledger-wasm.sh) to see this panel.";

pub fn view(id: PanelId) -> AnyView {
    let state = expect_context::<AppState>();

    Effect::new(move |_| {
        let _ = state.generation.get();
        let _ = state.refresh.get();

        // The bridge has no `balancesheetequity` command. Asking anyway would
        // record a failure that the panel deliberately never shows, so the
        // request is skipped on that flavor entirely.
        if state.flavor.get().supports_report_options() {
            state.report_for(id, ReportSpec::json("balancesheetequity"));
        }
    });

    view! {
        <div class="panel panel-net-assets">
            {argv_line(state, id)}
            {move || {
                if !state.flavor.get().supports_report_options() {
                    return error_panel(NEEDS_ENGINE);
                }
                report_view(state, id, move |output| {
                    match parse_compound_periodic_report(&output.stdout) {
                        Ok(report) => net_assets_view(state, &report),
                        Err(error) => {
                            error_panel(&format!("Could not decode the balance sheet: {error}"))
                        }
                    }
                })
            }}
        </div>
    }
    .into_any()
}

/// The whole report: the net figure first, then one table per subreport.
fn net_assets_view(state: AppState, report: &CompoundPeriodicReport) -> AnyView {
    let commodity = preference(state, report);

    let net = report
        .net_total(commodity.as_deref())
        .map(|amount| amount.display())
        .unwrap_or_else(|| "—".to_string());

    let mut sections: Vec<AnyView> = Vec::new();
    for title in SUBREPORTS {
        let Some(subreport) = report.subreport(title) else {
            continue;
        };
        // An all-zero section still has rows; only a genuinely absent one is
        // skipped, so a balance sheet with no liabilities does not vanish.
        if subreport.report.rows.is_empty() && subreport.report.labels().is_empty() {
            continue;
        }
        sections.push(subreport_table(title, subreport, commodity.as_deref()));
    }

    if sections.is_empty() {
        return message_panel("This journal has no balance sheet to report.");
    }

    let periods = report.labels().len();
    let sections = sections.into_iter().collect_view();

    view! {
        <div
            class="net-assets-figure"
            style="margin: 4px 0 10px; padding: 8px 10px; background: var(--gl-inset-bg); \
                   border-radius: var(--gl-radius); font-size: 16px; font-weight: 600;"
        >
            <span style="color: var(--gl-text-dim); font-weight: 400;">"Net assets"</span>
            "  "
            <span style="color: var(--gl-accent);">{net}</span>
        </div>
        <div class="panel-count">{format!("{periods} period(s)")}</div>
        {sections}
    }
    .into_any()
}

/// One subreport as an account-row table, one column per period.
fn subreport_table(
    title: &str,
    subreport: &CompoundSubreport,
    commodity: Option<&str>,
) -> AnyView {
    let labels = subreport.report.labels();
    let header = labels
        .iter()
        .map(|label| view! { <th class="num">{label.clone()}</th> })
        .collect_view();

    let body = subreport
        .report
        .rows
        .iter()
        .map(|row| {
            let name = row.account().unwrap_or_default().to_string();
            let cells = row
                .amounts
                .iter()
                .map(|amounts| cell_text(amounts, commodity))
                .map(|text| view! { <td class="num">{text}</td> })
                .collect_view();
            view! {
                <tr>
                    <td class="account">{name}</td>
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
fn cell_text(amounts: &[crate::journal::money::Amount], commodity: Option<&str>) -> String {
    pick_amount(amounts, commodity)
        .map(crate::journal::money::Amount::display)
        .unwrap_or_else(|| "—".to_string())
}

/// The commodity to show a figure in: the user's main currency when one is set,
/// otherwise the first commodity the report actually mentions.
fn preference(state: AppState, report: &CompoundPeriodicReport) -> Option<String> {
    state
        .settings
        .get_untracked()
        .main_currency
        .or_else(|| first_commodity(report))
}

fn first_commodity(report: &CompoundPeriodicReport) -> Option<String> {
    let totals = report.totals.amounts.iter().flatten();
    let rows = report
        .subreports
        .iter()
        .flat_map(|subreport| subreport.report.rows.iter())
        .flat_map(|row| row.amounts.iter())
        .flatten();
    totals
        .chain(rows)
        .map(|amount| amount.commodity.clone())
        .find(|commodity| !commodity.is_empty())
}
