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
    /// Open the file picker and mount what is chosen.
    Upload,
    /// Show or change which uploaded file is the journal.
    Journal(Option<&'a str>),
    /// Wipe the screen.
    Clear,
    /// The app's own help, not hledger's.
    Help,
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
        "journal" => Command::Journal((!rest.is_empty()).then_some(rest)),
        "clear" => Command::Clear,
        "?" => Command::Help,
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

    /// Ctrl+U and Ctrl+C: throw the line away.
    pub fn clear_line(&mut self) {
        self.chars.clear();
        self.cursor = 0;
        self.recalled = None;
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
    let mut all: Vec<String> = ["upload", "journal", "clear", "?"]
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
            "[output truncated after {} MB of {megabytes:.1} MB]",
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

/// What the terminal prints on a cold start.
pub fn welcome(version: &str) -> String {
    format!(
        "hledger-anywhere — hledger {version} (wasm32-wasi), running entirely in this tab.\r\n\
         No journal is loaded. Type `upload` to add hledger journal files, or `?` for help.\r\n",
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
    fn only_four_words_are_the_apps() {
        assert_eq!(classify("upload"), Command::Upload);
        assert_eq!(classify("  upload  "), Command::Upload);
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

    #[test]
    fn the_file_list_marks_the_one_in_use() {
        let files = ["a.journal".to_string(), "b.journal".to_string()];
        let text = file_list(&files, Some("b.journal"));
        assert!(text.contains("  a.journal"));
        assert!(text.contains(" * b.journal"));
        assert!(file_list(&[], None).contains("No files uploaded"));
    }
}
