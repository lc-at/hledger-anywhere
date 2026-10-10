//! The remoteStorage library, glued in (wasm-only).
//!
//! Everything here goes through `js_sys::Reflect`, like the rest of the app's
//! JavaScript boundary: the vendored bundle is an ordinary script that publishes
//! `window.RemoteStorage`, and going through the global keeps the boundary
//! callable by hand from the console when a connection misbehaves.
//!
//! The library is loaded **on demand**. It is 146 KB that most visits never need,
//! and the first thing this app has to do is be a terminal.

use js_sys::{Array, Function, Promise, Reflect};
use wasm_bindgen::closure::Closure;
use wasm_bindgen::{JsCast, JsValue};
use wasm_bindgen_futures::JsFuture;

use super::{CATEGORY, Entry};

/// Where the vendored library lives.
const LIBRARY: &str = "/js/vendor/remotestorage/remotestorage.js";

/// The category this app claims, in the form `access.claim` wants.
const CLAIM: &str = "hledger";

/// What went wrong, in terms the terminal can print.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RemoteError {
    /// The library could not be loaded.
    Library(String),
    /// The library was loaded but would not do what was asked.
    Call(String),
    /// The account is not connected yet.
    NotConnected,
    /// The account is connected but the request failed.
    Failed(String),
}

impl RemoteError {
    pub fn message(&self) -> String {
        match self {
            RemoteError::Library(reason) => {
                format!("could not load the remoteStorage library: {reason}")
            }
            RemoteError::Call(what) => format!("the remoteStorage library would not {what}"),
            RemoteError::NotConnected => {
                format!(
                    "no storage account is connected. {} starts that.",
                    crate::terminal::bold("connect user@host")
                )
            }
            RemoteError::Failed(reason) => reason.clone(),
        }
    }
}

fn window() -> Result<JsValue, RemoteError> {
    web_sys::window()
        .map(JsValue::from)
        .ok_or_else(|| RemoteError::Call("find the window".to_string()))
}

fn get(target: &JsValue, name: &str) -> Result<JsValue, RemoteError> {
    Reflect::get(target, &JsValue::from_str(name))
        .map_err(|_| RemoteError::Call(format!("read {}", crate::terminal::bold(name))))
}

fn call(target: &JsValue, name: &str, args: &[JsValue]) -> Result<JsValue, RemoteError> {
    let function = get(target, name)?
        .dyn_into::<Function>()
        .map_err(|_| RemoteError::Call(format!("use {}", crate::terminal::bold(name))))?;
    let list = Array::new();
    for argument in args {
        list.push(argument);
    }
    function
        .apply(target, &list)
        .map_err(|error| RemoteError::Failed(describe(&error)))
}

/// The message from a thrown value, which is a string as often as an Error.
fn describe(value: &JsValue) -> String {
    value
        .as_string()
        .or_else(|| get(value, "message").ok().and_then(|m| m.as_string()))
        .unwrap_or_else(|| "unknown error".to_string())
}

/// Load the vendored library, and install it as `window.RemoteStorage`.
///
/// Resolves immediately when it is already there, so this is safe to call before
/// every remote command.
pub async fn load_library() -> Result<JsValue, RemoteError> {
    let window = window()?;
    if let Ok(existing) = get(&window, "RemoteStorage")
        && !existing.is_undefined()
        && !existing.is_null()
    {
        return Ok(existing);
    }

    let document = get(&window, "document")?;
    let script = call(&document, "createElement", &[JsValue::from_str("script")])?;
    let script = script
        .dyn_into::<web_sys::EventTarget>()
        .map_err(|_| RemoteError::Library("could not create a script element".to_string()))?;
    Reflect::set(&script, &JsValue::from_str("src"), &JsValue::from_str(LIBRARY))
        .map_err(|_| RemoteError::Library("could not set the script source".to_string()))?;

    let loaded = Promise::new(&mut |resolve, reject| {
        let ok = Closure::once_into_js(move || {
            let _ = resolve.call0(&JsValue::UNDEFINED);
        });
        let failed = Closure::once_into_js(move || {
            let _ = reject.call1(
                &JsValue::UNDEFINED,
                &JsValue::from_str("the script did not load"),
            );
        });
        let _ = script.add_event_listener_with_callback(
            "load",
            ok.unchecked_ref::<Function>(),
        );
        let _ = script.add_event_listener_with_callback(
            "error",
            failed.unchecked_ref::<Function>(),
        );
    });

    let head = get(&document, "head")?;
    let _ = call(&head, "appendChild", &[script.into()]);
    JsFuture::from(loaded)
        .await
        .map_err(|error| RemoteError::Library(describe(&error)))?;

    let library = get(&window, "RemoteStorage")?;
    if library.is_undefined() || library.is_null() {
        return Err(RemoteError::Library(
            "the script loaded but published nothing".to_string(),
        ));
    }
    Ok(library)
}

/// A connected remoteStorage client with the app's category claimed.
pub struct Account {
    client: JsValue,
    /// The scope client, so listing and reading do not repeat the prefix.
    scope: JsValue,
}

impl Account {
    /// Connect, or find out that the account is not connected yet.
    ///
    /// `access.claim` has to happen before the client is used, and `connect` is
    /// what starts the OAuth dance, which is a redirect, so a caller that gets
    /// `Ok` may be about to lose the page.
    pub async fn open() -> Result<Account, RemoteError> {
        let _ = load_library().await?;
        // One client, polled: the library restores a stored connection
        // asynchronously, so a client asked once and thrown away answers "no" for
        // an account that is connected, and a second client starts the wait again
        // from nothing.
        let client = new_client()?;
        for _ in 0..15 {
            if get(&client, "connected")?.as_bool().unwrap_or(false) {
                let scope = call(&client, "scope", &[JsValue::from_str(CATEGORY)])?;
                return Ok(Account { client, scope });
            }
            tick().await;
        }
        Err(RemoteError::NotConnected)
    }


    /// The address the account belongs to, for saying which one is connected.
    pub fn user_address(&self) -> Option<String> {
        get(&self.client, "userAddress")
            .ok()
            .and_then(|value| value.as_string())
    }

    /// Start connecting to `address`.
    ///
    /// This returns as soon as the library has begun; the browser then leaves the
    /// page for the provider's consent screen and comes back. Anything the caller
    /// wants to say has to be said before this.
    pub fn connect(address: &str) -> Result<(), RemoteError> {
        let client = new_client()?;
        let _ = call(&client, "connect", &[JsValue::from_str(address)])?;
        Ok(())
    }

    /// Disconnect, leaving the local cache alone.
    pub fn disconnect() -> Result<(), RemoteError> {
        let client = new_client()?;
        let _ = call(&client, "disconnect", &[])?;
        Ok(())
    }

    /// Wait, briefly, for the library to report a connection.
    ///
    /// `connected` is restored from local storage asynchronously, so asking
    /// straight after construction answers "no" for an account that is in fact
    /// connected, which is exactly how a successful OAuth round trip came back
    /// and was then thrown away.
    pub async fn wait_connected() -> bool {
        for _ in 0..15 {
            if Account::is_connected() {
                return true;
            }
            tick().await;
        }
        false
    }

    /// Whether an account is connected, without asking the network.
    pub fn is_connected() -> bool {
        new_client()
            .ok()
            .and_then(|client| get(&client, "connected").ok())
            .and_then(|connected| connected.as_bool())
            .unwrap_or(false)
    }

    /// Run `handler` if and when the library reports a connection.
    ///
    /// This is how the app learns that someone has come back from the provider's
    /// consent screen: the library fires it, which may be some way after the page
    /// loaded.
    pub fn on_connected(
        handler: impl Fn(Option<String>) + 'static,
    ) -> Result<(), RemoteError> {
        let client = new_client()?;
        let callback = Closure::once(move |event: JsValue| {
            let address = get(&event, "userAddress")
                .ok()
                .and_then(|value| value.as_string());
            handler(address);
        });
        call(
            &client,
            "on",
            &[JsValue::from_str("connected"), callback.into_js_value()],
        )?;
        Ok(())
    }

    /// List a folder.
    ///
    /// An empty listing is asked for again before it is believed. The first read
    /// after an OAuth return can come back empty while the library is still
    /// bringing its wire client up, and an empty answer is indistinguishable from
    /// an empty account, so `remote` reported having found nothing while the
    /// account held two journals and the include between them was then missing.
    pub async fn list(&self, directory: &str) -> Result<Vec<Entry>, RemoteError> {
        for attempt in 0..3 {
            let entries = self.list_once(directory).await?;
            if !entries.is_empty() || attempt == 2 {
                return Ok(entries);
            }
            tick().await;
        }
        Ok(Vec::new())
    }

    /// One look at a folder, going to the network rather than the cache.
    async fn list_once(&self, directory: &str) -> Result<Vec<Entry>, RemoteError> {
        let listing = JsFuture::from(
            call(
                &self.scope,
                "getListing",
                &[
                    JsValue::from_str(&super::scoped(directory)),
                    // A number is a maximum age, so zero means "not older than
                    // now": a sync should look. (`false` is not the same thing , 
                    // it means the cache is all that may be used, which is how
                    // this first returned nothing at all.)
                    JsValue::from_f64(0.0),
                ],
            )?
            .dyn_into::<Promise>()
            .map_err(|_| RemoteError::Call("list a folder".to_string()))?,
        )
        .await
        .map_err(|error| RemoteError::Failed(describe(&error)))?;

        // A listing names its entries relative to the folder that was listed, and
        // the app wants account-absolute paths: those are what `mount_path` takes
        // the category off, and what the walk hands back to `list` in turn.
        let folder = format!("{}{}", super::CATEGORY, super::scoped(directory));
        let mut value = json_value(&listing);
        if let Some(object) = value.as_object_mut() {
            let renamed: Vec<(String, serde_json::Value)> = object
                .iter()
                .map(|(path, entry)| (super::joined(&folder, path), entry.clone()))
                .collect();
            object.clear();
            for (path, entry) in renamed {
                object.insert(path, entry);
            }
        }
        Ok(super::parse_listing(&value))
    }

    /// Write one file.
    ///
    /// `storeFile` takes the content type first, then the path, which is the one
    /// place this API's argument order surprises.
    pub async fn write(&self, path: &str, contents: &str) -> Result<(), RemoteError> {
        let call_args = [
            JsValue::from_str("text/plain"),
            JsValue::from_str(&super::scoped(path)),
            JsValue::from_str(contents),
        ];
        JsFuture::from(
            call(&self.scope, "storeFile", &call_args)?
                .dyn_into::<Promise>()
                .map_err(|_| RemoteError::Call("write a file".to_string()))?,
        )
        .await
        .map_err(|error| RemoteError::Failed(describe(&error)))?;
        Ok(())
    }

    /// Read one file.
    ///
    /// Fresh for the same reason as [`Account::list`]: `remote` is a sync, and a
    /// sync that quietly returns yesterday's file is worse than one that takes a
    /// moment.
    pub async fn read(&self, path: &str) -> Result<String, RemoteError> {
        let file = JsFuture::from(
            call(
                &self.scope,
                "getFile",
                &[
                    JsValue::from_str(&super::scoped(path)),
                    JsValue::from_f64(0.0),
                ],
            )?
            .dyn_into::<Promise>()
            .map_err(|_| RemoteError::Call("read a file".to_string()))?,
        )
        .await
        .map_err(|error| RemoteError::Failed(describe(&error)))?;
        let data = get(&file, "data")?;
        if let Some(text) = data.as_string() {
            return Ok(text);
        }
        // A file the library calls binary still has to come back as text: a journal
        // is text, and a CSV is text with commas in it. Only the extension makes one
        // of them look like bytes.
        if let Ok(bytes) = data.dyn_into::<js_sys::Uint8Array>() {
            let decoder = web_sys::TextDecoder::new()
                .map_err(|_| RemoteError::Failed("no text decoder".to_string()))?;
            return decoder
                .decode_with_u8_array(&bytes.to_vec())
                .map_err(|_| RemoteError::Failed(format!("`{path}` is not text")));
        }
        Err(RemoteError::Failed(format!("`{path}` is not text")))
    }
}

/// One hundred milliseconds, so a library that restores a connection from storage
/// has somewhere to do it.
async fn tick() {
    let promise = Promise::new(&mut |resolve, _| {
        let callback = Closure::once_into_js(move || {
            let _ = resolve.call0(&JsValue::UNDEFINED);
        });
        if let Some(window) = web_sys::window() {
            let _ = window.set_timeout_with_callback_and_timeout_and_arguments_0(
                callback.unchecked_ref::<Function>(),
                100,
            );
        }
    });
    let _ = JsFuture::from(promise).await;
}

/// A fresh client with the app's category claimed.
///
/// Claiming happens here, before any use, because the library refuses to touch a
/// path whose access was not claimed, and claiming is what puts the scope into
/// the OAuth request.
fn new_client() -> Result<JsValue, RemoteError> {
    let library = window().and_then(|window| get(&window, "RemoteStorage"))?;
    let constructor: Function = library
        .dyn_into()
        .map_err(|_| RemoteError::Library("RemoteStorage is not a constructor".to_string()))?;
    let client = Reflect::construct(&constructor, &Array::new())
        .map_err(|error| RemoteError::Failed(describe(&error)))?;
    let access = get(&client, "access")?;
    let _ = call(
        &access,
        "claim",
        &[JsValue::from_str(CLAIM), JsValue::from_str("rw")],
    )?;
    Ok(client)
}

/// A JS value as `serde_json`, through `JSON.stringify`.
fn json_value(value: &JsValue) -> serde_json::Value {
    js_sys::JSON::stringify(value)
        .ok()
        .and_then(|text| text.as_string())
        .and_then(|text| serde_json::from_str(&text).ok())
        .unwrap_or(serde_json::Value::Null)
}
