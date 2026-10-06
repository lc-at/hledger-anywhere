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
use web_sys::{Element, HtmlElement, PointerEvent};

use crate::layout::model::{
    Child, Dir, DropRegion, MIN_SIZE, Node, PaneRect, PanelId, PanelInstance, Rect, hit_test,
};
use crate::panels;
use crate::state::{AppState, DROP_INDICATOR_ID, DragState, TabDrag};

/// The whole layout area: the tree, or a prompt when nothing is open.
#[component]
pub fn LayoutView() -> impl IntoView {
    let state = expect_context::<AppState>();
    // Once, for the life of the app: a drag must never be able to strand the
    // drop indicator if pointer capture is lost.
    install_drag_guards(state);
    view! {
        <div class="gl-root">
            {move || match state.layout.get().root {
                Some(node) => render_node(state, node, Vec::new()),
                None => render_empty(state),
            }}
            // One persistent indicator, positioned directly during a drag rather
            // than re-rendered. See `show_drop_indicator`.
            <div class="gl-drop-indicator" id=DROP_INDICATOR_ID style="display:none"></div>
        </div>
    }
}

fn render_node(state: AppState, node: Node, path: Vec<usize>) -> AnyView {
    match node {
        Node::Stack { panels, active } => render_stack(state, panels, active),
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

fn render_stack(state: AppState, instances: Vec<PanelInstance>, active: usize) -> AnyView {
    let active = active.min(instances.len().saturating_sub(1));

    // Identifies this pane when a tab is dragged over it. The *active* panel is
    // used rather than the first, so dragging the first tab of a stack onto an
    // edge of that same stack still has a different id to aim at.
    let pane_id = instances
        .get(active)
        .map(|instance| instance.id.to_string())
        .unwrap_or_default();

    let tabs = instances
        .iter()
        .enumerate()
        .map(|(index, instance)| {
            let id = instance.id;
            let selected = index == active;
            let title = panels::title_for(&instance.kind);
            let icon = panels::icon_for(&instance.kind);

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
                    // `AppState::pane_rects`.
                    state.pane_rects.set(collect_pane_rects());
                    state.cache_indicator();
                    if let Some(element) = event_element(&ev) {
                        mark_dragging(&element);
                    }
                }

                // Pure arithmetic against the snapshot — no DOM reads — and the
                // result is written straight to the indicator, in this same
                // event, so it moves with the pointer instead of a task later.
                let target = hit_test(&state.pane_rects.get_untracked(), x, y, drag.panel);
                show_drop_indicator(state, target);
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
                    &state.pane_rects.get_untracked(),
                    ev.client_x() as f64,
                    ev.client_y() as f64,
                    drag.panel,
                );
                state.end_tab_drag();

                if drag.active {
                    // A drag is not a click: activating the tab as well would be
                    // surprising, and would fight the move.
                    if let Some((target, region, _)) = target {
                        state.layout.update(|layout| {
                            layout.move_panel(drag.panel, target, region);
                        });
                    }
                    return;
                }

                // A press that never moved is an ordinary tab click.
                state.layout.update(|layout| {
                    layout.activate(drag.panel);
                });
            };
            let on_cancel = on_up;

            view! {
                <div
                    class="gl-tab"
                    class:gl-tab-active=selected
                    on:pointerdown=on_down
                    on:pointermove=on_move
                    on:pointerup=on_up
                    on:pointercancel=on_cancel
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

    view! {
        <div class="gl-stack" data-pane-id=pane_id>
            <div class="gl-tabbar">{tabs}</div>
            <div class="gl-body">{body}</div>
        </div>
    }
    .into_any()
}

/// How far a tab must move before the gesture counts as a drag rather than a
/// click.
///
/// Small, because the threshold is dead time: nothing at all happens until it is
/// crossed, and a gesture that does not begin immediately reads as unresponsive.
/// Three pixels is still enough to survive a shaky click — and a click that never
/// crosses it is handled as a tab activation on pointer-up either way.
const DRAG_THRESHOLD_PX: f64 = 3.0;

/// Measure every pane once, at the start of a drag.
///
/// The only place a drag touches layout. Everything after it is arithmetic
/// against these rectangles, which is what keeps a drag tracking the pointer
/// instead of lagging a frame behind it.
fn collect_pane_rects() -> Vec<PaneRect> {
    let Some(document) = web_sys::window().and_then(|window| window.document()) else {
        return Vec::new();
    };
    let Ok(nodes) = document.query_selector_all("[data-pane-id]") else {
        return Vec::new();
    };

    let mut panes = Vec::with_capacity(nodes.length() as usize);
    for index in 0..nodes.length() {
        let Some(node) = nodes.item(index) else {
            continue;
        };
        let Ok(element) = node.dyn_into::<Element>() else {
            continue;
        };
        let Some(panel) = element
            .get_attribute("data-pane-id")
            .and_then(|value| value.parse::<PanelId>().ok())
        else {
            continue;
        };
        let rect = element.get_bounding_client_rect();
        panes.push(PaneRect {
            panel,
            rect: Rect {
                x: rect.left(),
                y: rect.top(),
                width: rect.width(),
                height: rect.height(),
            },
        });
    }
    panes
}

/// Show, in the DOM, that this is the tab being dragged.
///
/// Applied as a class rather than through a reactive flag: re-rendering the tab
/// would replace the element that holds the pointer capture and lose the rest of
/// the gesture.
fn mark_dragging(tab: &HtmlElement) {
    let _ = tab.class_list().add_1("gl-tab-dragging");
    if let Some(root) = web_sys::window()
        .and_then(|window| window.document())
        .and_then(|document| document.document_element())
    {
        let _ = root.class_list().add_1("gl-dragging");
    }
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
/// A centre drop highlights the whole pane (it will become a tab there); an edge
/// drop highlights that half, in a slightly stronger shade, so the two outcomes
/// are never confusable.
///
/// Written straight to the element rather than through a signal. A reactive
/// update is applied in a later task, which puts the indicator a frame behind
/// the pointer — and a drag where the feedback trails the input reads as
/// sluggish even when it is running at a locked 60 fps.
fn show_drop_indicator(state: AppState, target: Option<(PanelId, DropRegion, Rect)>) {
    let Some(element) = state.indicator.get_untracked() else {
        return;
    };
    let style = element.style();

    let Some((_, region, rect)) = target else {
        let _ = style.set_property("display", "none");
        return;
    };

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

    let _ = style.set_property("left", &format!("{x}px"));
    let _ = style.set_property("top", &format!("{y}px"));
    let _ = style.set_property("width", &format!("{width}px"));
    let _ = style.set_property("height", &format!("{height}px"));
    let _ = element
        .class_list()
        .toggle_with_force("gl-drop-indicator-split", region.is_split());
    let _ = style.set_property("display", "block");
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

    view! {
        <div
            class=class
            on:pointerdown=on_down
            on:pointermove=on_move
            on:pointerup=on_up
            on:pointercancel=on_cancel
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
