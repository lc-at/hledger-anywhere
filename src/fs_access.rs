//! Mounting a journal directory through the File System Access API (wasm-only).
//!
//! Where [`crate::upload`] reads what the browser hands over, this reads from a
//! directory the user grants access to with `showDirectoryPicker`, and keeps the
//! [`FileSystemDirectoryHandle`] and one [`FileSystemFileHandle`] per mounted file
//! so that the files can be written back. The read side obeys exactly the same
//! admission rules as an upload; the write side is the only way the app changes a
//! journal on disk.
//!
//! The picker is opened imperatively, and **not through an `async fn`**: a browser
//! only opens it while the user's gesture is still being handled, exactly as
//! [`crate::upload::open_picker`] describes.

#![cfg(target_arch = "wasm32")]

use std::collections::BTreeMap;

use js_sys::{JsString, Promise, Reflect};
use wasm_bindgen::prelude::*;
use wasm_bindgen::JsCast;
use wasm_bindgen_futures::JsFuture;
use web_sys::{
    DirectoryPickerOptions, File, FileSystemDirectoryHandle, FileSystemFileHandle,
    FileSystemHandle, FileSystemHandleKind, FileSystemHandlePermissionDescriptor,
    FileSystemPermissionMode, FileSystemWritableFileStream, WritableStream,
};

use crate::upload::{self, PickError, Picked};

/// How deep a directory walk may go. A journal tree is shallow; this exists so a
/// pathological tree cannot wedge the tab.
const MAX_DEPTH: usize = 32;

/// Whether this browser can open a directory picker at all.
///
/// Needs a secure context (HTTPS or localhost) and the `showDirectoryPicker`
/// method. Safari has neither the method, and the development server on a LAN
/// address has neither a secure context; both fall back to `webkitdirectory`.
pub fn available() -> bool {
    let Some(window) = web_sys::window() else {
        return false;
    };
    if !window.is_secure_context() {
        return false;
    }
    Reflect::has(window.as_ref(), &JsValue::from_str("showDirectoryPicker"))
        .unwrap_or(false)
}

/// What a mounted file remembers about its place on disk.
#[derive(Clone, Debug)]
pub struct FileRef {
    pub handle: FileSystemFileHandle,
    pub size: u64,
    pub last_modified: f64,
}

/// A directory that was opened and walked.
#[derive(Debug)]
pub struct Opened {
    pub root: FileSystemDirectoryHandle,
    pub picked: Picked,
    /// Whether `readwrite` permission was granted, so files can be written back.
    pub writable: bool,
    /// Mounted path -> the handle that wrote it, for files that were admitted.
    pub files: BTreeMap<String, FileRef>,
}

/// An opened picker waiting on the user. Held until the selection is read.
pub struct PendingDirectory {
    settled: Promise<FileSystemDirectoryHandle>,
}

impl PendingDirectory {
    /// Wait for the user to choose a directory, then read it.
    pub async fn await_selection(self) -> Result<Opened, PickError> {
        let root = JsFuture::from(self.settled)
            .await
            .map_err(|error| {
                if aborted(&error) {
                    PickError::Cancelled
                } else {
                    PickError::Unavailable(describe(&error))
                }
            })?;

        read_directory(root).await
    }
}

/// Read an already-granted directory into an [`Opened`].
///
/// Shared by the picker path and by a restore that still holds a usable handle.
pub async fn read_directory(root: FileSystemDirectoryHandle) -> Result<Opened, PickError> {
    let writable = query_write(&root).await;
    let mut files = BTreeMap::new();
    let mut picked = Picked::default();
    let mut total = 0.0f64;
    walk(&root, &mut files, &mut picked, &mut total).await?;
    picked.files.sort_by(|left, right| left.path.cmp(&right.path));
    Ok(Opened {
        root,
        picked,
        writable,
        files,
    })
}

/// Open the directory picker and return a handle to await the result.
///
/// Deliberately not `async fn`: see the module comment.
pub fn open_directory() -> Result<PendingDirectory, PickError> {
    let window = web_sys::window()
        .ok_or_else(|| PickError::Unavailable("there is no window object".into()))?;
    let options = DirectoryPickerOptions::new();
    // Asking for write up front, while the user's gesture is live, is what makes the
    // session writable without a second prompt.
    options.set_mode(FileSystemPermissionMode::Readwrite);
    let settled = window
        .show_directory_picker_with_options(&options)
        .map_err(|error| PickError::Unavailable(describe(&error)))?;
    Ok(PendingDirectory { settled })
}

/// Whether the directory still grants `readwrite` access.
pub async fn query_write(root: &FileSystemDirectoryHandle) -> bool {
    let descriptor = FileSystemHandlePermissionDescriptor::new();
    descriptor.set_mode(FileSystemPermissionMode::Readwrite);
    let handle: &FileSystemHandle = root.unchecked_ref();
    JsFuture::from(handle.query_permission_with_descriptor(&descriptor))
        .await
        .ok()
        .and_then(|value| value.as_string())
        .as_deref()
        == Some("granted")
}

/// Ask the browser to grant `readwrite` on a directory that was remembered from an
/// earlier visit.
///
/// **Deliberately not `async fn`**, for the same reason the picker is not: a
/// permission request only succeeds while the user's gesture is still being
/// handled, so the call has to be made from the command that keystroke produced.
/// Returns the promise to await.
pub fn request_write(root: &FileSystemDirectoryHandle) -> Promise<JsString> {
    let descriptor = FileSystemHandlePermissionDescriptor::new();
    descriptor.set_mode(FileSystemPermissionMode::Readwrite);
    let handle: &FileSystemHandle = root.unchecked_ref();
    handle.request_permission_with_descriptor(&descriptor)
}

/// The file's size and modification time on disk, for the conflict check.
pub async fn stat(handle: &FileSystemFileHandle) -> Result<(u64, f64), String> {
    let file: File = JsFuture::from(handle.get_file())
        .await
        .map_err(|error| describe(&error))?
        .dyn_into()
        .map_err(|_| "the file could not be read back".to_string())?;
    Ok((file.size() as u64, file.last_modified()))
}

/// Write `contents` over `path`'s file, refusing if it changed on disk since read.
///
/// The returned [`FileRef`] carries the post-write stat, so the next write compares
/// against this one rather than the original read.
pub async fn write_file(
    path: &str,
    known: &FileRef,
    contents: &str,
) -> Result<FileRef, String> {
    let (size, last_modified) = stat(&known.handle).await?;
    if size != known.size || last_modified != known.last_modified {
        return Err(format!(
            "{path} changed on disk since it was opened; run `open` again before saving"
        ));
    }

    let stream: FileSystemWritableFileStream = JsFuture::from(known.handle.create_writable())
        .await
        .map_err(|error| describe(&error))?
        .dyn_into()
        .map_err(|_| "the file could not be opened for writing".to_string())?;
    JsFuture::from(stream.write_with_str(contents).map_err(|error| describe(&error))?)
        .await
        .map_err(|error| describe(&error))?;
    let writable: &WritableStream = stream.unchecked_ref();
    JsFuture::from(writable.close())
        .await
        .map_err(|error| describe(&error))?;

    let (size, last_modified) = stat(&known.handle).await?;
    Ok(FileRef {
        handle: known.handle.clone(),
        size,
        last_modified,
    })
}

/// Walk a directory tree, admitting files the same way an upload does.
async fn walk(
    root: &FileSystemDirectoryHandle,
    files: &mut BTreeMap<String, FileRef>,
    picked: &mut Picked,
    total: &mut f64,
) -> Result<(), PickError> {
    // Iterative, so the recursion needs no boxing, and depth is enforced by the
    // `depth` carried on each stack frame.
    let mut stack: Vec<(FileSystemDirectoryHandle, String, usize)> =
        vec![(root.clone(), String::new(), 0)];

    while let Some((dir, prefix, depth)) = stack.pop() {
        let iterator = dir.entries();
        loop {
            let next = js_sys::AsyncIterator::next(&iterator)
                .map_err(|_| PickError::Unavailable("could not read the folder".into()))?;
            let value = JsFuture::from(next)
                .await
                .map_err(|_| PickError::Unavailable("could not read the folder".into()))?;
            let done = Reflect::get(&value, &JsValue::from_str("done"))
                .ok()
                .and_then(|flag| flag.as_bool())
                .unwrap_or(false);
            if done {
                break;
            }
            let Some(entry) = Reflect::get(&value, &JsValue::from_str("value")).ok() else {
                continue;
            };
            let name = Reflect::get(&entry, &JsValue::from(0))
                .ok()
                .and_then(|name| name.as_string())
                .unwrap_or_default();
            let Ok(handle) = Reflect::get(&entry, &JsValue::from(1))
                .and_then(|handle| handle.dyn_into::<FileSystemHandle>())
            else {
                continue;
            };
            let path = if prefix.is_empty() {
                name.clone()
            } else {
                format!("{prefix}/{name}")
            };

            match handle.kind() {
                FileSystemHandleKind::Directory if depth < MAX_DEPTH => {
                    let sub: FileSystemDirectoryHandle =
                        handle.unchecked_ref::<FileSystemDirectoryHandle>().clone();
                    stack.push((sub, path, depth + 1));
                }
                FileSystemHandleKind::File => {
                    admit_one(&path, &handle, files, picked, total).await?;
                }
                _ => {}
            }
        }
    }
    Ok(())
}

/// Read and admit one file, recording its handle when it is kept.
async fn admit_one(
    path: &str,
    handle: &FileSystemHandle,
    files: &mut BTreeMap<String, FileRef>,
    picked: &mut Picked,
    total: &mut f64,
) -> Result<(), PickError> {
    if picked.files.iter().any(|mounted| mounted.path == path) {
        picked
            .skipped
            .push((path.to_string(), "another file has this name".to_string()));
        return Ok(());
    }

    let file_handle: FileSystemFileHandle = handle.unchecked_ref::<FileSystemFileHandle>().clone();
    let file: File = match JsFuture::from(file_handle.get_file()).await {
        Ok(value) => match value.dyn_into() {
            Ok(file) => file,
            Err(_) => {
                picked
                    .skipped
                    .push((path.to_string(), "could not be read".to_string()));
                return Ok(());
            }
        },
        Err(_) => {
            picked
                .skipped
                .push((path.to_string(), "could not be read".to_string()));
            return Ok(());
        }
    };

    let size = file.size();
    if let Some(reason) = upload::admit_size(size) {
        picked.skipped.push((path.to_string(), reason));
        return Ok(());
    }
    *total += size;
    if *total > upload::MAX_TOTAL_BYTES {
        return Err(PickError::TooLarge {
            bytes: *total as u64,
        });
    }

    let contents = upload::read_text(&file).await;
    if let Some(reason) = upload::admit_text(&contents) {
        picked.skipped.push((path.to_string(), reason));
        return Ok(());
    }

    picked
        .files
        .push(crate::hledger::JournalFile::new(
            path,
            contents.expect("admitted"),
        ));
    files.insert(
        path.to_string(),
        FileRef {
            handle: file_handle,
            size: size as u64,
            last_modified: file.last_modified(),
        },
    );
    Ok(())
}

/// A `DOMException` name, if the value is one.
fn aborted(error: &JsValue) -> bool {
    Reflect::get(error, &JsValue::from_str("name"))
        .ok()
        .and_then(|name| name.as_string())
        .is_some_and(|name| name == "AbortError")
}

/// The best available description of a `JsValue`.
fn describe(error: &JsValue) -> String {
    error
        .as_string()
        .or_else(|| {
            Reflect::get(error, &JsValue::from_str("message"))
                .ok()
                .and_then(|message| message.as_string())
        })
        .unwrap_or_else(|| "the browser refused the file access".to_string())
}
