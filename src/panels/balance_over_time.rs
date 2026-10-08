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
use crate::journal::reports::{PeriodicReport, default_commodity, parse_periodic_report};
use crate::layout::model::PanelId;
use crate::panels::table::QueryField;
use crate::panels::{argv_line, error_panel, message_panel, report_view};
use crate::query;
use crate::state::AppState;

/// The period flags, as `(label, flag)`, coarsest first.
///
/// Ordered and defaulted this way because the cost of this report is rows ×
/// periods, and periods is the half the user controls: on a real multi-year
/// journal `--monthly` is around ten megabytes and several seconds, while
/// `--yearly` is about a tenth of that and still reads as a trend. The finer
/// intervals stay one click away, which is where a deliberate choice belongs.
const INTERVALS: [(&str, &str); 4] = [
    ("yearly", "--yearly"),
    ("quarterly", "--quarterly"),
    ("monthly", "--monthly"),
    ("weekly", "--weekly"),
];

pub fn view(id: PanelId) -> AnyView {
    let state = expect_context::<AppState>();
    // An index into `INTERVALS` rather than the flag itself, so the control and
    // the argv cannot drift apart.
    let interval = RwSignal::new(0usize);
    // Defaults to the net-worth view, not to the report's grand total. In a
    // double-entry journal every account balances to zero, so the grand total is
    // a flat line at zero — technically correct and completely useless as a
    // default. Assets plus liabilities *is* net worth, which is what people open
    // a balance-over-time chart to see.
    let query = RwSignal::new("assets liabilities".to_string());

    Effect::new(move |_| {
        let _ = state.generation.get();
        let _ = state.refresh.get();
        // Let the focused pane load first; see `AppState::may_load`.
        if !state.may_load(id) {
            return;
        }

        // `--historical` is what makes the columns running balances. The bridge
        // ignores every option, so on that flavor the flags are not even asked
        // for: an option the engine silently discards is worse than no option.
        let mut spec = ReportSpec::json("balance");
        if state.flavor.get().supports_report_options() {
            let flag = INTERVALS
                .get(interval.get())
                .map(|(_, flag)| *flag)
                .unwrap_or("--yearly");
            spec = spec.arg("--historical").arg(flag);
            for argument in query::query_args(&query.get()) {
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
                <QueryField
                    applied=query
                    placeholder="accounts to total, e.g. assets liabilities — Enter applies"
                />
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
                    Ok(report) => series_view(state, &report, &query.get_untracked()),
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
///
/// The series is the *total of whatever the query selected*. For the default
/// query that is assets plus liabilities, i.e. net worth; for a query naming one
/// account it is that account's balance over time. It deliberately does not try
/// to pick "the matching row": a query like `assets liabilities` selects a
/// subtree with hundreds of rows, and their total is the meaningful figure, not
/// any single row.
fn series_view(state: AppState, report: &PeriodicReport, query: &str) -> AnyView {
    let commodity = state
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
                    .chain(report.rows.iter().flat_map(|row| row.amounts.iter()).flatten()),
            )
        });

    let values = report.grand_total_values(commodity.as_deref());

    // Everything between here and the chart is about labelling what was plotted,
    // so the header can say which accounts the figure covers.
    let query = query.trim().to_string();
    let caption = if query.is_empty() {
        "everything (a balanced journal totals zero)".to_string()
    } else {
        query.clone()
    };

    let data: Vec<(String, Decimal)> = report.labels().into_iter().zip(values).collect();
    if data.is_empty() {
        return message_panel("This report has no periods to plot.");
    }

    let chart = line_chart(&data);
    // Name the commodity in the column heading. A mixed-commodity journal has to
    // pick one series, and a chart that does not say which one is impossible to
    // read — the figure can look "wrong" when it is simply denominated in
    // something other than expected.
    let balance_header = match &commodity {
        Some(commodity) => format!("Balance ({commodity})"),
        None => "Balance".to_string(),
    };
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

    // Say what the line covers, so a figure is never mistaken for the whole
    // journal when it is one subtree of it.
    let caption_view = view! {
        <div class="panel-count">{format!("showing {caption}")}</div>
    };

    view! {
        {caption_view}
        {chart}
        <table class="panel-table">
            <thead>
                <tr>
                    <th>"Period"</th>
                    <th class="num">{balance_header}</th>
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
