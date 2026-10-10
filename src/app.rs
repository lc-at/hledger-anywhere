//! The terminal application (wasm-only).
//!
//! One screen, one input line, one engine. Everything the user types is either
//! one of four words the app owns or a command line for hledger, and the only
//! state is what is on disk in the browser cache and what is being typed.
//!
//! Two structural notes, because both are load-bearing:
//!
//! * **The picker opens synchronously, inside the key handler.** A file dialog
//!   opened after an `await` is refused by the browser *silently*, no error, no
//!   dialog, a promise that never settles, so `upload` calls
//!   [`upload::open_picker`] before anything is spawned. See that module.
//! * **Input typed while a command runs is buffered, not dropped.** The engine
//!   runs one command at a time and cannot be interrupted, so the honest thing is
//!   to keep what was typed and replay it when the engine is free.

use std::cell::{Cell, RefCell};
use std::rc::Rc;

use js_sys::Reflect;
use wasm_bindgen::{JsCast, JsValue};
use wasm_bindgen_futures::spawn_local;
use web_sys::HtmlElement;

use crate::hledger::{self, EngineError, HledgerOutput, HledgerRequest, JournalFile};
use crate::plugins;
use crate::journal;
use crate::remote;
use crate::store::{Session, Store};
use crate::terminal::{self, Command, Completion, Editor};
use crate::terminal::view::Screen;
use crate::upload::{self, Picked};

/// The prompt while journal text is being typed, as a shell continues a line.
fn block_prompt() -> String {
    format!("{} {} ", terminal::dim("..."), terminal::accent("»"))
}

/// `localStorage` key for the terminal font size.
const FONT_KEY: &str = "hledger-anywhere.terminal.font.v1";

/// `localStorage` key for the command aliases.
const ALIAS_KEY: &str = "hledger-anywhere.terminal.aliases.v1";

/// `localStorage` key marking that a `connect` is waiting to come back.
///
/// The library claims the access token from the URL fragment when it starts, and it
/// only starts when a remote command runs, which is too late: the fragment is gone
/// by then and the connection with it. This flag says "someone is expected back", so
/// the next page load starts the library immediately.
const REMOTE_PENDING_KEY: &str = "hledger-anywhere.remote.pending.v1";

/// `localStorage` key for the screen reader preference.
const SCREEN_READER_KEY: &str = "hledger-anywhere.terminal.screenreader.v1";

/// A block of journal text being typed into a file.
///
/// The line editor holds one line, and a journal entry is several, so this is the
/// mode that collects them: `append <file>`, then lines, then `.` alone.
struct Block {
    /// The file as the app knows it.
    path: String,
    /// The file as the user wrote it, for the note.
    target: String,
    lines: Vec<String>,
}

/// An event listener the app keeps alive for as long as it runs.
///
/// A `Closure` dropped by its creator stops firing, so a listener that outlives
/// the call registering it has to be stored somewhere.
type Listener<T> = RefCell<Option<wasm_bindgen::closure::Closure<T>>>;

/// A Ctrl+R search in progress.
///
/// Held apart from the editor because it is a mode: while it is on, keys narrow
/// the query instead of editing the line, which is the whole point of an
/// incremental search, you keep typing until the line you want appears.
struct ISearch {
    query: String,
    /// Index in the history of the match being shown, for the next Ctrl+R.
    index: Option<usize>,
    /// The most recent query that found nothing, so the prompt can say so.
    failed: bool,
    /// The line as it was before Ctrl+R, restored when the search is cancelled.
    saved: String,
}

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
    let screen = match Screen::mount(&element, load_font(), load_screen_reader()) {
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
    // The font-size keys are the one thing xterm does not report through
    // `onData`, so they are caught on the element instead.
    app.font_keys(&element);
    app.drop_target();

    register_service_worker();

    app.remote_return();

    let booting = Rc::clone(&app);
    spawn_local(async move { boot(booting).await });
}

/// Save a file hledger wrote into the connected account.
///
/// This is the other half of `remote`: what was read from an account can be
/// written back to it, under the same category and at the same relative path, so
/// an exported report lands beside the journal it came from.
async fn write_remote(
    file: &JournalFile,
) -> Result<String, remote::client::RemoteError> {
    let account = remote::client::Account::open().await?;
    let path = remote::remote_path(&file.path);
    account.write(&path, &file.contents).await?;
    Ok(match account.user_address() {
        Some(address) => format!("{path} in {address}"),
        None => path,
    })
}

/// Walk a remoteStorage directory and read every file in it.
///
/// Breadth-first over the folders `getListing` reports, with a visited set: the
/// library is not consulted about loops, and one bad listing should not become an
/// infinite walk. The size cap is the same one an upload gets, because this is the
/// same act by a different route.
async fn read_remote(
    directory: &str,
) -> Result<(upload::Picked, Option<String>), remote::client::RemoteError> {
    let account = remote::client::Account::open().await?;
    let address = account.user_address();
    let mut picked = upload::Picked::default();
    let mut queue = vec![directory.to_string()];
    let mut visited: Vec<String> = Vec::new();
    let mut bytes = 0usize;
    let mut skipped: Vec<String> = Vec::new();

    while let Some(here) = queue.pop() {
        if visited.contains(&here) {
            continue;
        }
        visited.push(here.clone());

        let entries = account.list(&here).await?;
        // Only folders directly inside this one are worth listing next: a listing
        // that reached further would otherwise be walked twice.
        queue.extend(remote::subdirectories(&entries, &here));

        for entry in entries.iter().filter(|entry| !entry.is_dir) {
            let Some(path) = remote::mount_path(&entry.path) else {
                continue;
            };
            if picked.files.iter().any(|file| file.path == path) {
                continue;
            }
            // One file that cannot be read is not a reason to abandon the journal
            // next to it: an account may hold anything, and the point of `remote`
            // is the journals in it.
            let contents = match account.read(&entry.path).await {
                Ok(contents) => contents,
                Err(error) => {
                    skipped.push(format!("{} ({})", path, error.message()));
                    continue;
                }
            };
            bytes += contents.len();
            if bytes > MAX_REMOTE_BYTES {
                return Err(remote::client::RemoteError::Failed(format!(
                    "that is more than {} MB of journal. {} loads a smaller part.",
                    MAX_REMOTE_BYTES / (1024 * 1024),
                    terminal::bold("remote <folder>")
                )));
            }
            picked.files.push(JournalFile::new(path, contents));
        }
    }

    picked.files.sort_by(|left, right| left.path.cmp(&right.path));
    if !skipped.is_empty() {
        picked.skipped.extend(
            skipped
                .into_iter()
                .map(|entry| (entry, "could not be read".to_string())),
        );
    }
    Ok((picked, address))
}

/// How much may be read from an account in one go, matching the upload limit.
const MAX_REMOTE_BYTES: usize = 50 * 1024 * 1024;

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

/// Offer the app to the browser as something that works offline.
///
/// Every failure is silent and expected: a service worker needs a secure context,
/// and the development server on a LAN address is not one. The app works exactly
/// the same without it, just with a network in the way.
fn register_service_worker() {
    let Some(window) = web_sys::window() else {
        return;
    };
    // Asking on an insecure origin is not an error worth logging: the browser
    // would refuse, and the development server is exactly that case.
    if !window.is_secure_context() {
        return;
    }
    let Ok(navigator) = Reflect::get(window.as_ref(), &JsValue::from_str("navigator")) else {
        return;
    };
    let Ok(container) = Reflect::get(&navigator, &JsValue::from_str("serviceWorker")) else {
        return;
    };
    if container.is_undefined() || container.is_null() {
        return;
    }
    let Some(register) = Reflect::get(&container, &JsValue::from_str("register"))
        .ok()
        .and_then(|value| value.dyn_into::<js_sys::Function>().ok())
    else {
        return;
    };
    let _ = register.call1(
        &container,
        &JsValue::from_str(&crate::hledger_info::service_worker_url()),
    );
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
    /// The Ctrl+R search in progress, if any.
    isearch: RefCell<Option<ISearch>>,
    /// The block of typed journal text in progress, if any.
    block: RefCell<Option<Block>>,
    /// Whether the connection coming back has already been reported.
    remote_reported: Cell<bool>,
    /// The terminal font size, in pixels, kept between visits.
    font: Cell<u32>,
    /// Whether the terminal's accessibility tree is on, kept between visits.
    screen_reader: Cell<bool>,
    /// Command aliases, in the order they were defined.
    aliases: RefCell<Vec<(String, String)>>,
    /// The drop handler, kept alive. One listener serves all three drag events.
    _drop: Listener<dyn FnMut(web_sys::DragEvent)>,
    /// Kept alive for the lifetime of the app: the font-size keys, which xterm
    /// sends nothing for and so cannot be seen through `onData`.
    _keys: Listener<dyn FnMut(web_sys::KeyboardEvent)>,
    /// Kept alive for the lifetime of the app.
    _resize: Listener<dyn FnMut()>,
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
            isearch: RefCell::new(None),
            block: RefCell::new(None),
            remote_reported: Cell::new(false),
            font: Cell::new(load_font()),
            screen_reader: Cell::new(load_screen_reader()),
            aliases: RefCell::new(load_aliases()),
            _keys: RefCell::new(None),
            _resize: RefCell::new(None),
            _drop: RefCell::new(None),
        }
    }

    // -- printing -----------------------------------------------------------

    /// Redraw the prompt line, with the cursor where it belongs.
    ///
    /// While Ctrl+R is running the prompt is readline's, and the line is the
    /// match it found, so the two are drawn exactly as the editor's are.
    fn prompt(&self) {
        let editor = self.editor.borrow();
        let prompt = match self.isearch.borrow().as_ref() {
            Some(search) => terminal::isearch_prompt(&search.query, search.failed),
            None if self.block.borrow().is_some() => block_prompt(),
            None => self.prompt_text(),
        };
        self.screen
            .write(&terminal::prompt_redraw(&prompt, &editor.line(), editor.cursor()));
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

    /// What the prompt says right now: the journal being read, then `$ `.
    ///
    /// Used for drawing *and* for noting the command echo as the app's own line, so
    /// the two can never disagree, a mismatch there would leave the echo
    /// searchable and the match count would climb.
    fn prompt_text(&self) -> String {
        terminal::prompt_for(self.main.borrow().as_deref())
    }

    /// Keep the font-size keys. xterm sends nothing for Ctrl+=, Ctrl+- or Ctrl+0,
    /// so they never reach `onData`; a key listener on the terminal's element is
    /// the only place to see them.
    fn font_keys(self: &Rc<App>, element: &HtmlElement) {
        let app = Rc::clone(self);
        let closure = wasm_bindgen::closure::Closure::<dyn FnMut(web_sys::KeyboardEvent)>::new(
            move |event: web_sys::KeyboardEvent| {
                if !event.ctrl_key() || event.alt_key() || event.meta_key() {
                    return;
                }
                let direction = match event.key().as_str() {
                    "=" | "+" => 1,
                    "-" | "_" => -1,
                    "0" => 0,
                    _ => return,
                };
                event.prevent_default();
                app.rescale(direction);
            },
        );
        let _ = element.add_event_listener_with_callback(
            "keydown",
            closure.as_ref().unchecked_ref(),
        );
        *self._keys.borrow_mut() = Some(closure);
    }

    /// One step bigger, one smaller, or back to the default.
    fn rescale(self: &Rc<App>, direction: i32) {
        let next = if direction == 0 {
            terminal::DEFAULT_FONT
        } else {
            terminal::step_font(self.font.get(), direction)
        };
        self.set_font_size(next);
    }

    /// `append <file>`: start collecting typed journal text.
    fn start_block(self: &Rc<App>, target: &str) {
        match terminal::append_target(target) {
            Ok(path) => {
                *self.block.borrow_mut() = Some(Block {
                    path,
                    target: target.to_string(),
                    lines: Vec::new(),
                });
                self.announce(&terminal::block_header(target));
                self.prompt();
            }
            Err(complaint) => self.announce(&complaint),
        }
    }

    /// The `.`: append what was typed, as one well-formed file.
    fn finish_block(self: &Rc<App>) {
        let Some(block) = self.block.borrow_mut().take() else {
            return;
        };
        if block.lines.is_empty() {
            self.announce("Nothing was typed, so nothing was written.");
            self.prompt();
            return;
        }

        let addition = format!("{}\n", block.lines.join("\n"));
        let existing = self
            .files
            .borrow()
            .iter()
            .find(|file| file.path == block.path)
            .map(|file| file.contents.clone())
            .unwrap_or_default();
        let combined = terminal::append_text(&existing, &addition);
        let lines = block.lines.len();
        let total = combined.len();

        let file = JournalFile::new(&block.path, &combined);
        self.absorb(&[file]);
        self.say(&terminal::append_note(&block.target, lines, total));
        self.prompt();
    }

    /// Run what a plugin asked for.
    ///
    /// The plugin describes; the app carries it out. That is the whole contract, and
    /// it is why a plugin needs no access to anything here.
    fn run_plan(self: &Rc<App>, line: &str, plugin: &'static dyn plugins::Plugin) {
        let (_, arguments) = terminal::split_first_token(line);
        // The title says what was typed, not the command the plugin decided to run:
        // `running chart balance` is the user's line, `balance -O csv` is ours.
        self.title(&format!("running {}", line.trim()));
        match plugin.plan(&arguments) {
            plugins::Plan::Say(message) => self.announce(&message),
            plugins::Plan::Run { command } => self.run_drawn(&command, plugin),
        }
    }

    /// Run a command on a plugin's behalf, and let it present the output.
    fn run_drawn(
        self: &Rc<App>,
        command: &str,
        plugin: &'static dyn plugins::Plugin,
    ) {
        let argv = match argv_for(command) {
            Ok(argv) => argv,
            Err(complaint) => return self.announce(&complaint),
        };
        let command = command.to_string();
        let files = self.files.borrow().clone();
        self.busy.set(true);
        let app = Rc::clone(self);
        spawn_local(async move {
            let result = hledger::run(HledgerRequest::new(argv, files)).await;
            app.finish_drawn(&command, plugin, result);
        });
    }

    /// A run whose output is drawn rather than printed.
    fn finish_drawn(
        self: &Rc<App>,
        command: &str,
        plugin: &'static dyn plugins::Plugin,
        result: Result<HledgerOutput, EngineError>,
    ) {
        match result {
            Ok(output) => {
                let (columns, rows) = self.screen.size();
                // Drawn by the plugin, from hledger's own numbers, never from the
                // app's arithmetic: a picture that disagreed with the report would be
                // worse than no picture.
                let presented = if output.is_failure() {
                    None
                } else {
                    plugin.present(
                        &output.stdout,
                        columns as usize,
                        rows.saturating_sub(4) as usize,
                    )
                };

                let Some(lines) = presented else {
                    if output.is_failure() {
                        self.output(&output.stderr, Some(terminal::RED));
                    } else {
                        self.say(&format!(
                            "Nothing to show: {} gave nothing {} can present.",
                            terminal::bold(command),
                            terminal::bold(plugin.name())
                        ));
                    }
                    self.record_writes(&output);
                    if output.is_failure() {
                        let status = format!(
                            "[exit {} · {:.1} s]",
                            output.exit_code,
                            output.ms / 1000.0
                        );
                        self.block(&status, Some(terminal::DIM_RED));
                        self.remember_chatter(&status);
                    }
                    return self.settle();
                };

                let note = plugin.note(command);
                if !note.is_empty() {
                    self.say(&note);
                }
                self.output(&lines.join("\n"), None);

                self.record_writes(&output);

                if output.is_failure() {
                    let status = format!(
                        "[exit {} · {:.1} s]",
                        output.exit_code,
                        output.ms / 1000.0
                    );
                    self.block(&status, Some(terminal::DIM_RED));
                    self.remember_chatter(&status);
                }
            }
            Err(EngineError::Cancelled) => self.say("[cancelled]"),
            Err(error) => self.block(&error.to_string(), Some(terminal::RED)),
        }

        self.settle();
    }

    /// Keep what a run wrote, whatever the app did with its output.
    fn record_writes(self: &Rc<App>, output: &HledgerOutput) {
        let sizes = self.absorb(&output.written);
        if sizes.is_empty() {
            return;
        }
        self.say(&terminal::wrote_note(&sizes));
    }

    /// Take files into what is loaded, store them, and tell the engine.
    ///
    /// Files the engine produced are part of the filesystem, not a detour from it:
    /// they replace or join the mounted ones and are kept for the next visit, which
    /// is what makes `-o` onto a loaded file an edit rather than a report you have
    /// to catch. Takes the `Rc` because telling the engine is part of keeping a
    /// change: the write path and the read path must agree on what is loaded.
    fn absorb(self: &Rc<App>, incoming: &[JournalFile]) -> Vec<(String, usize, bool)> {
        if incoming.is_empty() {
            return Vec::new();
        }

        let mut sizes = Vec::new();
        {
            let mut files = self.files.borrow_mut();
            for file in incoming {
                let replaced = files.iter().any(|known| known.path == file.path);
                sizes.push((file.path.clone(), file.contents.len(), replaced));
                files.retain(|known| known.path != file.path);
                files.push(file.clone());
            }
            files.sort_by(|left, right| left.path.cmp(&right.path));
        }

        // A journal that arrived this way is a journal like any other.
        if self.main.borrow().is_none() {
            *self.main.borrow_mut() = journal::choose_main(&self.files.borrow());
        }
        // The account names were read from the journal just replaced.
        *self.accounts.borrow_mut() = None;

        // Kept for `download`, which may be typed long after the run; a later run
        // that writes the same path replaces it.
        {
            let mut written = self.written.borrow_mut();
            for file in incoming {
                written.retain(|kept| kept.path != file.path);
                written.push(file.clone());
            }
        }

        // Stored and re-sent, so the next command reads the new contents rather
        // than the ones it started with.
        self.remember();
        self.configure();
        sizes
    }

    /// Turn the terminal's accessibility tree on or off, and remember it.
    ///
    /// xterm can do this at runtime, so there is no reload and no lost scrollback;
    /// the setting is stored so the next visit starts the way this one ended.
    fn set_screen_reader(self: &Rc<App>, on: bool) {
        self.screen_reader.set(on);
        save_screen_reader(on);
        self.screen.set_screen_reader(on);
        self.announce(&format!(
            "The accessibility tree is now {}.{}",
            if on { "on" } else { "off" },
            if on {
                " A screen reader can now read the terminal line by line."
            } else {
                ""
            }
        ));
    }

    /// Set the font size outright, from a key or from `font <size>`.
    fn set_font_size(self: &Rc<App>, size: u32) {
        let size = size.clamp(terminal::MIN_FONT, terminal::MAX_FONT);
        if size == self.font.get() {
            return;
        }
        self.font.set(size);
        save_font(size);
        self.screen.set_font_size(size);
        // The size is part of what hledger is told, so a resize means the next
        // command formats to the new width.
        self.configure();
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
        // The record has to be the *visible* line: xterm's buffer holds no escape
        // sequences, so a record that kept them would never match the screen and the
        // app's own messages would become searchable again.
        let text = terminal::plain(text);
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
            self.screen.write(terminal::RESET);
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
        // A paste is several lines in one event, and a line editor holds one. Each
        // complete line is typed and entered in turn, exactly as if the user had
        // typed them, so a pasted journal entry works and a pasted command runs.
        if let Some(pasted) = terminal::paste(data) {
            for line in &pasted.lines {
                self.editor.borrow_mut().set_line(line);
                self.handle("\r");
            }
            self.editor.borrow_mut().set_line(&pasted.rest);
            self.prompt();
            return;
        }

        // While a reverse search is running, keys belong to it. This is what
        // makes it incremental rather than a dialog.
        if self.isearch.borrow().is_some() {
            self.isearch_input(data);
            return;
        }

        // A completion menu lasts until something else happens: Tab and Shift+Tab
        // step through it, Escape undoes it, and any other key takes what is on the
        // line and carries on.
        if !matches!(data, "\t" | "\u{1b}[Z" | "\u{1b}") {
            let _ = self.editor.borrow_mut().menu_close();
        }

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
            "\t" => self.complete_or_menu(),
            // Shift+Tab steps back through the menu, as zsh does.
            "\u{1b}[Z" => {
                if self.editor.borrow_mut().menu_previous() {
                    self.prompt();
                }
            }
            // Escape abandons the menu and puts the line back as it was typed. On
            // its own, outside a menu, it does nothing.
            "\u{1b}" => {
                if self.editor.borrow_mut().menu_cancel() {
                    self.prompt();
                }
            }
            // Emacs' line-editing keys, as readline has them. Ctrl+P and Ctrl+N
            // are history, Ctrl+A and Ctrl+E are the ends of the line, and the
            // kill ring is what makes Ctrl+K/Ctrl+U/Ctrl+W/Ctrl+Y worth having.
            "\u{1}" => {
                self.editor.borrow_mut().home();
                self.prompt();
            }
            "\u{5}" => {
                self.editor.borrow_mut().end();
                self.prompt();
            }
            "\u{2}" => {
                self.editor.borrow_mut().left();
                self.prompt();
            }
            "\u{6}" => {
                self.editor.borrow_mut().right();
                self.prompt();
            }
            "\u{4}" => {
                self.editor.borrow_mut().delete();
                self.prompt();
            }
            "\u{b}" => {
                self.editor.borrow_mut().kill_to_end();
                self.prompt();
            }
            "\u{17}" => {
                self.editor.borrow_mut().kill_word_backward();
                self.prompt();
            }
            "\u{19}" => {
                self.editor.borrow_mut().yank();
                self.prompt();
            }
            "\u{14}" => {
                self.editor.borrow_mut().transpose();
                self.prompt();
            }
            "\u{10}" => {
                self.editor.borrow_mut().history_prev();
                self.prompt();
            }
            "\u{e}" => {
                self.editor.borrow_mut().history_next();
                self.prompt();
            }
            "\u{12}" => self.start_isearch(),
            // Alt+B and Alt+F move by words, which is how Emacs users reach the
            // middle of an account path.
            "\u{1b}b" => {
                self.editor.borrow_mut().word_left();
                self.prompt();
            }
            "\u{1b}f" => {
                self.editor.borrow_mut().word_right();
                self.prompt();
            }
            // Ctrl+C clears the line, as in a shell. It cannot stop the engine.
            "\u{3}" => {
                self.screen.write("^C\r\n");
                *self.isearch.borrow_mut() = None;
                // Abandoning a block keeps nothing: half an entry is not an entry.
                if self.block.borrow_mut().take().is_some() {
                    self.announce("Nothing was written.");
                }
                self.editor.borrow_mut().clear_line();
                self.prompt();
            }
            // Ctrl+U kills back to the start, remembering it, as readline does;
            // Ctrl+L clears the screen.
            "\u{15}" => {
                self.editor.borrow_mut().kill_to_start();
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

    /// Tab: complete as far as everything agrees, then offer a menu of the rest.
    ///
    /// The first Tab does what a shell does. One match completes outright; several
    /// extend as far as they agree. When that gets nowhere there is nothing left to
    /// guess at, so the candidates are listed and the first goes on the line, and
    /// every Tab after that steps to the next one. Shift+Tab steps back, Escape puts
    /// the line back as it was typed, and anything else takes what is there.
    fn complete_or_menu(self: &Rc<App>) {
        // Tab with a menu open means "the next one", not "complete again".
        if self.editor.borrow_mut().menu_next() {
            self.prompt();
            return;
        }

        if self.accounts.borrow().is_none() && !self.files.borrow().is_empty() {
            self.say(&terminal::dim(
                "Reading account names, which takes a moment. Press Tab again shortly.",
            ));
            self.title("reading account names");
            self.fetch_accounts();
            return;
        }

        let paths = self.paths();
        let mut candidates = terminal::candidates(&paths);
        if let Some(accounts) = self.accounts.borrow().as_ref() {
            candidates.extend(accounts.iter().cloned());
        }
        candidates.extend(self.aliases.borrow().iter().map(|(name, _)| name.clone()));
        for plugin in plugins::bundled() {
            candidates.push(plugin.name().to_string());
            candidates.extend(plugin.completes().iter().map(|word| (*word).to_string()));
        }

        if let Completion::Ambiguous(options) = self.editor.borrow_mut().complete(&candidates) {
            // The prompt is already on the line, so it is cleared first: the list
            // belongs above it, not appended to the command being typed. It is
            // printed once; stepping through afterwards changes the line only.
            self.screen.write("\r\u{1b}[K");
            let (columns, _) = self.screen.size();
            for line in terminal::format_columns(&options, columns as usize) {
                self.remember_chatter(&line);
                self.block(&line, Some(terminal::DIM));
            }
        }
        self.prompt();
    }

    /// The uploaded paths, in upload order.
    fn paths(&self) -> Vec<String> {
        self.files.borrow().iter().map(|file| file.path.clone()).collect()
    }

    fn submit(self: &Rc<App>) {
        let taken = self.editor.borrow_mut().take();

        // While journal text is being typed every line is content, not a command,
        // and a blank one is content too: blank lines separate entries.
        if self.block.borrow().is_some() {
            let line = taken.unwrap_or_default();
            self.remember_chatter(&format!("{}{line}", block_prompt()));
            self.screen.write("\r\n");
            if terminal::ends_block(&line) {
                self.finish_block();
            } else {
                if let Some(block) = self.block.borrow_mut().as_mut() {
                    block.lines.push(line);
                }
                self.prompt();
            }
            return;
        }

        let Some(mut line) = taken else {
            // An empty line is a command too, and the one a terminal is most
            // often given: it prints a fresh prompt line, as a shell does.
            // Redrawing in place would be invisible, the prompt is already there
            //, so pressing Enter appeared to do nothing.
            self.screen.write("\r\n");
            self.prompt();
            return;
        };

        // Only now is it known to be a command, so only now does it belong in the
        // history: journal text goes through `submit` too.
        self.editor.borrow_mut().remember(&line);
        save_history(self.editor.borrow().history());
        // The echo is what was typed, `>>` and all, because that is what is on
        // screen and a search must not find it.
        self.remember_chatter(&format!("{}{line}", self.prompt_text()));

        // One piece of shell syntax, read before anything else: `cmd >> file`.
        let append = match terminal::redirect(&line) {
            terminal::Redirect::Plain(command) => {
                line = command;
                None
            }
            terminal::Redirect::Append { command, target } => match terminal::append_target(&target)
            {
                Ok(path) => {
                    line = command;
                    // Both forms matter: the app files under `path`, and the note
                    // has to name the file the way a command would.
                    Some((path, target))
                }
                Err(complaint) => {
                    self.announce(&complaint);
                    return;
                }
            },
            terminal::Redirect::Bad(message) => {
                self.announce(&message);
                return;
            }
        };

        // The command is already on screen: the prompt redraw printed what was
        // typed, character by character. A shell does not echo it again, and
        // echoing it here showed every command twice.
        self.screen.write("\r\n");

        // Aliases are expanded only for commands that are hledger's: an alias
        // called `upload` would otherwise shadow the app's own command, and the
        // words the app owns are the one part of the vocabulary it must keep.
        let line = match terminal::classify(&line) {
            Command::Hledger(_) => {
                let aliases = self.aliases.borrow().clone();
                let (expanded, used) = terminal::expand_alias(&line, &aliases);
                if let Some((name, expansion)) = used {
                    let note = terminal::alias_note(&name, &expansion);
                    self.say(&note);
                }
                expanded
            }
            _ => line,
        };

        // An append only means something for a command that prints journal text.
        // Saying so beats silently ignoring the `>>`, which would lose the output.
        if append.is_some() && !matches!(terminal::classify(&line), Command::Hledger(_)) {
            self.announce(&format!(
                "{} appends what an hledger command prints. Give it one to run.",
                terminal::bold(">>")
            ));
            return;
        }

        match terminal::classify(&line) {
            Command::Clear => {
                self.screen.clear();
                self.prompt();
            }
            Command::Help => {
                let help = format!(
                    "{}\n{}\n",
                    terminal::help(&plugins::help_entries()),
                    crate::hledger_info::describe()
                );
                self.announce(&help);
            }
            Command::Upload => self.upload(upload::Mode::Files),
            Command::UploadDir => self.upload(upload::Mode::Directory),
            Command::Demo => self.load_demo(),
            Command::Alias(None) => {
                let listing = terminal::alias_list(&self.aliases.borrow());
                self.announce(&listing);
            }
            Command::Alias(Some(text)) => self.set_alias(text),
            Command::Unalias(Some(name)) => {
                if let Some(name) = self.single(name) {
                    self.remove_alias(&name);
                }
            }
            Command::Unalias(None) => {
                self.announce(&format!(
                    "Which one? {}, or {} to list them.",
                    terminal::bold("unalias <name>"),
                    terminal::bold("alias")
                ));
            }
            Command::Connect(Some(address)) => {
                if let Some(address) = self.single(address) {
                    self.connect_remote(&address);
                }
            }
            Command::Connect(None) => self.announce(&format!(
                "Which account? Use {} for example {}.",
                terminal::bold("connect user@host"),
                terminal::bold("connect you@5apps.com")
            )),
            Command::Disconnect => self.disconnect_remote(),
            Command::Remote(None) => self.load_remote(""),
            Command::Remote(Some(path)) => {
                if let Some(path) = self.single(path) {
                    self.load_remote(&path);
                }
            }
            Command::Put(Some(path)) => {
                if let Some(path) = self.single(path) {
                    self.put_remote(&path);
                }
            }
            Command::Put(None) => {
                let names: Vec<String> = self
                    .written
                    .borrow()
                    .iter()
                    .map(|file| file.path.clone())
                    .collect();
                // The list message already explains an empty session, so it is
                // not repeated here.
                self.announce(&format!(
                    "Which file? {}.\n{}",
                    terminal::bold("put <path>"),
                    terminal::download_list(&names)
                ));
            }
            Command::Font(None) => self.announce(&format!(
                "The font is {}px, between {} and {}. {} changes it, and so do \
                 Ctrl+=, Ctrl+- and Ctrl+0.",
                self.font.get(),
                terminal::MIN_FONT,
                terminal::MAX_FONT,
                terminal::bold("font 18")
            )),
            Command::ScreenReader(None) => self.announce(&format!(
                "The accessibility tree is {}. {} turns it {}; the setting is \
                 remembered between visits.",
                if self.screen_reader.get() { "on" } else { "off" },
                terminal::bold("screenreader"),
                if self.screen_reader.get() { "off" } else { "on" }
            )),
            Command::Append(Some(target)) => {
                if let Some(target) = self.single(target) {
                    self.start_block(&target);
                }
            }
            Command::Append(None) => self.announce(&format!(
                "Which file? For example {}, then type or paste the entries, and \
                 finish with a line containing only {}.",
                terminal::bold("append data/2024.journal"),
                terminal::bold(".")
            )),
            Command::ScreenReader(Some(wanted)) => {
                if let Some(wanted) = self.single(wanted) {
                    match terminal::parse_switch(&wanted) {
                        Ok(on) => self.set_screen_reader(on),
                        Err(complaint) => self.announce(&complaint),
                    }
                }
            }
            Command::Font(Some(size)) => {
                if let Some(size) = self.single(size) {
                    match terminal::font_size(&size) {
                        Ok(size) => {
                            self.set_font_size(size);
                            self.announce(&format!("The font is now {}px.", self.font.get()));
                        }
                        Err(complaint) => self.announce(&complaint),
                    }
                }
            }
            Command::Search(term) => self.search(term.unwrap_or("")),
            Command::SearchAgain(backwards) => self.search_again(backwards),
            Command::Download(Some(path)) => {
                if let Some(path) = self.single(path) {
                    self.download(&path);
                }
            }
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
            Command::Journal(Some(path)) => {
                if let Some(path) = self.single(path) {
                    self.set_journal(&path);
                }
            }
            Command::Hledger(command) => {
                // A plugin gets first refusal on the word. The core does not know
                // their names, which is what makes them plugins.
                match plugins::owner(command) {
                    Some(plugin) if append.is_some() => self.announce(&format!(
                        "{} appends what an hledger command prints. {} is a plugin, so \
                         there is nothing to append.",
                        terminal::bold(">>"),
                        terminal::bold(plugin.name())
                    )),
                    Some(plugin) => self.run_plan(command, plugin),
                    None => self.run_with(command, append),
                }
            }
        }
    }

    // -- commands -----------------------------------------------------------

    /// One argument with its quoting removed, or a complaint about why not.
    ///
    /// The app's own commands take a single path, address or number. A path can
    /// have a space in it, an uploaded file is named whatever it was named, so
    /// `journal "my file.journal"` has to mean that file, and `journal a b` has to
    /// say so rather than quietly reading `a`.
    fn single(self: &Rc<App>, rest: &str) -> Option<String> {
        match terminal::single_argument(rest) {
            Ok(argument) => argument,
            Err(complaint) => {
                self.announce(&complaint);
                None
            }
        }
    }

    /// Files arrive three ways, picked, dropped, read from an account, and this
    /// is the one place that mounts them, so the states it sets (files, main
    /// journal, cache, engine configuration) cannot drift between them.
    fn accept_files(self: &Rc<App>, picked: Picked, source: &str) {
        let text = terminal::files_arrived(
            source,
            &picked
                .files
                .iter()
                .map(|file| file.path.clone())
                .collect::<Vec<_>>(),
            &picked.skipped,
            journal::choose_main(&picked.files).as_deref(),
        );
        // What is loaded is what was chosen: a second load replaces the first
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
                Ok(picked) => app.accept_files(picked, "Uploaded"),
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


    fn set_journal(self: &Rc<App>, path: &str) {
        let files = self.files.borrow();
        let Some(file) = files.iter().find(|file| file.path == path) else {
            drop(files);
            let text = terminal::file_list(&self.paths(), self.main.borrow().as_deref());
            self.announce(&format!("No loaded file is called {}.\n{text}", terminal::bold(path)));
            return;
        };
        let path = file.path.clone();
        drop(files);

        *self.main.borrow_mut() = Some(path.clone());
        self.remember();
        self.configure();
        self.announce(&format!(
            "Now reading {}. Type {} for a report.",
            terminal::bold(&path),
            terminal::bold("balance")
        ));
    }

    /// Tell the engine which journal to read and how big the terminal is.
    ///
    /// The journal is what makes a bare `hledger balance` work: hledger reads
    /// `$LEDGER_FILE` when no `-f` is given. The size is what it formats reports
    /// to, hledger asks the terminal, WASI cannot answer, and the wasm build's
    /// terminal-size stub reads `$COLUMNS`/`$LINES` instead, so the size has to be
    /// in the environment before every run. Called at startup, after an upload,
    /// and on every resize.
    fn configure(self: &Rc<App>) {
        let ledger_file = self.main.borrow().as_deref().map(hledger::mounted_path);
        let (columns, lines) = self.screen.size();
        let engine = crate::hledger_info::engine_url();
        spawn_local(async move {
            // A failure here only means the engine is unreachable, which the next
            // command will report in full.
            let _ = hledger::configure(
                ledger_file.as_deref(),
                Some(columns),
                Some(lines),
                Some(&engine),
            )
            .await;
        });
    }

    /// Stop the running command by throwing the engine's worker away.
    ///
    /// The worker is replaced on the next run, so the environment has to be given
    /// to it again, a new worker knows nothing about the journal or the terminal
    /// size.
    fn cancel(self: &Rc<App>) {
        let app = Rc::clone(self);
        spawn_local(async move {
            let _ = hledger::cancel().await;
            app.configure();
        });
    }

    /// Run a command, optionally appending what it prints to a loaded file.
    fn run_with(self: &Rc<App>, command: &str, append: Option<(String, String)>) {
        let argv = match argv_for(command) {
            Ok(argv) => argv,
            Err(complaint) => return self.announce(&complaint),
        };
        let files = self.files.borrow().clone();
        self.busy.set(true);
        self.title(&format!("running {command}"));

        let app = Rc::clone(self);
        spawn_local(async move {
            let result = hledger::run(HledgerRequest::new(argv, files)).await;
            app.finish(result, append);
        });
    }

    fn finish(
        self: &Rc<App>,
        result: Result<HledgerOutput, EngineError>,
        append: Option<(String, String)>,
    ) {
        match result {
            Ok(output) => {
                // Redirected output goes to the file, not the screen: showing it
                // as well would be the print you asked not to have. Nothing is
                // appended from a run that failed.
                if let (Some((path, target)), false) = (append.as_ref(), output.is_failure()) {
                    self.append_output(path, target, &output);
                    return self.settle();
                }

                let (visible, note) = terminal::visible_output(&output.stdout);
                if !visible.trim().is_empty() {
                    self.output(&visible, None);
                }
                if !output.stderr.trim().is_empty() {
                    self.output(&output.stderr, Some(terminal::RED));
                }
                if let Some(note) = note {
                    self.say(&note);
                }
                self.record_writes(&output);
                if output.is_failure() {
                    let status = format!(
                        "[exit {} · {:.1} s]",
                        output.exit_code,
                        output.ms / 1000.0
                    );
                    // The terminal's own exit status, but still the app talking.
                    self.block(&status, Some(terminal::DIM_RED));
                    self.remember_chatter(&status);
                }
            }
            // Stopping a command is not a failure: the terminal already printed
            // the ^C, and an error message would read as though something broke.
            Err(EngineError::Cancelled) => self.say("[cancelled]"),
            Err(error) => self.block(&error.to_string(), Some(terminal::RED)),
        }

        self.settle();
    }

    /// The end of every run: ready for input, and replaying what was typed while
    /// the engine was busy.
    /// Say in the window title what is running, if anything.
    ///
    /// A slow report is otherwise silent for as long as it takes, and the tab is the
    /// one place a browser lets an application speak without writing to the terminal.
    fn title(&self, suffix: &str) {
        let Some(document) = web_sys::window().and_then(|window| window.document()) else {
            return;
        };
        document.set_title(&if suffix.is_empty() {
            "hledger-anywhere".to_string()
        } else {
            format!("hledger-anywhere · {suffix}")
        });
    }

    fn settle(self: &Rc<App>) {
        self.busy.set(false);
        // Whatever was running has stopped, whether it printed, drew, or failed.
        self.title("");
        let pending = std::mem::take(&mut *self.pending.borrow_mut());
        if pending.is_empty() {
            self.prompt();
        } else {
            // Replay what was typed while the engine ran, which may itself end in
            // an Enter.
            self.handle(&pending);
        }
    }

    /// Append what a command printed to a loaded file.
    ///
    /// The command ran against the files as they were, and its output is journal
    /// text, that is what `import`, `print` and `rewrite` produce, so the file
    /// grows by exactly what was on stdout, well-formed at the join.
    fn append_output(self: &Rc<App>, path: &str, target: &str, output: &HledgerOutput) {
        let existing = self
            .files
            .borrow()
            .iter()
            .find(|file| file.path == path)
            .map(|file| file.contents.clone())
            .unwrap_or_default();
        let combined = terminal::append_text(&existing, &output.stdout);
        let added = output.stdout.lines().count();
        let total = combined.len();

        let file = JournalFile::new(path, &combined);
        self.absorb(&[file]);
        self.say(&terminal::append_note(target, added, total));
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

    /// Ctrl+R: start an incremental reverse search through the history.
    fn start_isearch(self: &Rc<App>) {
        let saved = self.editor.borrow().line();
        *self.isearch.borrow_mut() = Some(ISearch {
            query: String::new(),
            index: None,
            failed: false,
            saved,
        });
        self.refresh_isearch();
    }

    /// One keypress while a reverse search is running.
    fn isearch_input(self: &Rc<App>, data: &str) {
        match data {
            // Enter takes the match and runs it, as readline does: the search is
            // a way of getting to a command you have run before.
            "\r" => {
                *self.isearch.borrow_mut() = None;
                self.submit();
            }
            // Ctrl+G or Escape abandons the search and restores the line.
            "\u{7}" | "\u{1b}" => {
                let saved = self
                    .isearch
                    .borrow_mut()
                    .take()
                    .map(|search| search.saved)
                    .unwrap_or_default();
                self.editor.borrow_mut().set_line(&saved);
                self.prompt();
            }
            // Another Ctrl+R goes further back through the matches.
            "\u{12}" => {
                let from = self.isearch.borrow().as_ref().and_then(|search| search.index);
                if let Some(search) = self.isearch.borrow_mut().as_mut() {
                    search.index = from;
                }
                self.refresh_isearch_from(from);
            }
            // Backspace shortens the query, which is how an incremental search is
            // corrected.
            "\u{7f}" | "\u{8}" => {
                if let Some(search) = self.isearch.borrow_mut().as_mut() {
                    search.query.pop();
                }
                self.refresh_isearch();
            }
            // Anything else narrows the query.
            typed if !typed.chars().any(char::is_control) => {
                if let Some(search) = self.isearch.borrow_mut().as_mut() {
                    search.query.push_str(typed);
                }
                self.refresh_isearch();
            }
            // A key that means something else: accept the match and let the key
            // do its job.
            other => {
                *self.isearch.borrow_mut() = None;
                self.handle(other);
            }
        }
    }

    /// Search again from scratch with the current query.
    fn refresh_isearch(self: &Rc<App>) {
        self.refresh_isearch_from(None);
    }

    /// Search again, optionally looking only before `from`.
    fn refresh_isearch_from(self: &Rc<App>, from: Option<usize>) {
        let query = self
            .isearch
            .borrow()
            .as_ref()
            .map(|search| search.query.clone())
            .unwrap_or_default();
        let history = self.editor.borrow().history().to_vec();

        match terminal::reverse_search(&history, &query, from) {
            Some((index, entry)) => {
                {
                    let mut isearch = self.isearch.borrow_mut();
                    if let Some(search) = isearch.as_mut() {
                        search.index = Some(index);
                        search.failed = false;
                    }
                }
                // The match goes into the editor, so it is the line being edited
                // and Enter will run exactly what is on screen.
                self.editor.borrow_mut().set_line(&entry);
                self.prompt();
            }
            None => {
                // Keep whatever was found last: readline leaves the best match on
                // screen and says the search has failed.
                if let Some(search) = self.isearch.borrow_mut().as_mut() {
                    search.failed = true;
                }
                self.prompt();
            }
        }
    }

    /// `alias name=command`: define one.
    fn set_alias(self: &Rc<App>, text: &str) {
        match terminal::parse_alias(text) {
            terminal::AliasEdit::Bad(message) => self.announce(&message),
            terminal::AliasEdit::Set(name, expansion) => {
                {
                    let mut aliases = self.aliases.borrow_mut();
                    aliases.retain(|(existing, _)| existing != &name);
                    aliases.push((name.clone(), expansion.clone()));
                    aliases.sort_by(|left, right| left.0.cmp(&right.0));
                }
                save_aliases(&self.aliases.borrow());
                self.announce(&format!(
                    "{} now runs {}.",
                    terminal::bold(&name),
                    terminal::bold(&expansion)
                ));
            }
        }
    }

    fn remove_alias(self: &Rc<App>, name: &str) {
        let removed = {
            let mut aliases = self.aliases.borrow_mut();
            let before = aliases.len();
            aliases.retain(|(existing, _)| existing != name);
            aliases.len() != before
        };
        if !removed {
            let listing = terminal::alias_list(&self.aliases.borrow());
            self.announce(&format!("No alias called {}.\n{listing}", terminal::bold(name)));
            return;
        }
        save_aliases(&self.aliases.borrow());
        self.announce(&format!("Removed {}.", terminal::bold(name)));
    }

    /// `connect user@host`: start connecting a remoteStorage account.
    ///
    /// This ends in a redirect to the provider's consent screen and back, so the
    /// message has to be printed before anything else happens, after the redirect
    /// there is nobody left to print it.
    fn connect_remote(self: &Rc<App>, address: &str) {
        let app = Rc::clone(self);
        let address = address.to_string();
        // Marked before the redirect, so the page that comes back knows to expect
        // a token in its fragment.
        if let Some(storage) = storage() {
            let _ = storage.set_item(REMOTE_PENDING_KEY, "on");
        }
        self.announce(&format!(
            "Connecting {address}, your browser will leave this page for the \
             provider's consent screen and come back."
        ));
        spawn_local(async move {
            if let Err(error) = remote::client::load_library().await {
                app.announce(&error.message());
                return;
            }
            match remote::client::Account::connect(&address) {
                Ok(()) => {}
                Err(error) => app.announce(&error.message()),
            }
        });
    }

    /// Deal with a connection coming back from a provider.
    ///
    /// Called once at start-up, and does nothing at all unless a `connect` was
    /// started in some previous page load. Starting the library is what claims the
    /// token from the fragment, so this is the difference between connecting once
    /// and never connecting at all.
    fn remote_return(self: &Rc<App>) {
        let pending = storage()
            .and_then(|storage| storage.get_item(REMOTE_PENDING_KEY).ok().flatten())
            .is_some();
        if !pending {
            return;
        }
        if let Some(storage) = storage() {
            let _ = storage.remove_item(REMOTE_PENDING_KEY);
        }

        let app = Rc::clone(self);
        spawn_local(async move {
            if remote::client::load_library().await.is_err() {
                return;
            }
            // The library may already know, and may say so a moment later; either
            // way the message is printed once.
            if remote::client::Account::wait_connected().await {
                app.report_connection(None);
            }
            let announcing = Rc::clone(&app);
            let _ = remote::client::Account::on_connected(move |address| {
                announcing.report_connection(address);
            });
        });
    }

    /// Say that the account is connected, once.
    fn report_connection(self: &Rc<App>, address: Option<String>) {
        if self.remote_reported.replace(true) {
            return;
        }
        match address {
            Some(address) => self.announce(&format!(
                "Connected to {address}. {} loads your journals, and {} saves files \
                 back to the account.",
                terminal::bold("remote"),
                terminal::bold("put")
            )),
            None => self.announce(&format!(
                "Connected to your storage account. {} loads your journals, and {} \
                 saves files back to it.",
                terminal::bold("remote"),
                terminal::bold("put")
            )),
        }
        self.prompt();
    }

    /// `disconnect`: forget the account. The local cache is left alone, so the
    /// files already loaded keep working.
    fn disconnect_remote(self: &Rc<App>) {
        match remote::client::Account::disconnect() {
            Ok(()) => self.announce(&format!(
                "Disconnected. The files already loaded stay loaded; {} brings the \
                 account back.",
                terminal::bold("connect")
            )),
            Err(error) => self.announce(&error.message()),
        }
    }

    /// `put <path>`: save a file into the connected account.
    ///
    /// Either a file a command wrote this session, or anything loaded. The second
    /// half matters: putting a loaded journal into an account is how a journal gets
    /// *there* in the first place, and accepting only what hledger wrote would mean
    /// nothing could ever be uploaded.
    fn put_remote(self: &Rc<App>, path: &str) {
        let file = self
            .written
            .borrow()
            .iter()
            .find(|file| file.path == path)
            .cloned()
            .or_else(|| {
                self.files
                    .borrow()
                    .iter()
                    .find(|file| file.path == path)
                    .cloned()
            });
        let Some(file) = file else {
            let mut names: Vec<String> = self
                .files
                .borrow()
                .iter()
                .map(|file| file.path.clone())
                .collect();
            names.sort();
            names.dedup();
            self.announce(&format!(
                "Nothing called {} is loaded. {} lists what is.\n{}",
                terminal::bold(path),
                terminal::bold("journal"),
                terminal::download_list(&names)
            ));
            return;
        };

        let app = Rc::clone(self);
        self.announce(&format!(
            "Saving {} ({} bytes) to your storage account…",
            terminal::bold(&file.path),
            file.contents.len()
        ));
        spawn_local(async move {
            match write_remote(&file).await {
                Ok(where_to) => app.announce(&format!(
                    "Saved {} to {where_to}.",
                    terminal::bold(&file.path)
                )),
                Err(error) => app.announce(&error.message()),
            }
        });
    }

    /// `remote [dir]`: walk the account and mount what is there.
    ///
    /// The work is done in the terminal's own thread of control, so the terminal
    /// says what it is doing: a journal is a directory tree, and this walks it one
    /// listing at a time.
    fn load_remote(self: &Rc<App>, argument: &str) {
        let app = Rc::clone(self);
        let directory = remote::directory_for(argument);
        self.busy.set(true);
        self.announce(&format!("Reading {directory} from your storage account…"));

        spawn_local(async move {
            let outcome = read_remote(&directory).await;
            app.busy.set(false);
            match outcome {
                Ok((picked, _)) if picked.files.is_empty() => app.announce(&format!(
                    "Nothing under {directory}. Files have to live in the {} category.",
                    remote::CATEGORY
                )),
                Ok((picked, address)) => {
                    let count = picked.files.len();
                    app.accept_files(picked, "Read");
                    let from = match address {
                        Some(address) => format!("{directory} in {address}"),
                        None => directory.clone(),
                    };
                    app.announce(&format!("Read {count} file(s) from {from}."));
                }
                Err(error) => app.announce(&error.message()),
            }
        });
    }

    /// Take files dropped anywhere on the page.
    ///
    /// One listener for all three drag events: they differ only in what should
    /// happen, and the browser's own behaviour, navigating away to show a dropped
    /// file, has to be suppressed on all of them, or a drop that misses the
    /// terminal loses the app.
    fn drop_target(self: &Rc<App>) {
        let app = Rc::clone(self);
        let closure = wasm_bindgen::closure::Closure::<dyn FnMut(web_sys::DragEvent)>::new(
            move |event: web_sys::DragEvent| {
                // A drag with no files is a text selection being moved; leave it.
                let carries_files = event
                    .data_transfer()
                    .map(|transfer| transfer.types().length() > 0)
                    .unwrap_or(false);
                if !carries_files {
                    return;
                }
                event.prevent_default();

                match event.type_().as_str() {
                    "dragover" => app.highlight_drop(true),
                    "drop" => {
                        app.highlight_drop(false);
                        let files: Vec<web_sys::File> = event
                            .data_transfer()
                            .and_then(|transfer| transfer.files())
                            .map(|list| (0..list.length()).filter_map(|i| list.get(i)).collect())
                            .unwrap_or_default();
                        if files.is_empty() {
                            return;
                        }
                        let app = Rc::clone(&app);
                        spawn_local(async move {
                            match upload::read_dropped(&files).await {
                                Ok(picked) => app.accept_files(picked, "Dropped"),
                                Err(error) => app.announce(&error.message()),
                            }
                        });
                    }
                    _ => app.highlight_drop(false),
                }
            },
        );
        if let Some(document) = web_sys::window().and_then(|window| window.document()) {
            for name in ["dragover", "dragleave", "drop"] {
                let _ = document
                    .add_event_listener_with_callback(name, closure.as_ref().unchecked_ref());
            }
        }
        *self._drop.borrow_mut() = Some(closure);
    }

    /// Show that a drop would land here.
    fn highlight_drop(&self, on: bool) {
        if let Some(document) = web_sys::window().and_then(|window| window.document())
            && let Some(body) = document.body()
        {
            let _ = body.class_list().toggle_with_force("drop-target", on);
        }
    }

    /// `/text`: search the output, or repeat the last search when blank.
    fn search(self: &Rc<App>, term: &str) {
        let term = if term.trim().is_empty() {
            match self.last_search.borrow().clone() {
                Some(previous) => previous,
                None => {
                    self.announce(&format!(
                "Nothing to repeat yet. {} searches the output.",
                terminal::bold("/text")
            ));
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
            self.announce(&format!(
                "Nothing to repeat yet. {} searches the output.",
                terminal::bold("/text")
            ));
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
            None => self.announce(&format!("No match for {}.", terminal::bold(term))),
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
            self.announce(&format!("Nothing called {} was written.\n{text}", terminal::bold(path)));
            return;
        };
        match save_to_disk(&file) {
            Ok(()) => self.announce(&format!(
                "Saving {} ({} bytes). Check your downloads.",
                terminal::bold(&file.path),
                file.contents.len()
            )),
            Err(reason) => self.announce(&format!(
                    "Could not save {}: {reason}",
                    terminal::bold(&file.path)
                )),
        }
    }

    /// Ask the engine for the account names, once, so Tab can complete them.
    ///
    /// On a large journal this is a whole run, several seconds, so it happens
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
                    app.announce(&format!("{count} account names ready, press Tab again."));
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
/// The user's words, with a leading `hledger` accepted and dropped, that is how
/// the command looks in a shell, and people paste commands. Nothing else is added:
/// the journal comes from `$LEDGER_FILE`, so what runs is what was typed.
fn argv_for(command: &str) -> Result<Vec<String>, String> {
    // Quoting is the user's, and it is what makes a period expression with a space
    // in it one argument: `balance -p "this year"`. Splitting on whitespace handed
    // hledger `"this` and `year"`, which it could not parse.
    let mut parts = terminal::tokenize(command)?;
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
    Ok(argv)
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

/// The aliases to start with, from the last visit.
fn load_aliases() -> Vec<(String, String)> {
    let Some(raw) = storage().and_then(|storage| storage.get_item(ALIAS_KEY).ok().flatten())
    else {
        return Vec::new();
    };
    let mut aliases: Vec<(String, String)> = serde_json::from_str(&raw).unwrap_or_default();
    aliases.sort_by(|left, right| left.0.cmp(&right.0));
    aliases
}

fn save_aliases(aliases: &[(String, String)]) {
    let Some(storage) = storage() else {
        return;
    };
    if let Ok(json) = serde_json::to_string(aliases) {
        let _ = storage.set_item(ALIAS_KEY, &json);
    }
}

/// The font size to start with: the last one chosen, or the default.
fn load_font() -> u32 {
    let stored = storage()
        .and_then(|storage| storage.get_item(FONT_KEY).ok().flatten())
        .and_then(|raw| raw.parse::<u32>().ok());
    match stored {
        Some(size) => size.clamp(terminal::MIN_FONT, terminal::MAX_FONT),
        None => terminal::DEFAULT_FONT,
    }
}

/// Whether the accessibility tree was on last time.
///
/// Off by default: it makes xterm build and maintain a second representation of
/// the screen, which is a real cost for everyone who does not need it.
fn load_screen_reader() -> bool {
    storage()
        .and_then(|storage| storage.get_item(SCREEN_READER_KEY).ok().flatten())
        .map(|raw| raw == "on")
        .unwrap_or(false)
}

fn save_screen_reader(on: bool) {
    if let Some(storage) = storage() {
        let _ = storage.set_item(SCREEN_READER_KEY, if on { "on" } else { "off" });
    }
}

fn save_font(size: u32) {
    if let Some(storage) = storage() {
        let _ = storage.set_item(FONT_KEY, &size.to_string());
    }
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
        assert_eq!(
            argv_for("balance --tree").expect("argv"),
            ["hledger", "balance", "--tree"]
        );
        assert_eq!(argv_for("hledger balance").expect("argv"), ["hledger", "balance"]);
        assert_eq!(
            argv_for("  print   date:thismonth  ").expect("argv"),
            ["hledger", "print", "date:thismonth"]
        );
        assert_eq!(
            argv_for("hledger").expect("argv"),
            ["hledger"],
            "a bare hledger prints its usage"
        );
    }

    #[test]
    fn a_quoted_argument_reaches_hledger_whole_and_without_quotes() {
        // The reason any of this exists: a period expression with a space in it is
        // one argument, and hledger rejects it when it is not.
        assert_eq!(
            argv_for("balance -p \"this year\"").expect("argv"),
            ["hledger", "balance", "-p", "this year"]
        );
        assert_eq!(
            argv_for("register -p 'from 2024-01 to 2024-12'").expect("argv"),
            ["hledger", "register", "-p", "from 2024-01 to 2024-12"]
        );
        assert_eq!(
            argv_for("balance date:\"this year\"").expect("argv"),
            ["hledger", "balance", "date:this year"]
        );

        // And an unclosed quote is reported rather than guessed at.
        let complaint = argv_for("balance -p \"this year").expect_err("unclosed");
        assert!(complaint.contains("not closed"), "{complaint}");
    }

    #[test]
    fn a_file_flag_is_left_alone() {
        // -f still works if someone wants it; the app does not add or remove one.
        assert_eq!(
            argv_for("balance -f /data/other.journal").expect("argv"),
            ["hledger", "balance", "-f", "/data/other.journal"]
        );
    }
}
