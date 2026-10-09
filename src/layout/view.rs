//! Rendering the layout tree with Leptos (wasm-only).
//!
//! `layout::model` owns the data; this module turns it into DOM and maps pointer
//! gestures back into model operations.
//!
//! Two decisions are worth knowing before reading:
//!
//! * **The tree is re-rendered from the model**, not patched field by field.
//!   Layouts are small (a handful of panes) and structural changes are rare, so
//!   a full rebuild is far cheaper than the complexity of diffing. Panel *data*
//!   lives in signals, so it is unaffected by a rebuild.
//! * **A splitter drag never touches the model.** Rebuilding the tree on every
//!   pointermove would replace the very element holding the pointer capture, so
//!   the drag writes `flex-grow` straight to the two DOM nodes and only commits
//!   the final delta on pointer-up. This is why `AppState::drag` must not be
//!   read reactively in a view.
//!
//! Sizes are shares, so a pane's share becomes its CSS `flex-grow` with a
//! `flex-basis` of 0: the flex algorithm then distributes exactly the space left
//! over by the fixed-width splitters, which keeps the arithmetic honest without
//! this module ever measuring the container.

use leptos::prelude::*;
use wasm_bindgen::JsCast;
use wasm_bindgen::closure::Closure;
use web_sys::{Element, HtmlElement, KeyboardEvent, PointerEvent};

use crate::layout::model::{
    Child, Dir, DropGeometry, DropRegion, DropTarget, MIN_SIZE, Node, PaneRect, PanelId,
    PanelInstance, Rect, TabRect, hit_test,
};
use crate::panels;
use crate::state::{AppState, DRAG_PROXY_ID, DROP_INDICATOR_ID, DragState, TabDrag};

/// The whole layout area: the tree, or a prompt when nothing is open.
#[component]
pub fn LayoutView() -> impl IntoView {
    let state = expect_context::<AppState>();
    // Once, for the life of the app: a drag must never be able to strand the
    // drop indicator if pointer capture is lost.
    install_drag_guards(state);
    view! {
        <div class="gl-root">
            {move || {
                let layout = state.layout.get();
                // A maximised pane stands in for the whole tree while it is on.
                // The tree underneath is untouched, so restoring is exact and
                // costs nothing — the same way Golden Layout's maximise works.
                match layout.maximised.and_then(|id| layout.stack_containing(id)) {
                    Some(Node::Stack { panels, active }) => {
                        render_stack(state, panels, active, true)
                    }
                    _ => match layout.root {
                        Some(node) => render_node(state, node, Vec::new()),
                        None => render_empty(state),
                    },
                }
            }}
            // Both of these are positioned directly during a drag rather than
            // re-rendered. See `show_drop_indicator`.
            <div class="gl-drop-indicator" id=DROP_INDICATOR_ID style="display:none"></div>
            <div class="gl-drag-proxy" id=DRAG_PROXY_ID style="display:none"></div>
        </div>
    }
}

fn render_node(state: AppState, node: Node, path: Vec<usize>) -> AnyView {
    match node {
        Node::Stack { panels, active } => render_stack(state, panels, active, false),
        Node::Split { dir, children } => render_split(state, dir, children, path),
    }
}

/// Render a split: children interleaved with the draggable gutters between them.
///
/// Interleaving matters. A gutter's neighbours in the DOM are exactly the two
/// panes it resizes, so the drag handlers can find them with
/// `previous_element_sibling` / `next_element_sibling` and never need to know
/// their indices or hold references to them.
fn render_split(state: AppState, dir: Dir, children: Vec<Child>, path: Vec<usize>) -> AnyView {
    let class = match dir {
        Dir::Row => "gl-split gl-row",
        Dir::Column => "gl-split gl-col",
    };
    let count = children.len();

    let mut parts: Vec<AnyView> = Vec::with_capacity(count * 2);
    for (index, child) in children.into_iter().enumerate() {
        let mut child_path = path.clone();
        child_path.push(index);
        let style = format!("flex-grow: {}", child.size);
        parts.push(
            view! {
                <div class="gl-cell" style=style>
                    {render_node(state, child.node, child_path)}
                </div>
            }
            .into_any(),
        );
        if index + 1 < count {
            parts.push(splitter(state, dir, path.clone(), index));
        }
    }

    view! { <div class=class>{parts}</div> }.into_any()
}

fn render_stack(
    state: AppState,
    instances: Vec<PanelInstance>,
    active: usize,
    maximised: bool,
) -> AnyView {
    let active = active.min(instances.len().saturating_sub(1));

    // Identifies this pane when a tab is dragged over it. The *active* panel is
    // used rather than the first, so dragging the first tab of a stack onto an
    // edge of that same stack still has a different id to aim at.
    let pane_id = instances
        .get(active)
        .map(|instance| instance.id.to_string())
        .unwrap_or_default();

    // The pane is a tab panel, so it needs the name of the tab that is showing.
    let active_title = instances
        .get(active)
        .map(|instance| panels::title_for(&instance.kind))
        .unwrap_or_default();

    let tabs = instances
        .iter()
        .enumerate()
        .map(|(index, instance)| {
            let id = instance.id;
            let selected = index == active;
            let title = panels::title_for(&instance.kind);
            // A separate binding for the accessible name: the view macro moves
            // both values, and a `.clone()` inside it would make the attribute
            // depend on the order the macro expands its arguments in.
            let tab_label = title.clone();
            let icon = panels::icon_for(&instance.kind);
            let tab_panel = id.to_string();

            let on_down = move |ev: PointerEvent| {
                // Left button only, and never from the close button.
                if ev.button() != 0 {
                    return;
                }
                if let Some(target) = ev.target().and_then(|t| t.dyn_into::<Element>().ok())
                    && target.closest(".gl-tab-close").ok().flatten().is_some()
                {
                    return;
                }
                let Some(element) = event_element(&ev) else {
                    return;
                };
                // Suppress the browser's own drag/text-selection handling; the
                // gesture is resolved here, on pointer-up.
                ev.prevent_default();
                let _ = element.set_pointer_capture(ev.pointer_id());
                state.tab_drag.set(Some(TabDrag {
                    pointer_id: ev.pointer_id(),
                    panel: id,
                    origin_x: ev.client_x() as f64,
                    origin_y: ev.client_y() as f64,
                    active: false,
                }));
            };

            let on_move = move |ev: PointerEvent| {
                let Some(mut drag) = state.tab_drag.get_untracked() else {
                    return;
                };
                if drag.pointer_id != ev.pointer_id() {
                    return;
                }

                let x = ev.client_x() as f64;
                let y = ev.client_y() as f64;

                if !drag.active {
                    let distance =
                        ((x - drag.origin_x).powi(2) + (y - drag.origin_y).powi(2)).sqrt();
                    if distance < DRAG_THRESHOLD_PX {
                        return;
                    }
                    drag.active = true;
                    state.tab_drag.set(Some(drag));
                    // Measured once, here, rather than per move: see
                    // `AppState::geometry`.
                    state.geometry.set(collect_drop_geometry());
                    state.cache_drag_elements();
                    if let Some(element) = event_element(&ev) {
                        mark_dragging(state, &element);
                    }
                }

                // Pure arithmetic against the snapshot — no DOM reads — and the
                // result is written straight to the indicator, in this same
                // event, so it moves with the pointer instead of a task later.
                let target = hit_test(&state.geometry.get_untracked(), x, y, drag.panel);
                show_drop_indicator(state, target);
                move_drag_proxy(state, x, y);
            };

            let on_up = move |ev: PointerEvent| {
                let Some(drag) = state.tab_drag.get_untracked() else {
                    return;
                };
                if drag.pointer_id != ev.pointer_id() {
                    return;
                }

                // The target is recomputed from where the pointer actually was
                // released, rather than read back from whatever the indicator
                // was last told to show.
                let target = hit_test(
                    &state.geometry.get_untracked(),
                    ev.client_x() as f64,
                    ev.client_y() as f64,
                    drag.panel,
                );
                state.end_tab_drag();

                if drag.active {
                    // A drag is not a click: activating the tab as well would be
                    // surprising, and would fight the move.
                    match target {
                        Some(DropTarget::Pane { panel, region, .. }) => {
                            state.layout.update(|layout| {
                                layout.move_panel(drag.panel, panel, region);
                            });
                        }
                        Some(DropTarget::Tab { panel, before, .. }) => {
                            state.layout.update(|layout| {
                                layout.reorder_panel(drag.panel, panel, before);
                            });
                        }
                        None => {}
                    }
                    return;
                }

                // A press that never moved is an ordinary tab click.
                state.layout.update(|layout| {
                    layout.activate(drag.panel);
                });
            };
            let on_cancel = on_up;

            // Tabs are reachable and operable by keyboard. Arrowing along the bar
            // moves focus *only*: opening the next panel is a whole engine
            // invocation, and moving through six tabs should not start six
            // reports. Enter opens whatever focus landed on — the same
            // manual-activation rule the ARIA tabs pattern prescribes when
            // selection is expensive.
            let on_key = move |ev: KeyboardEvent| match ev.key().as_str() {
                "Enter" | " " => {
                    ev.prevent_default();
                    state.layout.update(|layout| {
                        layout.activate(id);
                    });
                }
                "ArrowRight" | "ArrowLeft" => {
                    ev.prevent_default();
                    let Some(current) =
                        ev.current_target().and_then(|t| t.dyn_into::<Element>().ok())
                    else {
                        return;
                    };
                    // Walk the tabs, not the siblings: the last tab's next
                    // sibling is the tab bar's filler span, which is not a tab
                    // and not focusable.
                    let Some(bar) = current.parent_element() else {
                        return;
                    };
                    let tabs: Vec<Element> = bar
                        .query_selector_all(".gl-tab")
                        .ok()
                        .map(|nodes| {
                            (0..nodes.length())
                                .filter_map(|index| nodes.item(index))
                                .filter_map(|node| node.dyn_into::<Element>().ok())
                                .collect()
                        })
                        .unwrap_or_default();
                    let (Some(index), false) =
                        (tabs.iter().position(|tab| *tab == current), tabs.is_empty())
                    else {
                        return;
                    };
                    // Wrap, as the tabs pattern asks: a tab list is a ring, and
                    // the end of the bar is not a wall.
                    let next = if ev.key() == "ArrowRight" {
                        (index + 1) % tabs.len()
                    } else {
                        (index + tabs.len() - 1) % tabs.len()
                    };
                    if let Some(tab) = tabs.get(next).and_then(|t| t.clone().dyn_into::<HtmlElement>().ok())
                    {
                        let _ = tab.focus();
                    }
                }
                _ => {}
            };

            view! {
                <div
                    class="gl-tab"
                    class:gl-tab-active=selected
                    data-tab-panel=tab_panel
                    role="tab"
                    tabindex="0"
                    aria-selected=if selected { "true" } else { "false" }
                    aria-label=tab_label
                    on:pointerdown=on_down
                    on:pointermove=on_move
                    on:pointerup=on_up
                    on:pointercancel=on_cancel
                    on:keydown=on_key
                >
                    <span class="gl-tab-icon">{icon}</span>
                    <span class="gl-tab-title">{title}</span>
                    <button
                        class="gl-tab-close"
                        title="Close panel"
                        on:click=move |ev: web_sys::MouseEvent| {
                            // The tab's own gesture resolution is on pointer
                            // events, so this click does not need to stop
                            // propagation — but it is harmless and explicit.
                            ev.stop_propagation();
                            state.layout.update(|layout| {
                                layout.close_panel(id);
                            });
                        }
                    >
                        "×"
                    </button>
                </div>
            }
        })
        .collect_view();

    let body = instances.get(active).map(|instance| {
        let id = instance.id;
        match panels::def(&instance.kind) {
            Some(def) => (def.view)(id),
            None => panels::unknown_kind(&instance.kind),
        }
    });

    let restore_title = if maximised { "Restore" } else { "Maximise" };
    let on_maximise = {
        let panel = pane_id.clone();
        move |ev: web_sys::MouseEvent| {
            ev.stop_propagation();
            let Ok(panel) = panel.parse::<PanelId>() else {
                return;
            };
            state.layout.update(|layout| {
                layout.toggle_maximised(panel);
            });
        }
    };

    view! {
        <div class="gl-stack" data-pane-id=pane_id>
            <div class="gl-tabbar" role="tablist">
                {tabs}
                <span class="gl-tabbar-fill"></span>
                <button
                    class="gl-tab-maximise"
                    title=restore_title
                    on:click=on_maximise
                >
                    {maximise_icon(maximised)}
                </button>
            </div>
            <div class="gl-body" role="tabpanel" aria-label=active_title>
                {body}
            </div>
        </div>
    }
    .into_any()
}

/// The expand/restore glyph, drawn rather than typed.
///
/// Inline SVG so it renders identically everywhere: the obvious Unicode
/// characters for this (⛶, ❐) are missing from enough fonts to be a lottery.
fn maximise_icon(restore: bool) -> AnyView {
    if restore {
        view! {
            <svg viewBox="0 0 12 12" width="12" height="12" aria-hidden="true">
                <path
                    d="M5 1v4H1M7 11V7h4M1 5l4-4M11 7l-4 4"
                    fill="none"
                    stroke="currentColor"
                ></path>
            </svg>
        }
        .into_any()
    } else {
        view! {
            <svg viewBox="0 0 12 12" width="12" height="12" aria-hidden="true">
                <path
                    d="M1 5V1h4M11 7v4H7M1 1l4 4M11 11L7 7"
                    fill="none"
                    stroke="currentColor"
                ></path>
            </svg>
        }
        .into_any()
    }
}

/// How far a tab must move before the gesture counts as a drag rather than a
/// click.
///
/// Small, because the threshold is dead time: nothing at all happens until it is
/// crossed, and a gesture that does not begin immediately reads as unresponsive.
/// Three pixels is still enough to survive a shaky click — and a click that never
/// crosses it is handled as a tab activation on pointer-up either way.
const DRAG_THRESHOLD_PX: f64 = 3.0;

/// Measure every pane and tab once, at the start of a drag.
///
/// The only place a drag touches layout. Everything after it is arithmetic
/// against these rectangles, which is what keeps a drag tracking the pointer
/// instead of lagging a frame behind it.
///
/// Tabs are measured as well as panes because a tab is a drop target in its own
/// right: that is what makes dragging along a tab bar reorder tabs rather than
/// resolving to whatever region of the pane happens to be underneath.
fn collect_drop_geometry() -> DropGeometry {
    let Some(document) = web_sys::window().and_then(|window| window.document()) else {
        return DropGeometry::default();
    };

    let rects = |selector: &str, attribute: &str| -> Vec<(PanelId, Rect)> {
        let Ok(nodes) = document.query_selector_all(selector) else {
            return Vec::new();
        };
        let mut found = Vec::with_capacity(nodes.length() as usize);
        for index in 0..nodes.length() {
            let Some(node) = nodes.item(index) else {
                continue;
            };
            let Ok(element) = node.dyn_into::<Element>() else {
                continue;
            };
            let Some(panel) = element
                .get_attribute(attribute)
                .and_then(|value| value.parse::<PanelId>().ok())
            else {
                continue;
            };
            let rect = element.get_bounding_client_rect();
            found.push((
                panel,
                Rect {
                    x: rect.left(),
                    y: rect.top(),
                    width: rect.width(),
                    height: rect.height(),
                },
            ));
        }
        found
    };

    DropGeometry {
        panes: rects("[data-pane-id]", "data-pane-id")
            .into_iter()
            .map(|(panel, rect)| PaneRect { panel, rect })
            .collect(),
        tabs: rects(".gl-tab", "data-tab-panel")
            .into_iter()
            .map(|(panel, rect)| TabRect { panel, rect })
            .collect(),
    }
}

/// Show, in the DOM, that this is the tab being dragged, and pick it up.
///
/// Applied as classes and to a proxy element rather than through a reactive
/// flag: re-rendering the tab would replace the element that holds the pointer
/// capture and lose the rest of the gesture.
///
/// The proxy is Golden Layout's drag proxy: a small label that travels with the
/// pointer. Dimming the source tab alone stops being enough feedback the moment
/// the cursor leaves the tab bar.
fn mark_dragging(state: AppState, tab: &HtmlElement) {
    let _ = tab.class_list().add_1("gl-tab-dragging");
    if let Some(root) = web_sys::window()
        .and_then(|window| window.document())
        .and_then(|document| document.document_element())
    {
        let _ = root.class_list().add_1("gl-dragging");
    }

    let Some(proxy) = state.proxy.get_untracked() else {
        return;
    };
    let text_of = |selector: &str| {
        tab.query_selector(selector)
            .ok()
            .flatten()
            .and_then(|element| element.text_content())
            .unwrap_or_default()
    };
    proxy.set_text_content(Some(&format!(
        "{} {}",
        text_of(".gl-tab-icon").trim(),
        text_of(".gl-tab-title").trim()
    )));
    let _ = proxy.style().set_property("display", "block");
}

/// Catch a drag ending somewhere the tab will not hear about.
///
/// Pointer capture normally guarantees the tab sees its own `pointerup`, but it
/// is not absolute: a release outside the window, or over browser chrome, can
/// take the capture with it and strand the drop indicator on screen. These
/// listeners are installed once for the life of the app, and ending a drag is
/// the only thing they do.
///
/// The closures are deliberately leaked. They live exactly as long as the
/// document does, so there is no point at which they could be freed, and three
/// closures are a fair price for a gesture that cannot get stuck.
fn install_drag_guards(state: AppState) {
    let Some(window) = web_sys::window() else {
        return;
    };

    for event in ["pointerup", "pointercancel", "blur"] {
        let callback: Closure<dyn FnMut(web_sys::Event)> = Closure::new(move |_| {
            // This fires for every pointerup in the whole app, so check first:
            // ending a drag that is not happening would re-render the indicator
            // closure for nothing on every click.
            if state.tab_drag.get_untracked().is_some() {
                state.end_tab_drag();
            }
        });
        let _ = window
            .add_event_listener_with_callback(event, callback.as_ref().unchecked_ref::<js_sys::Function>());
        callback.forget();
    }
}

/// Position the drop indicator, synchronously, in the same event as the pointer.
///
/// A pane target highlights the region it would take: the whole pane for a
/// merge, or half of it for a split, in a slightly stronger shade, so the two
/// outcomes are never confusable. A tab target is drawn instead as a thin
/// insertion bar at the edge of the tab it would land beside — the same
/// affordance Golden Layout uses for reordering.
///
/// Written straight to the element rather than through a signal. A reactive
/// update is applied in a later task, which puts the indicator a frame behind
/// the pointer — and a drag where the feedback trails the input reads as
/// sluggish even when it is running at a locked 60 fps.
fn show_drop_indicator(state: AppState, target: Option<DropTarget>) {
    let Some(element) = state.indicator.get_untracked() else {
        return;
    };
    let style = element.style();
    let classes = element.class_list();

    let Some(target) = target else {
        let _ = style.set_property("display", "none");
        return;
    };

    let (x, y, width, height, split) = match target {
        DropTarget::Pane { region, rect, .. } => {
            let (x, y, width, height) = match region {
                DropRegion::Center => (rect.x, rect.y, rect.width, rect.height),
                DropRegion::Left => (rect.x, rect.y, rect.width / 2.0, rect.height),
                DropRegion::Right => (
                    rect.x + rect.width / 2.0,
                    rect.y,
                    rect.width / 2.0,
                    rect.height,
                ),
                DropRegion::Top => (rect.x, rect.y, rect.width, rect.height / 2.0),
                DropRegion::Bottom => (
                    rect.x,
                    rect.y + rect.height / 2.0,
                    rect.width,
                    rect.height / 2.0,
                ),
            };
            (x, y, width, height, region.is_split())
        }
        DropTarget::Tab { before, rect, .. } => {
            // A 2px bar at the tab's leading or trailing edge, nudged so it sits
            // in the gap rather than over the label.
            const BAR: f64 = 2.0;
            let edge = if before {
                rect.x - BAR / 2.0
            } else {
                rect.x + rect.width - BAR / 2.0
            };
            (edge, rect.y, BAR, rect.height, false)
        }
    };

    let _ = style.set_property("left", &format!("{x}px"));
    let _ = style.set_property("top", &format!("{y}px"));
    let _ = style.set_property("width", &format!("{width}px"));
    let _ = style.set_property("height", &format!("{height}px"));
    let _ = classes.toggle_with_force("gl-drop-indicator-split", split);
    let _ = classes.toggle_with_force(
        "gl-drop-indicator-tab",
        matches!(target, DropTarget::Tab { .. }),
    );
    let _ = style.set_property("display", "block");
}

/// Move the drag proxy to follow the pointer.
///
/// Offset down and right of the cursor so it never sits under the pointer and
/// obscure what is being aimed at.
fn move_drag_proxy(state: AppState, x: f64, y: f64) {
    let Some(proxy) = state.proxy.get_untracked() else {
        return;
    };
    let style = proxy.style();
    let _ = style.set_property("left", &format!("{}px", x + 14.0));
    let _ = style.set_property("top", &format!("{}px", y + 14.0));
}

/// Where the boundary between two panes should sit for a pointer at `position`,
/// as `(leading, trailing)` shares of the split.
///
/// Used for both the live preview and the commit. Deriving it twice would be an
/// easy way for the size the user saw to differ from the size that got written
/// to the model.
///
/// The arithmetic is exact rather than approximate: a pair holding `pair_share`
/// of the container occupies `pair_share × free_space` pixels, so converting a
/// pixel delta into a share delta divides by that pixel extent. The boundary
/// therefore tracks the pointer one-to-one instead of drifting.
fn boundary_shares(drag: &DragState, position: f64) -> (f32, f32) {
    let total = drag.pair_share as f64;
    let min = (MIN_SIZE as f64).min(total / 2.0);
    let leading = (drag.start_before as f64 + (position - drag.origin) / drag.pair_px * total)
        .clamp(min, total - min);
    (leading as f32, (total - leading) as f32)
}

/// A draggable gutter between two panes.
fn splitter(state: AppState, dir: Dir, split_path: Vec<usize>, boundary: usize) -> AnyView {
    let vertical = matches!(dir, Dir::Column);
    let class = if vertical {
        "gl-splitter gl-splitter-col"
    } else {
        "gl-splitter gl-splitter-row"
    };

    let on_down = {
        let split_path = split_path.clone();
        move |ev: PointerEvent| {
            let Some(gutter) = event_element(&ev) else {
                return;
            };
            let (Some(before), Some(after)) =
                (gutter.previous_element_sibling(), gutter.next_element_sibling())
            else {
                return;
            };

            // The two panes must currently have real size for the drag to have
            // anything to work with. A non-finite or non-positive extent means
            // the pane is hidden, and a zero-denominator drag would be NaN.
            let (before_rect, after_rect) =
                (before.get_bounding_client_rect(), after.get_bounding_client_rect());
            let pair_px = if vertical {
                before_rect.height() + after_rect.height()
            } else {
                before_rect.width() + after_rect.width()
            };
            if !pair_px.is_finite() || pair_px <= 0.0 {
                return;
            }

            // Shares come from the model, which is the authority on them.
            let Some((start_before, start_after)) = state
                .layout
                .get_untracked()
                .boundary_pair(&split_path, boundary)
            else {
                return;
            };

            // Kept for the whole gesture so the move handler never has to look
            // anything up. Both are `HtmlElement`s we already know exist.
            if let (Ok(before), Ok(after)) = (
                before.clone().dyn_into::<HtmlElement>(),
                after.clone().dyn_into::<HtmlElement>(),
            ) {
                state.splitter_panes.set(Some((before, after)));
            }

            // Stops text selection from starting and keeps the gesture on the
            // gutter even when the pointer leaves it.
            ev.prevent_default();
            let _ = gutter.set_pointer_capture(ev.pointer_id());

            state.drag.set(Some(DragState {
                pointer_id: ev.pointer_id(),
                vertical,
                origin: if vertical {
                    ev.client_y() as f64
                } else {
                    ev.client_x() as f64
                },
                pair_px,
                pair_share: start_before + start_after,
                start_before,
            }));
        }
    };

    let on_move = {
        move |ev: PointerEvent| {
            let Some(drag) = state.drag.get_untracked() else {
                return;
            };
            if drag.pointer_id != ev.pointer_id() {
                return;
            }
            let Some((before, after)) = state.splitter_panes.get_untracked() else {
                return;
            };

            let position = if drag.vertical {
                ev.client_y() as f64
            } else {
                ev.client_x() as f64
            };
            let (leading, trailing) = boundary_shares(&drag, position);

            // Preview only. No model write and no signal write, so nothing
            // re-renders and the gesture stays a pure DOM update.
            set_flex_grow(&before, leading);
            set_flex_grow(&after, trailing);
        }
    };

    // A gutter is a control, so it is reachable and adjustable without a drag.
    // The arrows move it by a fixed share rather than by a pixel: the model
    // stores shares, and a share is the only unit that survives a window resize.
    let on_key = {
        let split_path = split_path.clone();
        move |ev: KeyboardEvent| {
            const STEP: f32 = 0.02;
            // Left/Right for a gutter between side-by-side panes, Up/Down for one
            // between stacked panes — the axis the gutter actually moves along.
            let delta = match (ev.key().as_str(), vertical) {
                ("ArrowLeft", false) | ("ArrowUp", true) => -STEP,
                ("ArrowRight", false) | ("ArrowDown", true) => STEP,
                _ => return,
            };
            ev.prevent_default();
            // A full update here, unlike the drag: there is no DOM preview to
            // preserve, and the shares are what has to change. Panels do not
            // re-run their reports for it — `report_for` skips a report whose
            // request key has not changed.
            state.layout.update(|layout| {
                layout.resize_split(&split_path, boundary, delta);
            });
            state.persist_layout();
        }
    };

    let on_up = {
        move |ev: PointerEvent| {
            let Some(drag) = state.drag.get_untracked() else {
                return;
            };
            if drag.pointer_id != ev.pointer_id() {
                return;
            }
            state.drag.set(None);
            state.splitter_panes.set(None);

            let position = if drag.vertical {
                ev.client_y() as f64
            } else {
                ev.client_x() as f64
            };
            let (leading, _) = boundary_shares(&drag, position);
            let delta = leading - drag.start_before;
            if delta == 0.0 {
                return;
            }

            // Committed without notifying: the preview already put these exact
            // sizes in the DOM, so re-rendering would rebuild every pane to
            // change nothing visible — and re-run each panel's effect on the
            // way. Storage is written explicitly because no effect will fire.
            state.layout.update_untracked(|layout| {
                layout.resize_split(&split_path, boundary, delta);
            });
            state.persist_layout();
        }
    };
    // Not `Copy`: this closure captures the split path.
    let on_cancel = on_up.clone();

    let orientation = if vertical { "horizontal" } else { "vertical" };

    view! {
        <div
            class=class
            role="separator"
            tabindex="0"
            aria-orientation=orientation
            aria-label="Resize panes"
            title="Drag, or use the arrow keys, to resize"
            on:pointerdown=on_down
            on:pointermove=on_move
            on:pointerup=on_up
            on:pointercancel=on_cancel
            on:keydown=on_key
        ></div>
    }
    .into_any()
}

/// Shown when every panel has been closed.
fn render_empty(state: AppState) -> AnyView {
    view! {
        <div class="gl-empty">
            <div class="gl-empty-inner">
                <h2>"No panels open"</h2>
                <p>"Add a panel to start exploring your journals."</p>
                <div class="gl-empty-actions">
                    {panels::PANELS
                        .iter()
                        .map(|def| {
                            let kind = def.kind;
                            view! {
                                <button class="gl-btn" on:click=move |_| state.add_panel(kind)>
                                    {def.icon} " " {def.title}
                                </button>
                            }
                        })
                        .collect_view()}
                </div>
            </div>
        </div>
    }
    .into_any()
}

fn event_element(ev: &PointerEvent) -> Option<HtmlElement> {
    ev.current_target()?.dyn_into::<HtmlElement>().ok()
}

/// Write a pane's share straight to the DOM, bypassing reactivity.
fn set_flex_grow(element: &Element, value: f32) {
    if let Some(html) = element.dyn_ref::<HtmlElement>() {
        let _ = html.style().set_property("flex-grow", &value.to_string());
    }
}
