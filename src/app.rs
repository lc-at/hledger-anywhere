//! The terminal application (wasm-only).
//!
//! One screen, one input line, one engine. Everything the user types is either
//! one of four words the app owns or a command line for hledger, and the only
//! state is what is on disk in the browser cache and what is being typed.
//!
//! Two structural notes, because both are load-bearing:
//!
//! * **The picker opens synchronously, inside the key handler.** A file dialog
//!   opened after an `await` is refused by the browser *silently* — no error, no
//!   dialog, a promise that never settles — so `upload` calls
//!   [`upload::open_picker`] before anything is spawned. See that module.
//! * **Input typed while a command runs is buffered, not dropped.** The engine
//!   runs one command at a time and cannot be interrupted, so the honest thing is
//!   to keep what was typed and replay it when the engine is free.

use std::cell::{Cell, RefCell};
use std::rc::Rc;

use wasm_bindgen::JsCast;
use wasm_bindgen_futures::spawn_local;
use web_sys::HtmlElement;

use crate::hledger::{self, EngineError, HledgerOutput, HledgerRequest, JournalFile};
use crate::journal;
use crate::store::{Session, Store};
use crate::terminal::{self, Command, Completion, Editor};
use crate::terminal::view::Screen;
use crate::upload::{self, Picked};

/// What the user sees before the line.
const PROMPT: &str = "$ ";

/// Id of the element the terminal is mounted into.
const TERMINAL_ID: &str = "terminal";

/// `localStorage` key for the command history, versioned like the store's keys.
const HISTORY_KEY: &str = "hledger-anywhere.terminal.history.v1";

/// How many history entries are kept.
const MAX_HISTORY: usize = 100;

/// Start the app. Called once, from `main`.
pub fn start() {
    let Some(element) = terminal_element() else {
        return;
    };
    let screen = match Screen::mount(&element) {
        Ok(screen) => Rc::new(screen),
        Err(error) => {
            // Nothing to print to, so this is the one place a console message is
            // the whole story: xterm.js is missing from the page.
            web_sys::console::error_1(&format!("hledger-anywhere: {error}").into());
            return;
        }
    };

    let app = Rc::new(App::new(screen));
    app.screen
        .write(&terminal::to_terminal_text(&terminal::welcome(crate::hledger_info::version())));

    let input = Rc::clone(&app);
    app.screen.on_data(move |data| input.on_input(data));

    app.resize_handler();

    let booting = Rc::clone(&app);
    spawn_local(async move { boot(booting).await });
}

/// The element the terminal lives in, from `index.html`.
fn terminal_element() -> Option<HtmlElement> {
    let document = web_sys::window()?.document()?;
    document
        .get_element_by_id(TERMINAL_ID)?
        .dyn_into::<HtmlElement>()
        .ok()
}

/// Everything the app owns.
struct App {
    screen: Rc<Screen>,
    editor: RefCell<Editor>,
    /// The uploaded files, mounted under `/data` for every run.
    files: RefCell<Vec<JournalFile>>,
    /// The uploaded path of the journal hledger reads, if one is chosen.
    main: RefCell<Option<String>>,
    store: RefCell<Option<Rc<Store>>>,
    /// True while the engine is running: it cannot be interrupted, and it cannot
    /// run twice at once.
    busy: Cell<bool>,
    /// Input typed while busy, replayed when the engine is free.
    pending: RefCell<String>,
    /// Kept alive for the lifetime of the app.
    _resize: RefCell<Option<wasm_bindgen::closure::Closure<dyn FnMut()>>>,
}

impl App {
    fn new(screen: Rc<Screen>) -> App {
        App {
            screen,
            editor: RefCell::new(Editor::with_history(load_history())),
            files: RefCell::new(Vec::new()),
            main: RefCell::new(None),
            store: RefCell::new(None),
            busy: Cell::new(false),
            pending: RefCell::new(String::new()),
            _resize: RefCell::new(None),
        }
    }

    // -- printing -----------------------------------------------------------

    /// Redraw the prompt line, with the cursor where it belongs.
    fn prompt(&self) {
        let editor = self.editor.borrow();
        self.screen
            .write(&terminal::prompt_redraw(PROMPT, &editor.line(), editor.cursor()));
    }

    /// Print text above the prompt line, then put the prompt back.
    ///
    /// Everything the app prints for itself goes through here, because the prompt
    /// line is live: without clearing it first, a message would be appended to
    /// what the user is typing.
    fn announce(&self, text: &str) {
        self.screen.write("\r\u{1b}[K");
        self.screen.write(&terminal::to_terminal_text(text));
        if !text.ends_with('\n') {
            self.screen.write("\r\n");
        }
        if !self.busy.get() {
            self.prompt();
        }
    }

    /// Print a block of engine output, in `style` when given.
    fn block(&self, text: &str, style: Option<&str>) {
        let text = terminal::to_terminal_text(text);
        if let Some(style) = style {
            self.screen.write(style);
        }
        self.screen.write(&text);
        if !text.ends_with("\r\n") {
            self.screen.write("\r\n");
        }
        if style.is_some() {
            self.screen.write("\u{1b}[0m");
        }
    }

    /// Keep the terminal sized to the window.
    fn resize_handler(&self) {
        let screen = Rc::clone(&self.screen);
        let closure = wasm_bindgen::closure::Closure::<dyn FnMut()>::new(move || screen.fit());
        if let Some(window) = web_sys::window() {
            let _ = window
                .add_event_listener_with_callback("resize", closure.as_ref().unchecked_ref());
        }
        *self._resize.borrow_mut() = Some(closure);
    }

    // -- input --------------------------------------------------------------

    fn on_input(self: &Rc<App>, data: &str) {
        if self.busy.get() {
            // Nothing typed is lost, and a queued Enter runs when the engine frees
            // up. The engine is synchronous inside its worker, so there is no way
            // to cancel what is already running.
            self.pending.borrow_mut().push_str(data);
            return;
        }
        self.handle(data);
    }

    fn handle(self: &Rc<App>, data: &str) {
        match data {
            "\r" => self.submit(),
            "\u{7f}" | "\u{8}" => {
                self.editor.borrow_mut().backspace();
                self.prompt();
            }
            "\u{1b}[A" => {
                self.editor.borrow_mut().history_prev();
                self.prompt();
            }
            "\u{1b}[B" => {
                self.editor.borrow_mut().history_next();
                self.prompt();
            }
            "\u{1b}[C" => {
                self.editor.borrow_mut().right();
                self.prompt();
            }
            "\u{1b}[D" => {
                self.editor.borrow_mut().left();
                self.prompt();
            }
            "\u{1b}[H" | "\u{1b}[1~" => {
                self.editor.borrow_mut().home();
                self.prompt();
            }
            "\u{1b}[F" | "\u{1b}[4~" => {
                self.editor.borrow_mut().end();
                self.prompt();
            }
            "\u{1b}[3~" => {
                self.editor.borrow_mut().delete();
                self.prompt();
            }
            "\t" => self.complete(),
            // Ctrl+C clears the line, as in a shell. It cannot stop the engine.
            "\u{3}" => {
                self.screen.write("^C\r\n");
                self.editor.borrow_mut().clear_line();
                self.prompt();
            }
            // Ctrl+U kills the line; Ctrl+L clears the screen.
            "\u{15}" => {
                self.editor.borrow_mut().clear_line();
                self.prompt();
            }
            "\u{c}" => {
                self.screen.clear();
                self.prompt();
            }
            // Anything else is typing, including a paste. Control characters
            // inside a chunk are dropped by the editor, so a pasted multi-line
            // command becomes one line rather than running several.
            typed => {
                self.editor.borrow_mut().insert(typed);
                self.prompt();
            }
        }
    }

    fn complete(&self) {
        let paths = self.paths();
        let candidates = terminal::candidates(&paths);
        let outcome = self.editor.borrow_mut().complete(&candidates);
        match outcome {
            Completion::Ambiguous(options) => self.announce(&options.join("  ")),
            _ => self.prompt(),
        }
    }

    /// The uploaded paths, in upload order.
    fn paths(&self) -> Vec<String> {
        self.files.borrow().iter().map(|file| file.path.clone()).collect()
    }

    fn submit(self: &Rc<App>) {
        let Some(line) = self.editor.borrow_mut().take() else {
            // A blank line: a shell prints another prompt and nothing else.
            self.prompt();
            return;
        };
        save_history(self.editor.borrow().history());

        // The command is already on screen: the prompt redraw printed what was
        // typed, character by character. A shell does not echo it again, and
        // echoing it here showed every command twice.
        self.screen.write("\r\n");

        match terminal::classify(&line) {
            Command::Clear => {
                self.screen.clear();
                self.prompt();
            }
            Command::Help => {
                let help = format!("{}\n{}\n", terminal::help(), crate::hledger_info::describe());
                self.announce(&help);
            }
            Command::Upload => self.upload(),
            Command::Journal(None) => {
                let text = terminal::file_list(&self.paths(), self.main.borrow().as_deref());
                self.announce(&text);
            }
            Command::Journal(Some(path)) => self.set_journal(path),
            Command::Hledger(command) => self.run(command),
        }
    }

    // -- commands -----------------------------------------------------------

    fn upload(self: &Rc<App>) {
        // Synchronously: see the module comment. Everything after this point can
        // be async because the dialog is already open.
        let pending = match upload::open_picker() {
            Ok(pending) => pending,
            Err(error) => {
                self.announce(&error.message());
                return;
            }
        };
        let app = Rc::clone(self);
        spawn_local(async move {
            match pending.await_selection().await {
                Ok(picked) => app.accept_upload(picked),
                Err(error) => app.announce(&error.message()),
            }
        });
    }

    fn accept_upload(self: &Rc<App>, picked: Picked) {
        let text = terminal::uploaded(
            &picked.files.iter().map(|file| file.path.clone()).collect::<Vec<_>>(),
            &picked.skipped,
            journal::choose_main(&picked.files).as_deref(),
        );
        // What is uploaded is what is loaded: a second upload replaces the first
        // rather than accumulating, so `journal` and `?` can describe the state in
        // one sentence.
        *self.files.borrow_mut() = picked.files;
        *self.main.borrow_mut() = journal::choose_main(&self.files.borrow());

        self.remember();
        self.configure();
        self.announce(&text);
    }

    fn set_journal(self: &Rc<App>, path: &str) {
        let files = self.files.borrow();
        let Some(file) = files.iter().find(|file| file.path == path) else {
            drop(files);
            let text = terminal::file_list(&self.paths(), self.main.borrow().as_deref());
            self.announce(&format!("No uploaded file is called `{path}`.\n{text}"));
            return;
        };
        let path = file.path.clone();
        drop(files);

        *self.main.borrow_mut() = Some(path.clone());
        self.remember();
        self.configure();
        self.announce(&format!(
            "Now reading `{path}`. Try `hledger balance`."
        ));
    }

    /// Point the engine at the current journal.
    ///
    /// This is what makes a bare `hledger balance` work: hledger reads
    /// `$LEDGER_FILE` when no `-f` is given.
    fn configure(self: &Rc<App>) {
        let ledger_file = self
            .main
            .borrow()
            .as_deref()
            .map(hledger::mounted_path);
        spawn_local(async move {
            // A failure here only means the engine is unreachable, which the next
            // command will report in full.
            let _ = hledger::configure(ledger_file.as_deref()).await;
        });
    }

    fn run(self: &Rc<App>, command: &str) {
        let argv = argv_for(command);
        let files = self.files.borrow().clone();
        self.busy.set(true);

        let app = Rc::clone(self);
        spawn_local(async move {
            let result = hledger::run(HledgerRequest::new(argv, files)).await;
            app.finish(result);
        });
    }

    fn finish(self: &Rc<App>, result: Result<HledgerOutput, EngineError>) {
        match result {
            Ok(output) => {
                let (visible, note) = terminal::visible_output(&output.stdout);
                if !visible.trim().is_empty() {
                    self.block(&visible, None);
                }
                if !output.stderr.trim().is_empty() {
                    self.block(&output.stderr, Some("\u{1b}[31m"));
                }
                if let Some(note) = note {
                    self.block(&note, Some("\u{1b}[2m"));
                }
                if output.is_failure() {
                    let status = format!(
                        "[exit {} · {:.1} s]",
                        output.exit_code,
                        output.ms / 1000.0
                    );
                    self.block(&status, Some("\u{1b}[2;31m"));
                }
            }
            Err(error) => self.block(&error.to_string(), Some("\u{1b}[31m")),
        }

        self.busy.set(false);
        let pending = std::mem::take(&mut *self.pending.borrow_mut());
        if pending.is_empty() {
            self.prompt();
        } else {
            // Replay what was typed while the engine ran, which may itself end in
            // an Enter.
            self.handle(&pending);
        }
    }

    // -- persistence --------------------------------------------------------

    /// Write the uploaded files and the chosen journal to the browser cache.
    fn remember(self: &Rc<App>) {
        let Some(store) = self.store.borrow().clone() else {
            return;
        };
        let files = self.files.borrow().clone();
        let session = Session {
            main_journal: self.main.borrow().clone(),
        };
        spawn_local(async move {
            // A cache that cannot be written is a lost convenience, never an
            // error the user has to deal with.
            let _ = store.save_files(&files).await;
            let _ = store.save_session(&session).await;
        });
    }
}

/// What the app does before the first prompt.
async fn boot(app: Rc<App>) {
    match Store::open().await {
        Ok(store) => {
            let files = store.load_files().await.unwrap_or_default();
            let session = store.load_session().await.unwrap_or_default();
            *app.store.borrow_mut() = Some(Rc::new(store));

            if !files.is_empty() {
                // Prefer what was being read last time, if it is still there;
                // otherwise choose again, in case the upload changed.
                let main = session
                    .main_journal
                    .filter(|path| files.iter().any(|file| &file.path == path))
                    .or_else(|| journal::choose_main(&files));
                *app.main.borrow_mut() = main.clone();
                *app.files.borrow_mut() = files;
                app.configure();
                match main {
                    Some(main) => app.announce(&terminal::resumed(app.files.borrow().len(), &main)),
                    None => app.announce(
                        "Resumed your upload, but none of it looks like a journal \
                         (.journal, .hledger or .j).",
                    ),
                }
            }
        }
        Err(_) => {
            // No cache: this is simply a first visit, every time.
            app.announce(
                "This browser will not let the app remember your upload \
                 (private mode, or storage disabled).",
            );
        }
    }

    // Compile the engine now, so the first real command is not the thing waiting
    // for the download.
    if let Err(error) = hledger::init().await {
        app.announce(&error.to_string());
    }
    app.prompt();
}

/// The command line to hand the engine.
///
/// The user's words, with a leading `hledger` accepted and dropped — that is how
/// the command looks in a shell, and people paste commands. Nothing else is added:
/// the journal comes from `$LEDGER_FILE`, so what runs is what was typed.
fn argv_for(command: &str) -> Vec<String> {
    let mut parts: Vec<String> = command.split_whitespace().map(str::to_string).collect();
    if parts
        .first()
        .is_some_and(|first| first == "hledger" || first == "hledger-wasm")
    {
        parts.remove(0);
    }
    // A bare `hledger` is a real command: it prints hledger's own usage, which is
    // a better answer than doing nothing.
    let mut argv = vec!["hledger".to_string()];
    argv.extend(parts);
    argv
}

// -- history ----------------------------------------------------------------

/// The browser's `localStorage`, or `None` when it is unavailable.
fn storage() -> Option<web_sys::Storage> {
    web_sys::window()?.local_storage().ok()?
}

fn load_history() -> Vec<String> {
    let Some(raw) = storage().and_then(|storage| storage.get_item(HISTORY_KEY).ok().flatten())
    else {
        return Vec::new();
    };
    let mut history: Vec<String> = serde_json::from_str(&raw).unwrap_or_default();
    let excess = history.len().saturating_sub(MAX_HISTORY);
    history.drain(0..excess);
    history
}

fn save_history(history: &[String]) {
    let Some(storage) = storage() else {
        return;
    };
    let start = history.len().saturating_sub(MAX_HISTORY);
    if let Ok(json) = serde_json::to_string(&history[start..]) {
        let _ = storage.set_item(HISTORY_KEY, &json);
    }
}

#[cfg(test)]
mod tests {
    use super::argv_for;

    // This module is wasm-gated, so these run under a wasm test target only and
    // are type-checked by `cargo clippy --target wasm32-unknown-unknown`.

    #[test]
    fn the_users_words_are_the_argv_apart_from_the_program_name() {
        assert_eq!(argv_for("balance --tree"), ["hledger", "balance", "--tree"]);
        assert_eq!(argv_for("hledger balance"), ["hledger", "balance"]);
        assert_eq!(argv_for("  print   date:thismonth  "), ["hledger", "print", "date:thismonth"]);
        assert_eq!(argv_for("hledger"), ["hledger"], "a bare hledger prints its usage");
    }

    #[test]
    fn a_file_flag_is_left_alone() {
        // -f still works if someone wants it; the app does not add or remove one.
        assert_eq!(
            argv_for("balance -f /data/other.journal"),
            ["hledger", "balance", "-f", "/data/other.journal"]
        );
    }
}
