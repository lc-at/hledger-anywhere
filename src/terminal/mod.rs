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
        let line = self.line().trim().to_string();
        self.clear_line();
        self.draft.clear();
        if line.is_empty() {
            return None;
        }
        if self.history.last() != Some(&line) {
            self.history.push(line.clone());
        }
        Some(line)
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
pub fn wrote_note(files: &[(String, usize)]) -> String {
    let mut text = String::from("[wrote");
    for (path, bytes) in files {
        text.push_str(&format!(" {path} ({bytes} bytes)"));
    }
    let names: Vec<&str> = files.iter().map(|(path, _)| path.as_str()).collect();
    text.push_str(&format!(
        " — `download {}` to save it]",
        names.first().copied().unwrap_or("")
    ));
    text
}

/// What the terminal prints for `download` with no argument.
pub fn download_list(files: &[String]) -> String {
    if files.is_empty() {
        return "Nothing to download yet. `-o FILE` on a command writes a file —                 for example `balance -O csv -o balance.csv`.\r\n"
            .to_string();
    }
    let mut text = String::from("Written by commands this session:\r\n");
    for path in files {
        text.push_str(&format!("  {path}\r\n"));
    }
    text.push_str("`download <path>` saves one to your computer.\r\n");
    text
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

/// What the terminal prints after an upload.
pub fn uploaded(loaded: &[String], skipped: &[(String, String)], main: Option<&str>) -> String {
    let mut text = format!("Uploaded {} file(s).\r\n", loaded.len());
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
     passed to hledger unchanged, without needing -f — the uploaded files are mounted\n\
     and LEDGER_FILE points at the one being read.\n\
     \n\
       upload            choose files to add (folders are not uploaded; pick the files)\n\
       journal           list uploaded files and mark the one being read\n\
       journal <path>    read a different uploaded file\n\
       clear             clear the screen\n\
       ?                 this help\n\
     \n\
     Keys: Enter runs, Up/Down recall history, Tab completes, Ctrl+U or Ctrl+C clears\n\
     the line. Try `hledger stats` or `hledger balance --tree`.\n"
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
    fn history_ignores_blank_lines_and_consecutive_repeats() {
        let mut e = Editor::with_history(Vec::new());
        e.insert("   ");
        assert_eq!(e.take(), None);
        assert!(e.history().is_empty());

        e.insert("balance");
        assert_eq!(e.take().as_deref(), Some("balance"));
        e.insert("balance");
        assert_eq!(e.take().as_deref(), Some("balance"));
        assert_eq!(e.history(), ["balance"], "a repeat is not remembered twice");

        e.insert("print");
        assert_eq!(e.take().as_deref(), Some("print"));
        assert_eq!(e.history(), ["balance", "print"]);
        assert_eq!(e.line(), "");
        assert_eq!(e.cursor(), 0);
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

        let up = uploaded(
            &["hledger.journal".to_string()],
            &[("logo.png".to_string(), "binary".to_string())],
            Some("hledger.journal"),
        );
        assert!(up.contains("Uploaded 1 file(s)"));
        assert!(up.contains("skipped logo.png: binary"));
        assert!(up.contains("hledger balance"));

        let nothing = uploaded(&["data.csv".to_string()], &[], None);
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
    fn the_isearch_prompt_looks_like_the_one_people_know() {
        assert_eq!(isearch_prompt("bal"), "(reverse-i-search)`bal\': ");
        assert_eq!(isearch_prompt(""), "(reverse-i-search)`\': ");
    }

    #[test]
    fn a_run_that_wrote_files_says_so_and_how_to_get_them() {
        let note = wrote_note(&[("out.csv".to_string(), 118)]);
        assert!(note.contains("out.csv"));
        assert!(note.contains("118 bytes"));
        assert!(note.contains("download out.csv"), "{note}");

        let two = wrote_note(&[
            ("a.csv".to_string(), 10),
            ("b.csv".to_string(), 20),
        ]);
        assert!(two.contains("a.csv (10 bytes)"));
        assert!(two.contains("b.csv (20 bytes)"));
    }

    #[test]
    fn the_download_list_explains_itself_when_there_is_nothing_to_save() {
        assert!(download_list(&[]).contains("-o FILE"));
        let listing = download_list(&["out.csv".to_string()]);
        assert!(listing.contains("out.csv"));
        assert!(listing.contains("download <path>"));
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
