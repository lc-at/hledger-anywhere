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

use crate::charts::data::Line;
use crate::charts::{line_chart, scale};
use crate::controls;
use crate::hledger::report::ReportSpec;
use crate::journal::reports::{
    PeriodicReport, default_commodity, parse_periodic_report, row_values,
};
use crate::layout::model::PanelId;
use crate::panels::table::QueryField;
use crate::panels::{argv_line, error_panel, message_panel, report_view};
use crate::query;
use crate::state::AppState;

/// How many account rows the chart draws, before the total line.
///
/// Past a handful, lines stop being distinguishable — especially on a phone —
/// and the table below always lists every period, so nothing is hidden by the
/// cap. Four plus the total leaves the default view at three: assets,
/// liabilities, net worth.
const MAX_LINES: usize = 4;

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
    let interval = RwSignal::new(state.recalled_index(id, controls::INTERVAL).unwrap_or(0));
    // One level deep by default. For the default `assets liabilities` query that
    // is exactly two rows — assets and liabilities — so the chart compares those
    // against net worth, rather than drawing a line for every leaf account.
    let depth =
        RwSignal::new(state.recalled_text(id, controls::DEPTH).unwrap_or_else(|| "1".to_string()));
    // Defaults to the net-worth view, not to the report's grand total. In a
    // double-entry journal every account balances to zero, so the grand total is
    // a flat line at zero — technically correct and completely useless as a
    // default. Assets plus liabilities *is* net worth, which is what people open
    // a balance-over-time chart to see.
    let query = RwSignal::new(
        state
            .recalled_text(id, controls::QUERY)
            .unwrap_or_else(|| "assets liabilities".to_string()),
    );

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
            let requested_depth = depth.get();
            if !requested_depth.is_empty() {
                spec = spec.arg("--depth").arg(requested_depth);
            }
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
                            state.remember(id, controls::INTERVAL, index.into());
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
                    "depth"
                    <select
                        prop:value=move || depth.get()
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
                    </select>
                </label>
                <QueryField
                panel=id
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
/// One line per account row, biggest last value first, plus the total. A single
/// total was the whole story before, which made the panel a plot of whatever
/// number the query happened to add up to; the rows are what make trends
/// comparable, and they cost nothing extra — hledger already returned them.
///
/// The total comes last and always, because for the default query it is net
/// worth, which is the figure the panel is named for.
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

    // Everything between here and the chart is about labelling what was plotted,
    // so the header can say which accounts the figure covers.
    let query = query.trim().to_string();
    let caption = if query.is_empty() {
        "everything (a balanced journal totals zero)".to_string()
    } else {
        query.clone()
    };

    let labels = report.labels();
    if labels.is_empty() {
        return message_panel("This report has no periods to plot.");
    }

    // Rows are ranked by their *last* value's magnitude — the size the account
    // has ended up at — rather than by hledger's own depth-first account order,
    // which has nothing to do with which accounts are worth following.
    let mut ranked: Vec<Line> = report
        .rows
        .iter()
        .map(|row| {
            Line::new(
                row.account().unwrap_or_default().to_string(),
                row_values(row, commodity.as_deref()),
            )
        })
        .collect();
    ranked.sort_by_key(|line| {
        std::cmp::Reverse(line.values.last().copied().unwrap_or_default().abs())
    });

    let mut lines: Vec<Line> = ranked.into_iter().take(MAX_LINES).collect();
    lines.push(Line::new("Total", report.grand_total_values(commodity.as_deref())));
    let chart = line_chart(labels.clone(), lines);

    // Name the commodity in the column heading. A mixed-commodity journal has to
    // pick one series, and a chart that does not say which one is impossible to
    // read — the figure can look "wrong" when it is simply denominated in
    // something other than expected.
    let balance_header = match &commodity {
        Some(commodity) => format!("Balance ({commodity})"),
        None => "Balance".to_string(),
    };
    let totals = report.grand_total_values(commodity.as_deref());
    let rows = labels
        .iter()
        .zip(totals)
        .map(|(label, value)| {
            let text = value_text(value, commodity.as_deref());
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
