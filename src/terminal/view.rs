//! xterm.js, wrapped (wasm-only).
//!
//! xterm is vendored under `assets/js/vendor/xterm/` and loaded by plain
//! `<script>` tags in `index.html`, so by the time this runs `window.Terminal`
//! and `window.FitAddon.FitAddon` are there. That ordering is deliberate: a
//! non-module script in the head executes before Trunk's deferred wasm bootstrap.
//!
//! The bindings are hand-written rather than generated: the app has no JavaScript
//! build step, and two globals do not justify adding one. The addon is reached
//! through `Reflect` because its global is a namespace object
//! (`FitAddon.FitAddon`), which the `wasm_bindgen` macro cannot spell.

use js_sys::{Array, Function, Object, Reflect};
use wasm_bindgen::prelude::*;
use wasm_bindgen::JsCast;
use web_sys::HtmlElement;

#[wasm_bindgen]
extern "C" {
    /// The xterm.js `Terminal` class, published as a global.
    #[wasm_bindgen(js_name = "Terminal")]
    type Xterm;

    #[wasm_bindgen(constructor, js_class = "Terminal")]
    fn new(options: &JsValue) -> Xterm;

    #[wasm_bindgen(method)]
    fn open(this: &Xterm, element: &HtmlElement);

    #[wasm_bindgen(method)]
    fn write(this: &Xterm, data: &str);

    #[wasm_bindgen(method)]
    fn clear(this: &Xterm);

    #[wasm_bindgen(method)]
    fn focus(this: &Xterm);

    #[wasm_bindgen(method, js_name = "onData")]
    fn on_data(this: &Xterm, callback: &Function);

    #[wasm_bindgen(method, js_name = "loadAddon")]
    fn load_addon(this: &Xterm, addon: &JsValue);
}

/// The terminal on screen.
pub struct Screen {
    terminal: Xterm,
    /// The fit addon, if it loaded. Without it the terminal still works; it just
    /// keeps whatever size it was created at.
    fit: Option<JsValue>,
}

impl Screen {
    /// Create a terminal inside `element`.
    pub fn mount(element: &HtmlElement) -> Result<Screen, String> {
        let terminal = Xterm::new(&options());

        let fit = fit_addon();
        if let Some(addon) = &fit {
            terminal.load_addon(addon);
        }

        terminal.open(element);
        let screen = Screen { terminal, fit };
        screen.fit();
        screen.focus();
        Ok(screen)
    }

    /// Write text. The caller normalises newlines; see
    /// [`to_terminal_text`](super::to_terminal_text).
    pub fn write(&self, text: &str) {
        self.terminal.write(text);
    }

    pub fn clear(&self) {
        self.terminal.clear();
    }

    pub fn focus(&self) {
        self.terminal.focus();
    }

    /// Resize the terminal to its element.
    pub fn fit(&self) {
        let Some(addon) = &self.fit else {
            return;
        };
        if let Ok(fit) = Reflect::get(addon, &JsValue::from_str("fit"))
            && let Ok(fit) = fit.dyn_into::<Function>()
        {
            let _ = fit.call0(addon);
        }
    }

    /// Call `handler` for every chunk of input the user types.
    ///
    /// The closure is handed to JavaScript and deliberately never dropped: the
    /// terminal outlives this call, so a `Closure` that went out of scope here
    /// would take the handler with it.
    pub fn on_data(&self, handler: impl Fn(&str) + 'static) {
        let closure = Closure::<dyn FnMut(JsValue)>::new(move |value: JsValue| {
            if let Some(text) = value.as_string() {
                handler(&text);
            }
        });
        self.terminal
            .on_data(closure.as_ref().unchecked_ref::<Function>());
        closure.forget();
    }
}

/// Construct the fit addon, or `None` when it is not on the page.
fn fit_addon() -> Option<JsValue> {
    let window = web_sys::window()?;
    let namespace = Reflect::get(window.as_ref(), &JsValue::from_str("FitAddon")).ok()?;
    let class = Reflect::get(&namespace, &JsValue::from_str("FitAddon")).ok()?;
    let class = class.dyn_into::<Function>().ok()?;
    Reflect::construct(&class, &Array::new()).ok()
}

/// The terminal's appearance.
///
/// Black and amber, like the trading terminals this kind of tool grew up beside,
/// with enough contrast for a monospace report to be read for a long time.
fn options() -> JsValue {
    let options = Object::new();
    set(&options, "cursorBlink", JsValue::TRUE);
    set(&options, "cursorStyle", JsValue::from_str("block"));
    set(&options, "fontSize", JsValue::from_f64(14.0));
    set(
        &options,
        "fontFamily",
        JsValue::from_str(
            "ui-monospace, SFMono-Regular, Menlo, Consolas, \"DejaVu Sans Mono\", monospace",
        ),
    );
    set(&options, "scrollback", JsValue::from_f64(5000.0));
    // The app writes every newline itself, so xterm must not rewrite them.
    set(&options, "convertEol", JsValue::FALSE);
    set(&options, "allowProposedApi", JsValue::TRUE);

    let theme = Object::new();
    set(&theme, "background", JsValue::from_str("#000000"));
    set(&theme, "foreground", JsValue::from_str("#d8d8d8"));
    set(&theme, "cursor", JsValue::from_str("#ff9f1c"));
    set(&theme, "selectionBackground", JsValue::from_str("#3a3021"));
    // The error colour the terminal prints stderr in, to match bright red.
    set(&theme, "red", JsValue::from_str("#ff6b5e"));
    set(&theme, "brightRed", JsValue::from_str("#ff8a80"));
    set(&options, "theme", theme.into());

    options.into()
}

fn set(object: &Object, key: &str, value: JsValue) {
    let _ = Reflect::set(object, &JsValue::from_str(key), &value);
}
