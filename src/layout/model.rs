//! Pure (wasm-free) layout model.
//!
//! This is a Golden-Layout-style docking model: a tree of nested *splits*
//! (rows or columns) whose leaves are *stacks* (tab groups). Exactly one panel
//! in a stack is visible at a time.
//!
//! The model is deliberately the single source of truth for what is on screen,
//! and it is what gets serialized for persistence. Two invariants make every
//! operation simple:
//!
//! 1. **Sizes are shares, not pixels.** A [`Child`]'s `size` is its fraction of
//!    its parent split, so a split's children always sum to 1.0. Nothing here
//!    needs to know about pixels, scrollbars or DPI; the view turns shares into
//!    `flex-grow` values and turns pointer deltas into share deltas.
//! 2. **A normalized tree has no empty stacks and no single-child splits.**
//!    [`Layout::renormalise`] restores this after every mutation, hoisting the
//!    sole survivor of a collapsed split and accumulating its share on the way
//!    up so that closing a pane does not make its neighbours jump.
//!
//! The root is `Option<Node>` because an empty layout is a real state: the user
//! can close every panel, and the view then shows an "add a panel" placeholder.

// The consumers are the wasm-only view and panels, so a native build legitimately
// sees more API here than it uses.
#![cfg_attr(not(target_arch = "wasm32"), allow(dead_code))]

use serde::{Deserialize, Serialize};

/// Identifies one panel *instance* (two Accounts panels are two instances).
pub type PanelId = u64;

/// The smallest share a split child may take, so a pane can never be dragged
/// completely shut and become unrecoverable by dragging.
pub const MIN_SIZE: f32 = 0.05;

/// Split orientation: `Row` lays children out left-to-right, `Column` top-to-bottom.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum Dir {
    Row,
    Column,
}

/// Where a dragged panel would land relative to the pane under the pointer.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum DropRegion {
    /// Merge into that pane's stack, as another tab.
    Center,
    Left,
    Right,
    Top,
    Bottom,
}

impl DropRegion {
    /// The split this region creates: its direction, and whether the dragged
    /// panel goes before the pane it was dropped on.
    ///
    /// `Center` is not a split, hence `None`.
    fn placement(self) -> Option<(Dir, bool)> {
        match self {
            DropRegion::Center => None,
            DropRegion::Left => Some((Dir::Row, true)),
            DropRegion::Right => Some((Dir::Row, false)),
            DropRegion::Top => Some((Dir::Column, true)),
            DropRegion::Bottom => Some((Dir::Column, false)),
        }
    }

    /// Whether this region splits, as opposed to merging into a tab.
    pub fn is_split(self) -> bool {
        self.placement().is_some()
    }
}

/// A rectangle in viewport coordinates.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Rect {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

impl Rect {
    fn contains(&self, x: f64, y: f64) -> bool {
        x >= self.x && x <= self.x + self.width && y >= self.y && y <= self.y + self.height
    }

    fn has_extent(&self) -> bool {
        self.width.is_finite()
            && self.width > 0.0
            && self.height.is_finite()
            && self.height > 0.0
    }
}

/// A pane's position on screen, captured once at the start of a drag.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct PaneRect {
    /// Any panel in the pane; that is how a pane is addressed.
    pub panel: PanelId,
    pub rect: Rect,
}

/// Height of a stack's tab bar, in CSS pixels.
///
/// Mirrors `--gl-tabbar-height` in the stylesheet. `hit_test` needs it because
/// aiming at a stack's tabs has to mean "add this as a tab": a tab bar is only a
/// thin strip at the top of a pane, and without this the pointer over it would
/// resolve to the top edge and a drop there would split the pane — not what
/// anyone means when they aim at somebody else's tabs.
pub const TAB_BAR_HEIGHT: f64 = 27.0;

/// A tab's position on screen, captured at the start of a drag.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct TabRect {
    /// The panel that tab shows.
    pub panel: PanelId,
    pub rect: Rect,
}

/// Everything a drag needs to know about where things are.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct DropGeometry {
    pub panes: Vec<PaneRect>,
    pub tabs: Vec<TabRect>,
}

/// What a dragged panel would do if it were released at a point.
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum DropTarget {
    /// Merge into a pane, or split against it.
    Pane {
        panel: PanelId,
        region: DropRegion,
        rect: Rect,
    },
    /// Take a specific position in a tab bar. `before` is which side of the tab
    /// under the pointer it would be inserted on.
    Tab {
        panel: PanelId,
        before: bool,
        rect: Rect,
    },
}

/// Which pane or tab a viewport point is over, for a drag of `dragged`.
///
/// Deliberately takes pre-measured rectangles rather than looking anything up:
/// measuring during a drag means calling `getBoundingClientRect`, and doing that
/// on every pointermove forces a synchronous reflow per frame — the difference
/// between a drag that tracks the pointer and one that lags behind it. The rects
/// are snapshotted once, when the drag starts.
///
/// Tabs are tested before panes, because a tab sits *inside* its pane and must
/// win: that is what makes dragging along a tab bar reorder tabs, the way Golden
/// Layout does, instead of resolving to whatever pane region happens to be
/// underneath.
///
/// Pane regions are computed against the pane *body*, not the whole pane, so the
/// top edge is a real target rather than the few pixels between the tab bar and
/// the top of the content. Without that, aiming at the tab bar and slipping a
/// couple of pixels would turn "join these tabs" into "split above here".
///
/// Returns `None` when the point is over nothing, or over the middle of the pane
/// the drag started from — re-merging a tab into its own stack is nothing the
/// user can want, and showing a drop target there would just be noise. The
/// *edges* of that same pane are still valid, because that is how a stack gets
/// split apart.
pub fn hit_test(
    geometry: &DropGeometry,
    x: f64,
    y: f64,
    dragged: PanelId,
) -> Option<DropTarget> {
    // A tab wins over the pane behind it. Dropping onto the dragged tab itself
    // is nothing, but either side of it is a reorder.
    for tab in &geometry.tabs {
        if tab.panel == dragged || !tab.rect.has_extent() || !tab.rect.contains(x, y) {
            continue;
        }
        return Some(DropTarget::Tab {
            panel: tab.panel,
            before: x < tab.rect.x + tab.rect.width / 2.0,
            rect: tab.rect,
        });
    }

    let hit = geometry
        .panes
        .iter()
        .find(|pane| pane.rect.has_extent() && pane.rect.contains(x, y))?;

    let body_top = hit.rect.y + TAB_BAR_HEIGHT;
    let body_height = hit.rect.height - TAB_BAR_HEIGHT;

    let region = if body_height <= 0.0 || y <= body_top {
        // The tab bar itself, or a pane too short to have a body.
        DropRegion::Center
    } else {
        region_at(
            (x - hit.rect.x) / hit.rect.width,
            (y - body_top) / body_height,
        )
    };

    if hit.panel == dragged && !region.is_split() {
        return None;
    }

    Some(DropTarget::Pane {
        panel: hit.panel,
        region,
        rect: hit.rect,
    })
}

/// Which region of a pane a point falls in, given the point as a fraction of the
/// pane (`0.0`–`1.0` on each axis).
///
/// The middle is "tab into this stack"; the four edges split instead. The centre
/// box is the middle half of each axis — the same ballpark as other docking
/// libraries — so the edges are forgiving without making the centre awkward to
/// hit.
///
/// Kept pure and separately tested because the geometry is the part most likely
/// to be subtly wrong and least likely to be noticed by eye.
pub fn region_at(relative_x: f64, relative_y: f64) -> DropRegion {
    const EDGE: f64 = 0.25;
    let x = relative_x.clamp(0.0, 1.0);
    let y = relative_y.clamp(0.0, 1.0);

    if (EDGE..=1.0 - EDGE).contains(&x) && (EDGE..=1.0 - EDGE).contains(&y) {
        return DropRegion::Center;
    }

    // Outside the centre box the nearest edge wins, so corners resolve by
    // distance rather than by the order the cases happen to be written.
    [
        (x, DropRegion::Left),
        (1.0 - x, DropRegion::Right),
        (y, DropRegion::Top),
        (1.0 - y, DropRegion::Bottom),
    ]
    .into_iter()
    .min_by(|a, b| a.0.partial_cmp(&b.0).unwrap_or(std::cmp::Ordering::Equal))
    .map(|(_, region)| region)
    .unwrap_or(DropRegion::Center)
}

/// One open panel: which registered kind it is, and its unique instance id.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct PanelInstance {
    pub id: PanelId,
    pub kind: String,
}

/// A child of a split: how much of the parent it occupies, and its subtree.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Child {
    pub size: f32,
    pub node: Node,
}

/// A node in the layout tree.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub enum Node {
    /// A row or column of children, each with its own share.
    Split { dir: Dir, children: Vec<Child> },
    /// A tab group. `active` indexes `panels`; it is always in range.
    Stack {
        panels: Vec<PanelInstance>,
        active: usize,
    },
}

impl Node {
    /// The stack holding `id`, if any, as a path of child indices from the root.
    fn stack_path_of(&self, id: PanelId) -> Option<Vec<usize>> {
        let mut path = Vec::new();
        if self.find_stack(id, &mut path) {
            Some(path)
        } else {
            None
        }
    }

    fn find_stack(&self, id: PanelId, path: &mut Vec<usize>) -> bool {
        match self {
            Node::Stack { panels, .. } => panels.iter().any(|p| p.id == id),
            Node::Split { children, .. } => {
                for (i, child) in children.iter().enumerate() {
                    path.push(i);
                    if child.node.find_stack(id, path) {
                        return true;
                    }
                    path.pop();
                }
                false
            }
        }
    }

    /// The first stack in depth-first order, as a path from the root.
    fn first_stack_path(&self) -> Vec<usize> {
        let mut path = Vec::new();
        let mut node = self;
        loop {
            match node {
                Node::Stack { .. } => return path,
                Node::Split { children, .. } => {
                    // A normalized split always has children; guard anyway.
                    let Some(first) = children.first() else {
                        return path;
                    };
                    path.push(0);
                    node = &first.node;
                }
            }
        }
    }
}

/// The whole layout: the tree, which panel has focus, and the id allocator.
///
/// `focused` is what makes "add panel" land where the user expects it: a new
/// panel joins the focused panel's stack. It is `None` only when no panel is
/// open.
///
/// `maximised` names the panel whose stack is temporarily filling the layout.
/// It is stored as a panel id rather than a path so that it survives the tree
/// being rebuilt, and it is a *view* state: the tree underneath is untouched, so
/// restoring is exact and free. Golden Layout behaves the same way.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Layout {
    pub root: Option<Node>,
    pub focused: Option<PanelId>,
    /// `serde(default)` so layouts persisted before this field existed still
    /// load, rather than silently resetting to the default layout.
    #[serde(default)]
    pub maximised: Option<PanelId>,
    next_id: PanelId,
}

impl Default for Layout {
    fn default() -> Self {
        Layout::empty()
    }
}

impl Layout {
    /// A layout with no panels at all.
    pub fn empty() -> Self {
        Layout {
            root: None,
            focused: None,
            next_id: 1,
            maximised: None,
        }
    }

    /// The starting layout: reports along the top, console across the bottom.
    ///
    /// `kinds` supplies the panel kinds in the order they should be placed; it
    /// is a slice rather than a fixed list so the default can follow the
    /// registry rather than duplicating it.
    pub fn default_with(kinds: &[&str]) -> Self {
        let mut layout = Layout::empty();

        // Collect the ids we create so the first one can take focus.
        let mut made: Vec<PanelId> = Vec::new();
        let mut stack = |layout: &mut Layout, kinds: &[&str]| -> Node {
            let mut panels = Vec::new();
            for kind in kinds {
                let id = layout.next_id;
                layout.next_id += 1;
                made.push(id);
                panels.push(PanelInstance {
                    id,
                    kind: (*kind).to_string(),
                });
            }
            Node::Stack { panels, active: 0 }
        };

        let mut left = Vec::new();
        let mut middle = Vec::new();
        let mut right = Vec::new();
        let mut bottom = Vec::new();
        for (i, kind) in kinds.iter().enumerate() {
            match i {
                0 | 1 => left.push(*kind),
                2 => middle.push(*kind),
                3 => right.push(*kind),
                _ => bottom.push(*kind),
            }
        }

        let mut top_children = Vec::new();
        for (kinds, size) in [
            (left.as_slice(), 0.24),
            (middle.as_slice(), 0.44),
            (right.as_slice(), 0.32),
        ] {
            if !kinds.is_empty() {
                top_children.push(Child {
                    size,
                    node: stack(&mut layout, kinds),
                });
            }
        }

        let mut root_children = Vec::new();
        if !top_children.is_empty() {
            let node = if top_children.len() == 1 {
                top_children.pop().expect("checked non-empty").node
            } else {
                let total: f32 = top_children.iter().map(|c| c.size).sum();
                for child in &mut top_children {
                    child.size /= total;
                }
                Node::Split {
                    dir: Dir::Row,
                    children: top_children,
                }
            };
            root_children.push(Child { size: 0.74, node });
        }
        if !bottom.is_empty() {
            root_children.push(Child {
                size: 0.26,
                node: stack(&mut layout, &bottom),
            });
        }

        layout.root = if root_children.is_empty() {
            None
        } else if root_children.len() == 1 {
            Some(root_children.pop().expect("checked non-empty").node)
        } else {
            Some(Node::Split {
                dir: Dir::Column,
                children: root_children,
            })
        };
        layout.focused = made.first().copied();
        layout.renormalise();
        layout
    }

    fn node_at(&self, path: &[usize]) -> Option<&Node> {
        let mut node = self.root.as_ref()?;
        for &index in path {
            match node {
                Node::Split { children, .. } => node = &children.get(index)?.node,
                Node::Stack { .. } => return None,
            }
        }
        Some(node)
    }

    fn node_at_mut(&mut self, path: &[usize]) -> Option<&mut Node> {
        let mut node = self.root.as_mut()?;
        for &index in path {
            match node {
                Node::Split { children, .. } => node = &mut children.get_mut(index)?.node,
                Node::Stack { .. } => return None,
            }
        }
        Some(node)
    }

    /// Every open panel instance, in tree order.
    pub fn panels(&self) -> Vec<&PanelInstance> {
        fn walk<'a>(node: &'a Node, out: &mut Vec<&'a PanelInstance>) {
            match node {
                Node::Stack { panels, .. } => out.extend(panels.iter()),
                Node::Split { children, .. } => {
                    for child in children {
                        walk(&child.node, out);
                    }
                }
            }
        }
        let mut out = Vec::new();
        if let Some(root) = &self.root {
            walk(root, &mut out);
        }
        out
    }

    /// The first panel id in tree order, used to move focus after a close.
    fn first_panel_id(&self) -> Option<PanelId> {
        let root = self.root.as_ref()?;
        let path = root.first_stack_path();
        match self.node_at(&path) {
            Some(Node::Stack { panels, .. }) => panels.first().map(|p| p.id),
            _ => None,
        }
    }

    /// Restore the invariants: no empty stacks, no single-child splits, and
    /// sizes that sum to 1.0.
    pub fn renormalise(&mut self) {
        let root = self.root.take();
        self.root = root.and_then(|node| normalise(node, 1.0)).map(|c| c.node);

        // Focus must always name a panel that actually exists.
        if let Some(focused) = self.focused {
            let still_open = self
                .root
                .as_ref()
                .and_then(|root| root.stack_path_of(focused))
                .is_some();
            if !still_open {
                self.focused = self.first_panel_id();
            }
        }
        if self.focused.is_none() {
            self.focused = self.first_panel_id();
        }

        // A maximised panel that has since been closed must not leave the layout
        // showing a pane that no longer exists.
        if let Some(maximised) = self.maximised {
            let still_open = self
                .root
                .as_ref()
                .and_then(|root| root.stack_path_of(maximised))
                .is_some();
            if !still_open {
                self.maximised = None;
            }
        }
    }

    /// Fill the layout with `id`'s stack, or restore the tree if it already is.
    ///
    /// Only the view state changes; the tree is left exactly as it was, so
    /// restoring is exact and cannot lose a split or a size.
    pub fn toggle_maximised(&mut self, id: PanelId) -> bool {
        let exists = self
            .root
            .as_ref()
            .and_then(|root| root.stack_path_of(id))
            .is_some();
        if !exists {
            return false;
        }
        self.maximised = if self.maximised == Some(id) {
            None
        } else {
            Some(id)
        };
        self.focused = Some(id);
        true
    }

    /// The stack containing `id`, cloned, for rendering it on its own.
    pub fn stack_containing(&self, id: PanelId) -> Option<Node> {
        let path = self.root.as_ref()?.stack_path_of(id)?;
        self.node_at(&path).cloned()
    }

    /// Move `id` to sit immediately before or after `target` as a tab.
    ///
    /// This is the gesture Golden Layout calls reordering: dragging a tab along a
    /// tab bar (or onto another one) to change the order rather than the shape.
    /// Dragging a tab within its own stack is otherwise a no-op, which reads as
    /// broken.
    pub fn reorder_panel(&mut self, id: PanelId, target: PanelId, before: bool) -> bool {
        let mut candidate = self.clone();
        if candidate.try_reorder_panel(id, target, before) {
            *self = candidate;
            true
        } else {
            false
        }
    }

    fn try_reorder_panel(&mut self, id: PanelId, target: PanelId, before: bool) -> bool {
        if id == target {
            return false;
        }
        let order_before: Vec<PanelId> = self.panels().iter().map(|panel| panel.id).collect();

        let Some(source_path) = self.root.as_ref().and_then(|root| root.stack_path_of(id)) else {
            return false;
        };
        let Some(instance) = self.take_panel(&source_path, id) else {
            return false;
        };
        self.drop_empty_stack(&source_path);
        self.renormalise();

        // Re-resolved after the removal, which may have shifted or collapsed
        // everything above it.
        let Some(target_path) = self
            .root
            .as_ref()
            .and_then(|root| root.stack_path_of(target))
        else {
            return false;
        };
        let Some(Node::Stack { panels, active }) = self.node_at_mut(&target_path) else {
            return false;
        };
        let Some(index) = panels.iter().position(|panel| panel.id == target) else {
            return false;
        };

        let insert_at = if before { index } else { index + 1 };
        panels.insert(insert_at, instance);
        *active = insert_at;
        self.focused = Some(id);

        // Whether the order actually changed is the honest test of "was this a
        // reorder at all": dropping a tab back exactly where it was must not
        // count as an edit, or the caller would treat a no-op as a move.
        let order_after: Vec<PanelId> = self.panels().iter().map(|panel| panel.id).collect();
        order_after != order_before
    }

    /// Add a panel of `kind`, as a new tab in stack `target`.
    ///
    /// `target` selects the stack by any panel already in it (usually the
    /// focused panel). When `target` is `None`, or does not exist, the focused
    /// stack is used, falling back to the first stack, and finally to creating
    /// a new root stack.
    pub fn add_panel(&mut self, kind: impl Into<String>, target: Option<PanelId>) -> PanelId {
        let id = self.next_id;
        self.next_id += 1;

        let stack_path = target
            .and_then(|t| self.root.as_ref()?.stack_path_of(t))
            .or_else(|| {
                let focused = self.focused?;
                let root = self.root.as_ref()?;
                root.stack_path_of(focused)
            })
            .or_else(|| self.root.as_ref().map(|root| root.first_stack_path()));

        match stack_path {
            Some(path) => {
                if let Some(Node::Stack { panels, active }) = self.node_at_mut(&path) {
                    panels.push(PanelInstance {
                        id,
                        kind: kind.into(),
                    });
                    *active = panels.len() - 1;
                }
            }
            None => {
                // Nothing open yet: this panel becomes the whole layout.
                self.root = Some(Node::Stack {
                    panels: vec![PanelInstance {
                        id,
                        kind: kind.into(),
                    }],
                    active: 0,
                });
            }
        }

        self.focused = Some(id);
        self.renormalise();
        id
    }

    /// Close a panel. Returns false if `id` was not open.
    ///
    /// When the panel was the stack's last tab, the stack itself is removed
    /// from its parent split; `renormalise` then redistributes the space and
    /// hoists the split if only one child remains.
    pub fn close_panel(&mut self, id: PanelId) -> bool {
        let Some(stack_path) = self
            .root
            .as_ref()
            .and_then(|root| root.stack_path_of(id))
        else {
            return false;
        };

        if let Some(Node::Stack { panels, active }) = self.node_at_mut(&stack_path) {
            let Some(index) = panels.iter().position(|p| p.id == id) else {
                return false;
            };
            panels.remove(index);
            let len = panels.len();
            if len > 0 {
                if index < *active {
                    *active -= 1;
                } else if *active >= len {
                    *active = len - 1;
                }
            }
        }

        self.drop_empty_stack(&stack_path);

        if self.focused == Some(id) {
            self.focused = None;
        }
        self.renormalise();
        true
    }

    /// Remove a stack from its parent if it has become empty.
    ///
    /// Shared by `close_panel` and `move_panel`: both can leave a stack with no
    /// panels, and in both cases the stack itself must go rather than linger as
    /// an empty tab bar. `renormalise` afterwards hoists a single-child split and
    /// redistributes the space.
    fn drop_empty_stack(&mut self, stack_path: &[usize]) {
        let emptied = matches!(
            self.node_at(stack_path),
            Some(Node::Stack { panels, .. }) if panels.is_empty()
        );
        if !emptied {
            return;
        }

        if stack_path.is_empty() {
            self.root = None;
            return;
        }

        let child_index = stack_path[stack_path.len() - 1];
        let parent_path = &stack_path[..stack_path.len() - 1];
        if let Some(Node::Split { children, .. }) = self.node_at_mut(parent_path) {
            children.remove(child_index);
        }
    }

    /// Move a panel to another pane: merge into its stack, or split against it.
    ///
    /// The whole operation is applied to a copy and swapped in only on success.
    /// Docking has several ways to be a no-op or to invalidate a path it has
    /// already computed — dropping a panel onto itself, or onto the only other
    /// panel's stack such that the target disappears — and doing the work on a
    /// clone makes every one of those a clean "no change" instead of a partially
    /// applied edit.
    pub fn move_panel(&mut self, id: PanelId, target: PanelId, region: DropRegion) -> bool {
        let mut candidate = self.clone();
        if candidate.try_move_panel(id, target, region) {
            *self = candidate;
            true
        } else {
            false
        }
    }

    fn try_move_panel(&mut self, id: PanelId, target: PanelId, region: DropRegion) -> bool {
        if id == target {
            return false;
        }
        let Some(root) = self.root.as_ref() else {
            return false;
        };
        let Some(source_path) = root.stack_path_of(id) else {
            return false;
        };
        let Some(target_path) = root.stack_path_of(target) else {
            return false;
        };
        let same_stack = source_path == target_path;

        // Re-merging a panel into the stack it already occupies changes nothing.
        if same_stack && !region.is_split() {
            return false;
        }

        let Some(instance) = self.take_panel(&source_path, id) else {
            return false;
        };

        self.drop_empty_stack(&source_path);
        self.renormalise();

        // Paths computed before the removal are stale now, so the target is
        // looked up again. If it vanished, it was inside the stack we just
        // dropped, and the move is impossible.
        let Some(target_path) = self.root.as_ref().and_then(|r| r.stack_path_of(target)) else {
            return false;
        };

        let moved = match region.placement() {
            None => self.merge_into_stack(&target_path, instance),
            Some((dir, before)) => self.split_around(&target_path, dir, before, instance),
        };
        if !moved {
            return false;
        }

        self.focused = Some(id);
        self.renormalise();
        true
    }

    /// Remove a panel from a stack, returning it, and keep `active` in range.
    fn take_panel(&mut self, stack_path: &[usize], id: PanelId) -> Option<PanelInstance> {
        let Some(Node::Stack { panels, active }) = self.node_at_mut(stack_path) else {
            return None;
        };
        let index = panels.iter().position(|panel| panel.id == id)?;
        let instance = panels.remove(index);

        if !panels.is_empty() {
            if index < *active {
                *active -= 1;
            } else if *active >= panels.len() {
                *active = panels.len() - 1;
            }
        }
        Some(instance)
    }

    fn merge_into_stack(&mut self, stack_path: &[usize], instance: PanelInstance) -> bool {
        let Some(Node::Stack { panels, active }) = self.node_at_mut(stack_path) else {
            return false;
        };
        panels.push(instance);
        *active = panels.len() - 1;
        true
    }

    /// Insert `instance` as a new stack beside the stack at `target_path`.
    ///
    /// When the target's parent already splits in the requested direction the
    /// new stack becomes its neighbour, sharing the target's space. When the
    /// direction differs — including when the target is the whole layout — the
    /// target has to be wrapped in a new split, because a `Row` child cannot
    /// hold a `Column` sibling.
    fn split_around(
        &mut self,
        target_path: &[usize],
        dir: Dir,
        before: bool,
        instance: PanelInstance,
    ) -> bool {
        let new_stack = Node::Stack {
            panels: vec![instance],
            active: 0,
        };

        if target_path.is_empty() {
            let Some(old) = self.root.take() else {
                return false;
            };
            let (first, second) = if before {
                (new_stack, old)
            } else {
                (old, new_stack)
            };
            self.root = Some(Node::Split {
                dir,
                children: vec![
                    Child {
                        size: 0.5,
                        node: first,
                    },
                    Child {
                        size: 0.5,
                        node: second,
                    },
                ],
            });
            return true;
        }

        let parent_path = &target_path[..target_path.len() - 1];
        let index = target_path[target_path.len() - 1];

        let Some(Node::Split {
            dir: parent_dir,
            children,
        }) = self.node_at_mut(parent_path)
        else {
            return false;
        };

        let target_size = children[index].size;

        if *parent_dir == dir {
            children[index].size = target_size / 2.0;
            let insert_at = if before { index } else { index + 1 };
            children.insert(
                insert_at,
                Child {
                    size: target_size / 2.0,
                    node: new_stack,
                },
            );
            return true;
        }

        // The old subtree is cloned rather than moved out with a placeholder,
        // because a `Node` has no cheap empty value to swap in and the trees here
        // are tiny.
        let old = children[index].node.clone();
        let (first, second) = if before {
            (new_stack, old)
        } else {
            (old, new_stack)
        };
        children[index].node = Node::Split {
            dir,
            children: vec![
                Child {
                    size: 0.5,
                    node: first,
                },
                Child {
                    size: 0.5,
                    node: second,
                },
            ],
        };
        true
    }

    /// Make `id` the visible tab of its stack and the focused panel.
    pub fn activate(&mut self, id: PanelId) -> bool {
        let Some(stack_path) = self
            .root
            .as_ref()
            .and_then(|root| root.stack_path_of(id))
        else {
            return false;
        };
        if let Some(Node::Stack { panels, active }) = self.node_at_mut(&stack_path)
            && let Some(index) = panels.iter().position(|p| p.id == id)
        {
            *active = index;
        }
        self.focused = Some(id);
        true
    }

    /// The (before, after) shares either side of `boundary` in the split at
    /// `split_path`.
    ///
    /// Used by the view when a splitter drag starts: the model, not the DOM, is
    /// the authority on how much space each side currently has.
    pub fn boundary_pair(&self, split_path: &[usize], boundary: usize) -> Option<(f32, f32)> {
        match self.node_at(split_path)? {
            Node::Split { children, .. } => {
                let before = children.get(boundary)?.size;
                let after = children.get(boundary + 1)?.size;
                Some((before, after))
            }
            Node::Stack { .. } => None,
        }
    }

    /// Move the boundary between `boundary` and `boundary + 1` by `delta`,
    /// expressed as a share of the split.
    ///
    /// The pair's combined share is preserved exactly, so the rest of the split
    /// is untouched. Both sides are clamped to [`MIN_SIZE`], except that a pair
    /// too small to give both sides `MIN_SIZE` is split evenly instead.
    pub fn resize_split(&mut self, split_path: &[usize], boundary: usize, delta: f32) -> bool {
        let Some(Node::Split { children, .. }) = self.node_at_mut(split_path) else {
            return false;
        };
        if boundary + 1 >= children.len() {
            return false;
        }

        let before = children[boundary].size;
        let after = children[boundary + 1].size;
        let pair = before + after;
        // Rejects zero, negatives and NaN alike: a non-finite or non-positive
        // pair has no meaningful split point, and silently accepting it would
        // put NaN into the layout.
        if !pair.is_finite() || pair <= 0.0 {
            return false;
        }

        let min = MIN_SIZE.min(pair / 2.0);
        let new_before = (before + delta).clamp(min, pair - min);
        children[boundary].size = new_before;
        children[boundary + 1].size = pair - new_before;
        true
    }

    /// Drop panels whose kind is not in `known`.
    ///
    /// This is the guard against a persisted layout outliving a panel: if a
    /// kind is renamed or removed, restoring an old layout must not produce a
    /// tab that cannot render.
    pub fn retain_kinds(&mut self, known: &[&str]) {
        let stale: Vec<PanelId> = self
            .panels()
            .into_iter()
            .filter(|panel| !known.contains(&panel.kind.as_str()))
            .map(|panel| panel.id)
            .collect();
        for id in stale {
            self.close_panel(id);
        }
    }
}

/// Recursively drop empty stacks and collapse single-child splits, returning
/// the surviving subtree with its accumulated share of the original root.
///
/// `share` is the fraction of the *original parent* that this subtree occupies.
/// Carrying it down means a hoisted child keeps exactly the screen space its
/// collapsed ancestor held, which is what stops panes from jumping when a
/// neighbour is closed.
fn normalise(node: Node, share: f32) -> Option<Child> {
    match node {
        Node::Stack { panels, active } => {
            if panels.is_empty() {
                return None;
            }
            let active = active.min(panels.len() - 1);
            Some(Child {
                size: share,
                node: Node::Stack { panels, active },
            })
        }
        Node::Split { dir, children } => {
            // Fractions are taken against the children's own total rather than
            // assuming 1.0, so a hand-edited or partially-normalized tree still
            // redistributes sensibly.
            let total: f32 = children.iter().map(|c| c.size).sum();
            let count = children.len().max(1) as f32;
            let mut kept = Vec::new();
            for child in children {
                let fraction = if total > 0.0 {
                    child.size / total
                } else {
                    1.0 / count
                };
                if let Some(survivor) = normalise(child.node, share * fraction) {
                    kept.push(survivor);
                }
            }

            match kept.len() {
                0 => None,
                // A split with one child is not a split: hoist it, carrying the
                // share we accumulated from this (now removed) level.
                1 => kept.pop(),
                _ => {
                    let total: f32 = kept.iter().map(|c| c.size).sum();
                    let mut kept = kept;
                    for child in &mut kept {
                        child.size /= total;
                    }
                    Some(Child {
                        size: share,
                        node: Node::Split { dir, children: kept },
                    })
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Build a stack of panels with sequential ids.
    fn stack(ids: &[PanelId]) -> Node {
        Node::Stack {
            panels: ids
                .iter()
                .map(|id| PanelInstance {
                    id: *id,
                    kind: "test".to_string(),
                })
                .collect(),
            active: 0,
        }
    }

    fn split(dir: Dir, children: Vec<(f32, Node)>) -> Node {
        Node::Split {
            dir,
            children: children
                .into_iter()
                .map(|(size, node)| Child { size, node })
                .collect(),
        }
    }

    fn sizes(layout: &Layout, path: &[usize]) -> Vec<f32> {
        match layout.node_at(path) {
            Some(Node::Split { children, .. }) => children.iter().map(|c| c.size).collect(),
            _ => panic!("not a split at {path:?}"),
        }
    }

    fn assert_normalized(layout: &Layout) {
        fn walk(node: &Node, is_root: bool) {
            match node {
                Node::Stack { panels, active } => {
                    assert!(!panels.is_empty(), "empty stack survived normalization");
                    assert!(*active < panels.len(), "active index out of range");
                }
                Node::Split { children, .. } => {
                    assert!(
                        children.len() >= 2 || is_root,
                        "single-child split survived at a non-root position"
                    );
                    let total: f32 = children.iter().map(|c| c.size).sum();
                    assert!(
                        (total - 1.0).abs() < 1e-3,
                        "split sizes sum to {total}, expected 1.0"
                    );
                    for child in children {
                        walk(&child.node, false);
                    }
                }
            }
        }
        if let Some(root) = &layout.root {
            walk(root, true);
        }
    }

    #[test]
    fn default_layout_is_normalized_and_places_every_kind() {
        let layout = Layout::default_with(&["journals", "accounts", "balances", "transactions", "console"]);
        assert_normalized(&layout);
        let kinds: Vec<&str> = layout.panels().iter().map(|p| p.kind.as_str()).collect();
        assert_eq!(
            kinds,
            vec!["journals", "accounts", "balances", "transactions", "console"]
        );
        assert_eq!(layout.focused, Some(1));
    }

    #[test]
    fn default_layout_handles_a_single_kind_and_none() {
        let one = Layout::default_with(&["solo"]);
        // One kind must not leave a degenerate split or an empty row behind.
        assert!(matches!(one.root, Some(Node::Stack { .. })));
        assert_normalized(&one);

        let none = Layout::default_with(&[]);
        assert_eq!(none.root, None);
        assert_eq!(none.focused, None);
        assert_normalized(&none);
    }

    #[test]
    fn add_panel_joins_the_focused_stack_as_a_new_tab() {
        // Row[ Stack[1,2], Stack[3] ] — focus the single-panel stack.
        let mut layout = Layout {
            root: Some(split(
                Dir::Row,
                vec![(0.5, stack(&[1, 2])), (0.5, stack(&[3]))],
            )),
            focused: Some(3),
            next_id: 4,
            maximised: None,
        };

        let added = layout.add_panel("accounts", None);

        let path = layout.root.as_ref().unwrap().stack_path_of(3).unwrap();
        match layout.node_at(&path).unwrap() {
            Node::Stack { panels, active } => {
                assert_eq!(panels.len(), 2, "should be a tab, not a new split");
                assert_eq!(panels[*active].id, added, "new tab should be selected");
                assert_eq!(panels[*active].kind, "accounts");
            }
            _ => panic!("expected a stack"),
        }
        // The other stack must be untouched: adding a tab is not a re-split.
        assert_eq!(layout.panels().len(), 4);
        assert_eq!(layout.focused, Some(added));
        assert_normalized(&layout);
    }

    #[test]
    fn add_panel_uses_the_focused_panel_not_the_first_stack() {
        let mut layout = Layout {
            root: Some(split(
                Dir::Row,
                vec![(0.5, stack(&[1])), (0.5, stack(&[2]))],
            )),
            focused: Some(2),
            next_id: 3,
            maximised: None,
        };
        let added = layout.add_panel("new", None);
        let path = layout.root.as_ref().unwrap().stack_path_of(2).unwrap();
        match layout.node_at(&path).unwrap() {
            Node::Stack { panels, .. } => {
                assert!(panels.iter().any(|p| p.id == added), "landed in stack 2");
                assert_eq!(panels.len(), 2);
            }
            _ => panic!("expected a stack"),
        }
        assert_normalized(&layout);
    }

    #[test]
    fn add_panel_into_an_empty_layout_creates_the_root_stack() {
        let mut layout = Layout::empty();
        let id = layout.add_panel("balances", None);
        assert!(matches!(layout.root, Some(Node::Stack { .. })));
        assert_eq!(layout.focused, Some(id));
        assert_normalized(&layout);
    }

    #[test]
    fn add_panel_targets_a_specific_stack_not_the_focused_one() {
        let mut layout = Layout::default_with(&["a", "b", "c", "d", "e"]);
        let ids: Vec<PanelId> = layout.panels().iter().map(|p| p.id).collect();
        // Focus nothing relevant, then explicitly target the last panel's stack.
        let target = *ids.last().unwrap();
        layout.add_panel("extra", Some(target));

        let path = layout.root.as_ref().unwrap().stack_path_of(target).unwrap();
        match layout.node_at(&path) {
            Some(Node::Stack { panels, .. }) => {
                assert!(panels.iter().any(|p| p.kind == "extra"));
            }
            _ => panic!("expected a stack"),
        }
        assert_normalized(&layout);
    }

    #[test]
    fn closing_a_tab_keeps_the_stack_alive_and_picks_a_valid_active_tab() {
        let mut layout = Layout::default_with(&["a", "b"]);
        let ids: Vec<PanelId> = layout.panels().iter().map(|p| p.id).collect();
        layout.add_panel("c", Some(ids[0]));
        let path = layout.root.as_ref().unwrap().stack_path_of(ids[0]).unwrap();

        // Close the active tab (the newly added "c").
        let c = layout.panels().iter().find(|p| p.kind == "c").unwrap().id;
        assert!(layout.close_panel(c));

        match layout.node_at(&path) {
            Some(Node::Stack { panels, active }) => {
                assert_eq!(panels.len(), 2);
                assert!(*active < panels.len(), "active must stay in range");
            }
            _ => panic!("stack should survive"),
        }
        assert_normalized(&layout);
    }

    #[test]
    fn closing_the_last_tab_removes_the_stack_and_redistributes_space() {
        // Row[ A(0.3), B(0.4), C(0.3) ] — close the middle stack entirely.
        let mut layout = Layout {
            root: Some(split(
                Dir::Row,
                vec![(0.3, stack(&[1])), (0.4, stack(&[2])), (0.3, stack(&[3]))],
            )),
            focused: Some(2),
            next_id: 4,
            maximised: None,
        };

        assert!(layout.close_panel(2));

        match layout.node_at(&[]) {
            Some(Node::Split { children, .. }) => {
                assert_eq!(children.len(), 2, "the emptied stack should be gone");
                // The survivors keep their relative proportions: 0.3 and 0.3 of
                // the remaining 0.6, i.e. half each.
                assert!(
                    (children[0].size - 0.5).abs() < 1e-3,
                    "left survivor should take half, got {}",
                    children[0].size
                );
                assert!((children[1].size - 0.5).abs() < 1e-3);
            }
            other => panic!("expected a row split, got {other:?}"),
        }
        assert_normalized(&layout);
    }

    #[test]
    fn collapsing_a_split_hoists_the_survivor_and_preserves_its_screen_share() {
        // root = Row[ A(0.5), Column[ B(0.5), C(0.5) ](0.5) ]
        let mut layout = Layout {
            root: Some(split(
                Dir::Row,
                vec![
                    (0.5, stack(&[1])),
                    (
                        0.5,
                        split(Dir::Column, vec![(0.5, stack(&[2])), (0.5, stack(&[3]))]),
                    ),
                ],
            )),
            focused: Some(2),
            next_id: 4,
            maximised: None,
        };
        assert_normalized(&layout);

        // Closing C must not leave a single-child Column behind; B takes over
        // the whole right half.
        assert!(layout.close_panel(3));

        match layout.root.as_ref().unwrap() {
            Node::Split { children, .. } => {
                assert_eq!(children.len(), 2, "Column should have collapsed away");
                assert!(
                    matches!(children[1].node, Node::Stack { .. }),
                    "B should be hoisted into the row"
                );
                assert!(
                    (children[1].size - 0.5).abs() < 1e-3,
                    "B should keep the whole right half, got {}",
                    children[1].size
                );
            }
            other => panic!("expected a row split, got {other:?}"),
        }
        assert_normalized(&layout);
    }

    #[test]
    fn closing_the_only_panel_empties_the_layout() {
        let mut layout = Layout::default_with(&["only"]);
        let id = layout.panels()[0].id;
        assert!(layout.close_panel(id));
        assert_eq!(layout.root, None);
        assert_eq!(layout.focused, None);
        assert_normalized(&layout);
    }

    #[test]
    fn closing_an_unknown_panel_is_a_no_op() {
        let mut layout = Layout::default_with(&["a"]);
        let before = layout.clone();
        assert!(!layout.close_panel(999));
        assert_eq!(layout, before);
    }

    #[test]
    fn focus_moves_off_a_closed_panel() {
        let mut layout = Layout::default_with(&["a", "b", "c"]);
        let b = layout.panels().iter().find(|p| p.kind == "b").unwrap().id;
        layout.activate(b);
        assert_eq!(layout.focused, Some(b));
        layout.close_panel(b);
        assert_ne!(layout.focused, Some(b));
        assert!(layout.focused.is_some(), "focus should land on a survivor");
    }

    /// Row[ Stack[1](0.3), Stack[2](0.4), Stack[3](0.3) ], ids allocated from 4.
    fn three_across() -> Layout {
        Layout {
            root: Some(split(
                Dir::Row,
                vec![(0.3, stack(&[1])), (0.4, stack(&[2])), (0.3, stack(&[3]))],
            )),
            focused: Some(1),
            next_id: 4,
            maximised: None,
        }
    }

    #[test]
    fn resize_moves_the_boundary_and_preserves_the_total() {
        let mut layout = three_across();
        let before = sizes(&layout, &[]);
        let pair = before[0] + before[1];

        assert!(layout.resize_split(&[], 0, 0.1));

        let after = sizes(&layout, &[]);
        assert!((after[0] - (before[0] + 0.1)).abs() < 1e-4);
        assert!(
            (after[0] + after[1] - pair).abs() < 1e-4,
            "the pair's combined share must be preserved exactly"
        );
        assert!((after[2] - before[2]).abs() < 1e-6, "other children untouched");
        assert_normalized(&layout);
    }

    #[test]
    fn resize_clamps_so_neither_side_can_be_lost() {
        let mut layout = three_across();
        // Try to drag far past the left edge, then far past the right edge.
        assert!(layout.resize_split(&[], 0, -100.0));
        let after = sizes(&layout, &[]);
        assert!(after[0] >= MIN_SIZE - 1e-6, "left side collapsed: {}", after[0]);
        assert!(after[1] >= MIN_SIZE - 1e-6, "right side collapsed: {}", after[1]);

        assert!(layout.resize_split(&[], 0, 100.0));
        let after = sizes(&layout, &[]);
        assert!(after[0] >= MIN_SIZE - 1e-6);
        assert!(after[1] >= MIN_SIZE - 1e-6);
        assert!((after.iter().sum::<f32>() - 1.0).abs() < 1e-3);
    }

    #[test]
    fn resize_handles_a_pair_too_small_to_split_fairly() {
        // A pair sharing 0.02 cannot give both sides MIN_SIZE; it must still not
        // panic or produce NaN, and the totals must hold.
        let mut layout = Layout {
            root: Some(split(
                Dir::Row,
                vec![(0.01, stack(&[1])), (0.01, stack(&[2])), (0.98, stack(&[3]))],
            )),
            focused: Some(1),
            next_id: 4,
            maximised: None,
        };
        assert!(layout.resize_split(&[], 0, 0.5));
        let after = sizes(&layout, &[]);
        assert!(after.iter().all(|s| s.is_finite() && *s >= 0.0));
        assert!((after.iter().sum::<f32>() - 1.0).abs() < 1e-3);
        assert_normalized(&layout);
    }

    #[test]
    fn resize_rejects_a_boundary_that_does_not_exist() {
        let mut layout = three_across();
        let before = layout.clone();
        assert!(
            !layout.resize_split(&[], 2, 0.1),
            "the last child has no right-hand neighbour"
        );
        assert!(!layout.resize_split(&[9], 0, 0.1), "no such split");
        assert_eq!(layout, before);
    }

    #[test]
    fn activate_switches_the_visible_tab() {
        let mut layout = Layout::default_with(&["a", "b", "c"]);
        let a = layout.panels().iter().find(|p| p.kind == "a").unwrap().id;
        let b = layout.panels().iter().find(|p| p.kind == "b").unwrap().id;
        layout.add_panel("twin", Some(a));
        let twin = layout.panels().iter().find(|p| p.kind == "twin").unwrap().id;

        let path = layout.root.as_ref().unwrap().stack_path_of(a).unwrap();
        assert!(layout.activate(a));
        match layout.node_at(&path) {
            Some(Node::Stack { active, panels }) => assert_eq!(panels[*active].id, a),
            _ => panic!("expected a stack"),
        }
        assert!(layout.activate(twin));
        assert!(!layout.activate(4242), "unknown panel");
        let _ = b;
    }

    #[test]
    fn retain_kinds_drops_unknown_panels_and_keeps_the_tree_sane() {
        let mut layout = Layout::default_with(&["journals", "balances", "console"]);
        layout.retain_kinds(&["journalz"]);
        assert_eq!(layout.root, None, "nothing survives an empty known set");
        assert_normalized(&layout);

        let mut layout = Layout::default_with(&["journals", "balances", "console"]);
        layout.retain_kinds(&["journals", "console"]);
        let kinds: Vec<&str> = layout.panels().iter().map(|p| p.kind.as_str()).collect();
        assert_eq!(kinds, vec!["journals", "console"]);
        assert_normalized(&layout);
    }

    #[test]
    fn layout_round_trips_through_json() {
        let mut layout = Layout::default_with(&["a", "b", "c", "d", "e"]);
        let id = layout.panels()[0].id;
        layout.add_panel("extra", Some(id));
        assert!(layout.resize_split(&[0], 0, 0.05));

        let json = serde_json::to_string(&layout).expect("serialize");
        let back: Layout = serde_json::from_str(&json).expect("deserialize");
        assert_eq!(layout, back);

        // The id allocator must survive, or a restored layout would mint ids
        // that collide with restored panels.
        let mut restored = back;
        let new_id = restored.add_panel("fresh", None);
        assert!(
            restored.panels().iter().filter(|p| p.id == new_id).count() == 1
        );
    }

    #[test]
    fn panels_are_listed_in_tree_order() {
        let layout = Layout::default_with(&["a", "b", "c", "d", "e"]);
        let kinds: Vec<&str> = layout.panels().iter().map(|p| p.kind.as_str()).collect();
        assert_eq!(kinds, vec!["a", "b", "c", "d", "e"]);
    }

    // -- docking ------------------------------------------------------------

    /// The first panel id in a subtree, for asserting which pane landed where.
    fn first_panel_of(node: &Node) -> Option<PanelId> {
        match node {
            Node::Stack { panels, .. } => panels.first().map(|panel| panel.id),
            Node::Split { .. } => None,
        }
    }

    #[test]
    fn region_at_maps_the_middle_to_centre_and_the_edges_to_splits() {
        assert_eq!(region_at(0.5, 0.5), DropRegion::Center);
        assert_eq!(region_at(0.3, 0.7), DropRegion::Center, "inside the centre box");
        assert_eq!(region_at(0.05, 0.5), DropRegion::Left);
        assert_eq!(region_at(0.95, 0.5), DropRegion::Right);
        assert_eq!(region_at(0.5, 0.05), DropRegion::Top);
        assert_eq!(region_at(0.5, 0.95), DropRegion::Bottom);
    }

    #[test]
    fn region_at_resolves_corners_by_distance_and_clamps_wild_points() {
        // Corner cases are decided by which edge is nearest, not by case order.
        assert_eq!(region_at(0.1, 0.2), DropRegion::Left);
        assert_eq!(region_at(0.2, 0.1), DropRegion::Top);
        // Points outside the pane (possible while dragging past an edge) must
        // still produce something usable rather than panicking.
        assert_eq!(region_at(-1.0, -1.0), DropRegion::Left);
        assert_eq!(region_at(2.0, 2.0), DropRegion::Right);
    }

    fn pane(panel: PanelId, x: f64, y: f64, width: f64, height: f64) -> PaneRect {
        PaneRect {
            panel,
            rect: Rect { x, y, width, height },
        }
    }

    fn tab(panel: PanelId, x: f64, y: f64, width: f64, height: f64) -> TabRect {
        TabRect {
            panel,
            rect: Rect { x, y, width, height },
        }
    }

    /// Geometry with panes only, which is all most of these tests need.
    fn panes(panes: Vec<PaneRect>) -> DropGeometry {
        DropGeometry {
            panes,
            tabs: Vec::new(),
        }
    }

    /// The pane side of a hit, ignoring tabs.
    fn pane_hit(
        geometry: &DropGeometry,
        x: f64,
        y: f64,
        dragged: PanelId,
    ) -> Option<(PanelId, DropRegion)> {
        match hit_test(geometry, x, y, dragged)? {
            DropTarget::Pane { panel, region, .. } => Some((panel, region)),
            DropTarget::Tab { .. } => None,
        }
    }

    #[test]
    fn hit_test_finds_the_pane_and_region_under_a_point() {
        let geometry = panes(vec![
            pane(1, 0.0, 0.0, 100.0, 100.0),
            pane(2, 100.0, 0.0, 200.0, 100.0),
        ]);
        // The middle of pane 2 is a merge target.
        assert_eq!(
            pane_hit(&geometry, 200.0, 50.0, 1),
            Some((2, DropRegion::Center))
        );
        // The left edge of pane 2 splits against it.
        assert_eq!(pane_hit(&geometry, 105.0, 50.0, 1), Some((2, DropRegion::Left)));
        // A point over no pane is not a target.
        assert_eq!(hit_test(&geometry, 500.0, 50.0, 1), None);
    }

    #[test]
    fn hit_test_ignores_the_middle_of_the_source_pane_but_keeps_its_edges() {
        let geometry = panes(vec![pane(7, 0.0, 0.0, 100.0, 100.0)]);
        // Re-merging a tab into the stack it came from is not something the user
        // can want, so it is not offered.
        assert_eq!(hit_test(&geometry, 50.0, 50.0, 7), None);
        // Splitting that same stack apart is.
        assert_eq!(pane_hit(&geometry, 2.0, 50.0, 7), Some((7, DropRegion::Left)));
    }

    #[test]
    fn hit_test_skips_panes_with_no_extent() {
        // A collapsed or hidden pane must not swallow the hit from a real one.
        let geometry = panes(vec![pane(1, 0.0, 0.0, 0.0, 0.0), pane(2, 0.0, 0.0, 100.0, 100.0)]);
        assert_eq!(pane_hit(&geometry, 50.0, 50.0, 9).map(|(panel, _)| panel), Some(2));
    }

    #[test]
    fn hit_test_returns_the_rect_so_the_indicator_needs_no_measurement() {
        let geometry = panes(vec![pane(3, 10.0, 20.0, 100.0, 80.0)]);
        match hit_test(&geometry, 15.0, 60.0, 9).expect("should hit") {
            DropTarget::Pane { region, rect, .. } => {
                assert_eq!(region, DropRegion::Left);
                assert_eq!(
                    rect,
                    Rect {
                        x: 10.0,
                        y: 20.0,
                        width: 100.0,
                        height: 80.0
                    }
                );
            }
            other => panic!("expected a pane target, got {other:?}"),
        }
    }

    #[test]
    fn aiming_at_a_stacks_tab_bar_means_join_it_not_split_above_it() {
        let geometry = panes(vec![
            pane(1, 0.0, 0.0, 200.0, 300.0),
            pane(2, 200.0, 0.0, 200.0, 300.0),
        ]);

        // Anywhere across the tab bar is a merge, including the far left column
        // that would otherwise resolve to "split left".
        assert_eq!(
            pane_hit(&geometry, 205.0, 10.0, 1),
            Some((2, DropRegion::Center))
        );
        assert_eq!(
            pane_hit(&geometry, 395.0, 25.0, 1).map(|(_, region)| region),
            Some(DropRegion::Center)
        );

        // Immediately below the tab bar the top edge is a real, reachable
        // target — it is not squeezed out by the strip above it.
        assert_eq!(
            pane_hit(&geometry, 300.0, 45.0, 1).map(|(_, region)| region),
            Some(DropRegion::Top)
        );
    }

    #[test]
    fn a_pane_too_short_to_have_a_body_is_still_a_merge_target() {
        // Degenerate, but it must not divide by a negative height.
        let geometry = panes(vec![pane(4, 0.0, 0.0, 200.0, 20.0)]);
        assert_eq!(
            pane_hit(&geometry, 100.0, 10.0, 1).map(|(_, region)| region),
            Some(DropRegion::Center)
        );
    }

    #[test]
    fn a_tab_wins_over_the_pane_behind_it() {
        // The tab sits inside pane 2, whose middle would otherwise be a merge.
        let geometry = DropGeometry {
            panes: vec![
                pane(1, 0.0, 0.0, 200.0, 300.0),
                pane(2, 200.0, 0.0, 200.0, 300.0),
            ],
            tabs: vec![tab(2, 210.0, 0.0, 80.0, 27.0)],
        };

        // The left half of a tab inserts before it, the right half after.
        assert_eq!(
            hit_test(&geometry, 220.0, 12.0, 1),
            Some(DropTarget::Tab {
                panel: 2,
                before: true,
                rect: Rect {
                    x: 210.0,
                    y: 0.0,
                    width: 80.0,
                    height: 27.0
                },
            })
        );
        assert!(matches!(
            hit_test(&geometry, 280.0, 12.0, 1),
            Some(DropTarget::Tab { before: false, .. })
        ));

        // There is nothing to order against when the tab *is* the dragged panel,
        // and the pane behind it is its own stack's middle, which is never a
        // target — so this point resolves to nothing at all.
        assert_eq!(hit_test(&geometry, 220.0, 12.0, 2), None);
    }

    #[test]
    fn maximising_is_a_view_state_that_leaves_the_tree_alone() {
        let mut layout = three_across();
        let original = layout.clone();

        assert_eq!(layout.maximised, None);
        assert!(layout.toggle_maximised(2));
        assert_eq!(layout.maximised, Some(2));
        assert_eq!(layout.root, original.root, "the tree must be untouched");
        assert_eq!(layout.panels(), original.panels());

        // Toggling again restores exactly, with nothing to rebuild.
        assert!(layout.toggle_maximised(2));
        assert_eq!(layout.maximised, None);
        assert_eq!(layout.root, original.root);

        // An unknown panel cannot be maximised.
        assert!(!layout.toggle_maximised(999));
        assert_eq!(layout.maximised, None);
    }

    #[test]
    fn closing_a_maximised_panel_restores_the_tree() {
        let mut layout = three_across();
        assert!(layout.toggle_maximised(1));
        assert!(layout.close_panel(1));
        assert_eq!(
            layout.maximised, None,
            "a maximised panel that no longer exists must not persist"
        );
        assert_normalized(&layout);
    }

    #[test]
    fn the_maximised_stack_can_be_rendered_on_its_own() {
        let mut layout = three_across();
        assert!(layout.toggle_maximised(2));
        match layout.stack_containing(2) {
            Some(Node::Stack { panels, .. }) => assert_eq!(panels[0].id, 2),
            other => panic!("expected the maximised stack, got {other:?}"),
        }
        assert_eq!(layout.stack_containing(999), None);
    }

    #[test]
    fn a_layout_saved_before_maximising_existed_still_loads() {
        // Persisted layouts are user data, so adding a field must not reset them.
        let json = r#"{"root":{"Stack":{"panels":[{"id":1,"kind":"journals"}],"active":0}},
                       "focused":1,"next_id":2}"#;
        let layout: Layout = serde_json::from_str(json).expect("should load");
        assert_eq!(layout.maximised, None);
        assert_eq!(layout.panels().len(), 1);
    }

    #[test]
    fn reordering_moves_a_tab_within_its_stack() {
        // Stack[1,2,3] — drag 3 in front of 1.
        let mut layout = Layout {
            root: Some(stack(&[1, 2, 3])),
            focused: Some(1),
            maximised: None,
            next_id: 4,
        };
        assert!(layout.reorder_panel(3, 1, true));
        match layout.root.as_ref().unwrap() {
            Node::Stack { panels, active } => {
                let ids: Vec<PanelId> = panels.iter().map(|panel| panel.id).collect();
                assert_eq!(ids, vec![3, 1, 2]);
                assert_eq!(panels[*active].id, 3, "the moved tab becomes visible");
            }
            other => panic!("expected a stack, got {other:?}"),
        }
        assert_normalized(&layout);
    }

    #[test]
    fn reordering_onto_its_own_position_is_a_no_op() {
        let mut layout = Layout {
            root: Some(stack(&[1, 2, 3])),
            focused: Some(1),
            maximised: None,
            next_id: 4,
        };
        let before = layout.clone();
        // 2 is already immediately before 3.
        assert!(!layout.reorder_panel(2, 3, true));
        assert_eq!(layout, before);
        // And a tab cannot be reordered against itself.
        assert!(!layout.reorder_panel(2, 2, true));
        assert_eq!(layout, before);
    }

    #[test]
    fn reordering_can_move_a_tab_into_another_stack() {
        // Row[ Stack[1,2], Stack[3] ] — drag 1 in front of 3.
        let mut layout = Layout {
            root: Some(split(Dir::Row, vec![(0.5, stack(&[1, 2])), (0.5, stack(&[3]))])),
            focused: Some(1),
            maximised: None,
            next_id: 4,
        };
        assert!(layout.reorder_panel(1, 3, true));
        let order: Vec<PanelId> = layout.panels().iter().map(|panel| panel.id).collect();
        assert_eq!(order, vec![2, 1, 3]);
        assert_normalized(&layout);
    }

    #[test]
    fn a_centre_drop_merges_the_panel_into_the_target_stack() {
        // Row[ Stack[1], Stack[2] ]
        let mut layout = Layout {
            root: Some(split(Dir::Row, vec![(0.5, stack(&[1])), (0.5, stack(&[2]))])),
            focused: Some(1),
            next_id: 3,
            maximised: None,
        };

        assert!(layout.move_panel(1, 2, DropRegion::Center));

        // Emptying the source stack must collapse the row entirely.
        match layout.root.as_ref().unwrap() {
            Node::Stack { panels, active } => {
                assert_eq!(panels.len(), 2);
                assert_eq!(panels[*active].id, 1, "the moved panel becomes the visible tab");
            }
            other => panic!("expected a single stack, got {other:?}"),
        }
        assert_eq!(layout.focused, Some(1));
        assert_normalized(&layout);
    }

    #[test]
    fn an_edge_drop_splits_against_the_target() {
        // Row[ Stack[1](0.6), Stack[2](0.4) ]
        let mut layout = Layout {
            root: Some(split(Dir::Row, vec![(0.6, stack(&[1])), (0.4, stack(&[2]))])),
            focused: Some(1),
            next_id: 3,
            maximised: None,
        };

        assert!(layout.move_panel(1, 2, DropRegion::Left));

        match layout.root.as_ref().unwrap() {
            Node::Split { dir, children } => {
                assert_eq!(*dir, Dir::Row);
                assert_eq!(children.len(), 2);
                // The target had the whole layout to itself after the move, so
                // the two panes share it evenly.
                assert!((children[0].size - 0.5).abs() < 1e-3);
                assert!((children[1].size - 0.5).abs() < 1e-3);
                match &children[0].node {
                    Node::Stack { panels, .. } => assert_eq!(panels[0].id, 1, "dropped on the left"),
                    other => panic!("expected the dragged stack, got {other:?}"),
                }
            }
            other => panic!("expected a row split, got {other:?}"),
        }
        assert_normalized(&layout);
    }

    #[test]
    fn a_horizontal_drop_onto_a_vertical_target_wraps_it_rather_than_nesting_wrong() {
        // Column[ Stack[1], Stack[2], Stack[3] ] — a left drop needs a Row, and a
        // Row cannot be a sibling inside a Column without changing the layout.
        let mut layout = Layout {
            root: Some(split(
                Dir::Column,
                vec![(0.3, stack(&[1])), (0.4, stack(&[2])), (0.3, stack(&[3]))],
            )),
            focused: Some(1),
            next_id: 4,
            maximised: None,
        };

        assert!(layout.move_panel(1, 2, DropRegion::Left));

        match layout.root.as_ref().unwrap() {
            Node::Split { dir, children } => {
                assert_eq!(*dir, Dir::Column, "the outer column must survive");
                assert_eq!(children.len(), 2, "the emptied stack was removed");
                match &children[0].node {
                    Node::Split { dir, children } => {
                        assert_eq!(*dir, Dir::Row, "the target was wrapped in a row");
                        assert_eq!(children.len(), 2);
                        match (&children[0].node, &children[1].node) {
                            (Node::Stack { panels: left, .. }, Node::Stack { panels: right, .. }) => {
                                assert_eq!(left[0].id, 1, "dragged panel on the left");
                                assert_eq!(right[0].id, 2, "target on the right");
                            }
                            other => panic!("expected two stacks, got {other:?}"),
                        }
                    }
                    other => panic!("expected a row wrapper, got {other:?}"),
                }
            }
            other => panic!("expected a column, got {other:?}"),
        }
        assert_normalized(&layout);
    }

    #[test]
    fn an_edge_drop_beside_a_same_direction_sibling_shares_its_space() {
        // Row[ Stack[1](0.3), Stack[2](0.4), Stack[3](0.3) ] — drop 1 to the
        // right of 3, which is already in a row, so no wrapper is needed.
        let mut layout = three_across();

        assert!(layout.move_panel(1, 3, DropRegion::Right));

        match layout.root.as_ref().unwrap() {
            Node::Split { dir, children } => {
                assert_eq!(*dir, Dir::Row);
                assert_eq!(children.len(), 3);
                assert_eq!(first_panel_of(&children[2].node), Some(1), "new stack goes last");
                let total: f32 = children.iter().map(|c| c.size).sum();
                assert!((total - 1.0).abs() < 1e-3, "shares still sum to 1, got {total}");
            }
            other => panic!("expected a row, got {other:?}"),
        }
        assert_normalized(&layout);
    }

    #[test]
    fn moving_one_tab_out_of_a_shared_stack_leaves_the_stack_alive() {
        // Row[ Stack[1,2], Stack[3] ] — moving 1 out must leave Stack[2] behind.
        let mut layout = Layout {
            root: Some(split(Dir::Row, vec![(0.5, stack(&[1, 2])), (0.5, stack(&[3]))])),
            focused: Some(1),
            next_id: 4,
            maximised: None,
        };

        assert!(layout.move_panel(1, 3, DropRegion::Center));

        let ids: Vec<PanelId> = layout.panels().iter().map(|p| p.id).collect();
        assert!(ids.contains(&2), "the sibling tab must survive");
        assert!(ids.contains(&1) && ids.contains(&3));
        assert_eq!(layout.panels().len(), 3, "no panel was lost or duplicated");
        assert_normalized(&layout);
    }

    #[test]
    fn moving_a_panel_onto_itself_changes_nothing() {
        let mut layout = three_across();
        let before = layout.clone();
        assert!(!layout.move_panel(1, 1, DropRegion::Center));
        assert!(!layout.move_panel(1, 1, DropRegion::Left));
        assert_eq!(layout, before);
    }

    #[test]
    fn re_merging_a_panel_into_its_own_stack_is_a_no_op() {
        // A centre drop onto a sibling tab is already the case, so nothing should
        // be reordered or rebuilt.
        let mut layout = Layout {
            root: Some(stack(&[1, 2])),
            focused: Some(1),
            next_id: 3,
            maximised: None,
        };
        let before = layout.clone();
        assert!(!layout.move_panel(1, 2, DropRegion::Center));
        assert_eq!(layout, before);
    }

    #[test]
    fn an_edge_drop_within_one_stack_splits_it() {
        // Dragging a tab to the edge of its own stack should pull it out into a
        // sibling pane, which is how a single-pane layout gets divided.
        let mut layout = Layout {
            root: Some(stack(&[1, 2])),
            focused: Some(1),
            next_id: 3,
            maximised: None,
        };

        assert!(layout.move_panel(1, 2, DropRegion::Right));

        match layout.root.as_ref().unwrap() {
            Node::Split { dir, children } => {
                assert_eq!(*dir, Dir::Row);
                assert_eq!(children.len(), 2);
                assert_eq!(first_panel_of(&children[1].node), Some(1));
            }
            other => panic!("expected a row, got {other:?}"),
        }
        assert_normalized(&layout);
    }

    #[test]
    fn a_move_that_cannot_apply_leaves_the_layout_untouched() {
        // The target no longer exists, so nothing may be half-applied.
        let mut layout = three_across();
        let before = layout.clone();
        assert!(!layout.move_panel(1, 999, DropRegion::Center));
        assert!(!layout.move_panel(999, 1, DropRegion::Center));
        assert_eq!(layout, before);
    }
}
