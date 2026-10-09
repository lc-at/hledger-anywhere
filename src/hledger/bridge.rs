//! Calling the WASI worker from Rust (wasm-only).
//!
//! This module is the only place that talks to `window.hledgerWasi`, published
//! by `assets/js/hledger-wasi.js`. Keeping the boundary this thin means the rest
//! of the app sees a plain Rust `async fn`, and the JS side can be changed — or
//! replaced by a different WASI host — without touching callers.
//!
//! Everything goes through `js_sys::Reflect` rather than
//! `#[wasm_bindgen(module = ...)]`. That is deliberate: the generated import
//! specifier would have to match Trunk's output layout exactly, and using the
//! global keeps the boundary callable by hand from the browser console, which is
//! how a failing report is diagnosed.

use js_sys::{Array, Date, Function, Promise, Reflect};
use wasm_bindgen::closure::Closure;
use wasm_bindgen::{JsCast, JsValue};
use wasm_bindgen_futures::JsFuture;

use super::{EngineError, HledgerOutput, HledgerRequest};

/// The global published by `assets/js/hledger-wasi.js`.
const BRIDGE_GLOBAL: &str = "hledgerWasi";

/// How long to wait for the bridge script to publish itself.
///
/// The bridge is a module script, so it is parsed and executed *after* the
/// document, concurrently with the Trunk/Rust glue. The app's first engine use
/// (the startup probe) can therefore run before the bridge has published, which
/// is a normal ordering, not a failure. Waiting a bounded time turns that race
/// into a non-event while still surfacing a genuinely missing script.
const BRIDGE_WAIT_MS: f64 = 5_000.0;
const BRIDGE_POLL_MS: i32 = 25;

/// Look up `window.hledgerWasi` if it has been published yet.
fn bridge_if_ready() -> Option<JsValue> {
    let window = web_sys::window()?;
    let bridge = Reflect::get(window.as_ref(), &JsValue::from_str(BRIDGE_GLOBAL)).ok()?;
    if bridge.is_undefined() || bridge.is_null() {
        None
    } else {
        Some(bridge)
    }
}

/// Look up `window.hledgerWasi`, waiting for the bridge script if necessary.
async fn bridge() -> Result<JsValue, EngineError> {
    if web_sys::window().is_none() {
        return Err(EngineError::Unsupported("no window object".into()));
    }
    if let Some(bridge) = bridge_if_ready() {
        return Ok(bridge);
    }

    let deadline = Date::now() + BRIDGE_WAIT_MS;
    loop {
        delay(BRIDGE_POLL_MS).await;
        if let Some(bridge) = bridge_if_ready() {
            return Ok(bridge);
        }
        if Date::now() >= deadline {
            return Err(EngineError::Missing(format!(
                "window.{BRIDGE_GLOBAL} did not appear within {} ms; \
                 is /js/hledger-wasi.js loading?",
                BRIDGE_WAIT_MS as u32
            )));
        }
    }
}

/// Yield to the browser's event loop for `ms` milliseconds.
async fn delay(ms: i32) {
    let promise = Promise::new(&mut |resolve, _reject| {
        let Some(window) = web_sys::window() else {
            return;
        };
        let callback = Closure::once_into_js(move || {
            let _ = resolve.call0(&JsValue::UNDEFINED);
        });
        let _ = window.set_timeout_with_callback_and_timeout_and_arguments_0(
            callback.unchecked_ref::<Function>(),
            ms,
        );
    });
    let _ = JsFuture::from(promise).await;
}

/// Look up a method on the bridge object.
fn method(target: &JsValue, name: &str) -> Result<Function, EngineError> {
    Reflect::get(target, &JsValue::from_str(name))
        .ok()
        .and_then(|value| value.dyn_into::<Function>().ok())
        .ok_or_else(|| {
            EngineError::Missing(format!("window.{BRIDGE_GLOBAL}.{name} is not a function"))
        })
}

/// Call a bridge method and await its promise.
async fn call(target: &JsValue, name: &str, arguments: &[JsValue]) -> Result<JsValue, EngineError> {
    let function = method(target, name)?;
    let arguments = Array::from_iter(arguments.iter().cloned());

    let returned = function
        .apply(target, &arguments)
        .map_err(|error| classify(error, name))?;

    let promise: Promise = returned.dyn_into().map_err(|_| {
        EngineError::Bridge(format!("{BRIDGE_GLOBAL}.{name}() did not return a promise"))
    })?;

    JsFuture::from(promise)
        .await
        .map_err(|error| classify(error, name))
}

/// Turn a JavaScript rejection into the most specific error we can.
///
/// The bridge tags transport failures with a `code`, which is what lets a
/// missing `hledger.wasm` be reported as actionable guidance rather than as a
/// generic engine error.
fn classify(error: JsValue, operation: &str) -> EngineError {
    let message = message_of(&error);
    let message = if message.is_empty() {
        format!("{BRIDGE_GLOBAL}.{operation}() failed")
    } else {
        message
    };

    match code_of(&error).as_deref() {
        Some("unsupported") => EngineError::Unsupported(message),
        Some("missing-wasm") => EngineError::Missing(message),
        _ => EngineError::Bridge(message),
    }
}

fn message_of(value: &JsValue) -> String {
    if let Some(text) = value.as_string() {
        return text;
    }
    Reflect::get(value, &JsValue::from_str("message"))
        .ok()
        .and_then(|message| message.as_string())
        .unwrap_or_default()
}

fn code_of(value: &JsValue) -> Option<String> {
    Reflect::get(value, &JsValue::from_str("code"))
        .ok()
        .and_then(|code| code.as_string())
}

fn field(object: &JsValue, name: &str) -> JsValue {
    Reflect::get(object, &JsValue::from_str(name)).unwrap_or(JsValue::UNDEFINED)
}

fn string_field(object: &JsValue, name: &str) -> String {
    field(object, name).as_string().unwrap_or_default()
}

fn number_field(object: &JsValue, name: &str) -> Option<f64> {
    field(object, name).as_f64()
}

fn string_array(value: &JsValue) -> Vec<String> {
    let Ok(array) = value.clone().dyn_into::<Array>() else {
        return Vec::new();
    };
    array.iter().filter_map(|item| item.as_string()).collect()
}

/// Compile the module ahead of the first command.
///
/// Optional — `run` compiles on demand — but doing it up front means the first
/// command is not the thing that has to wait for the whole download.
pub async fn init() -> Result<(), EngineError> {
    let bridge = bridge().await?;
    call(&bridge, "init", &[]).await.map(|_| ())
}

/// Tell the worker which journal to read by default.
///
/// This is what lets the user type `hledger balance` with no `-f`: hledger reads
/// `$LEDGER_FILE` when no file is given, and the worker builds the environment.
/// Passing `None` clears it.
pub async fn configure(ledger_file: Option<&str>) -> Result<(), EngineError> {
    let bridge = bridge().await?;

    let options = js_sys::Object::new();
    let value = match ledger_file {
        Some(path) => JsValue::from_str(path),
        None => JsValue::UNDEFINED,
    };
    Reflect::set(&options, &JsValue::from_str("ledgerFile"), &value)
        .map_err(|error| classify(error, "configure"))?;

    call(&bridge, "configure", &[options.into()]).await.map(|_| ())
}

/// Run one invocation on the worker.
pub async fn run(request: &HledgerRequest) -> Result<HledgerOutput, EngineError> {
    let bridge = bridge().await?;

    let argv = Array::new();
    for argument in &request.argv {
        argv.push(&JsValue::from_str(argument));
    }

    // Files travel as compact [path, contents] pairs: an array of two strings
    // per file is far less code on the Rust side than building objects, and the
    // bridge normalises both shapes.
    let files = Array::new();
    for file in &request.files {
        let pair = Array::new();
        pair.push(&JsValue::from_str(&file.path));
        pair.push(&JsValue::from_str(&file.contents));
        files.push(&pair);
    }

    let result = call(&bridge, "run", &[argv.into(), files.into()]).await?;

    let argv_echo = string_array(&field(&result, "argv"));
    Ok(HledgerOutput {
        argv: if argv_echo.is_empty() {
            request.argv.clone()
        } else {
            argv_echo
        },
        stdout: string_field(&result, "stdout"),
        stderr: string_field(&result, "stderr"),
        // A missing exitCode means the result shape changed; -1 is a failure,
        // which is the safe direction to be wrong in.
        exit_code: number_field(&result, "exitCode").unwrap_or(-1.0) as i32,
        ms: number_field(&result, "ms").unwrap_or(0.0),
    })
}
