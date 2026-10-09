//! Payees panel: who the money went to, as a bar chart and a table.
//!
//! hledger cannot group by payee for us. `balance --pivot payee` returns an
//! empty report with a zero total in the engine this app ships (1.52.4), while
//! `register --pivot payee` works — so the panel runs the register and totals it
//! here, because once pivoted a posting's *account* is the payee. That grouping
//! is [`total_by_payee`], which is pure and tested on the host.
//!
//! Like the register, it is bounded by a period by default: every row of a
//! pivoted register carries its own running balance, so the same window costs
//! several times what the equivalent `balance` does.
//!
//! `--historical` is deliberately *not* passed. It only changes the running
//! total, which this panel does not read, and it makes the engine compute a
//! balance per row for nothing.

use leptos::prelude::*;
use rust_decimal::Decimal;

use crate::charts::bar_chart;
use crate::hledger::report::ReportSpec;
use crate::journal::model::{PayeeTotal, parse_register, total_by_payee};
use crate::journal::money::{self, Amount};
use crate::journal::reports::{default_commodity, pick_amount};
use crate::layout::model::PanelId;
use crate::panels::table::{QueryField, sort_header};
use crate::panels::{argv_line, empty_report_view, error_panel, message_panel, report_view};
use crate::query::{self, SortDir};
use crate::state::AppState;

/// How many payees the bar chart draws.
///
/// A month of real spending has dozens of payees and a long tail; past a dozen
/// bars the labels collide and the chart stops saying anything. The table below
/// always lists every one.
const CHART_ROWS: usize = 12;

/// The windows this panel can be bounded to. See `register` for why the default
/// is a month rather than everything.
const PERIODS: [(&str, Option<&str>); 4] = [
    ("this month", Some("date:thismonth")),
    ("this quarter", Some("date:thisquarter")),
    ("this year", Some("date:thisyear")),
    ("all", None),
];

/// The index of the entry in [`PERIODS`] with no date bound.
const ALL_PERIODS: usize = 3;

/// The columns this table can be ordered by.
#[derive(Clone, Copy, PartialEq, Eq)]
enum SortKey {
    Payee,
    Amount,
}

impl SortKey {
    fn first_direction(self) -> SortDir {
        match self {
            SortKey::Payee => SortDir::Ascending,
            SortKey::Amount => SortDir::Descending,
        }
    }
}

pub fn view(id: PanelId) -> AnyView {
    let state = expect_context::<AppState>();
    let period = RwSignal::new(0usize);
    // Spending by default: the question this panel exists to answer is "who did
    // I pay", and without a query the pivot also collects employers, banks and
    // transfers — which is a different question. Clearing the field asks it.
    let query = RwSignal::new("expenses".to_string());
    let sort = RwSignal::new(Some((SortKey::Amount, SortDir::Descending)));

    Effect::new(move |_| {
        let _ = state.generation.get();
        let _ = state.refresh.get();
        // Tracked, so committing a new query re-runs the report.
        let requested = query.get();
        let requested_period = period.get();

        // Let the focused pane load first; see `AppState::may_load`.
        if !state.may_load(id) {
            return;
        }

        let mut spec = ReportSpec::json("register");
        // The bridge accepts no query arguments, so asking would return the whole
        // journal while the field claimed otherwise.
        if state.flavor.get().supports_report_options() {
            spec = spec.arg("--pivot").arg("payee");
            if let Some(Some(bound)) = PERIODS.get(requested_period).map(|(_, bound)| *bound) {
                spec = spec.arg(bound);
            }
            for argument in query::query_args(&requested) {
                spec = spec.arg(argument);
            }
        }
        state.report_for(id, spec);
    });

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

    let controls = move || {
        if !state.flavor.get().supports_report_options() {
            return ().into_any();
        }
        view! {
            <div class="panel-controls">
                <label>
                    "period"
                    <select
                        prop:value=move || period.get().to_string()
                        on:change=move |event| {
                            if let Ok(index) = event_target_value(&event).parse::<usize>() {
                                period.set(index);
                            }
                        }
                    >
                        {PERIODS
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
                    placeholder="query, e.g. not:transfer — Enter applies"
                />
            </div>
        }
        .into_any()
    };

    view! {
        <div class="panel panel-payees">
            {controls}
            {argv_line(state, id)}
            {report_view(state, id, move |output| {
                match parse_register(&output.stdout) {
                    Ok(entries) if entries.is_empty() => {
                        let index = period.get().min(PERIODS.len() - 1);
                        let (label, _) = PERIODS[index];
                        let text = query.get();
                        empty_report_view(Some((label, period, ALL_PERIODS)), &text, query)
                    }
                    Ok(entries) => payees_view(state, total_by_payee(&entries), sort, toggle, direction_of),
                    Err(error) => error_panel(&format!(
                        "Could not decode the register: {error}"
                    )),
                }
            })}
        </div>
    }
    .into_any()
}

/// The chart, then the full table.
fn payees_view<F, G>(
    state: AppState,
    totals: Vec<PayeeTotal>,
    sort: RwSignal<Option<(SortKey, SortDir)>>,
    toggle: F,
    direction_of: G,
) -> AnyView
where
    F: Fn(SortKey) + Copy + 'static,
    G: Fn(SortKey) -> Option<SortDir> + Copy + 'static,
{
    if totals.is_empty() {
        return message_panel("This query matches no payees.");
    }

    // One commodity for the chart and the ordering: a payee's total is a mixed
    // amount, and a chart cannot draw several at once.
    let commodity = state
        .settings
        .get_untracked()
        .main_currency
        .or_else(|| default_commodity(totals.iter().flat_map(|total| total.amounts.iter())));

    let value_of = |total: &PayeeTotal| -> Decimal {
        pick_amount(&total.amounts, commodity.as_deref())
            .map(|amount| amount.quantity.0)
            .unwrap_or_default()
    };

    // The chart takes the biggest, by absolute value: a month of spending has a
    // long tail that would flatten every meaningful bar.
    let mut ranked: Vec<(&PayeeTotal, Decimal)> = totals
        .iter()
        .map(|total| (total, value_of(total)))
        .collect();
    ranked.sort_by_key(|(_, value)| std::cmp::Reverse(value.abs()));

    let data: Vec<(String, Decimal)> = ranked
        .iter()
        .take(CHART_ROWS)
        .map(|(total, value)| (total.payee.clone(), *value))
        .collect();
    let chart = bar_chart(&data);
    let chart_note = (ranked.len() > CHART_ROWS)
        .then(|| format!("Charting the top {CHART_ROWS} by amount."));
    let note_view: AnyView = match chart_note {
        Some(text) => view! { <div class="panel-count">{text}</div> }.into_any(),
        None => ().into_any(),
    };

    let mut ordered = totals;
    if let Some((key, direction)) = sort.get() {
        query::sort_by_cmp(
            &mut ordered,
            |left, right| match key {
                SortKey::Payee => left.payee.cmp(&right.payee),
                SortKey::Amount => value_of(left).cmp(&value_of(right)),
            },
            direction,
        );
    }

    let count = ordered.len();
    let rows = ordered
        .iter()
        .map(|total| {
            let payee = total.payee.clone();
            let tooltip = payee.clone();
            let postings = total.postings;
            let amounts = total.amounts_display();
            let zero = total.amounts.iter().all(|amount| amount.quantity.0.is_zero());
            view! {
                <tr class:panel-row-zero=zero>
                    <td title=tooltip>{payee}</td>
                    <td class="num">{postings}</td>
                    <td class="num">{amounts}</td>
                </tr>
            }
        })
        .collect_view();

    // The table foots: the sum of every payee row, which is the same figure the
    // register totalled, so a row that looks wrong has something to be wrong
    // against.
    let mut everything: Vec<Amount> = Vec::new();
    for total in &ordered {
        everything.extend(total.amounts.iter().cloned());
    }
    let grand_total = money::mixed_display(&money::sum_by_commodity(&everything));

    // Name the commodity the chart and the default ordering use, since a mixed
    // amount has to resolve to one number for either.
    let commodity_note = commodity
        .as_ref()
        .map(|commodity| format!("Chart and default order use {commodity}."));

    view! {
        <div class="panel-count">{format!("{count} payee(s)")}</div>
        {commodity_note
            .map(|text| view! { <div class="panel-count">{text}</div> }.into_any())
            .unwrap_or_else(|| ().into_any())}
        {note_view}
        {chart}
        <table class="panel-table">
            <thead>
                <tr>
                    {sort_header(
                        "Payee",
                        false,
                        direction_of(SortKey::Payee),
                        move || toggle(SortKey::Payee),
                    )}
                    <th class="num">"Postings"</th>
                    {sort_header(
                        "Total",
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
                    <td></td>
                    <td class="num">{grand_total}</td>
                </tr>
            </tfoot>
        </table>
    }
    .into_any()
}
