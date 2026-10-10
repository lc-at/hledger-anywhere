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

use wasm_bindgen::{JsCast, JsValue};
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

/// Hand a file to the browser as a download.
///
/// The object URL is deliberately not revoked: revoking it immediately can beat
/// the browser to starting the download, and one URL per download is released
/// when the page goes away.
fn save_to_disk(file: &JournalFile) -> Result<(), String> {
    let document = web_sys::window()
        .and_then(|window| window.document())
        .ok_or("there is no document")?;

    let parts = js_sys::Array::new();
    parts.push(&JsValue::from_str(&file.contents));
    let blob = web_sys::Blob::new_with_str_sequence(&parts)
        .map_err(|_| "could not build the file")?;
    let url = web_sys::Url::create_object_url_with_blob(&blob)
        .map_err(|_| "could not build a download URL")?;

    let anchor: web_sys::HtmlAnchorElement = document
        .create_element("a")
        .map_err(|_| "could not create a link")?
        .dyn_into()
        .map_err(|_| "could not create a link")?;
    anchor.set_href(&url);
    // Only the file name: the browser's download directory is its own business,
    // and a path from the mounted filesystem would be meaningless there.
    anchor.set_download(file.path.rsplit('/').next().unwrap_or(&file.path));
    anchor.click();
    Ok(())
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
    /// The last search term, so `n` and `N` have something to repeat, and where it
    /// last matched, so they move on from there rather than sticking.
    last_search: RefCell<Option<String>>,
    last_hit: RefCell<Option<(usize, usize)>>,
    /// Files commands have written this session, for `download`.
    written: RefCell<Vec<JournalFile>>,
    /// Account names for completion: fetched once per journal, on the first Tab,
    /// because on a large journal that fetch is a whole engine run.
    accounts: RefCell<Option<Vec<String>>>,
    /// Lines the app itself put on screen: the command echoes and its own
    /// messages. The search skips them, so `/foo` finds what a command printed
    /// rather than the `/foo` you just typed or the count line that followed it.
    chatter: RefCell<Vec<String>>,
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
            last_search: RefCell::new(None),
            last_hit: RefCell::new(None),
            written: RefCell::new(Vec::new()),
            accounts: RefCell::new(None),
            chatter: RefCell::new(Vec::new()),
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
        self.remember_chatter(text);
        self.screen.write("\r\u{1b}[K");
        self.screen.write(&terminal::to_terminal_text(text));
        if !text.ends_with('\n') {
            self.screen.write("\r\n");
        }
        if !self.busy.get() {
            self.prompt();
        }
    }

    /// Print what a command produced. Searchable.
    fn output(&self, text: &str, style: Option<&str>) {
        self.block(text, style);
    }

    /// Print the app's own words: not searchable, because they are not what the
    /// user asked to see.
    fn say(&self, text: &str) {
        self.remember_chatter(text);
        self.block(text, None);
    }

    /// Note every line of `text` as the app's own, for the search to skip.
    ///
    /// Rows are not tracked instead, because xterm parses writes on a later tick:
    /// a cursor position read straight after a write is stale, and a stale range
    /// silently searches the wrong lines. Comparing text cannot go stale.
    fn remember_chatter(&self, text: &str) {
        let mut chatter = self.chatter.borrow_mut();
        for line in text.lines() {
            let line = line.trim();
            if !line.is_empty() {
                chatter.push(line.to_string());
            }
        }
        // Only recent lines matter: the search is about what is on screen.
        let excess = chatter.len().saturating_sub(500);
        if excess > 0 {
            chatter.drain(0..excess);
        }
    }

    /// Print a block, in `style` when given.
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

    /// Keep the terminal sized to the window, and the engine told about it.
    ///
    /// A resized terminal means resized reports, so fitting is only half of it:
    /// the new column count has to reach hledger before the next command. The
    /// handler holds a `Weak` rather than an `Rc`, because it is stored *in* the
    /// app and a strong reference would be a cycle.
    fn resize_handler(self: &Rc<App>) {
        let screen = Rc::clone(&self.screen);
        let app = Rc::downgrade(self);
        let closure = wasm_bindgen::closure::Closure::<dyn FnMut()>::new(move || {
            screen.fit();
            if let Some(app) = app.upgrade() {
                app.configure();
            }
        });
        if let Some(window) = web_sys::window() {
            let _ = window
                .add_event_listener_with_callback("resize", closure.as_ref().unchecked_ref());
        }
        *self._resize.borrow_mut() = Some(closure);
    }

    // -- input --------------------------------------------------------------

    fn on_input(self: &Rc<App>, data: &str) {
        if self.busy.get() {
            // Ctrl+C is the one thing that must never be queued: it is what stops
            // the command that is running. Everything else typed while busy is kept
            // and replayed, because there is no way to cancel a command that has
            // not started and dropping it would lose what someone typed.
            if data.contains('\u{3}') {
                self.screen.write("^C\r\n");
                self.pending.borrow_mut().clear();
                self.cancel();
                return;
            }
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

    fn complete(self: &Rc<App>) {
        if self.accounts.borrow().is_none() && !self.files.borrow().is_empty() {
            self.announce("Reading account names for completion…");
            self.fetch_accounts();
            return;
        }

        let paths = self.paths();
        let mut candidates = terminal::candidates(&paths);
        if let Some(accounts) = self.accounts.borrow().as_ref() {
            candidates.extend(accounts.iter().cloned());
        }
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
            // An empty line is a command too, and the one a terminal is most
            // often given: it prints a fresh prompt line, as a shell does.
            // Redrawing in place would be invisible — the prompt is already there
            // — so pressing Enter appeared to do nothing.
            self.screen.write("\r\n");
            self.prompt();
            return;
        };
        save_history(self.editor.borrow().history());
        self.remember_chatter(&format!("{PROMPT}{line}"));

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
            Command::Upload => self.upload(upload::Mode::Files),
            Command::UploadDir => self.upload(upload::Mode::Directory),
            Command::Demo => self.load_demo(),
            Command::Search(term) => self.search(term.unwrap_or("")),
            Command::SearchAgain(backwards) => self.search_again(backwards),
            Command::Download(Some(path)) => self.download(path),
            Command::Download(None) => {
                let names: Vec<String> =
                    self.written.borrow().iter().map(|file| file.path.clone()).collect();
                let text = terminal::download_list(&names);
                self.announce(&text);
            }
            Command::Journal(None) => {
                let text = terminal::file_list(&self.paths(), self.main.borrow().as_deref());
                self.announce(&text);
            }
            Command::Journal(Some(path)) => self.set_journal(path),
            Command::Hledger(command) => self.run(command),
        }
    }

    // -- commands -----------------------------------------------------------

    fn upload(self: &Rc<App>, mode: upload::Mode) {
        // Synchronously: see the module comment. Everything after this point can
        // be async because the dialog is already open.
        let pending = match upload::open_picker(mode) {
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
                // Naming the command that was cancelled matters here: a directory
                // dialog and a file dialog look nothing alike, and the user should
                // not have to remember which one they asked for.
                Err(upload::PickError::Cancelled) => {
                    app.announce(&format!("{} cancelled", mode.name()))
                }
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
        // Different journal, different accounts.
        *self.accounts.borrow_mut() = None;

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

    /// Tell the engine which journal to read and how big the terminal is.
    ///
    /// The journal is what makes a bare `hledger balance` work: hledger reads
    /// `$LEDGER_FILE` when no `-f` is given. The size is what it formats reports
    /// to — hledger asks the terminal, WASI cannot answer, and the wasm build's
    /// terminal-size stub reads `$COLUMNS`/`$LINES` instead, so the size has to be
    /// in the environment before every run. Called at startup, after an upload,
    /// and on every resize.
    fn configure(self: &Rc<App>) {
        let ledger_file = self.main.borrow().as_deref().map(hledger::mounted_path);
        let (columns, lines) = self.screen.size();
        spawn_local(async move {
            // A failure here only means the engine is unreachable, which the next
            // command will report in full.
            let _ = hledger::configure(ledger_file.as_deref(), Some(columns), Some(lines)).await;
        });
    }

    /// Stop the running command by throwing the engine's worker away.
    ///
    /// The worker is replaced on the next run, so the environment has to be given
    /// to it again — a new worker knows nothing about the journal or the terminal
    /// size.
    fn cancel(self: &Rc<App>) {
        let app = Rc::clone(self);
        spawn_local(async move {
            let _ = hledger::cancel().await;
            app.configure();
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
                    self.output(&visible, None);
                }
                if !output.stderr.trim().is_empty() {
                    self.output(&output.stderr, Some("\u{1b}[31m"));
                }
                if let Some(note) = note {
                    self.say(&note);
                }
                if !output.written.is_empty() {
                    let sizes: Vec<(String, usize)> = output
                        .written
                        .iter()
                        .map(|file| (file.path.clone(), file.contents.len()))
                        .collect();
                    self.say(&terminal::wrote_note(&sizes));
                    // Kept for `download`, which may be typed long after the run;
                    // a later run that writes the same path replaces it.
                    let mut written = self.written.borrow_mut();
                    for file in &output.written {
                        written.retain(|kept| kept.path != file.path);
                        written.push(file.clone());
                    }
                }
                if output.is_failure() {
                    let status = format!(
                        "[exit {} · {:.1} s]",
                        output.exit_code,
                        output.ms / 1000.0
                    );
                    // The terminal's own exit status, but still the app talking.
                    self.block(&status, Some("\u{1b}[2;31m"));
                    self.remember_chatter(&status);
                }
            }
            // Stopping a command is not a failure: the terminal already printed
            // the ^C, and an error message would read as though something broke.
            Err(EngineError::Cancelled) => self.say("[cancelled]"),
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

    /// Load the built-in sample journal.
    ///
    /// The app is only useful with a journal, and a first-time visitor has not
    /// got one here yet: `demo` is the difference between "upload something" and
    /// seeing a report.
    fn load_demo(self: &Rc<App>) {
        *self.files.borrow_mut() = vec![
            JournalFile::new("hledger.journal", terminal::DEMO_JOURNAL),
            JournalFile::new("demo-prices.journal", terminal::DEMO_PRICES),
        ];
        *self.main.borrow_mut() = journal::choose_main(&self.files.borrow());
        *self.accounts.borrow_mut() = None;

        self.remember();
        self.configure();
        let text = match self.main.borrow().as_deref() {
            Some(main) => terminal::demo_loaded(self.files.borrow().len(), main),
            None => "The demo journal could not be selected.".to_string(),
        };
        self.announce(&text);
    }

    /// `/text`: search the output, or repeat the last search when blank.
    fn search(self: &Rc<App>, term: &str) {
        let term = if term.trim().is_empty() {
            match self.last_search.borrow().clone() {
                Some(previous) => previous,
                None => {
                    self.announce("Nothing to repeat yet — `/text` searches the output.");
                    return;
                }
            }
        } else {
            term.trim().to_string()
        };
        *self.last_search.borrow_mut() = Some(term.clone());
        // A new term starts from the top, not from wherever the last one was.
        *self.last_hit.borrow_mut() = None;
        self.find(&term, false);
    }

    /// `n` and `N`: repeat the last search, forwards or backwards.
    fn search_again(self: &Rc<App>, backwards: bool) {
        let Some(term) = self.last_search.borrow().clone() else {
            self.announce("Nothing to repeat yet — `/text` searches the output.");
            return;
        };
        self.find(&term, backwards);
    }

    /// Search the scrollback, and say which match it landed on.
    ///
    /// The count is the reason this is not left to an addon: "3 of 17" is what
    /// tells a reader whether they are looking at the thing they meant, and
    /// whether pressing `n` is worth it.
    fn find(&self, term: &str, backwards: bool) {
        // Everything on screen except the app's own lines.
        let chatter = self.chatter.borrow().clone();
        let output: Vec<(usize, String)> = self
            .screen
            .lines()
            .into_iter()
            .enumerate()
            .filter(|(_, line)| {
                let line = line.trim();
                !line.is_empty() && !chatter.iter().any(|said| said == line)
            })
            .collect();
        if output.is_empty() {
            self.announce("There is no output to search yet.");
            return;
        }
        let from = *self.last_hit.borrow();
        match terminal::search_lines(&output, term, from, backwards) {
            Some(hit) => {
                self.screen.reveal(hit.row, hit.column, hit.length);
                *self.last_hit.borrow_mut() = Some((hit.row, hit.column));
                // Deliberately without repeating the term: the status line is on
                // screen, and a line containing the term would be found by the
                // next search for it.
                self.announce(&format!(
                    "match {} of {} · {term}",
                    hit.index, hit.total
                ));
            }
            None => self.announce(&format!("No match for `{term}`.")),
        }
    }

    /// `download <path>`: save a file a command wrote with `-o`.
    fn download(self: &Rc<App>, path: &str) {
        let found = self
            .written
            .borrow()
            .iter()
            .find(|file| file.path == path)
            .cloned();
        let Some(file) = found else {
            let names: Vec<String> =
                self.written.borrow().iter().map(|file| file.path.clone()).collect();
            let text = terminal::download_list(&names);
            self.announce(&format!("Nothing called `{path}` was written.\n{text}"));
            return;
        };
        match save_to_disk(&file) {
            Ok(()) => self.announce(&format!(
                "Saving `{}` ({} bytes) — check your downloads.",
                file.path,
                file.contents.len()
            )),
            Err(reason) => self.announce(&format!("Could not save `{}`: {reason}", file.path)),
        }
    }

    /// Ask the engine for the account names, once, so Tab can complete them.
    ///
    /// On a large journal this is a whole run — several seconds — so it happens
    /// when someone first presses Tab rather than at startup, and it says so.
    fn fetch_accounts(self: &Rc<App>) {
        let files = self.files.borrow().clone();
        self.busy.set(true);
        let app = Rc::clone(self);
        spawn_local(async move {
            let request =
                HledgerRequest::new(vec!["hledger".to_string(), "accounts".to_string()], files);
            let outcome = hledger::run(request).await;
            app.busy.set(false);
            match outcome {
                Ok(output) if !output.is_failure() => {
                    let names: Vec<String> = output
                        .stdout
                        .lines()
                        .map(str::trim)
                        .filter(|line| !line.is_empty())
                        .map(str::to_string)
                        .collect();
                    let count = names.len();
                    *app.accounts.borrow_mut() = Some(names);
                    app.announce(&format!("{count} account names ready — press Tab again."));
                }
                Ok(output) => app.announce(&output.failure_message()),
                Err(error) => app.announce(&error.to_string()),
            }
        });
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
