//! The wasm side of plugins: fetching a repository, running a command through one.
//!
//! The JavaScript half is `assets/js/plugins.js`, reached the way the engine bridge is:
//! through one global, waited for rather than assumed, so the order of a module script
//! against the Trunk glue is a non-event.
//!
//! Deliberately thin. Fetching text and importing a module are the browser's job, and
//! what the text means is this crate's job: [`super::Registry`] parses and validates the
//! manifest, so nothing a repository says is taken on trust.

#![cfg(target_arch = "wasm32")]

use js_sys::{Object, Promise, Reflect};
use wasm_bindgen::prelude::*;
use wasm_bindgen_futures::JsFuture;

use crate::hledger::bridge;

/// The global published by `assets/js/plugins.js`.
const GLOBAL: &str = "hledgerPlugins";

/// Look up `window.hledgerPlugins`, if it is there yet.
fn plugins_if_ready() -> Option<JsValue> {
    let window = web_sys::window()?;
    let plugins = Reflect::get(window.as_ref(), &JsValue::from_str(GLOBAL)).ok()?;
    if plugins.is_undefined() || plugins.is_null() {
        None
    } else {
        Some(plugins)
    }
}

/// Look up `window.hledgerPlugins`, waiting briefly for the module script.
async fn plugins() -> Result<JsValue, String> {
    if let Some(plugins) = plugins_if_ready() {
        return Ok(plugins);
    }
    // The script is a module, so it runs after the document and concurrently with the
    // wasm glue: being early is normal, being missing is not.
    for _ in 0..200 {
        bridge::delay(25).await;
        if let Some(plugins) = plugins_if_ready() {
            return Ok(plugins);
        }
    }
    Err(format!(
        "window.{GLOBAL} did not appear; is /js/plugins.js loading?"
    ))
}

/// Call one of the loader's functions and await what it returns.
async fn call(name: &str, arguments: &[JsValue]) -> Result<JsValue, String> {
    let plugins = plugins().await?;
    let function = Reflect::get(&plugins, &JsValue::from_str(name))
        .ok()
        .filter(|value| value.is_function())
        .ok_or_else(|| format!("the plugin loader has no {name}()"))?;
    let function: &js_sys::Function = function.unchecked_ref();
    let result = function
        .apply(&plugins, &js_sys::Array::from_iter(arguments.iter().cloned()))
        .map_err(|error| describe(&error))?;
    JsFuture::from(Promise::resolve(&result))
        .await
        .map_err(|error| describe(&error))
}

/// The `error` field of a result object, if it has one.
fn field(result: &JsValue, name: &str) -> Option<String> {
    Reflect::get(result, &JsValue::from_str(name))
        .ok()
        .and_then(|value| value.as_string())
}

fn describe(error: &JsValue) -> String {
    error
        .as_string()
        .or_else(|| {
            Reflect::get(error, &JsValue::from_str("message"))
                .ok()
                .and_then(|message| message.as_string())
        })
        .unwrap_or_else(|| "the plugin loader failed".to_string())
}

/// Fetch a manifest. The text is returned, not trusted: the caller parses it.
pub async fn fetch(url: &str) -> Result<String, String> {
    let result = call("fetchManifest", &[JsValue::from_str(url)]).await?;
    match field(&result, "text") {
        Some(text) => Ok(text),
        None => Err(field(&result, "error").unwrap_or_else(|| format!("could not fetch {url}"))),
    }
}

/// Run a plugin command, handing the plugin the app's own API as `host`.
///
/// Everything about which module implements which word was settled when the repository
/// was installed, so this only has to find it and call it.
pub async fn run(
    manifest: &str,
    module: &str,
    name: &str,
    arguments: &str,
    host: &JsValue,
) -> Result<(), String> {
    let result = call(
        "run",
        &[
            JsValue::from_str(manifest),
            JsValue::from_str(module),
            JsValue::from_str(name),
            JsValue::from_str(arguments),
            host.clone(),
        ],
    )
    .await?;
    match field(&result, "error") {
        Some(error) => Err(error),
        None => Ok(()),
    }
}

/// Forget imported modules, so a reloaded repository is read again.
pub async fn reset() -> Result<(), String> {
    call("reset", &[]).await.map(|_| ())
}

/// An empty object, which the host API is filled into.
pub fn empty_object() -> Object {
    Object::new()
}
