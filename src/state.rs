//! Shared application state (wasm-only: signal-based).
//!
//! Rather than a context object per feature, the app has one `Copy` state value
//! provided at the root. Because it is `Copy`, panels capture it by value in
//! their closures without cloning or lifetime juggling.
//!
//! Three kinds of state live here and they behave differently on purpose:
//!
//! * **`layout`** is the model and the source of truth for the screen. It is
//!   persisted to `localStorage` on every change.
//! * **`drag`** is transient splitter-drag state. It is a signal so the pointer
//!   handlers can share it, but nothing may *read* it reactively: a drag updates
//!   it on every pointermove, and re-rendering mid-drag would replace the element
//!   holding the pointer capture and break the gesture.
//! * **`reports`** is keyed by panel *instance*, so two Balances panels can show
//!   different reports without either needing to know about the other.

use std::collections::HashMap;

use leptos::prelude::*;
use wasm_bindgen::JsCast;
use wasm_bindgen_futures::spawn_local;
use web_sys::HtmlElement;

use crate::fsx;
use crate::hledger::report::{Flavor, ReportSpec};
use crate::hledger::{Engine, EngineError, HledgerOutput, HledgerRequest, JournalFile};
use crate::journal::{self, MainJournal};
use crate::layout::model::{DropGeometry, Layout, PanelId};
use crate::panels;

/// `localStorage` key for the persisted layout. Versioned so a future change to
/// the layout schema cannot be silently misread as the current one.
const STORAGE_KEY: &str = "hledger-anywhere.layout.v1";

/// Id of the drop indicator element, which the drag positions directly.
///
/// Defined here rather than in the view because both the view (which renders it)
/// and `end_tab_drag` (which must be able to find it to hide it, even if the
/// cached handle was never populated) need the same name.
pub const DROP_INDICATOR_ID: &str = "hledger-anywhere-drop-indicator";

/// Id of the element that follows the cursor while a tab is dragged.
pub const DRAG_PROXY_ID: &str = "hledger-anywhere-drag-proxy";

/// The demo journal, reused straight from the test fixtures so the two cannot
/// drift apart.
const DEMO_MAIN: &str = include_str!("../fixtures/demo/hledger.journal");
const DEMO_EXTRA: &str = include_str!("../fixtures/demo/extra.journal");
const DEMO_MAIN_PATH: &str = "hledger.journal";
const DEMO_EXTRA_PATH: &str = "extra.journal";

/// How many engine invocations the Console panel keeps.
const MAX_LOG_ENTRIES: usize = 200;

/// A splitter drag in progress.
#[derive(Clone, Copy, Debug)]
pub struct DragState {
    /// The pointer that started the drag; other pointers are ignored.
    pub pointer_id: i32,
    /// True when the drag runs along the y axis (a column split).
    pub vertical: bool,
    /// Pointer position along the drag axis when the drag began.
    pub origin: f64,
    /// Combined pixel extent of the two panes being resized.
    pub pair_px: f64,
    /// Combined share of the layout those two panes hold.
    pub pair_share: f32,
    /// The leading pane's share when the drag began.
    pub start_before: f32,
}

/// Where the journal files came from.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum SourceStatus {
    /// No directory loaded yet.
    Idle,
    Loading,
    Ready {
        files: usize,
        skipped: usize,
        main: String,
    },
    Error(String),
}

/// Whether the engine can be used, and what it is.
#[derive(Clone, Debug, PartialEq, Eq, Default)]
pub enum EngineStatus {
    #[default]
    Unknown,
    Checking,
    Ready {
        version: Option<String>,
    },
    /// The engine is not usable, with an explanation and a remedy.
    Unavailable(String),
    Error(String),
}

/// The most recent report for one panel.
#[derive(Clone, Debug, Default)]
pub enum ReportState {
    #[default]
    Idle,
    Loading,
    Ready(HledgerOutput),
    /// A report that ran but failed, kept with its output so the Console can
    /// show exactly what the engine said.
    Failed {
        message: String,
        output: HledgerOutput,
    },
}

/// One engine invocation, as shown in the Console.
#[derive(Clone, Debug)]
pub struct LogEntry {
    pub argv: Vec<String>,
    pub exit_code: i32,
    pub ms: f64,
    pub stdout_bytes: usize,
    pub stderr_bytes: usize,
    /// Leading part of stdout, for the Console's raw viewer. Truncated because a
    /// transaction list runs to megabytes and the log would then be the biggest
    /// thing in memory.
    pub stdout_preview: String,
    /// stderr in full: it is short, and it is where a failure explains itself.
    pub stderr: String,
    /// Transport-level failure, if the bridge itself failed.
    pub error: Option<String>,
    /// Whether the run returned a failing exit code or the bridge's
    /// exit-0-with-stderr failure mode.
    pub failure: bool,
}

/// How much of stdout the Console keeps per invocation.
const STDOUT_PREVIEW_BYTES: usize = 2000;

fn preview(text: &str) -> String {
    if text.len() <= STDOUT_PREVIEW_BYTES {
        return text.to_string();
    }
    let mut end = STDOUT_PREVIEW_BYTES;
    while end > 0 && !text.is_char_boundary(end) {
        end -= 1;
    }
    format!("{}\n… ({} more bytes)", &text[..end], text.len() - end)
}

#[derive(Clone, Copy)]
pub struct AppState {
    /// The layout tree, persisted on change.
    pub layout: RwSignal<Layout>,
    /// In-progress splitter drag, if any. See the note on this module.
    pub drag: RwSignal<Option<DragState>>,
    /// Whether the header's add-panel menu is open.
    pub add_menu_open: RwSignal<bool>,

    /// The engine, and the argv dialect it speaks.
    pub engine: Engine,
    pub flavor: RwSignal<Flavor>,
    pub engine_status: RwSignal<EngineStatus>,

    /// The loaded files, and which of them reports should use.
    pub files: RwSignal<Vec<JournalFile>>,
    pub main_journal: RwSignal<Option<MainJournal>>,
    pub source: RwSignal<SourceStatus>,

    /// Report results, keyed by panel instance.
    pub reports: RwSignal<HashMap<PanelId, ReportState>>,
    /// What each panel's report was last computed for.
    ///
    /// Panels are re-rendered whenever the layout changes, and re-rendering a
    /// panel re-runs the effect that asks for its report. Without this record,
    /// resizing a splitter or adding a panel would silently re-run every report
    /// in the app — visible as panes "refreshing" on every resize.
    pub report_keys: RwSignal<HashMap<PanelId, ReportKey>>,
    pub log: RwSignal<Vec<LogEntry>>,

    /// A tab being dragged, if any.
    pub tab_drag: RwSignal<Option<TabDrag>>,
    /// Every pane's and tab's rectangle, measured once when a drag starts.
    ///
    /// Measuring per pointermove would call `getBoundingClientRect` after the
    /// DOM had just been written to move the indicator, forcing a synchronous
    /// reflow on every frame. The layout cannot change during a drag, so one
    /// snapshot is both correct and much faster. Nothing reads this reactively.
    pub geometry: RwSignal<DropGeometry>,
    /// The drop indicator element, looked up once per drag and then positioned
    /// directly.
    ///
    /// Held rather than re-rendered on purpose. Driving the indicator through a
    /// signal means the update lands in a later task, so it trails the pointer by
    /// a frame; the drag then feels soft even when it is running at a solid
    /// 60 fps, because the thing the user is watching is always slightly behind
    /// the thing they are moving. Writing to it synchronously is what makes it
    /// feel attached to the pointer. Only ever read untracked.
    pub indicator: RwSignal<Option<HtmlElement>>,
    /// The element that follows the pointer while a tab is dragged.
    ///
    /// Golden Layout shows a proxy rather than only dimming the source tab: it
    /// makes the thing being moved feel picked up, and it is the only feedback
    /// that says "this is the panel you are carrying" once the cursor has left
    /// the tab bar.
    pub proxy: RwSignal<Option<HtmlElement>>,
    /// The two panes either side of the gutter being dragged, resolved once.
    ///
    /// Looking the siblings up at pointer-down means the move handler does no
    /// DOM reading at all — only the `flex-grow` writes that actually move the
    /// panes — and, because the share delta is recomputed from the release
    /// position instead of being accumulated, it performs no reactive writes
    /// either. Nothing can re-render during the gesture.
    pub splitter_panes: RwSignal<Option<(HtmlElement, HtmlElement)>>,

    /// Bumped whenever the journal changes, so every panel knows to re-run.
    pub generation: RwSignal<u64>,
    /// Bumped by the header's Refresh, to re-run reports without reloading.
    pub refresh: RwSignal<u64>,
}

/// Identifies one report request, so an identical one can be skipped.
#[derive(Clone, Debug, PartialEq)]
pub struct ReportKey {
    pub generation: u64,
    pub refresh: u64,
    pub spec: ReportSpec,
}

/// A tab drag in progress.
#[derive(Clone, Copy, Debug)]
pub struct TabDrag {
    pub pointer_id: i32,
    pub panel: PanelId,
    pub origin_x: f64,
    pub origin_y: f64,
    /// Set once the pointer has moved far enough to mean a drag rather than a
    /// click. Until then the gesture is still a candidate tab click.
    pub active: bool,
}

impl AppState {
    /// Build the state, restoring a persisted layout when there is a usable one.
    pub fn new() -> Self {
        // Never trust the stored layout blindly: it can outlive a panel kind, so
        // unknown panels are dropped before anything renders them.
        let mut layout =
            load_persisted().unwrap_or_else(|| Layout::default_with(&panels::default_kinds()));
        layout.retain_kinds(&panels::kinds());

        let layout_signal = RwSignal::new(layout);
        let engine = Engine::configured();

        let state = AppState {
            layout: layout_signal,
            drag: RwSignal::new(None),
            add_menu_open: RwSignal::new(false),
            engine,
            flavor: RwSignal::new(engine.flavor()),
            engine_status: RwSignal::new(EngineStatus::Unknown),
            files: RwSignal::new(Vec::new()),
            main_journal: RwSignal::new(None),
            source: RwSignal::new(SourceStatus::Idle),
            reports: RwSignal::new(HashMap::new()),
            report_keys: RwSignal::new(HashMap::new()),
            log: RwSignal::new(Vec::new()),
            tab_drag: RwSignal::new(None),
            indicator: RwSignal::new(None),
            proxy: RwSignal::new(None),
            splitter_panes: RwSignal::new(None),
            geometry: RwSignal::new(DropGeometry::default()),
            generation: RwSignal::new(0),
            refresh: RwSignal::new(0),
        };

        // One place persists, so every mutation is covered no matter what caused
        // it: adding, closing, tab switching, a reset — and the splitter commit,
        // which writes without notifying and therefore persists explicitly.
        Effect::new(move |_| {
            save_persisted(&layout_signal.get());
        });

        state
    }

    /// Write the current layout to storage without triggering a re-render.
    ///
    /// Used by the splitter commit, which updates the model untracked so the
    /// tree is not rebuilt just to change two numbers.
    pub fn persist_layout(&self) {
        save_persisted(&self.layout.get_untracked());
    }

    /// End a tab drag, whatever ended it.
    ///
    /// Every path that can finish a gesture funnels through here — a normal
    /// drop, a cancelled pointer, the window losing focus, or the document-level
    /// fallback catching a release that pointer capture never delivered. Doing
    /// the cleanup in one place is what stops the drop indicator being left on
    /// screen after the pointer is gone.
    pub fn end_tab_drag(&self) {
        self.tab_drag.set(None);
        self.geometry.set(DropGeometry::default());

        let Some(document) = web_sys::window().and_then(|window| window.document()) else {
            return;
        };

        // Hide both follow-the-pointer elements, querying if the cached handle is
        // missing: these are the two things that must never be left on screen, so
        // they do not rely on the drag having got as far as caching them.
        for (cached, id) in [
            (self.indicator.get_untracked(), DROP_INDICATOR_ID),
            (self.proxy.get_untracked(), DRAG_PROXY_ID),
        ] {
            let element = cached.or_else(|| {
                document
                    .get_element_by_id(id)
                    .and_then(|element| element.dyn_into::<HtmlElement>().ok())
            });
            if let Some(element) = element {
                let _ = element.style().set_property("display", "none");
            }
        }
        self.indicator.set(None);
        self.proxy.set(None);

        // The drag affordances are applied by class rather than by a reactive
        // flag, because re-rendering the tab mid-drag would replace the element
        // holding the pointer capture and lose the rest of the gesture.
        if let Ok(Some(tab)) = document.query_selector(".gl-tab-dragging") {
            let _ = tab.class_list().remove_1("gl-tab-dragging");
        }
        if let Some(root) = document.document_element() {
            let _ = root.class_list().remove_1("gl-dragging");
        }
    }

    /// Cache the two follow-the-pointer elements for the duration of a drag.
    pub fn cache_drag_elements(&self) {
        if self.indicator.get_untracked().is_some() {
            return;
        }
        let document = web_sys::window().and_then(|window| window.document());
        let find = |id: &str| {
            document
                .clone()?
                .get_element_by_id(id)
                .and_then(|element| element.dyn_into::<HtmlElement>().ok())
        };
        self.indicator.set(find(DROP_INDICATOR_ID));
        self.proxy.set(find(DRAG_PROXY_ID));
    }

    /// Discard the current layout and rebuild the default one.
    pub fn reset_layout(&self) {
        self.layout
            .set(Layout::default_with(&panels::default_kinds()));
    }

    /// Add a panel as a tab in the focused stack, then close the menu.
    pub fn add_panel(&self, kind: &'static str) {
        self.layout.update(|layout| {
            // Read the target before the mutable borrow of `layout`.
            let target = layout.focused;
            layout.add_panel(kind, target);
        });
        self.add_menu_open.set(false);
    }

    /// Re-run every panel's report without reloading the journal.
    pub fn refresh_all(&self) {
        self.refresh.update(|count| *count += 1);
    }

    // -- journal sources ----------------------------------------------------

    /// Install a set of journal files and choose which one to analyse.
    pub fn publish_files(&self, files: Vec<JournalFile>, skipped: usize) {
        let main = journal::resolve_main_journal(
            &files
                .iter()
                .map(|file| journal::Candidate {
                    path: &file.path,
                    contents: &file.contents,
                })
                .collect::<Vec<_>>(),
        );

        self.files.set(files.clone());
        self.main_journal.set(main.clone());
        self.source.set(match &main {
            Some(main) => SourceStatus::Ready {
                files: files.len(),
                skipped,
                main: main.path().to_string(),
            },
            None => SourceStatus::Error(
                "No file in that directory looks like an hledger journal \
                 (.journal, .hledger or .j)."
                    .to_string(),
            ),
        });

        // Any report still in flight belongs to the previous journal.
        self.reports.update(|reports| reports.clear());
        // Keys must be dropped with the results, or a panel would be told its
        // stale report is still current for the new journal.
        self.report_keys.update(|keys| keys.clear());
        self.generation.update(|generation| *generation += 1);
    }

    /// Point reports at a different file from the loaded set.
    ///
    /// Any picked path can be analysed, including ones the heuristics did not
    /// choose, which is the escape hatch when the guess is wrong.
    pub fn set_main_journal(&self, path: String) {
        if !self.files.get_untracked().iter().any(|file| file.path == path) {
            return;
        }
        self.main_journal.set(Some(MainJournal::File(path.clone())));
        self.source.update(|status| {
            if let SourceStatus::Ready { main, .. } = status {
                *main = path.clone();
            }
        });
        self.reports.update(|reports| reports.clear());
        // Keys must be dropped with the results, or a panel would be told its
        // stale report is still current for the new journal.
        self.report_keys.update(|keys| keys.clear());
        self.generation.update(|generation| *generation += 1);
    }

    /// Load the built-in demo journal, so the app is usable with one click.
    pub fn load_demo(&self) {
        // hledger.journal includes extra.journal, so mounting both also proves
        // that `include` resolves inside the engine's filesystem.
        self.publish_files(
            vec![
                JournalFile::new(DEMO_MAIN_PATH, DEMO_MAIN),
                JournalFile::new(DEMO_EXTRA_PATH, DEMO_EXTRA),
            ],
            0,
        );
    }

    /// Open a directory picker and load what the user chooses.
    ///
    /// The dialog is opened *synchronously*, before anything is spawned — see
    /// `fsx::open_directory_picker`. A picker opened from a deferred task is
    /// silently refused by browsers that enforce transient activation, which
    /// presents as a button that does nothing at all.
    pub fn pick_directory(&self) {
        let pending = match fsx::open_directory_picker() {
            Ok(pending) => pending,
            Err(error) => {
                self.source.set(SourceStatus::Error(error.message()));
                return;
            }
        };

        // Remember what we had, so dismissing the dialog does not erase the
        // status of a journal that is still loaded.
        let previous = self.source.get_untracked();
        self.source.set(SourceStatus::Loading);

        let state = *self;
        spawn_local(async move {
            match pending.await_selection().await {
                Ok(picked) => state.publish_files(picked.files, picked.skipped.len()),
                Err(fsx::PickError::Cancelled) => state.source.set(previous),
                Err(error) => state.source.set(SourceStatus::Error(error.message())),
            }
        });
    }

    // -- engine -------------------------------------------------------------

    /// Run one invocation against the current journal.
    pub async fn run(&self, spec: ReportSpec) -> Result<HledgerOutput, EngineError> {
        let journal = self
            .main_journal
            .get_untracked()
            .ok_or_else(|| EngineError::Missing("no journal is loaded".to_string()))?;

        let files = self.files.get_untracked().clone();
        let mut request = HledgerRequest::report(&spec, self.engine.flavor(), journal.path(), files);

        // When the main journal is a generated include-root, it is not one of
        // the picked files, so it has to be mounted alongside them — otherwise
        // hledger is asked to read a path that does not exist.
        if let Some((path, contents)) = journal.extra_file() {
            request.files.push(JournalFile::new(path, contents));
        }

        let result = self.engine.run(request).await;

        match &result {
            Ok(output) => self.push_log(LogEntry {
                argv: output.argv.clone(),
                exit_code: output.exit_code,
                ms: output.ms,
                stdout_bytes: output.stdout.len(),
                stderr_bytes: output.stderr.len(),
                stdout_preview: preview(&output.stdout),
                stderr: output.stderr.clone(),
                error: None,
                failure: output.is_failure(),
            }),
            Err(error) => self.push_log(LogEntry {
                argv: spec.argv(self.engine.flavor(), journal.path()),
                exit_code: -1,
                ms: 0.0,
                stdout_bytes: 0,
                stderr_bytes: 0,
                stdout_preview: String::new(),
                stderr: String::new(),
                error: Some(error.to_string()),
                failure: true,
            }),
        }

        result
    }

    /// Check that the engine is present, recording the outcome for the UI.
    pub fn check_engine(&self) {
        self.engine_status.set(EngineStatus::Checking);
        let state = *self;
        spawn_local(async move {
            let status = match state.engine.probe().await {
                Ok(output) if output.is_failure() => {
                    EngineStatus::Error(output.failure_message())
                }
                Ok(output) => EngineStatus::Ready {
                    // Only the full CLI has a `--version` command. The bridge's
                    // probe runs a real report, so its stdout is account data —
                    // reporting that as a version would be nonsense.
                    version: match state.engine.flavor() {
                        Flavor::HledgerCli => parse_version(&output.stdout),
                        Flavor::WasmBridge => None,
                    },
                },
                Err(EngineError::Missing(message)) => EngineStatus::Unavailable(message),
                Err(error) => EngineStatus::Error(error.to_string()),
            };
            state.engine_status.set(status.clone());
            state.push_log(LogEntry {
                argv: HledgerRequest::probe(state.engine.flavor()).argv,
                exit_code: -1,
                ms: 0.0,
                stdout_bytes: 0,
                stderr_bytes: 0,
                stdout_preview: String::new(),
                stderr: String::new(),
                error: Some(match &status {
                    EngineStatus::Ready { version } => format!(
                        "engine ready{}",
                        version
                            .as_deref()
                            .map(|v| format!(": {v}"))
                            .unwrap_or_default()
                    ),
                    EngineStatus::Unavailable(message) | EngineStatus::Error(message) => {
                        message.clone()
                    }
                    EngineStatus::Checking | EngineStatus::Unknown => "checking".to_string(),
                }),
                failure: !matches!(status, EngineStatus::Ready { .. }),
            });
        });
    }

    /// Run `spec` for one panel, recording the result against that instance.
    ///
    /// Panels call this from an effect that tracks `generation` and `refresh`,
    /// so a panel re-runs when the journal changes, when the user asks for a
    /// refresh, and never at any other time. The report map is deliberately not
    /// read by that effect, or writing a result would re-trigger the run.
    pub fn report_for(&self, id: PanelId, spec: ReportSpec) {
        let key = ReportKey {
            generation: self.generation.get_untracked(),
            refresh: self.refresh.get_untracked(),
            spec: spec.clone(),
        };

        // Idempotent by design. A panel's effect re-runs whenever the panel is
        // re-rendered, and panels are re-rendered by any layout change — so
        // dragging a splitter or adding a tab would otherwise re-run every report
        // in the app. Re-requesting the same report for the same journal, the
        // same refresh generation and the same options is a no-op.
        if self.report_keys.get_untracked().get(&id) == Some(&key) {
            return;
        }
        self.report_keys.update(|keys| {
            keys.insert(id, key);
        });

        if self.main_journal.get_untracked().is_none() {
            self.reports.update(|reports| {
                reports.insert(id, ReportState::Idle);
            });
            return;
        }

        self.reports.update(|reports| {
            reports.insert(id, ReportState::Loading);
        });

        let state = *self;
        spawn_local(async move {
            let next = match state.run(spec).await {
                Ok(output) if output.is_failure() => ReportState::Failed {
                    message: output.failure_message(),
                    output,
                },
                Ok(output) => ReportState::Ready(output),
                Err(error) => ReportState::Failed {
                    message: error.to_string(),
                    output: HledgerOutput::default(),
                },
            };
            state.reports.update(|reports| {
                reports.insert(id, next);
            });
        });
    }

    /// The current report state for one panel.
    pub fn report(&self, id: PanelId) -> ReportState {
        self.reports
            .get()
            .get(&id)
            .cloned()
            .unwrap_or_default()
    }

    fn push_log(&self, entry: LogEntry) {
        self.log.update(|entries| {
            entries.push(entry);
            let excess = entries.len().saturating_sub(MAX_LOG_ENTRIES);
            if excess > 0 {
                entries.drain(0..excess);
            }
        });
    }
}

/// Pull a version line out of `hledger --version` output.
fn parse_version(stdout: &str) -> Option<String> {
    stdout
        .lines()
        .map(str::trim)
        .find(|line| !line.is_empty())
        .map(str::to_string)
}

// -- layout persistence -----------------------------------------------------

fn load_persisted() -> Option<Layout> {
    let storage = web_sys::window()?.local_storage().ok()??;
    let raw = storage.get_item(STORAGE_KEY).ok()??;
    serde_json::from_str(&raw).ok()
}

fn save_persisted(layout: &Layout) {
    // Storage can be unavailable (private browsing, disabled, quota). A layout
    // that cannot be saved is a lost convenience, never a broken app, so every
    // failure here is intentionally ignored.
    let Some(storage) = web_sys::window()
        .and_then(|window| window.local_storage().ok())
        .flatten()
    else {
        return;
    };
    if let Ok(json) = serde_json::to_string(layout) {
        let _ = storage.set_item(STORAGE_KEY, &json);
    }
}
