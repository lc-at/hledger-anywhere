//! Balances panel: the balance report, with its report options.
//!
//! This is the panel that proves the full-CLI engine is worth its build: `--tree`
//! gives real parent sub-totals and indentation, and `--depth` collapses the
//! tree, neither of which the interim bridge could do. The options are hidden
//! when the engine cannot honour them, rather than being shown and ignored.

use leptos::prelude::*;

use crate::hledger::report::ReportSpec;
use crate::journal;
use crate::layout::model::PanelId;
use crate::panels::{error_panel, message_panel, report_view};
use crate::state::AppState;

pub fn view(id: PanelId) -> AnyView {
    let state = expect_context::<AppState>();

    let tree = RwSignal::new(true);
    let depth = RwSignal::new(String::new());

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
        }
        state.report_for(id, spec);
    });

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
                        on:change=move |_| tree.update(|value| *value = !*value)
                    />
                    "tree"
                </label>
                <label>
                    "depth"
                    <select
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
        <div class="panel panel-balances">
            {controls}
            {report_view(state, id, |output| {
                match journal::model::parse_balance(&output.stdout) {
                    Ok(report) if report.rows.is_empty() => {
                        message_panel("This journal has no balances to report.")
                    }
                    Ok(report) => view! {
                        <table class="panel-table">
                            <thead>
                                <tr>
                                    <th>"Account"</th>
                                    <th class="num">"Balance"</th>
                                </tr>
                            </thead>
                            <tbody>
                                {report
                                    .rows
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
                                        let amounts = row.amounts_display();
                                        let zero = row.amounts.iter().all(|amount| {
                                            amount.quantity.0.is_zero()
                                        });
                                        view! {
                                            <tr class:panel-row-zero=zero>
                                                <td style=style title=full>{name}</td>
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
                    .into_any(),
                    Err(error) => error_panel(&format!(
                        "Could not decode the balance report: {error}"
                    )),
                }
            })}
        </div>
    }
    .into_any()
}
