//! The terminal's own logic, with no browser in it.
//!
//! xterm.js renders and collects keystrokes; everything about *what those
//! keystrokes mean* lives here, so it can be tested natively. That split is the
//! point: a line editor is the kind of code where an off-by-one at the start of a
//! line is invisible until someone hits the Home key, and a browser is a slow
//! place to find that out.

// Natively this module exists for its tests: the only code that uses it is
// wasm-gated, so its items look unused to `cargo test`'s build.
#![cfg_attr(not(target_arch = "wasm32"), allow(dead_code))]

#[cfg(target_arch = "wasm32")]
pub mod view;

/// The smallest and largest font the terminal will use, in pixels.
///
/// A terminal that can be shrunk to nothing or grown past the window is worse
/// than one that cannot be resized at all, so the ends are pinned.
pub const MIN_FONT: u32 = 8;
pub const MAX_FONT: u32 = 32;
pub const DEFAULT_FONT: u32 = 14;

/// The next font size in `direction` (+1 bigger, -1 smaller), clamped.
pub fn step_font(current: u32, direction: i32) -> u32 {
    let step = 2;
    let next = if direction >= 0 {
        current.saturating_add(step)
    } else {
        current.saturating_sub(step)
    };
    next.clamp(MIN_FONT, MAX_FONT)
}

/// The largest stdout written to the terminal, in bytes.
///
/// `hledger print` on a real journal is tens of megabytes, and writing that to
/// xterm.js stalls the tab for minutes. Cutting it is a visible, explainable lie;
/// freezing is not.
pub const MAX_OUTPUT_BYTES: usize = 2 * 1024 * 1024;

/// hledger's commands, for completion. Not exhaustive — completion is a
/// convenience, and anything missing can still be typed out.
const HLEDGER_COMMANDS: [&str; 34] = [
    "accounts",
    "activity",
    "add",
    "aregister",
    "balance",
    "balancesheet",
    "balancesheetequity",
    "cashflow",
    "check",
    "close",
    "codes",
    "commodities",
    "descriptions",
    "diff",
    "edit",
    "equity",
    "expenses",
    "files",
    "help",
    "import",
    "incomestatement",
    "journal",
    "notes",
    "payees",
    "prices",
    "print",
    "print-unique",
    "register",
    "rewrite",
    "roi",
    "stats",
    "tags",
    "test",
    "ui",
];

/// Common report and query flags, for completion.
const FLAGS: [&str; 32] = [
    "-O",
    "--account",
    "--begin",
    "--budget",
    "--change",
    "--cleared",
    "--cumulative",
    "--daily",
    "--depth",
    "--end",
    "--flat",
    "--forecast",
    "--help",
    "--historical",
    "--infer-market-prices",
    "--invert",
    "--monthly",
    "--no-elide",
    "--no-total",
    "--output-format",
    "--pending",
    "--period",
    "--quarterly",
    "--real",
    "--related",
    "--sort",
    "--tree",
    "--unmarked",
    "--value",
    "--version",
    "--weekly",
    "--yearly",
];

/// What a typed line means.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Command<'a> {
    /// Open the file picker and mount the files chosen.
    Upload,
    /// Open a directory picker and mount the files inside it, keeping the paths.
    UploadDir,
    /// Show or change which uploaded file is the journal.
    Journal(Option<&'a str>),
    /// Wipe the screen.
    Clear,
    /// The app's own help, not hledger's.
    Help,
    /// Load a small built-in journal, so the app can be tried without one.
    Demo,
    /// `/term` — find `term` in the scrollback, or the last term when blank.
    Search(Option<&'a str>),
    /// `n` / `N` — repeat the last search, forwards / backwards.
    SearchAgain(bool),
    /// `download <path>` — save a file hledger wrote in the last run.
    Download(Option<&'a str>),
    /// `alias` lists them; `alias name=expansion` sets one.
    Alias(Option<&'a str>),
    /// `unalias name` removes one.
    Unalias(Option<&'a str>),
    /// `connect user@host` connects a remoteStorage account.
    Connect(Option<&'a str>),
    /// `disconnect` forgets it.
    Disconnect,
    /// `remote [dir]` loads files from the connected account.
    Remote(Option<&'a str>),
    /// `put <path>` saves a file a command wrote into the connected account.
    Put(Option<&'a str>),
    /// `font [size]` shows or sets the terminal font size.
    Font(Option<&'a str>),
    /// `screenreader [on|off]` shows or sets the accessibility tree.
    ScreenReader(Option<&'a str>),
    /// `chart [hledger args]` draws a report instead of printing it.
    Chart(Option<&'a str>),
    /// `append <file>` types journal text into a file, a line at a time.
    Append(Option<&'a str>),
    /// Everything else is hledger's, verbatim.
    Hledger(&'a str),
}

/// Classify a line.
///
/// Only four words are the app's; the rest belong to hledger, which is why the
/// fallback case is the interesting one. `journal` collides with hledger's own
/// `journal` command, and the app's reading wins: with no journal configured, the
/// hledger report of that name could not run anyway.
pub fn classify(line: &str) -> Command<'_> {
    let trimmed = line.trim();
    let (head, rest) = match trimmed.split_once(char::is_whitespace) {
        Some((head, rest)) => (head, rest.trim()),
        None => (trimmed, ""),
    };
    match head {
        "upload" => Command::Upload,
        "upload_dir" => Command::UploadDir,
        "journal" => Command::Journal((!rest.is_empty()).then_some(rest)),
        "clear" => Command::Clear,
        "?" => Command::Help,
        "demo" => Command::Demo,
        "download" => Command::Download((!rest.is_empty()).then_some(rest)),
        "alias" => Command::Alias((!rest.is_empty()).then_some(rest)),
        "connect" => Command::Connect((!rest.is_empty()).then_some(rest)),
        "disconnect" => Command::Disconnect,
        "remote" => Command::Remote((!rest.is_empty()).then_some(rest)),
        "put" => Command::Put((!rest.is_empty()).then_some(rest)),
        "font" => Command::Font((!rest.is_empty()).then_some(rest)),
        "screenreader" => Command::ScreenReader((!rest.is_empty()).then_some(rest)),
        "chart" => Command::Chart((!rest.is_empty()).then_some(rest)),
        "append" => Command::Append((!rest.is_empty()).then_some(rest)),
        "unalias" => Command::Unalias((!rest.is_empty()).then_some(rest)),
        // Vim's vocabulary, because it is the one people already know for
        // scrolling back through output. `n` and `N` are not hledger commands, so
        // nothing is shadowed; `/` alone repeats the last search.
        "n" => Command::SearchAgain(false),
        "N" => Command::SearchAgain(true),
        _ if trimmed.starts_with('/') => Command::Search(Some(trimmed[1..].trim())),
        _ => Command::Hledger(trimmed),
    }
}

/// The line the user is editing.
///
/// Kept as characters rather than bytes: a journal is full of payees in whatever
/// script their author writes in, and a cursor that can land inside a multi-byte
/// character panics the renderer.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Editor {
    chars: Vec<char>,
    cursor: usize,
    history: Vec<String>,
    /// Where in the history the current line came from, if it came from there.
    recalled: Option<usize>,
    /// The line as it was before history recall began, so ↓ can come back to it.
    draft: String,
    /// What Ctrl+K, Ctrl+U and Ctrl+W have killed, oldest first. Emacs' kill ring,
    /// minus the cycling: Ctrl+Y yanks the most recent kill.
    kill_ring: Vec<String>,
}

impl Editor {
    /// An editor holding `history`, oldest first.
    pub fn with_history(history: Vec<String>) -> Self {
        Editor {
            history,
            ..Editor::default()
        }
    }

    pub fn line(&self) -> String {
        self.chars.iter().collect()
    }

    /// The cursor's position, in characters from the start of the line.
    pub fn cursor(&self) -> usize {
        self.cursor
    }

    pub fn history(&self) -> &[String] {
        &self.history
    }

    /// Insert typed text at the cursor, ignoring control characters.
    ///
    /// xterm delivers pastes and some keys as multi-character chunks, so this
    /// takes a string rather than a character.
    pub fn insert(&mut self, text: &str) {
        for character in text.chars() {
            if character.is_control() {
                continue;
            }
            self.chars.insert(self.cursor, character);
            self.cursor += 1;
        }
    }

    /// Delete the character before the cursor.
    pub fn backspace(&mut self) {
        if self.cursor > 0 {
            self.chars.remove(self.cursor - 1);
            self.cursor -= 1;
        }
    }

    /// Delete the character under the cursor.
    pub fn delete(&mut self) {
        if self.cursor < self.chars.len() {
            self.chars.remove(self.cursor);
        }
    }

    pub fn left(&mut self) {
        self.cursor = self.cursor.saturating_sub(1);
    }

    pub fn right(&mut self) {
        if self.cursor < self.chars.len() {
            self.cursor += 1;
        }
    }

    pub fn home(&mut self) {
        self.cursor = 0;
    }

    pub fn end(&mut self) {
        self.cursor = self.chars.len();
    }

    /// Ctrl+C: throw the line away without remembering it.
    pub fn clear_line(&mut self) {
        self.chars.clear();
        self.cursor = 0;
        self.recalled = None;
    }

    fn kill(&mut self, text: String) {
        if !text.is_empty() {
            self.kill_ring.push(text);
        }
    }

    /// Ctrl+K: kill from the cursor to the end of the line.
    pub fn kill_to_end(&mut self) {
        let killed: String = self.chars.split_off(self.cursor).into_iter().collect();
        self.kill(killed);
    }

    /// Ctrl+U: kill from the cursor back to the start.
    pub fn kill_to_start(&mut self) {
        let killed: String = self.chars.drain(..self.cursor).collect();
        self.cursor = 0;
        self.kill(killed);
    }

    /// Ctrl+W: kill the word before the cursor, as a shell does — whitespace
    /// separates words, so a path or an account name goes in one keystroke.
    pub fn kill_word_backward(&mut self) {
        let start = self.word_start();
        let killed: String = self.chars.drain(start..self.cursor).collect();
        self.cursor = start;
        self.kill(killed);
    }

    /// Ctrl+Y: put the most recent kill back at the cursor.
    ///
    /// A no-op when nothing has been killed, rather than an error: a reader who
    /// presses it out of habit should not be told off.
    pub fn yank(&mut self) {
        let Some(text) = self.kill_ring.last().cloned() else {
            return;
        };
        for character in text.chars() {
            self.chars.insert(self.cursor, character);
            self.cursor += 1;
        }
    }

    /// Ctrl+T: swap the two characters either side of the cursor.
    ///
    /// At the end of a line Emacs swaps the last two, which is the behaviour
    /// people rely on for fixing a typo they have just noticed.
    pub fn transpose(&mut self) {
        if self.chars.len() < 2 {
            return;
        }
        let right = if self.cursor >= self.chars.len() {
            self.chars.len() - 1
        } else {
            self.cursor
        };
        let left = right - 1;
        self.chars.swap(left, right);
        self.cursor = right + 1;
    }

    /// Alt+B: move to the start of the word before the cursor.
    pub fn word_left(&mut self) {
        self.cursor = self.word_start();
    }

    /// Alt+F: move past the end of the word after the cursor.
    pub fn word_right(&mut self) {
        let mut index = self.cursor;
        // Skip the whitespace we are sitting in, then the word itself.
        while index < self.chars.len() && self.chars[index].is_whitespace() {
            index += 1;
        }
        while index < self.chars.len() && !self.chars[index].is_whitespace() {
            index += 1;
        }
        self.cursor = index;
    }

    /// Where the word before the cursor begins.
    fn word_start(&self) -> usize {
        let mut index = self.cursor;
        while index > 0 && self.chars[index - 1].is_whitespace() {
            index -= 1;
        }
        while index > 0 && !self.chars[index - 1].is_whitespace() {
            index -= 1;
        }
        index
    }

    /// Replace the whole line, as completion does.
    pub fn set_line(&mut self, line: &str) {
        self.chars = line.chars().collect();
        self.cursor = self.chars.len();
    }

    /// The previous history entry, or stay put at the oldest.
    pub fn history_prev(&mut self) {
        if self.history.is_empty() {
            return;
        }
        let next = match self.recalled {
            None => {
                // Remember what was being typed so ↓ can restore it.
                self.draft = self.line();
                self.history.len() - 1
            }
            Some(0) => 0,
            Some(current) => current - 1,
        };
        self.recalled = Some(next);
        self.set_line(&self.history[next].clone());
    }

    /// The next history entry, ending back at the line that was being typed.
    pub fn history_next(&mut self) {
        match self.recalled {
            None => {}
            Some(current) if current + 1 < self.history.len() => {
                self.recalled = Some(current + 1);
                self.set_line(&self.history[current + 1].clone());
            }
            Some(_) => {
                self.recalled = None;
                let draft = self.draft.clone();
                self.set_line(&draft);
            }
        }
    }

    /// Enter was pressed: take the line, and remember it.
    ///
    /// Blank lines return `None` and are not remembered, so pressing Enter twice
    /// does not put an empty entry in the history.
    pub fn take(&mut self) -> Option<String> {
        // Deliberately untrimmed. Trimming looks harmless for a command and is
        // not: a journal posting's leading whitespace is its syntax, and a
        // transaction typed into the terminal lost exactly that until this
        // stopped. Callers that want a command trim it, and the empty check below
        // is the only place the trimmed form matters.
        let line = self.line();
        self.clear_line();
        self.draft.clear();
        if line.trim().is_empty() {
            return None;
        }
        Some(line)
    }

    /// Add a line to the history worth recalling as a command.
    ///
    /// Journal text typed into a file is not a command and does not belong here,
    /// which is why this is the caller's decision rather than `take`'s.
    pub fn remember(&mut self, line: &str) {
        let line = line.trim();
        if line.is_empty() || self.history.last() == Some(&line.to_string()) {
            return;
        }
        self.history.push(line.to_string());
    }

    /// The token under the cursor, for completion.
    pub fn token(&self) -> String {
        let head: String = self.chars[..self.cursor].iter().collect();
        match head.rfind(char::is_whitespace) {
            Some(index) => head[index + 1..].to_string(),
            None => head,
        }
    }

    /// Complete the token under the cursor from `candidates`.
    ///
    /// One match completes outright; several extend as far as they agree, and
    /// otherwise the caller lists them. That is what a shell does, and it is the
    /// behaviour that makes Tab worth pressing twice.
    pub fn complete(&mut self, candidates: &[String]) -> Completion {
        let token = self.token();
        let mut matches: Vec<&String> = candidates
            .iter()
            .filter(|candidate| candidate.starts_with(&token))
            .collect();
        matches.sort();
        matches.dedup();

        match matches.as_slice() {
            [] => Completion::None,
            [only] => {
                let replacement = format!("{only} ");
                self.replace_token(&replacement);
                Completion::Completed
            }
            many => {
                let prefix = common_prefix(many);
                if prefix.chars().count() > token.chars().count() {
                    self.replace_token(&prefix);
                    Completion::Extended
                } else {
                    Completion::Ambiguous(many.iter().map(|value| (*value).clone()).collect())
                }
            }
        }
    }

    /// Replace the token under the cursor, keeping the rest of the line.
    ///
    /// The cursor moves to just after the replacement, so completing a token in
    /// the middle of a command line — a query term, say — leaves the arguments
    /// that follow it alone and still editable.
    fn replace_token(&mut self, replacement: &str) {
        let token_length = self.token().chars().count();
        let start = self.cursor.saturating_sub(token_length);
        let head: String = self.chars[..start].iter().collect();
        let tail: String = self.chars[self.cursor..].iter().collect();
        let line = format!("{head}{replacement}{tail}");
        self.chars = line.chars().collect();
        self.cursor = start + replacement.chars().count();
    }
}

/// What completion did, so the caller knows whether to print the options.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Completion {
    None,
    Completed,
    Extended,
    Ambiguous(Vec<String>),
}

/// Every word completion can offer: the app's commands, hledger's, the common
/// flags, and the uploaded file paths.
pub fn candidates(paths: &[String]) -> Vec<String> {
    let mut all: Vec<String> = [
        "upload",
        "upload_dir",
        "journal",
        "clear",
        "?",
        "demo",
        "download",
        "alias",
        "unalias",
        "connect",
        "remote",
        "disconnect",
        "put",
        "font",
        "screenreader",
        "chart",
        "append",
    ]
        .iter()
        .map(|word| (*word).to_string())
        .collect();
    all.extend(HLEDGER_COMMANDS.iter().map(|word| (*word).to_string()));
    all.extend(FLAGS.iter().map(|word| (*word).to_string()));
    all.extend(paths.iter().cloned());
    all
}

fn common_prefix(values: &[&String]) -> String {
    let mut iter = values.iter();
    let Some(first) = iter.next() else {
        return String::new();
    };
    let mut prefix: Vec<char> = first.chars().collect();
    for value in iter {
        let other: Vec<char> = value.chars().collect();
        let shared = prefix
            .iter()
            .zip(other.iter())
            .take_while(|(a, b)| a == b)
            .count();
        prefix.truncate(shared);
    }
    prefix.into_iter().collect()
}

/// stdout as it should be shown, and a note when it had to be cut.
pub fn visible_output(stdout: &str) -> (String, Option<String>) {
    if stdout.len() <= MAX_OUTPUT_BYTES {
        return (stdout.to_string(), None);
    }
    // Cut on a line boundary where there is one nearby, so the last line shown is
    // not half a number.
    let mut cut = MAX_OUTPUT_BYTES;
    while cut > 0 && !stdout.is_char_boundary(cut) {
        cut -= 1;
    }
    let window = &stdout[..cut];
    if let Some(index) = window.rfind('\n') {
        cut = index + 1;
    }
    let megabytes = stdout.len() as f64 / (1024.0 * 1024.0);
    (
        stdout[..cut].to_string(),
        Some(format!(
            "[output truncated after {} MB of {megabytes:.1} MB — `-o out.csv` writes the \
             whole thing, and `download out.csv` saves it]",
            MAX_OUTPUT_BYTES / (1024 * 1024)
        )),
    )
}

/// Normalise text for a terminal.
///
/// xterm.js, like a real terminal, starts a new line only on `\r\n`: a bare `\n`
/// moves down without returning to the left margin, which turns a report into a
/// staircase. The engine's output uses `\n`, so it is converted here rather than
/// being written raw.
pub fn to_terminal_text(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut chars = text.chars().peekable();
    while let Some(character) = chars.next() {
        match character {
            '\n' => out.push_str("\r\n"),
            '\r' => {
                out.push('\r');
                if chars.peek() == Some(&'\n') {
                    chars.next();
                    out.push('\n');
                }
            }
            _ => out.push(character),
        }
    }
    out
}

/// The bytes that redraw the prompt line in place.
///
/// A terminal has no DOM to update: the line is redrawn by returning the cursor
/// to the start of it, clearing to the end, writing the prompt and the line, and
/// then moving the cursor back left over however many characters follow it. That
/// is what a shell does, and it is why the editor itself is only data.
pub fn prompt_redraw(prompt: &str, line: &str, cursor: usize) -> String {
    let tail = line.chars().count().saturating_sub(cursor);
    let mut out = format!("\r\u{1b}[K{prompt}{line}");
    if tail > 0 {
        out.push_str(&format!("\u{1b}[{tail}D"));
    }
    out
}

/// A small journal to try the app on, for a first visit with nothing to upload.
///
/// Deliberately tiny and deliberately dated in the past: it is a sample, and the
/// point of `demo` is that every command in `hledger help` works immediately
/// rather than that the numbers mean anything. It includes a second file so that
/// `include` resolution is exercised too, and covers a few commodities, tags and
/// a price so that reports which group by those have something to group.
pub const DEMO_JOURNAL: &str = "\
; Demo journal — loaded by the `demo` command. Replace it with `upload`.
include demo-prices.journal

2024-01-01 * Opening balances
    assets:bank:checking              $2,400.00
    assets:bank:savings               $5,000.00
    assets:cash                         $120.00
    equity:opening balances

2024-01-05 * (rent:january) Landlord
    expenses:housing:rent             $1,200.00
    assets:bank:checking

2024-01-09 * Grocery Store  ; weekly shop
    expenses:food:groceries              $86.40
    assets:bank:checking

2024-01-14 * (salary:january) Employer
    assets:bank:checking              $3,200.00
    income:salary

2024-02-01 * Coffee Roasters
    expenses:food:coffee                 $12.50
    assets:cash

2024-02-03 * Bookshop  ; receipt:yes
    expenses:reading:books               $34.99
    assets:bank:checking
";

/// The demo's price file, mounted alongside the journal so `include` resolves.
pub const DEMO_PRICES: &str = "\
P 2024-02-01 EUR $1.08
P 2024-02-01 GBP $1.27
";

/// What a submitted line asks for.
///
/// The app is not a shell, but one piece of shell syntax is worth having: hledger
/// prints what it computed, and appending that to a journal is how `import`,
/// `print` and `rewrite` are actually used. Without it, the only way to keep a
/// command's output is `-o`, which overwrites — and appending is the operation a
/// journal needs.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Redirect {
    /// A command, with nothing redirected.
    Plain(String),
    /// Run `command` and append its output to `target`.
    Append { command: String, target: String },
    /// Something to tell the user about instead.
    Bad(String),
}

/// Read `command >> target` from a line.
///
/// Only the first `>>` counts and the target must be one word: a path with spaces
/// would be indistinguishable from more arguments, and guessing would append a
/// journal somewhere nobody meant. Quoting the target is not supported either — say
/// `>> data/my file.journal` and you get told, rather than a surprise.
pub fn redirect(line: &str) -> Redirect {
    let trimmed = line.trim();
    let Some((command, target)) = trimmed.split_once(">>") else {
        return Redirect::Plain(trimmed.to_string());
    };
    let command = command.trim();
    let target = target.trim();
    if command.is_empty() {
        return Redirect::Bad("Nothing to run before `>>`.".to_string());
    }
    if target.is_empty() {
        return Redirect::Bad(format!(
            "`{command} >>` needs a file to append to, like `>> data/2024.journal`."
        ));
    }
    if target.split_whitespace().count() != 1 {
        return Redirect::Bad(format!(
            "`{target}` is more than one word. Write the file alone after `>>`."
        ));
    }
    Redirect::Append {
        command: command.to_string(),
        target: target.to_string(),
    }
}

/// Whether a line ends a block of typed journal text.
///
/// A single `.` on its own, as a here-document ends. A journal entry that is
/// exactly one dot is not a thing, so this costs nothing to reserve.
pub fn ends_block(line: &str) -> bool {
    line.trim() == "."
}

/// What to say when a block of typed text starts.
pub fn block_header(target: &str) -> String {
    format!(
        "Typing into {target}. Paste or type journal text, then `.` on its own to \
         finish; Ctrl+C abandons it."
    )
}

/// A paste, split into the lines it contains.
///
/// Terminals deliver a paste as one string with newlines in it, which otherwise
/// ends up inserted into the line being edited — a journal snippet pasted into a
/// single-line editor is how this was noticed. `rest` is what follows the last
/// newline, if anything: it belongs on the line still being typed.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Paste {
    pub lines: Vec<String>,
    pub rest: String,
}

/// Split `data` when it is a paste, or `None` when it is an ordinary keypress.
///
/// A single character is never a paste, however it looks, so Enter stays Enter.
pub fn paste(data: &str) -> Option<Paste> {
    if !data.contains(['\n', '\r']) || data.chars().count() < 2 {
        return None;
    }
    let mut lines: Vec<String> = Vec::new();
    let mut current = String::new();
    let mut characters = data.chars().peekable();
    while let Some(character) = characters.next() {
        match character {
            '\r' => {
                // CRLF is one newline, not two.
                if characters.peek() == Some(&'\n') {
                    characters.next();
                }
                lines.push(std::mem::take(&mut current));
            }
            '\n' => lines.push(std::mem::take(&mut current)),
            _ => current.push(character),
        }
    }
    Some(Paste {
        lines,
        rest: current,
    })
}

/// The file a `>>` target names, as the app knows it.
///
/// The engine sees the journal directory mounted at `data/`, so people write
/// `data/2024.journal`; the app's own files are named without it. Both are accepted
/// and neither is guessed at: a target outside the mount is not a file this app can
/// append to.
pub fn append_target(target: &str) -> Result<String, String> {
    let path = target.trim().trim_start_matches("./");
    let path = path.strip_prefix("data/").unwrap_or(path);
    let path = path.trim_start_matches('/');
    if path.is_empty() {
        return Err("`>>` needs a file name, not a directory.".to_string());
    }
    if path.ends_with('/') {
        return Err(format!(
            "`{target}` is a directory. Append to a file inside it."
        ));
    }
    if path.split('/').any(|part| part == "..") {
        return Err(format!("`{target}` is outside the journal directory."));
    }
    Ok(path.to_string())
}

/// `existing` with `addition` on the end, as one well-formed file.
///
/// Both sides are made to end in a newline, because appending to a file that does
/// not end in one is how two journal entries become one broken one.
pub fn append_text(existing: &str, addition: &str) -> String {
    let mut text = existing.to_string();
    if !text.is_empty() && !text.ends_with('\n') {
        text.push('\n');
    }
    text.push_str(addition);
    if !text.is_empty() && !text.ends_with('\n') {
        text.push('\n');
    }
    text
}

/// What the terminal says after appending.
pub fn append_note(target: &str, added_lines: usize, total_bytes: usize) -> String {
    format!(
        "[appended {added_lines} line(s) to {target} ({}) — `print -f {target}` shows it]",
        bytes_label(total_bytes)
    )
}

/// What `alias name=expansion` means.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum AliasEdit {
    /// Set `name` to `expansion`.
    Set(String, String),
    /// Something the user should be told about instead.
    Bad(String),
}

/// Read an `alias` argument.
///
/// The first `=` separates name from expansion, so an expansion may contain `=`
/// — queries do — and the name may not contain spaces, because that is what makes
/// it a name.
pub fn parse_alias(text: &str) -> AliasEdit {
    let Some((name, expansion)) = text.split_once('=') else {
        return AliasEdit::Bad(format!(
            "Write it as `alias name=command`: `alias {text}=…`."
        ));
    };
    let name = name.trim();
    let expansion = expansion.trim();
    if name.is_empty() || name.contains(char::is_whitespace) {
        return AliasEdit::Bad(
            "An alias name cannot be empty or contain spaces. Try `alias bal=balance --tree`."
                .to_string(),
        );
    }
    if expansion.is_empty() {
        return AliasEdit::Bad(format!(
            "`{name}` would expand to nothing. Try `alias {name}=balance --tree`."
        ));
    }
    AliasEdit::Set(name.to_string(), expansion.to_string())
}

/// Expand the command word of `line` if it is an alias.
///
/// Only the first word is looked at, and only once: an alias whose expansion
/// begins with another alias is left alone rather than followed, because a loop
/// between two aliases would otherwise be a hang. The rest of the line is the
/// argument list and passes through untouched, so `bal --depth 2` works.
///
/// Returns the line to run and the alias that was used, if any.
pub fn expand_alias(
    line: &str,
    aliases: &[(String, String)],
) -> (String, Option<(String, String)>) {
    let trimmed = line.trim();
    let (head, rest) = match trimmed.split_once(char::is_whitespace) {
        Some((head, rest)) => (head, rest),
        None => (trimmed, ""),
    };
    let Some((name, expansion)) = aliases
        .iter()
        .find(|(name, _)| name == head)
        .map(|(name, expansion)| (name.clone(), expansion.clone()))
    else {
        return (trimmed.to_string(), None);
    };
    let expanded = if rest.trim().is_empty() {
        expansion.clone()
    } else {
        format!("{expansion} {}", rest.trim())
    };
    (expanded, Some((name, expansion)))
}

/// What the terminal prints when `alias` is given the list of them.
pub fn alias_list(aliases: &[(String, String)]) -> String {
    if aliases.is_empty() {
        return "No aliases yet. `alias bal=balance --tree` makes `bal` run that.\r\n"
            .to_string();
    }
    let mut text = String::from("Aliases:\r\n");
    for (name, expansion) in aliases {
        text.push_str(&format!("  {name} = {expansion}\r\n"));
    }
    text.push_str("`unalias <name>` removes one.\r\n");
    text
}

/// The note printed when a command was expanded, so it is never a surprise that
/// something other than what was typed ran.
pub fn alias_note(name: &str, expansion: &str) -> String {
    format!("[{name} → {expansion}]")
}

/// The most recent history entry before `from` that contains `query`.
///
/// This is Ctrl+R: incremental reverse search, so the caller narrows `query` a
/// character at a time and asks again. Case-insensitive, like the scrollback
/// search, and `from` is the index to search *before*, which is how repeated
/// Ctrl+R walks backwards through the matches.
pub fn reverse_search(history: &[String], query: &str, from: Option<usize>) -> Option<(usize, String)> {
    if history.is_empty() {
        return None;
    }
    let needle = query.to_lowercase();
    let start = from.unwrap_or(history.len()).min(history.len());
    // Walking backwards, so the first hit is the most recent one.
    history[..start]
        .iter()
        .enumerate()
        .rev()
        .find(|(_, entry)| entry.to_lowercase().contains(&needle))
        .map(|(index, entry)| (index, entry.clone()))
}

/// Where a search term was found in the scrollback.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Hit {
    /// Index of the line the match starts on.
    pub row: usize,
    /// Character column the match starts at.
    pub column: usize,
    /// Length of the match, in characters.
    pub length: usize,
    /// Which match this is, counting from 1, and how many there are in total.
    pub index: usize,
    pub total: usize,
}

/// Find `term` in `lines`, starting after `from` and wrapping once.
///
/// Case-insensitive, because a terminal search usually is and journals are full
/// of names whose capitalisation nobody remembers. `from` is `None` for the first
/// search, and the last match's position otherwise, so pressing `n` repeatedly
/// walks forward rather than sticking on the match it just showed — and a line
/// with two matches yields both. Wrapping is what makes `n` useful on the last
/// match instead of silently doing nothing.
pub fn search_lines(
    lines: &[(usize, String)],
    term: &str,
    from: Option<(usize, usize)>,
    backwards: bool,
) -> Option<Hit> {
    let needle = term.trim().to_lowercase();
    if needle.is_empty() || lines.is_empty() {
        return None;
    }

    // Every match, so the caller can say "3 of 17" and so `n` knows where it is.
    let mut matches: Vec<(usize, usize, usize)> = Vec::new();
    for (row, line) in lines.iter() {
        let haystack = line.to_lowercase();
        let mut start = 0usize;
        while let Some(offset) = haystack[start..].find(&needle) {
            let column = haystack[..start + offset].chars().count();
            matches.push((*row, column, needle.chars().count()));
            start += offset + needle.len();
            if start >= haystack.len() {
                break;
            }
        }
    }
    if matches.is_empty() {
        return None;
    }

    let count = matches.len();
    let index = match from {
        None => {
            if backwards {
                count - 1
            } else {
                0
            }
        }
        Some(position) => {
            if backwards {
                matches
                    .iter()
                    .rposition(|(row, column, _)| (*row, *column) < position)
                    .unwrap_or(count - 1)
            } else {
                matches
                    .iter()
                    .position(|(row, column, _)| (*row, *column) > position)
                    .unwrap_or(0)
            }
        }
    };
    let (row, column, length) = matches[index];
    Some(Hit {
        row,
        column,
        length,
        index: index + 1,
        total: count,
    })
}

/// The prompt shown while Ctrl+R is narrowing a search, as readline shows it.
pub fn isearch_prompt(query: &str) -> String {
    format!("(reverse-i-search)`{query}': ")
}

/// What the terminal prints after a run that wrote files.
///
/// Writing instead of printing is what `-o` is for, and the file only exists
/// inside the run's in-memory mount, so saying where it went matters more than
/// usual: without this the command looks like it did nothing.
pub fn wrote_note(files: &[(String, usize, bool)]) -> String {
    let mut text = String::from("[");
    for (index, (path, bytes, replaced)) in files.iter().enumerate() {
        if index > 0 {
            text.push(';');
        }
        text.push_str(&format!(
            "{}{} {path} ({})",
            if index > 0 { " " } else { "" },
            if *replaced { "changed" } else { "wrote" },
            bytes_label(*bytes)
        ));
    }
    let names: Vec<&str> = files.iter().map(|(path, _, _)| path.as_str()).collect();
    text.push_str(&format!(
        " — saved; `download {}` for a copy]",
        names.first().copied().unwrap_or("")
    ));
    text
}

/// A size as a person would say it.
pub fn bytes_label(bytes: usize) -> String {
    const KB: f64 = 1024.0;
    const MB: f64 = KB * 1024.0;
    let bytes = bytes as f64;
    if bytes >= MB {
        format!("{:.1} MB", bytes / MB)
    } else if bytes >= KB {
        format!("{:.1} KB", bytes / KB)
    } else {
        format!("{bytes:.0} bytes")
    }
}

/// What the terminal prints for `download` with no argument.
pub fn download_list(files: &[String]) -> String {
    if files.is_empty() {
        // "Written" rather than "downloaded": `put` shows this list too, and the
        // file has not been saved anywhere yet either way.
        return "Nothing has been written yet. `-o FILE` on a command writes a file — \
                for example `balance -O csv -o balance.csv`.\r\n"
            .to_string();
    }
    let mut text = String::from("Written by commands this session:\r\n");
    for path in files {
        text.push_str(&format!("  {path}\r\n"));
    }
    text.push_str("`download <path>` saves one to your computer.\r\n");
    text
}

/// The note printed above a chart, so it is always clear what was drawn.
///
/// A chart is the app's interpretation, not hledger's output, and the numbers are
/// hledger's own; saying which command produced them is the difference between a
/// picture and a claim.
pub fn chart_note(command: &str) -> String {
    format!("[chart of `{command}` — hledger's numbers, drawn]")
}

/// Read an on/off argument, accepting the spellings people actually type.
pub fn parse_switch(text: &str) -> Result<bool, String> {
    match text.trim().to_lowercase().as_str() {
        "on" | "yes" | "true" | "1" | "enable" | "enabled" => Ok(true),
        "off" | "no" | "false" | "0" | "disable" | "disabled" => Ok(false),
        other => Err(format!("`{other}` is not on or off. Try `screenreader on`.")),
    }
}

/// Read a font size from a command argument, clamped to the usable range.
///
/// Clamping rather than refusing on purpose: `font 100` plainly means "as big as
/// it goes", and the keyboard shortcuts already clamp.
pub fn font_size(text: &str) -> Result<u32, String> {
    let trimmed = text.trim();
    if trimmed.is_empty() {
        return Err("Give a size in pixels, like `font 18`.".to_string());
    }
    match trimmed.parse::<u32>() {
        Ok(size) => Ok(size.clamp(MIN_FONT, MAX_FONT)),
        Err(_) => Err(format!(
            "`{trimmed}` is not a number. Give a size in pixels, like `font 18` ({} to {}).",
            MIN_FONT, MAX_FONT
        )),
    }
}

/// The prompt for the journal being read.
///
/// A terminal that shows only `$ ` makes "which journal is this?" a question you
/// have to ask. The file's own name is enough to answer it and short enough not to
/// eat the line; `(no journal)` says plainly that nothing is loaded.
pub fn prompt_for(main: Option<&str>) -> String {
    match main {
        Some(path) => {
            let name = path.rsplit('/').next().unwrap_or(path);
            if name.is_empty() {
                "$ ".to_string()
            } else {
                format!("{name} $ ")
            }
        }
        None => "(no journal) $ ".to_string(),
    }
}

/// What the terminal prints after loading the demo.
pub fn demo_loaded(files: usize, main: &str) -> String {
    format!(
        "Loaded the demo journal ({files} file(s)) — reading `{main}`. It is a sample; \
         `upload` replaces it.\r\n",
    )
}

/// What the terminal prints on a cold start.
pub fn welcome(version: &str) -> String {
    format!(
        "hledger-anywhere — hledger {version} (wasm32-wasi), running entirely in this tab.\r\n\
         No journal is loaded. Type `upload` for files, `upload_dir` for a folder,\r\n\
         `demo` to try it on a sample journal, or `?` for help.\r\n",
    )
}

/// What the terminal prints when files came back from a previous visit.
pub fn resumed(count: usize, main: &str) -> String {
    format!(
        "Resumed {count} file(s) from last time — reading `{main}`. \
         `journal` lists or changes it.\r\n",
    )
}

/// What the terminal prints after files arrive, from wherever they came.
///
/// `source` is the verb: files are uploaded, dropped or read from an account, and
/// saying "Uploaded" after `remote` would be a lie about where they went.
pub fn files_arrived(
    source: &str,
    loaded: &[String],
    skipped: &[(String, String)],
    main: Option<&str>,
) -> String {
    let mut text = format!("{source} {} file(s).\r\n", loaded.len());
    for path in loaded {
        text.push_str(&format!("  {path}\r\n"));
    }
    for (path, reason) in skipped {
        text.push_str(&format!("  skipped {path}: {reason}\r\n"));
    }
    match main {
        Some(main) => {
            text.push_str(&format!("Reading `{main}`. Try `hledger balance`.\r\n"));
        }
        None => {
            text.push_str(
                "None of those looks like a journal (.journal, .hledger or .j), so hledger has \
                 nothing to read yet.\r\n",
            );
        }
    }
    text
}

/// What the terminal prints for `journal` with no argument.
pub fn file_list(files: &[String], main: Option<&str>) -> String {
    if files.is_empty() {
        return "No files uploaded yet. Type `upload`.\r\n".to_string();
    }
    let mut text = String::from("Uploaded files:\r\n");
    for path in files {
        let marker = if Some(path.as_str()) == main {
            "*"
        } else {
            " "
        };
        text.push_str(&format!(" {marker} {path}\r\n"));
    }
    text.push_str("The `*` is the one hledger reads. `journal <path>` changes it.\r\n");
    text
}

/// The app's own help, for `?`. Deliberately short: `hledger help` is one
/// keystroke away and knows far more.
pub fn help() -> String {
    "This is a terminal for hledger, running in your browser. Everything you type is\n\
     passed to hledger unchanged, without needing -f: the loaded files are mounted and\n\
     LEDGER_FILE points at the one being read.\n\
     \n\
       upload            choose files to add\n\
       upload_dir        choose a folder to add, keeping the paths inside it\n\
       demo              load a small built-in journal to try things on\n\
       journal           list loaded files and mark the one being read\n\
       journal <path>    read a different loaded file\n\
       download <path>   save a file a command wrote with -o\n\
       alias name=cmd    make `name` run `cmd` (`alias` lists, `unalias` removes)\n\
       connect user@host connect a remoteStorage account, then `remote`\n\
       remote [dir]      load every journal file under /hledger/ (or a folder in it)\n\
       disconnect        forget the account (the files stay in the cache)\n\
       put <path>        save a file hledger wrote into the connected account\n\
       font [size]       show or set the font size (Ctrl+= / Ctrl+- / Ctrl+0 too)\n\
       screenreader on   turn the accessibility tree on (off turns it off)\n\
       chart [args]      draw a report instead of printing it, e.g. `chart expenses -M`\n\
       cmd >> file       run `cmd` and append its output to a loaded file\n\
       append file       type or paste journal text into a file, ending with `.`\n\
       /text             search the output; n and N repeat the search\n\
       clear             clear the screen\n\
       ?                 this help\n\
     \n\
     Keys: Enter runs; Tab completes commands, flags, accounts, aliases and paths;\n\
     Up/Down recall history; Ctrl+C stops a running command or clears the line.\n\
     Emacs/readline keys work too: Ctrl+A/E line ends, Ctrl+B/F back and forward,\n\
     Ctrl+K/U/W kill, Ctrl+Y yank, Ctrl+T transpose, Ctrl+D delete, Alt+B/F by word,\n\
     Ctrl+L clear, Ctrl+R reverse search the history, Ctrl+= and Ctrl+- the font.\n\
     Try `hledger stats` or `hledger balance --tree`.\n"
        .to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn editor() -> Editor {
        Editor::with_history(vec!["balance".to_string(), "print".to_string()])
    }

    #[test]
    fn typing_and_moving_puts_text_where_the_cursor_is() {
        let mut e = Editor::default();
        e.insert("balance");
        assert_eq!(e.line(), "balance");
        assert_eq!(e.cursor(), 7);

        e.home();
        e.insert("hledger ");
        assert_eq!(e.line(), "hledger balance");

        e.end();
        e.left();
        e.left();
        e.insert("X");
        assert_eq!(e.line(), "hledger balanXce");
    }

    #[test]
    fn deleting_respects_the_cursor() {
        let mut e = Editor::default();
        e.insert("abc");
        e.backspace();
        assert_eq!(e.line(), "ab");
        e.home();
        e.delete();
        assert_eq!(e.line(), "b", "delete removes the character under the cursor");
        e.delete();
        assert_eq!(e.line(), "");
        e.delete();
        assert_eq!(e.line(), "", "delete on an empty line is a no-op");

        let mut e = Editor::default();
        e.backspace();
        assert_eq!(e.line(), "");
    }

    #[test]
    fn arrows_stop_at_the_ends() {
        let mut e = Editor::default();
        e.insert("ab");
        e.left();
        e.left();
        e.left();
        assert_eq!(e.cursor(), 0);
        for _ in 0..5 {
            e.right();
        }
        assert_eq!(e.cursor(), 2);
    }

    #[test]
    fn multi_byte_characters_are_edited_whole() {
        let mut e = Editor::default();
        e.insert("café ☕");
        e.backspace();
        assert_eq!(e.line(), "café ");
        e.home();
        e.right();
        e.right();
        e.right();
        e.insert("!");
        assert_eq!(e.line(), "caf!é ");
        e.delete();
        assert_eq!(e.line(), "caf! ");
    }

    #[test]
    fn control_characters_never_reach_the_line() {
        let mut e = Editor::default();
        e.insert("a\u{7}b\u{1b}[A");
        assert_eq!(e.line(), "ab[A");
    }

    #[test]
    fn history_walks_back_and_returns_the_draft() {
        let mut e = editor();
        e.insert("half-typed");
        e.history_prev();
        assert_eq!(e.line(), "print");
        e.history_prev();
        assert_eq!(e.line(), "balance");
        e.history_prev();
        assert_eq!(e.line(), "balance", "the oldest entry is a wall");
        e.history_next();
        assert_eq!(e.line(), "print");
        e.history_next();
        assert_eq!(e.line(), "half-typed", "the draft comes back");
        e.history_next();
        assert_eq!(e.line(), "half-typed");
    }

    #[test]
    fn taking_a_line_empties_the_editor_and_refuses_a_blank_one() {
        // What goes into the history is the caller's decision now — see
        // `only_commands_go_into_the_history` — so this is about the line itself.
        let mut e = Editor::with_history(Vec::new());
        e.insert("   ");
        assert_eq!(e.take(), None, "a blank line is not a command");

        e.insert("balance");
        assert_eq!(e.take().as_deref(), Some("balance"));
        assert_eq!(e.line(), "");
        assert_eq!(e.cursor(), 0);

        e.insert("print");
        assert_eq!(e.take().as_deref(), Some("print"));
    }

    #[test]
    fn tab_completes_one_match_outright() {
        // "cash" is unique among hledger's commands; "bal" is not, which is the
        // next test's subject.
        let mut e = Editor::default();
        e.insert("cash");
        assert_eq!(e.complete(&candidates(&[])), Completion::Completed);
        assert_eq!(e.line(), "cashflow ");
    }

    #[test]
    fn tab_extends_to_the_common_prefix_then_lists() {
        let mut e = Editor::default();
        e.insert("pr");
        // prices / print / print-unique agree up to "pri", so Tab extends that
        // far and stops.
        assert_eq!(e.complete(&candidates(&[])), Completion::Extended);
        assert_eq!(e.line(), "pri");

        // A second Tab has nothing left to extend, so it lists the options.
        match e.complete(&candidates(&[])) {
            Completion::Ambiguous(options) => {
                assert!(options.contains(&"print".to_string()));
                assert!(options.contains(&"print-unique".to_string()));
            }
            other => panic!("expected an ambiguous completion, got {other:?}"),
        }
        assert_eq!(e.line(), "pri", "an ambiguous Tab leaves the line alone");
    }

    #[test]
    fn completion_offers_something_for_a_bare_tab_and_for_paths() {
        let mut e = Editor::default();
        assert!(matches!(e.complete(&candidates(&[])), Completion::Ambiguous(_)));

        let mut e = Editor::default();
        e.insert("books/2024");
        let paths = vec!["books/2024.journal".to_string()];
        assert_eq!(e.complete(&candidates(&paths)), Completion::Completed);
        assert_eq!(e.line(), "books/2024.journal ");
    }

    #[test]
    fn completion_keeps_the_rest_of_the_line_and_puts_the_cursor_after_it() {
        // Completing a query term in the middle of a command must not throw away
        // the arguments that follow it.
        let mut e = Editor::default();
        e.insert("stat assets");
        e.home();
        e.right();
        e.right();
        e.right();
        e.right();
        assert_eq!(e.token(), "stat");
        assert_eq!(e.complete(&candidates(&[])), Completion::Completed);
        assert_eq!(e.line(), "stats  assets");
        // The cursor sits just after the completed word, before the tail.
        assert_eq!(e.cursor(), 6);
    }

    #[test]
    fn search_and_download_are_the_apps_but_nothing_else_is_shadowed() {
        assert_eq!(classify("/rent"), Command::Search(Some("rent")));
        assert_eq!(classify("/  spaced  "), Command::Search(Some("spaced")));
        assert_eq!(classify("/"), Command::Search(Some("")));
        assert_eq!(classify("n"), Command::SearchAgain(false));
        assert_eq!(classify("N"), Command::SearchAgain(true));
        assert_eq!(classify("demo"), Command::Demo);
        assert_eq!(classify("download out.csv"), Command::Download(Some("out.csv")));
        assert_eq!(classify("download"), Command::Download(None));

        // The words that must still reach hledger.
        for line in ["balance", "print --explicit", "notes", "codes", "stats --help"] {
            assert!(
                matches!(classify(line), Command::Hledger(_)),
                "{line} should go to hledger"
            );
        }
    }

    #[test]
    fn the_demo_journal_is_a_whole_journal_not_a_fragment() {
        // It is shown to a first-time visitor, so it has to exercise the things
        // the app claims: a second file, an include of it, several accounts,
        // commodities, tags and a price.
        assert!(DEMO_JOURNAL.contains("include demo-prices.journal"));
        assert!(DEMO_JOURNAL.contains("expenses:"));
        assert!(DEMO_JOURNAL.contains("income:"));
        assert!(DEMO_JOURNAL.contains("assets:"));
        assert!(DEMO_JOURNAL.contains("; weekly shop"));
        assert!(DEMO_JOURNAL.contains("(rent:january)"));
        assert!(DEMO_PRICES.contains("P 2024-02-01"));
        // Every top-level line is either a directive or a dated transaction, so
        // the journal is not accidentally missing a date or indented wrongly.
        for line in DEMO_JOURNAL.lines() {
            if line.is_empty() || line.starts_with([' ', ';']) {
                continue;
            }
            assert!(
                line.starts_with("20") || line.starts_with("include"),
                "unexpected top-level line: {line}"
            );
        }
    }

    #[test]
    fn only_four_words_are_the_apps() {
        assert_eq!(classify("upload"), Command::Upload);
        assert_eq!(classify("  upload  "), Command::Upload);
        assert_eq!(classify("upload_dir"), Command::UploadDir);
        assert_eq!(classify("clear"), Command::Clear);
        assert_eq!(classify("?"), Command::Help);
        assert_eq!(classify("journal"), Command::Journal(None));
        assert_eq!(classify("journal books/2024.journal"), Command::Journal(Some("books/2024.journal")));
        assert_eq!(classify("balance --tree"), Command::Hledger("balance --tree"));
        assert_eq!(classify("hledger stats"), Command::Hledger("hledger stats"));
        // hledger's own help must reach hledger, not the app's.
        assert_eq!(classify("help"), Command::Hledger("help"));
        assert_eq!(classify("uploads"), Command::Hledger("uploads"));
    }

    #[test]
    fn small_output_is_shown_exactly_as_it_came() {
        let (shown, note) = visible_output("balance\n  1  assets\n");
        assert_eq!(shown, "balance\n  1  assets\n");
        assert_eq!(note, None);
    }

    #[test]
    fn huge_output_is_cut_on_a_line_with_an_honest_note() {
        let line = "x".repeat(99) + "\n";
        let huge = line.repeat(MAX_OUTPUT_BYTES / line.len() + 100);
        let (shown, note) = visible_output(&huge);
        assert!(shown.len() <= MAX_OUTPUT_BYTES);
        assert!(shown.ends_with('\n'), "the cut lands on a line boundary");
        let note = note.expect("truncation must be reported");
        assert!(note.contains("truncated"), "{note}");
        assert!(note.contains("MB"), "{note}");
        // It must also say how to get the whole thing, since that is the only
        // reason the reader is being told.
        assert!(note.contains("-o out.csv"), "{note}");
        assert!(note.contains("download"), "{note}");
    }

    #[test]
    fn output_newlines_become_carriage_returns() {
        // A bare \n staircases a terminal; \r\n does not, and an existing
        // \r\n must not become \r\r\n.
        assert_eq!(to_terminal_text("a\nb\n"), "a\r\nb\r\n");
        assert_eq!(to_terminal_text("a\r\nb"), "a\r\nb");
        assert_eq!(to_terminal_text("no newline"), "no newline");
        assert_eq!(to_terminal_text(""), "");
    }

    #[test]
    fn the_prompt_redraws_in_place_and_returns_the_cursor() {
        // Middle of the line: two characters follow the cursor, so it steps back
        // two columns after writing them.
        assert_eq!(prompt_redraw("$ ", "balance", 5), "\r\u{1b}[K$ balance\u{1b}[2D");
        // End of the line: nothing to step back over.
        assert_eq!(prompt_redraw("$ ", "balance", 7), "\r\u{1b}[K$ balance");
        // Empty line.
        assert_eq!(prompt_redraw("$ ", "", 0), "\r\u{1b}[K$ ");
        // The cursor index is in characters, not bytes.
        assert_eq!(prompt_redraw("$ ", "café", 4), "\r\u{1b}[K$ café");
    }

    #[test]
    fn banners_say_what_is_loaded_and_what_to_do() {
        let cold = welcome("1.52.4");
        assert!(cold.contains("1.52.4"));
        assert!(cold.contains("upload"));
        assert!(cold.contains("upload_dir"), "a folder upload must be discoverable");

        let back = resumed(3, "books/hledger.journal");
        assert!(back.contains('3'));
        assert!(back.contains("books/hledger.journal"));

        let up = files_arrived(
            "Uploaded",
            &["hledger.journal".to_string()],
            &[("logo.png".to_string(), "binary".to_string())],
            Some("hledger.journal"),
        );
        assert!(up.contains("Uploaded 1 file(s)"));
        assert!(up.contains("skipped logo.png: binary"));
        assert!(up.contains("hledger balance"));

        let nothing = files_arrived("Uploaded", &["data.csv".to_string()], &[], None);
        assert!(nothing.contains("None of those looks like a journal"));
    }

    fn lines(text: &[&str]) -> Vec<(usize, String)> {
        text.iter()
            .enumerate()
            .map(|(row, line)| (row, (*line).to_string()))
            .collect()
    }

    /// Lines from the middle of a buffer, as the app passes them: only output,
    /// with the rows it really occupies.
    fn sparse(pairs: &[(usize, &str)]) -> Vec<(usize, String)> {
        pairs
            .iter()
            .map(|(row, line)| (*row, (*line).to_string()))
            .collect()
    }

    #[test]
    fn a_search_finds_the_first_match_then_walks_forward() {
        let text = lines(&["alpha", "beta groceries", "gamma", "more groceries here"]);

        let first = search_lines(&text, "groceries", None, false).expect("a match exists");
        assert_eq!((first.row, first.column, first.length), (1, 5, 9));
        assert_eq!((first.index, first.total), (1, 2));

        // `from` is what was already shown, so `n` moves on rather than sticking.
        let second = search_lines(&text, "groceries", Some((first.row, first.column)), false)
            .expect("another");
        assert_eq!(second.row, 3);
        assert_eq!((second.index, second.total), (2, 2));

        // Past the last one it wraps, which is what makes `n` useful there.
        let wrapped = search_lines(&text, "groceries", Some((second.row, second.column)), false)
            .expect("wraps");
        assert_eq!(wrapped.row, 1);
        assert_eq!(wrapped.index, 1);
    }

    #[test]
    fn searching_backwards_goes_to_the_last_match_and_wraps() {
        let text = lines(&["groceries one", "nothing", "groceries two"]);
        let last = search_lines(&text, "GROCERIES", None, true).expect("case-insensitive");
        assert_eq!(last.row, 2);
        assert_eq!(last.total, 2);

        let earlier = search_lines(&text, "groceries", Some((last.row, last.column)), true)
            .expect("earlier");
        assert_eq!(earlier.row, 0);

        let wrapped = search_lines(&text, "groceries", Some((earlier.row, earlier.column)), true)
            .expect("wraps");
        assert_eq!(wrapped.row, 2);
    }

    #[test]
    fn two_matches_on_one_line_are_both_counted_and_both_reachable() {
        let text = lines(&["a a a"]);
        let first = search_lines(&text, "a", None, false).expect("match");
        assert_eq!(first.total, 3);
        assert_eq!((first.index, first.column), (1, 0));

        let second = search_lines(&text, "a", Some((first.row, first.column)), false).expect("2nd");
        assert_eq!((second.index, second.column), (2, 2));
        let third = search_lines(&text, "a", Some((second.row, second.column)), false).expect("3rd");
        assert_eq!((third.index, third.column), (3, 4));

        // Columns are characters, not bytes, so a match after a multi-byte word
        // still lands where the eye expects.
        let text = lines(&["café x"]);
        let hit = search_lines(&text, "x", None, false).expect("match");
        assert_eq!(hit.column, 5);
    }

    #[test]
    fn rows_are_the_callers_rows_not_the_lists() {
        // The app hands over only the output lines, which are not contiguous in
        // the buffer; a hit has to report where the line really is, or scrolling
        // to it lands somewhere else.
        let output = sparse(&[(12, "alpha"), (13, "beta groceries"), (30, "more groceries")]);
        let hit = search_lines(&output, "groceries", None, false).expect("match");
        assert_eq!(hit.row, 13);
        let next = search_lines(&output, "groceries", Some((hit.row, hit.column)), false)
            .expect("match");
        assert_eq!(next.row, 30);
    }

    #[test]
    fn a_search_that_finds_nothing_says_nothing_rather_than_guessing() {
        assert_eq!(search_lines(&lines(&["alpha"]), "zebra", None, false), None);
        assert_eq!(search_lines(&lines(&["alpha"]), "   ", None, false), None);
        assert_eq!(search_lines(&[], "alpha", None, false), None);
    }

    #[test]
    fn taken_lines_keep_their_indentation() {
        // Four spaces are a posting, not noise: trimming here is what made a
        // transaction typed into the terminal unreadable to hledger.
        let mut e = Editor::default();
        e.insert("    expenses:food  $4.00");
        assert_eq!(e.take().as_deref(), Some("    expenses:food  $4.00"));

        // A line of nothing but spaces is still nothing.
        let mut e = Editor::default();
        e.insert("   ");
        assert_eq!(e.take(), None);

        // And a command keeps its own spaces until whatever needs them trimmed
        // asks for them.
        let mut e = Editor::default();
        e.insert("  balance --tree  ");
        assert_eq!(e.take().as_deref(), Some("  balance --tree  "));
    }

    #[test]
    fn only_commands_go_into_the_history() {
        let mut e = Editor::default();
        e.remember("balance");
        e.remember("balance");
        e.remember("   ");
        e.remember("stats");
        assert_eq!(e.history(), ["balance", "stats"]);
    }

    #[test]
    fn killing_and_yanking_round_trips_through_the_ring() {
        let mut e = Editor::default();
        e.insert("balance assets:bank");
        // Ctrl+K kills from the cursor to the end, which means the cursor has to
        // be where the wanted text starts.
        e.home();
        for _ in 0..8 {
            e.right();
        }
        e.kill_to_end();
        assert_eq!(e.line(), "balance ");
        assert_eq!(e.kill_ring, ["assets:bank"]);
        e.yank();
        assert_eq!(e.line(), "balance assets:bank");

        // Ctrl+U kills back to the start, and the newest kill is what Ctrl+Y
        // brings back.
        e.kill_to_start();
        assert_eq!(e.line(), "");
        assert_eq!(e.kill_ring.len(), 2);
        e.yank();
        assert_eq!(e.line(), "balance assets:bank");
    }

    #[test]
    fn ctrl_w_takes_the_whole_previous_word() {
        let mut e = Editor::default();
        e.insert("balance expenses:food:groceries");
        e.kill_word_backward();
        assert_eq!(e.line(), "balance ");
        assert_eq!(e.kill_ring, ["expenses:food:groceries"]);
        e.yank();
        assert_eq!(e.line(), "balance expenses:food:groceries");

        // At the start there is no word to take, and nothing lands in the ring.
        let mut e = Editor::default();
        e.insert("balance");
        e.home();
        e.kill_word_backward();
        assert_eq!(e.line(), "balance");
        assert!(e.kill_ring.is_empty());
    }

    #[test]
    fn yanking_an_empty_ring_does_nothing_rather_than_complaining() {
        let mut e = Editor::default();
        e.insert("balance");
        e.yank();
        assert_eq!(e.line(), "balance");
    }

    #[test]
    fn transposing_fixes_the_character_you_just_got_wrong() {
        // "balance" typed with the first two letters the wrong way round.
        let mut e = Editor::default();
        e.insert("ablance");
        e.home();
        e.right();
        e.transpose();
        assert_eq!(e.line(), "balance");
        assert_eq!(e.cursor(), 2, "the cursor ends up past the pair");

        // At the end, Emacs swaps the last two.
        let mut e = Editor::default();
        e.insert("ab");
        e.transpose();
        assert_eq!(e.line(), "ba");

        // Nothing to swap.
        let mut e = Editor::default();
        e.insert("a");
        e.transpose();
        assert_eq!(e.line(), "a");
    }

    #[test]
    fn word_motion_moves_by_words() {
        let mut e = Editor::default();
        e.insert("balance expenses:food --tree");
        e.word_left();
        assert_eq!(e.cursor(), 22);
        e.word_left();
        assert_eq!(e.cursor(), 8);
        e.word_left();
        assert_eq!(e.cursor(), 0);
        e.word_left();
        assert_eq!(e.cursor(), 0, "the start is a wall");

        e.word_right();
        assert_eq!(e.cursor(), 7);
        e.word_right();
        assert_eq!(e.cursor(), 21);
        e.word_right();
        assert_eq!(e.cursor(), 28);
        e.word_right();
        assert_eq!(e.cursor(), 28, "the end is a wall");
    }

    #[test]
    fn reverse_search_finds_the_most_recent_match_and_walks_backwards() {
        let history: Vec<String> = ["balance assets", "print", "balance expenses", "stats"]
            .iter()
            .map(|entry| (*entry).to_string())
            .collect();

        // Ctrl+R with nothing typed yet takes the newest entry at all.
        let (index, entry) = reverse_search(&history, "", None).expect("a match");
        assert_eq!((index, entry.as_str()), (3, "stats"));

        // Typing narrows it, newest match first.
        let (index, entry) = reverse_search(&history, "balance", None).expect("a match");
        assert_eq!((index, entry.as_str()), (2, "balance expenses"));

        // Pressing Ctrl+R again goes further back.
        let (index, entry) = reverse_search(&history, "balance", Some(index)).expect("another");
        assert_eq!((index, entry.as_str()), (0, "balance assets"));

        // Past the oldest there is nothing, and the search says so.
        assert_eq!(reverse_search(&history, "balance", Some(index)), None);
        assert_eq!(reverse_search(&history, "nothing here", None), None);
        assert_eq!(reverse_search(&[], "balance", None), None);

        // Case-insensitive, like the other search.
        assert!(reverse_search(&history, "BALANCE", None).is_some());
    }

    #[test]
    fn the_remote_commands_are_the_apps_and_nothing_else_is_shadowed() {
        assert_eq!(classify("connect user@5apps.com"), Command::Connect(Some("user@5apps.com")));
        assert_eq!(classify("connect"), Command::Connect(None));
        assert_eq!(classify("disconnect"), Command::Disconnect);
        assert_eq!(classify("remote"), Command::Remote(None));
        assert_eq!(classify("remote books"), Command::Remote(Some("books")));
        // hledger's own `close` and `roi` are untouched, and so is `remote`-ish text.
        assert_eq!(classify("remote-control"), Command::Hledger("remote-control"));
        assert_eq!(classify("close"), Command::Hledger("close"));
    }

    #[test]
    fn an_alias_replaces_the_command_word_and_keeps_the_arguments() {
        let aliases = vec![
            ("bal".to_string(), "balance --tree".to_string()),
            ("m".to_string(), "balance -M".to_string()),
        ];
        let (line, used) = expand_alias("bal", &aliases);
        assert_eq!(line, "balance --tree");
        assert_eq!(used.map(|(name, _)| name).as_deref(), Some("bal"));

        // Arguments are the user's, and follow the expansion.
        let (line, _) = expand_alias("bal --depth 2", &aliases);
        assert_eq!(line, "balance --tree --depth 2");

        // Only the command word is looked at, and only once.
        let (line, used) = expand_alias("print bal", &aliases);
        assert_eq!((line.as_str(), used), ("print bal", None));
        let (line, _) = expand_alias("m m", &aliases);
        assert_eq!(line, "balance -M m", "expansion is not followed twice");

        // Nothing aliased, nothing changed.
        let (line, used) = expand_alias("balance", &[]);
        assert_eq!((line.as_str(), used), ("balance", None));
        let (line, _) = expand_alias("  stats  ", &aliases);
        assert_eq!(line, "stats", "the line is trimmed");
    }

    #[test]
    fn an_alias_is_written_name_equals_command() {
        assert_eq!(
            parse_alias("bal=balance --tree"),
            AliasEdit::Set("bal".to_string(), "balance --tree".to_string())
        );
        // The expansion may contain `=`, which a query often does.
        assert_eq!(
            parse_alias("nw=balance --value=cost"),
            AliasEdit::Set("nw".to_string(), "balance --value=cost".to_string())
        );

        // And the complaints say what to do instead.
        for bad in ["bal", "two words=x", "=balance", "bal="] {
            match parse_alias(bad) {
                AliasEdit::Bad(message) => assert!(!message.is_empty(), "{bad}"),
                other => panic!("{bad} should not be accepted: {other:?}"),
            }
        }
    }

    #[test]
    fn the_alias_list_says_how_to_start_and_how_to_remove() {
        assert!(alias_list(&[]).contains("alias bal=balance --tree"));
        let listing = alias_list(&[("bal".to_string(), "balance --tree".to_string())]);
        assert!(listing.contains("bal = balance --tree"));
        assert!(listing.contains("unalias"));
    }

    #[test]
    fn the_prompt_names_the_journal_without_eating_the_line() {
        assert_eq!(prompt_for(Some("hledger.journal")), "hledger.journal $ ");
        assert_eq!(prompt_for(Some("books/2024.journal")), "2024.journal $ ");
        assert_eq!(prompt_for(Some("/data/deep/path.journal")), "path.journal $ ");
        assert_eq!(prompt_for(None), "(no journal) $ ");
        // A path with no name in it falls back to the plain prompt rather than a
        // dangling separator.
        assert_eq!(prompt_for(Some("books/")), "$ ");
    }

    #[test]
    fn the_font_steps_between_limits_and_stops_there() {
        assert_eq!(step_font(14, 1), 16);
        assert_eq!(step_font(14, -1), 12);
        assert_eq!(step_font(MAX_FONT, 1), MAX_FONT);
        assert_eq!(step_font(MIN_FONT, -1), MIN_FONT);
        // Never past either end, from any starting point.
        assert_eq!(step_font(MAX_FONT - 1, 1), MAX_FONT);
        assert_eq!(step_font(MIN_FONT + 1, -1), MIN_FONT);
        assert_eq!(step_font(0, -1), MIN_FONT);
        const { assert!(MIN_FONT < DEFAULT_FONT && DEFAULT_FONT < MAX_FONT) };
    }

    #[test]
    fn the_isearch_prompt_looks_like_the_one_people_know() {
        assert_eq!(isearch_prompt("bal"), "(reverse-i-search)`bal\': ");
        assert_eq!(isearch_prompt(""), "(reverse-i-search)`\': ");
    }

    #[test]
    fn a_run_that_wrote_files_says_so_and_how_to_get_them() {
        let note = wrote_note(&[("out.csv".to_string(), 118, false)]);
        assert!(note.starts_with("[wrote out.csv"), "no stray gap: {note}");
        assert!(note.ends_with("]"), "{note}");
        assert!(note.contains("out.csv"));
        assert!(note.contains("118 bytes"));
        assert!(note.contains("download out.csv"), "{note}");

        let two = wrote_note(&[
            ("a.csv".to_string(), 10, false),
            ("b.csv".to_string(), 20, false),
        ]);
        assert!(two.contains("a.csv (10 bytes)"));
        assert!(two.contains("b.csv (20 bytes)"));
    }

    #[test]
    fn a_written_file_says_whether_it_was_new_or_changed() {
        let note = wrote_note(&[
            ("bal.csv".to_string(), 326, false),
            ("data/2024.journal".to_string(), 4096, true),
        ]);
        assert!(note.contains("wrote bal.csv (326 bytes)"), "{note}");
        assert!(note.contains("changed data/2024.journal (4.0 KB)"), "{note}");
        // And that it was kept, with the command that gets a copy.
        assert!(note.contains("saved"), "{note}");
        assert!(note.contains("`download bal.csv`"), "{note}");
    }

    #[test]
    fn sizes_are_written_the_way_people_say_them() {
        assert_eq!(bytes_label(0), "0 bytes");
        assert_eq!(bytes_label(326), "326 bytes");
        assert_eq!(bytes_label(1024), "1.0 KB");
        assert_eq!(bytes_label(1536), "1.5 KB");
        assert_eq!(bytes_label(1024 * 1024), "1.0 MB");
        assert_eq!(bytes_label(3 * 1024 * 1024 + 512 * 1024), "3.5 MB");
    }

    #[test]
    fn the_download_list_explains_itself_when_there_is_nothing_to_save() {
        let nothing = download_list(&[]);
        assert!(nothing.contains("-o FILE"), "{nothing}");
        // It must not promise a download: `put` shows the same list.
        assert!(nothing.contains("has been written yet"), "{nothing}");
        assert!(!nothing.contains("  "), "the message has a stray gap: {nothing}");
        let listing = download_list(&["out.csv".to_string()]);
        assert!(listing.contains("out.csv"));
        assert!(listing.contains("download <path>"));
    }

    #[test]
    fn a_font_size_is_read_from_a_command_as_well_as_a_key() {
        // A phone has no Ctrl+=, so the size has to be reachable by typing.
        assert_eq!(font_size("18"), Ok(18));
        assert_eq!(font_size(" 12 "), Ok(12));
        // Clamped rather than refused, like the keys are.
        assert_eq!(font_size("4"), Ok(MIN_FONT));
        assert_eq!(font_size("400"), Ok(MAX_FONT));
        assert!(font_size("big").is_err());
        assert!(font_size("").is_err());
        let complaint = font_size("big").expect_err("not a number");
        assert!(complaint.contains("number"), "{complaint}");
    }

    #[test]
    fn an_on_off_argument_is_read_generously() {
        for yes in ["on", "ON", " yes ", "true", "1", "enable", "enabled"] {
            assert_eq!(parse_switch(yes), Ok(true), "{yes}");
        }
        for no in ["off", "No", "false", "0", "disable", "disabled"] {
            assert_eq!(parse_switch(no), Ok(false), "{no}");
        }
        // It has to say what to type instead, not just that it is wrong.
        let complaint = parse_switch("maybe").expect_err("not a switch");
        assert!(complaint.contains("on or off"), "{complaint}");
        assert!(complaint.contains("screenreader on"), "{complaint}");
    }

    #[test]
    fn a_paste_is_split_into_lines_and_a_remainder() {
        // An ordinary keypress is not a paste, however many bytes it is.
        assert_eq!(paste("a"), None);
        assert_eq!(paste("balance --tree"), None);
        assert_eq!(paste(""), None);

        // A pasted snippet: complete lines, and whatever follows the last newline
        // belongs on the line still being typed.
        let pasted = paste("2024-01-01 * Coffee\n    expenses:food  $4\n").expect("a paste");
        assert_eq!(
            pasted.lines,
            vec!["2024-01-01 * Coffee", "    expenses:food  $4"]
        );
        assert_eq!(pasted.rest, "");

        let pasted = paste("first\r\nsecond\r\nthird").expect("a paste");
        assert_eq!(pasted.lines, vec!["first", "second"]);
        assert_eq!(pasted.rest, "third", "CRLF is one newline, not two");

        // A blank line in the middle is a line of its own, not something to drop.
        let pasted = paste("a\n\nb").expect("a paste");
        assert_eq!(pasted.lines, vec!["a", ""]);
        assert_eq!(pasted.rest, "b");
    }

    #[test]
    fn a_block_ends_on_a_dot_alone_and_says_how_to_finish() {
        assert!(ends_block("."));
        assert!(ends_block("  .  "));
        assert!(!ends_block(".."));
        assert!(!ends_block(""));
        assert!(!ends_block("2024-01-01 * ."));

        let header = block_header("data/2024.journal");
        assert!(header.contains("data/2024.journal"), "{header}");
        assert!(header.contains("Ctrl+C"), "{header}");
    }

    #[test]
    fn a_redirect_is_read_from_the_line() {
        assert_eq!(
            redirect("hledger import data/2024.csv >> data/2024.journal"),
            Redirect::Append {
                command: "hledger import data/2024.csv".to_string(),
                target: "data/2024.journal".to_string(),
            }
        );
        // No redirect at all is the ordinary case and must pass through untouched.
        assert_eq!(
            redirect("  balance --tree  "),
            Redirect::Plain("balance --tree".to_string())
        );

        // Each way it can be wrong says which part is wrong.
        for (line, expected) in [
            (">> data/x.journal", "before"),
            ("print >>", "append to"),
            ("print >> two words", "more than one word"),
        ] {
            match redirect(line) {
                Redirect::Bad(message) => assert!(message.contains(expected), "{line}: {message}"),
                other => panic!("{line} should be refused: {other:?}"),
            }
        }
    }

    #[test]
    fn a_redirect_target_is_understood_the_way_people_write_it() {
        // The engine's view and the app's view of the same file.
        assert_eq!(append_target("data/2024.journal").as_deref(), Ok("2024.journal"));
        assert_eq!(append_target("2024.journal").as_deref(), Ok("2024.journal"));
        assert_eq!(
            append_target("data/books/2024.journal").as_deref(),
            Ok("books/2024.journal")
        );
        assert_eq!(append_target("./data/x.journal").as_deref(), Ok("x.journal"));

        assert!(append_target("data/").is_err());
        assert!(append_target("../outside.journal").is_err());
        assert!(append_target("data/books/").is_err());
    }

    #[test]
    fn appending_keeps_the_file_well_formed() {
        // Either side missing its newline must not join two entries together.
        assert_eq!(append_text("a\n", "b\n"), "a\nb\n");
        assert_eq!(append_text("a", "b\n"), "a\nb\n");
        assert_eq!(append_text("a\n", "b"), "a\nb\n");
        assert_eq!(append_text("a", "b"), "a\nb\n");
        // An empty file is not a special case that needs a leading newline.
        assert_eq!(append_text("", "b\n"), "b\n");
        assert_eq!(append_text("", ""), "");
    }

    #[test]
    fn the_append_note_says_what_landed_where() {
        let note = append_note("2024.journal", 12, 4096);
        assert!(note.contains("12 line(s)"), "{note}");
        assert!(note.contains("2024.journal"), "{note}");
        assert!(note.contains("4.0 KB"), "{note}");
    }

    #[test]
    fn a_chart_is_asked_for_like_any_other_command() {
        assert_eq!(classify("chart"), Command::Chart(None));
        assert_eq!(
            classify("chart expenses -M"),
            Command::Chart(Some("expenses -M"))
        );
        // hledger's own commands are untouched, including one that starts the same.
        assert_eq!(classify("charting"), Command::Hledger("charting"));
        assert!(chart_note("balance -M expenses").contains("balance -M expenses"));
    }

    #[test]
    fn the_help_mentions_every_command_the_app_owns() {
        // The help is the only place the vocabulary is written down, so a command
        // that is classified but not documented is a command nobody will find.
        let help = help();
        for word in [
            "upload", "upload_dir", "demo", "journal", "download", "alias", "unalias", "connect",
            "remote", "disconnect", "clear", "?",
        ] {
            assert!(help.contains(word), "help does not mention `{word}`");
        }
    }

    #[test]
    fn the_file_list_marks_the_one_in_use() {
        let files = ["a.journal".to_string(), "b.journal".to_string()];
        let text = file_list(&files, Some("b.journal"));
        assert!(text.contains("  a.journal"));
        assert!(text.contains(" * b.journal"));
        assert!(file_list(&[], None).contains("No files uploaded"));
    }
}
