//! xterm.js, wrapped (wasm-only).
//!
//! xterm is vendored under `assets/js/vendor/xterm/` and loaded by plain
//! `<script>` tags in `index.html`, so by the time this runs `window.Terminal`
//! and `window.FitAddon.FitAddon` are there. That ordering is deliberate: a
//! non-module script in the head executes before Trunk's deferred wasm bootstrap.
//!
//! The bindings are hand-written rather than generated: the app has no JavaScript
//! build step, and a handful of globals do not justify adding one. The fit addon
//! is reached through `Reflect` because its global is a namespace object
//! (`FitAddon.FitAddon`), which the `wasm_bindgen` macro cannot spell; the buffer
//! is read the same way for the same reason, xterm's scrollback API is deep and
//! mostly untyped, and searching it is the app's job, not an addon's.

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

    /// Character columns, kept current by the fit addon.
    #[wasm_bindgen(method, getter)]
    fn cols(this: &Xterm) -> u32;

    /// Character rows.
    #[wasm_bindgen(method, getter)]
    fn rows(this: &Xterm) -> u32;
}

/// The terminal on screen.
pub struct Screen {
    terminal: Xterm,
    /// The fit addon, if it loaded. Without it the terminal still works; it just
    /// keeps whatever size it was created at.
    fit: Option<JsValue>,
}

impl Screen {
    /// Create a terminal inside `element`, at `font` pixels.
    pub fn mount(
        element: &HtmlElement,
        font: u32,
        screen_reader: bool,
    ) -> Result<Screen, String> {
        // The accessibility tree is asked for at construction when it was asked for
        // last time: someone using a screen reader should not have to run a command
        // before the terminal becomes readable.
        let terminal = Xterm::new(&options(font, screen_reader));

        let fit = addon("FitAddon");
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

    /// The terminal's size in character cells.
    ///
    /// hledger formats its reports to the width of the terminal it is running in,
    /// and the only way to tell it is through the environment, see
    /// [`Screen::size`]'s callers and `hledger-wasm/terminal-size-stub`.
    pub fn size(&self) -> (u32, u32) {
        (self.terminal.cols(), self.terminal.rows())
    }

    /// Change the font size and resize to match.
    ///
    /// The rows and columns have to be recomputed afterwards: a bigger font fits
    /// fewer of both, and hledger is told the count on the next command.
    pub fn set_font_size(&self, font: u32) {
        if let Ok(options) = Reflect::get(&self.terminal, &JsValue::from_str("options")) {
            let _ = Reflect::set(
                &options,
                &JsValue::from_str("fontSize"),
                &JsValue::from_f64(f64::from(font)),
            );
        }
        self.fit();
    }

    /// Turn xterm's accessibility tree on or off.
    ///
    /// Without it the terminal is a canvas of rows and a screen reader can say
    /// nothing useful about it. xterm watches this option specifically, so it can
    /// be changed at runtime, `cols` and `rows` are the only options that cannot.
    pub fn set_screen_reader(&self, on: bool) {
        if let Ok(options) = Reflect::get(&self.terminal, &JsValue::from_str("options")) {
            let _ = Reflect::set(
                &options,
                &JsValue::from_str("screenReaderMode"),
                &JsValue::from_bool(on),
            );
        }
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

    /// The whole scrollback, oldest first, as plain text.
    ///
    /// This is what the search reads, including the lines that have scrolled off
    /// screen, which is the whole reason to search a terminal. The app decides
    /// which of these rows are engine output; see `App::output_rows`.
    pub fn lines(&self) -> Vec<String> {
        let Some(active) = self.buffer() else {
            return Vec::new();
        };
        let Some(get_line) = method(&active, "getLine") else {
            return Vec::new();
        };
        let length = property(&active, "length").unwrap_or(0.0) as usize;

        let mut lines = Vec::with_capacity(length);
        for row in 0..length {
            let Ok(line) = get_line.call1(&active, &JsValue::from_f64(row as f64)) else {
                continue;
            };
            if line.is_null() || line.is_undefined() {
                lines.push(String::new());
                continue;
            }
            // `translateToString(true)` trims the padding a terminal pads every
            // line with, which is what makes a search match what is visible.
            let text = method(&line, "translateToString")
                .and_then(|function| function.call1(&line, &JsValue::TRUE).ok())
                .and_then(|value| value.as_string())
                .unwrap_or_default();
            lines.push(text);
        }
        lines
    }

    /// Scroll the line at buffer index `row` into view and select the match.
    pub fn reveal(&self, row: usize, column: usize, length: usize) {
        if let Some(scroll) = method(&self.terminal, "scrollToLine") {
            let _ = scroll.call1(&self.terminal, &JsValue::from_f64(row as f64));
        }
        let Some(select) = method(&self.terminal, "select") else {
            return;
        };
        // `select` works in viewport coordinates, so the row has to be converted
        // after scrolling, otherwise every match above the fold selects the
        // wrong line.
        let viewport = self
            .buffer()
            .and_then(|active| property(&active, "viewportY"))
            .unwrap_or(0.0);
        let view_row = (row as f64 - viewport).max(0.0);
        let _ = select.call3(
            &self.terminal,
            &JsValue::from_f64(column as f64),
            &JsValue::from_f64(view_row),
            &JsValue::from_f64(length as f64),
        );
    }

    /// xterm's active buffer, which holds the scrollback.
    fn buffer(&self) -> Option<JsValue> {
        let buffer = Reflect::get(&self.terminal, &JsValue::from_str("buffer")).ok()?;
        Reflect::get(&buffer, &JsValue::from_str("active")).ok()
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

/// A method on a JS object, ready to call.
fn method(target: &JsValue, name: &str) -> Option<Function> {
    Reflect::get(target, &JsValue::from_str(name))
        .ok()
        .and_then(|value| value.dyn_into::<Function>().ok())
}

/// A numeric property of a JS object.
fn property(target: &JsValue, name: &str) -> Option<f64> {
    Reflect::get(target, &JsValue::from_str(name)).ok()?.as_f64()
}

/// Construct one of the vendored xterm addons, or `None` when it is not on the
/// page. Both publish themselves as `<Name>.<Name>`, so the global is a namespace
/// object holding the class.
fn addon(name: &str) -> Option<JsValue> {
    let window = web_sys::window()?;
    let namespace = Reflect::get(window.as_ref(), &JsValue::from_str(name)).ok()?;
    let class = Reflect::get(&namespace, &JsValue::from_str(name)).ok()?;
    let class = class.dyn_into::<Function>().ok()?;
    Reflect::construct(&class, &Array::new()).ok()
}

/// The terminal's appearance.
///
/// Black and amber, like the trading terminals this kind of tool grew up beside,
/// with enough contrast for a monospace report to be read for a long time.
fn options(font: u32, screen_reader: bool) -> JsValue {
    let options = Object::new();
    set(&options, "cursorBlink", JsValue::TRUE);
    set(&options, "cursorStyle", JsValue::from_str("block"));
    set(&options, "fontSize", JsValue::from_f64(f64::from(font)));
    set(&options, "screenReaderMode", JsValue::from_bool(screen_reader));
    set(
        &options,
        "fontFamily",
        JsValue::from_str(
            "ui-monospace, SFMono-Regular, Menlo, Consolas, \"DejaVu Sans Mono\", monospace",
        ),
    );
    // Generous, because this is where a long report goes to be read: a terminal
    // that keeps only the last few screens cannot be searched for what scrolled
    // past. The output cap in `terminal::MAX_OUTPUT_BYTES` is what bounds it.
    set(&options, "scrollback", JsValue::from_f64(50_000.0));
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
