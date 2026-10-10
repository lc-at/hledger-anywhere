//! Choosing what to upload (wasm-only).
//!
//! Two shapes, because journals come in two shapes. `<input type="file" multiple>`
//! takes individual files, which all land at the root of the mount; adding
//! `webkitdirectory` takes a whole directory and keeps the paths inside it, which
//! is what a journal split into `2024.journal`, `2025.journal` and a `prices/`
//! directory needs — an `include` graph is only a graph if the paths survive.
//!
//! The picker is driven imperatively rather than through the rendered tree
//! because it is a modal browser dialog whose result is a one-shot event.

use js_sys::Promise;
use wasm_bindgen::closure::Closure;
use wasm_bindgen::{JsCast, JsValue};
use wasm_bindgen_futures::JsFuture;
use web_sys::{File, HtmlInputElement};

use crate::hledger::JournalFile;

/// Refuse to read any single file larger than this. hledger journals are text; a
/// file this big is either not a journal or not something to hand to an
/// in-browser engine.
const MAX_FILE_BYTES: f64 = 5.0 * 1024.0 * 1024.0;

/// Refuse to mount more than this in total, so a mis-click on a huge file fails
/// with a message instead of wedging the tab.
const MAX_TOTAL_BYTES: f64 = 50.0 * 1024.0 * 1024.0;

/// Keeps the picker input in the layout but off-screen.
///
/// See [`open_picker`] for why this is used instead of the `hidden` attribute.
const OFFSCREEN_INPUT_STYLE: &str =
    "position:fixed;left:-10000px;top:0;width:1px;height:1px;opacity:0;pointer-events:none;";

/// Id of the transient upload input, while it exists. Stable so the element can
/// be found in devtools, and driven by tests.
pub const UPLOAD_INPUT_ID: &str = "hledger-anywhere-upload-input";

/// Which picker to open.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Mode {
    /// Individual files, all mounted at the root.
    Files,
    /// A directory, with the paths inside it preserved.
    Directory,
}

impl Mode {
    /// The command word that opens this picker, for messages.
    pub fn name(self) -> &'static str {
        match self {
            Mode::Files => "upload",
            Mode::Directory => "upload_dir",
        }
    }
}

/// What went wrong, in terms the terminal can print.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PickError {
    /// The browser refused to open a picker.
    Unavailable(String),
    /// The user dismissed the dialog.
    Cancelled,
    /// Nothing usable was chosen.
    Empty,
    /// Too much data to mount.
    TooLarge { bytes: u64 },
}

impl PickError {
    pub fn message(&self) -> String {
        match self {
            PickError::Unavailable(reason) => {
                format!("this browser cannot open a file picker: {reason}")
            }
            PickError::Cancelled => "upload cancelled".to_string(),
            PickError::Empty => "nothing usable was uploaded".to_string(),
            PickError::TooLarge { bytes } => format!(
                "too much to mount ({:.1} MB, limit {:.0} MB)",
                *bytes as f64 / (1024.0 * 1024.0),
                MAX_TOTAL_BYTES / (1024.0 * 1024.0)
            ),
        }
    }
}

/// Outcome of an upload, including what was skipped and why.
#[derive(Debug, Default)]
pub struct Picked {
    pub files: Vec<JournalFile>,
    pub skipped: Vec<(String, String)>,
}

/// An opened picker waiting on the user.
///
/// Holding the input element keeps it alive until the selection has been read.
pub struct PendingPick {
    input: HtmlInputElement,
    settled: Promise,
    /// Remembered so the selection is read the same way it was asked for.
    mode: Mode,
}

/// Open the upload picker and return a handle to await the result.
///
/// **This is deliberately not `async fn`.** Browsers gate opening a file picker on
/// transient user activation, so the `.click()` has to happen while the user's
/// gesture is still being handled. Awaiting anything first — or routing this
/// through `spawn_local`, which defers it to a later task — makes the browser
/// refuse the dialog *silently*: no error, no dialog, and a promise that never
/// settles. That failure looks exactly like a dead command.
pub fn open_picker(mode: Mode) -> Result<PendingPick, PickError> {
    let window = web_sys::window()
        .ok_or_else(|| PickError::Unavailable("there is no window object".into()))?;
    let document = window
        .document()
        .ok_or_else(|| PickError::Unavailable("there is no document object".into()))?;

    let input: HtmlInputElement = document
        .create_element("input")
        .map_err(|_| PickError::Unavailable("could not create a file input".into()))?
        .dyn_into()
        .map_err(|_| PickError::Unavailable("could not create a file input".into()))?;

    input.set_type("file");
    input.set_multiple(true);
    let _ = input.set_attribute("id", UPLOAD_INPUT_ID);
    let _ = input.set_attribute("data-hledger-anywhere", "upload-input");
    // Accept everything: journals, include files, CSV imports and `.rules` files
    // all belong to a journal, and guessing at extensions would hide the ones
    // that do not look like any of them.

    if mode == Mode::Directory {
        // `webkitdirectory` is what makes this a *directory* picker. web-sys
        // exposes no setter, so set the content attribute — which is what the
        // behaviour keys on — as well as the IDL property. The legacy `directory`
        // attribute is set too, for engines that predate the standardised name.
        let _ = input.set_attribute("webkitdirectory", "");
        let _ = input.set_attribute("directory", "");
        let _ = js_sys::Reflect::set(
            input.as_ref(),
            &JsValue::from_str("webkitdirectory"),
            &JsValue::TRUE,
        );
    }

    // Positioned off-screen rather than hidden. The `hidden` attribute means
    // `display: none`, and a browser is entitled to refuse to open a picker for an
    // element that is not rendered.
    let _ = input.set_attribute("style", OFFSCREEN_INPUT_STYLE);

    let body = document
        .body()
        .ok_or_else(|| PickError::Unavailable("the document has no body".into()))?;
    body.append_child(&input)
        .map_err(|_| PickError::Unavailable("could not attach the file input".into()))?;

    // Listeners are registered here, synchronously, so they are already in place
    // when the click below opens the dialog.
    let settled = picker_promise(&input);

    // The dialog opens *only* because of this call.
    input.click();

    Ok(PendingPick {
        input,
        settled,
        mode,
    })
}

impl PendingPick {
    /// Wait for the user to finish with the dialog, then read the selection.
    pub async fn await_selection(self) -> Result<Picked, PickError> {
        let PendingPick {
            input,
            settled,
            mode,
        } = self;

        let event = JsFuture::from(settled)
            .await
            .ok()
            .and_then(|value| value.as_string())
            .unwrap_or_default();

        // Read the selection into owned handles *before* detaching the input: the
        // `FileList` belongs to the input, and removing it can leave the list
        // empty.
        let files: Vec<File> = input
            .files()
            .map(|list| (0..list.length()).filter_map(|index| list.get(index)).collect())
            .unwrap_or_default();
        input.remove();

        if event == "cancel" {
            return Err(PickError::Cancelled);
        }
        if files.is_empty() {
            return Err(PickError::Empty);
        }

        read_files(&files, mode).await
    }
}

/// Resolve with the name of the event that settled the dialog.
///
/// Not `async` on purpose: the listeners must be registered synchronously, at the
/// moment this is called, so they are in place before `.click()` opens the dialog.
fn picker_promise(input: &HtmlInputElement) -> Promise {
    let input = input.clone();
    Promise::new(&mut |resolve, _reject| {
        for name in ["change", "cancel"] {
            let resolve = resolve.clone();
            // `once_into_js` hands ownership of the closure to JavaScript so it is
            // not dropped before the event fires, and releases it after the single
            // call.
            let callback = Closure::once_into_js(move || {
                let _ = resolve.call1(&JsValue::UNDEFINED, &JsValue::from_str(name));
            });
            let _ = input.add_event_listener_with_callback(
                name,
                callback.unchecked_ref::<js_sys::Function>(),
            );
        }
    })
}

/// Read files handed over by a drop, the same way the picker reads them.
///
/// Dropped files have no `webkitRelativePath` — a drop carries files, not a
/// directory — so they land at the root exactly as `upload` puts them.
pub async fn read_dropped(files: &[File]) -> Result<Picked, PickError> {
    read_files(files, Mode::Files).await
}

/// Read every chosen file into memory, skipping what cannot be mounted.
async fn read_files(files: &[File], mode: Mode) -> Result<Picked, PickError> {
    let mut picked = Picked::default();
    let mut total = 0.0f64;

    for file in files {
        // Files land under one directory, so their path is either the name or,
        // for a directory pick, where they sat inside it.
        let path = match mode {
            Mode::Files => file.name(),
            Mode::Directory => relative_path(file),
        };
        if picked.files.iter().any(|mounted| mounted.path == path) {
            picked
                .skipped
                .push((path, "another uploaded file has this name".to_string()));
            continue;
        }

        let size = file.size();
        if size <= 0.0 {
            picked.skipped.push((path, "empty file".to_string()));
            continue;
        }
        if size > MAX_FILE_BYTES {
            picked.skipped.push((
                path,
                format!("{:.1} MB is over the per-file limit", size / (1024.0 * 1024.0)),
            ));
            continue;
        }
        total += size;
        if total > MAX_TOTAL_BYTES {
            return Err(PickError::TooLarge {
                bytes: total as u64,
            });
        }

        match read_text(file).await {
            Some(contents) if contents.contains('\0') => picked
                .skipped
                .push((path, "looks like a binary file".to_string())),
            Some(contents) => picked.files.push(JournalFile::new(path, contents)),
            None => picked
                .skipped
                .push((path, "could not be read as text".to_string())),
        }
    }

    if picked.files.is_empty() {
        return Err(PickError::Empty);
    }

    if mode == Mode::Directory {
        crate::journal::strip_common_root(&mut picked.files);
    }
    picked.files.sort_by(|left, right| left.path.cmp(&right.path));

    // A name that collides after the root was stripped would silently shadow the
    // file already mounted, so say which one lost.
    let mut seen: Vec<String> = Vec::new();
    picked.files.retain(|file| {
        if seen.contains(&file.path) {
            picked
                .skipped
                .push((file.path.clone(), "duplicate path after upload".to_string()));
            false
        } else {
            seen.push(file.path.clone());
            true
        }
    });
    Ok(picked)
}

/// Where a file sat inside the picked directory.
///
/// `webkitRelativePath` is the only thing that carries this — the `File` API has
/// no directory walk — and it includes the directory the user chose, so a pick of
/// `~/books` yields `books/hledger.journal`.
fn relative_path(file: &File) -> String {
    let raw = js_sys::Reflect::get(file.as_ref(), &JsValue::from_str("webkitRelativePath"))
        .ok()
        .and_then(|value| value.as_string())
        .unwrap_or_default();
    if raw.is_empty() { file.name() } else { raw }
}


/// Read a file as text, or `None` if the browser refuses.
async fn read_text(file: &File) -> Option<String> {
    // `Blob::text()` is infallible in web-sys; only awaiting it can fail.
    let value = JsFuture::from(file.text()).await.ok()?;
    value.as_string()
}
