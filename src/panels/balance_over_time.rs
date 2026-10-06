//! Balance over time: a periodic `balance` report as a line chart.
//!
//! The report is `balance --historical <interval>`, so each column is a period
//! and each value is the balance *as at* that period rather than the change
//! during it — which is what "balance over time" means. A query argument narrows
//! the series to one account; with no query the report's grand totals are
//! plotted.
//!
//! Both values and labels come out of [`PeriodicReport`], and the figure is
//! always one commodity, chosen once, so a mixed-commodity journal plots a
//! coherent line instead of silently adding unlike amounts.

use leptos::prelude::*;
use rust_decimal::Decimal;

use crate::charts::{line_chart, scale};
use crate::hledger::report::ReportSpec;
use crate::journal::reports::{parse_periodic_report, row_values, PeriodicReport};
use crate::layout::model::PanelId;
use crate::panels::{argv_line, error_panel, message_panel, report_view};
use crate::state::AppState;

/// The period flags, as `(label, flag)`, in the order the control offers them.
const INTERVALS: [(&str, &str); 4] = [
    ("monthly", "--monthly"),
    ("weekly", "--weekly"),
    ("quarterly", "--quarterly"),
    ("yearly", "--yearly"),
];

pub fn view(id: PanelId) -> AnyView {
    let state = expect_context::<AppState>();
    // An index into `INTERVALS` rather than the flag itself, so the control and
    // the argv cannot drift apart.
    let interval = RwSignal::new(0usize);
    let account = RwSignal::new(String::new());

    Effect::new(move |_| {
        let _ = state.generation.get();
        let _ = state.refresh.get();

        // `--historical` is what makes the columns running balances. The bridge
        // ignores every option, so on that flavor the flags are not even asked
        // for: an option the engine silently discards is worse than no option.
        let mut spec = ReportSpec::json("balance");
        if state.flavor.get().supports_report_options() {
            let flag = INTERVALS
                .get(interval.get())
                .map(|(_, flag)| *flag)
                .unwrap_or("--monthly");
            spec = spec.arg("--historical").arg(flag);
            for token in account.get().split_whitespace() {
                spec = spec.arg(token);
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
                    "interval"
                    <select on:change=move |event| {
                        if let Ok(index) = event_target_value(&event).parse::<usize>() {
                            interval.set(index);
                        }
                    }>
                        {INTERVALS
                            .iter()
                            .enumerate()
                            .map(|(index, (label, _))| {
                                view! { <option value=index.to_string()>{*label}</option> }
                            })
                            .collect_view()}
                    </select>
                </label>
                <label>
                    "account"
                    <input
                        type="text"
                        placeholder="e.g. assets"
                        prop:value=move || account.get()
                        on:input=move |event| account.set(event_target_value(&event))
                    />
                </label>
            </div>
        }
        .into_any()
    };

    view! {
        <div class="panel panel-balance-over-time">
            {controls}
            {move || {
                if state.flavor.get().supports_report_options() {
                    ().into_any()
                } else {
                    view! {
                        <p class="panel-remedy">
                            "Period and account options need the full hledger engine; \
                             showing the overall balance."
                        </p>
                    }
                    .into_any()
                }
            }}
            {argv_line(state, id)}
            {report_view(state, id, move |output| {
                match parse_periodic_report(&output.stdout) {
                    Ok(report) => series_view(state, &report, &account.get_untracked()),
                    Err(error) => error_panel(&format!(
                        "Could not decode the periodic balance report: {error}"
                    )),
                }
            })}
        </div>
    }
    .into_any()
}

/// The chart and the table behind it.
fn series_view(state: AppState, report: &PeriodicReport, account: &str) -> AnyView {
    let commodity = state
        .settings
        .get_untracked()
        .main_currency
        .or_else(|| first_commodity(report));

    let query = account.trim();
    let (values, note) = if query.is_empty() {
        (report.grand_total_values(commodity.as_deref()), None)
    } else {
        match report.row(query) {
            Some(row) => (row_values(row, commodity.as_deref()), None),
            None => (
                report.grand_total_values(commodity.as_deref()),
                Some(format!(
                    "No account row matches `{query}`; showing the grand total."
                )),
            ),
        }
    };

    let data: Vec<(String, Decimal)> = report.labels().into_iter().zip(values).collect();
    if data.is_empty() {
        return message_panel("This report has no periods to plot.");
    }

    let chart = line_chart(&data);
    let rows = data
        .iter()
        .map(|(label, value)| {
            let text = value_text(*value, commodity.as_deref());
            view! {
                <tr>
                    <td>{label.clone()}</td>
                    <td class="num">{text}</td>
                </tr>
            }
        })
        .collect_view();

    let note_view: AnyView = match note {
        Some(text) => view! { <p class="panel-remedy">{text}</p> }.into_any(),
        None => ().into_any(),
    };

    view! {
        {note_view}
        {chart}
        <table class="panel-table">
            <thead>
                <tr>
                    <th>"Period"</th>
                    <th class="num">"Balance"</th>
                </tr>
            </thead>
            <tbody>{rows}</tbody>
        </table>
    }
    .into_any()
}

/// A decimal value as text, with the commodity when one is known.
fn value_text(value: Decimal, commodity: Option<&str>) -> String {
    match commodity {
        Some(commodity) => format!("{} {commodity}", scale::format_tick(value)),
        None => scale::format_tick(value),
    }
}

/// The first commodity the report mentions anywhere.
fn first_commodity(report: &PeriodicReport) -> Option<String> {
    let totals = report.totals.amounts.iter().flatten();
    let rows = report.rows.iter().flat_map(|row| row.amounts.iter()).flatten();
    totals
        .chain(rows)
        .map(|amount| amount.commodity.clone())
        .find(|commodity| !commodity.is_empty())
}
