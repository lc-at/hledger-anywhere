//! Reading a directory of journal files from the user's disk (wasm-only).
//!
//! Uses `<input type="file" webkitdirectory>`, which is the only directory
//! picker that works in Chrome, Edge, Firefox *and* Safari. The File System
//! Access API's `showDirectoryPicker()` is Chromium-only and returns handles
//! rather than file contents, so it would need a second code path for no gain
//! here.
//!
//! The picker is driven imperatively rather than through the Leptos view
//! because it is a modal browser dialog whose result is a one-shot event, not
//! part of the rendered tree.

use wasm_bindgen::closure::Closure;
use js_sys::Promise;
use wasm_bindgen::{JsCast, JsValue};
use wasm_bindgen_futures::JsFuture;
use web_sys::{File, HtmlInputElement};

use crate::hledger::JournalFile;

/// Refuse to read any single file larger than this. hledger journals are text;
/// a file this big is either not a journal or not something to hand to an
/// in-browser engine.
const MAX_FILE_BYTES: f64 = 5.0 * 1024.0 * 1024.0;

/// Refuse to mount more than this in total, so a wrongly chosen root (say, a
/// home directory) fails with a message instead of wedging the tab.
const MAX_TOTAL_BYTES: f64 = 50.0 * 1024.0 * 1024.0;

/// Keeps the picker input in the layout but off-screen.
///
/// See `pick_directory` for why this is used instead of the `hidden` attribute.
const OFFSCREEN_INPUT_STYLE: &str =
    "position:fixed;left:-10000px;top:0;width:1px;height:1px;opacity:0;pointer-events:none;";

/// Id of the transient directory-picker input, while it exists.
pub const DIRECTORY_INPUT_ID: &str = "hledger-anywhere-directory-input";

/// What went wrong, in terms the UI can show.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PickError {
    /// The browser refused to open a directory picker.
    Unavailable(String),
    /// The user dismissed the dialog.
    Cancelled,
    /// The directory had no readable text files.
    Empty,
    /// Too much data to mount.
    TooLarge { bytes: u64 },
}

impl PickError {
    pub fn message(&self) -> String {
        match self {
            PickError::Unavailable(reason) => {
                format!("This browser cannot open a directory picker: {reason}")
            }
            PickError::Cancelled => "Directory selection was cancelled.".to_string(),
            PickError::Empty => {
                "That directory contained no readable text files.".to_string()
            }
            PickError::TooLarge { bytes } => format!(
                "That directory is too large to mount ({:.1} MB, limit {:.0} MB).",
                *bytes as f64 / (1024.0 * 1024.0),
                MAX_TOTAL_BYTES / (1024.0 * 1024.0)
            ),
        }
    }
}

/// Outcome of a pick, including what was skipped and why.
#[derive(Debug, Default)]
pub struct Picked {
    pub files: Vec<JournalFile>,
    /// Files that were present but not mounted, with a reason.
    pub skipped: Vec<(String, String)>,
}

/// Open a directory picker and read every text file in it.
/// A directory dialog that has been opened and is waiting on the user.
///
/// Holding the input element keeps it alive until the selection has been read;
/// the caller must eventually `await_selection` (or drop it, which leaves the
/// element in the DOM).
pub struct PendingPick {
    input: HtmlInputElement,
    settled: Promise,
}

/// Open the directory picker and return a handle to await the result.
///
/// **This is deliberately not `async fn`.** Browsers gate opening a file picker
/// on transient user activation, so the `.click()` has to happen while the user's
/// gesture is still being handled. Awaiting anything first — or routing this
/// through `spawn_local`, which is how it used to be called — defers the click to
/// a later task, and the browser then refuses the dialog *silently*: no error,
/// no dialog, and a promise that never settles. That failure looks exactly like
/// a dead button.
pub fn open_directory_picker() -> Result<PendingPick, PickError> {
    let window =
        web_sys::window().ok_or_else(|| PickError::Unavailable("there is no window object".into()))?;
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

    // A stable hook so this transient element can be found by hand in devtools,
    // and driven by tests (CDP's `DOM.setFileInputFiles` needs a selector).
    let _ = input.set_attribute("id", DIRECTORY_INPUT_ID);
    let _ = input.set_attribute("data-hledger-anywhere", "directory-input");

    // `webkitdirectory` is what makes this a *directory* picker. web-sys exposes
    // no setter for it, so set the content attribute — which is what the
    // behaviour actually keys on — as well as the IDL property. The legacy
    // `directory` attribute is set too; engines that predate the standardised
    // name still honour it.
    let _ = input.set_attribute("webkitdirectory", "");
    let _ = input.set_attribute("directory", "");
    let _ = js_sys::Reflect::set(
        input.as_ref(),
        &JsValue::from_str("webkitdirectory"),
        &JsValue::TRUE,
    );

    // Positioned off-screen rather than hidden. The `hidden` attribute means
    // `display: none`, and a browser is entitled to refuse to open a picker for
    // an element that is not rendered; keeping it laid out but invisible avoids
    // depending on that.
    let _ = input.set_attribute("style", OFFSCREEN_INPUT_STYLE);

    let body = document
        .body()
        .ok_or_else(|| PickError::Unavailable("the document has no body".into()))?;
    body.append_child(&input)
        .map_err(|_| PickError::Unavailable("could not attach the file input".into()))?;

    // Listeners are registered here, synchronously, so they are already in place
    // when the click below opens the dialog. Attaching them after the click would
    // risk missing the event entirely.
    let settled = picker_promise(&input);

    // The dialog opens *only* because of this call. Without it no `change` and no
    // `cancel` ever fires, so nothing downstream would ever settle.
    input.click();

    Ok(PendingPick { input, settled })
}

impl PendingPick {
    /// Wait for the user to finish with the dialog, then read the selection.
    pub async fn await_selection(self) -> Result<Picked, PickError> {
        let PendingPick { input, settled } = self;

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
            .map(|list| {
                (0..list.length())
                    .filter_map(|index| list.get(index))
                    .collect()
            })
            .unwrap_or_default();
        input.remove();

        if event == "cancel" {
            return Err(PickError::Cancelled);
        }

        // A directory can legitimately be empty; that is not a cancellation, and
        // saying so would send the user looking in the wrong place.
        if files.is_empty() {
            return Err(PickError::Empty);
        }

        read_files(&files).await
    }
}

/// Resolve with the name of the event that settled the dialog.
///
/// Not `async` on purpose: the listeners must be registered synchronously, at the
/// moment this is called, so they are in place before `.click()` opens the
/// dialog. An `async fn` would defer them to the first poll, which happens after
/// the click.
fn picker_promise(input: &HtmlInputElement) -> Promise {
    let input = input.clone();
    Promise::new(&mut |resolve, _reject| {
        for name in ["change", "cancel"] {
            let resolve = resolve.clone();
            // `once_into_js` hands ownership of the closure to JavaScript so it is
            // not dropped before the event fires — the usual footgun with
            // `Closure::new` — and releases it after the single call.
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

/// Read every file in a picker result into memory.
async fn read_files(files: &[File]) -> Result<Picked, PickError> {
    let mut picked = Picked::default();
    let mut total = 0.0f64;

    for file in files {
        let name = file.name();
        let path = relative_path(file, &name);
        let size = file.size();

        if size <= 0.0 {
            picked
                .skipped
                .push((path, "empty file".to_string()));
            continue;
        }
        if size > MAX_FILE_BYTES {
            picked
                .skipped
                .push((path, format!("{:.1} MB is over the per-file limit", size / (1024.0 * 1024.0))));
            continue;
        }
        total += size;
        if total > MAX_TOTAL_BYTES {
            return Err(PickError::TooLarge {
                bytes: total as u64,
            });
        }

        match read_text(file).await {
            Some(contents) => {
                if contents.contains('\0') {
                    picked
                        .skipped
                        .push((path, "looks like a binary file".to_string()));
                } else {
                    picked.files.push(JournalFile::new(path, contents));
                }
            }
            None => picked
                .skipped
                .push((path, "could not be read as text".to_string())),
        }
    }

    if picked.files.is_empty() {
        return Err(PickError::Empty);
    }

    strip_common_root(&mut picked.files);
    picked.files.sort_by(|a, b| a.path.cmp(&b.path));
    Ok(picked)
}

/// The file's path relative to the picked directory.
fn relative_path(file: &File, fallback: &str) -> String {
    let raw = js_sys::Reflect::get(file.as_ref(), &JsValue::from_str("webkitRelativePath"))
        .ok()
        .and_then(|value| value.as_string())
        .unwrap_or_default();
    if raw.is_empty() {
        fallback.to_string()
    } else {
        raw
    }
}

/// Read a file as text, or `None` if the browser refuses.
async fn read_text(file: &File) -> Option<String> {
    // `Blob::text()` is infallible in web-sys; only awaiting it can fail.
    let value = JsFuture::from(file.text()).await.ok()?;
    value.as_string()
}

/// Drop the picked directory's own name from every path.
///
/// `webkitRelativePath` includes the directory the user selected, so a pick of
/// `~/books` yields `books/hledger.journal`. Reports read better, and `-f`
/// arguments stay short, if paths are relative to what was actually chosen.
/// Only stripped when *every* file agrees on the first component.
fn strip_common_root(files: &mut [JournalFile]) {
    let Some(prefix) = files
        .iter()
        .map(|file| file.path.split_once('/').map(|(head, _)| head.to_string()))
        .collect::<Option<Vec<_>>>()
        .and_then(|heads| {
            let first = heads.first()?.clone();
            heads.iter().all(|head| *head == first).then_some(first)
        })
    else {
        return;
    };

    let prefix_with_slash = format!("{prefix}/");
    for file in files.iter_mut() {
        if let Some(rest) = file.path.strip_prefix(&prefix_with_slash) {
            file.path = rest.to_string();
        }
    }
}
