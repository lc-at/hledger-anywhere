//! The terminal's own logic, with no browser in it.
//!
//! xterm.js renders and collects keystrokes; everything about *what those
//! keystrokes mean* lives here, so it can be tested natively. That split is the
//! point: a line editor is the kind of code where an off-by-one at the start of a
//! line is invisible until someone hits the Home key, and a browser is a slow
//! place to find that out.

// Natively this module exists for its tests: the only code that uses it is
// wasm-gated, so its items look unused to `cargo test`'s build.
#![cfg_attr(not(target_arch = "wasm32"), allow(dead_code, unused_imports))]

#[cfg(target_arch = "wasm32")]
pub mod view;

/// The smallest and largest font the terminal will use, in pixels.
///
/// A terminal that can be shrunk to nothing or grown past the window is worse
/// than one that cannot be resized at all, so the ends are pinned.
pub const MIN_FONT: u32 = 8;
pub const MAX_FONT: u32 = 32;
pub const DEFAULT_FONT: u32 = 14;

// -- style ------------------------------------------------------------------
//
// The terminal is a terminal, so it can say things with weight and colour instead
// of quoting them with punctuation. Commands in a message are bold, explanations
// are dim, and the prompt's marker carries the accent colour: the same information
// that backticks and capitals were carrying, in the form a terminal user already
// reads without thinking about it.

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

/// hledger's commands, for completion. Not exhaustive, completion is a
/// convenience, and anything missing can still be typed out.
pub const HLEDGER_COMMANDS: [&str; 34] = [
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
    /// The completion menu being stepped through, if one is open.
    menu: Option<Menu>,
}

/// A menu of completions, as zsh offers after a second Tab.
///
/// The first Tab does what a shell does: one match completes, several extend as far
/// as they agree. When that gets nowhere there is nothing left to guess, so the
/// candidates are offered instead, one on the line at a time. The original line is
/// kept so Escape can put it back, and each step re-completes from that original
/// rather than from the candidate the step before inserted.
#[derive(Clone, Debug, PartialEq, Eq)]
struct Menu {
    original: Vec<char>,
    original_cursor: usize,
    candidates: Vec<String>,
    index: usize,
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

    /// Ctrl+W: kill the word before the cursor, as a shell does, whitespace
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

    /// The whole words before the token under the cursor: the command, then its arguments.
    ///
    /// None means the cursor is in the first word, where commands go; one means it is the
    /// first argument, which is where a plugin's own words are offered on their own.
    pub fn words_before_token(&self) -> Vec<String> {
        let head: String = self.chars[..self.cursor].iter().collect();
        let done = match head.rfind(char::is_whitespace) {
            Some(index) => &head[..index],
            None => "",
        };
        done.split_whitespace().map(str::to_string).collect()
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
    ///
    /// Matching ignores case, in both directions: `EXP` completes `expenses:food`,
    /// and what goes on the line is the account's own spelling rather than the typed
    /// one, the way a shell does it. When nothing starts with what was typed, the
    /// nearest names are offered as a list and the line is left alone: completing a
    /// guess over someone's typing is worse than showing them the guess.
    pub fn complete(&mut self, candidates: &[String]) -> Completion {
        let token = self.token();
        if token.is_empty() {
            // Nothing was typed, so there is nothing to complete *from*. Every
            // candidate matches an empty token, and completing one of them would type
            // a guess onto an empty line: press Tab to see what there is and end up
            // with `--account` in front of you. So the candidates are listed, in the
            // order they were offered, and the line is left alone.
            let mut offered: Vec<String> = Vec::new();
            for candidate in candidates {
                if !offered.contains(candidate) {
                    offered.push(candidate.clone());
                }
            }
            return if offered.is_empty() {
                Completion::None
            } else {
                Completion::Listed(offered)
            };
        }

        let mut matches: Vec<&String> = candidates
            .iter()
            .filter(|candidate| starts_with_ignoring_case(candidate, &token))
            .collect();
        matches.sort();
        matches.dedup();

        match matches.as_slice() {
            [] => {
                let fuzzy = fuzzy_matches(&token, candidates, FUZZY_LIMIT);
                if fuzzy.is_empty() {
                    Completion::None
                } else {
                    Completion::Fuzzy(fuzzy)
                }
            }
            [only] => {
                let replacement = format!("{only} ");
                self.replace_token(&replacement);
                Completion::Completed
            }
            many => {
                let prefix = common_prefix_ignoring_case(many);
                if prefix.chars().count() > token.chars().count() {
                    self.replace_token(&prefix);
                    Completion::Extended
                } else {
                    let candidates: Vec<String> =
                        many.iter().map(|value| (*value).clone()).collect();
                    self.open_menu(&candidates);
                    Completion::Ambiguous(candidates)
                }
            }
        }
    }

    /// Offer `candidates` as a menu, with the first one on the line.
    fn open_menu(&mut self, candidates: &[String]) {
        let menu = Menu {
            original: self.chars.clone(),
            original_cursor: self.cursor,
            candidates: candidates.to_vec(),
            index: 0,
        };
        self.menu = Some(menu);
        self.show_candidate(0);
    }

    /// Put candidate `index` on the line, replacing whatever was there.
    fn show_candidate(&mut self, index: usize) {
        let Some(mut menu) = self.menu.take() else {
            return;
        };
        let Some(candidate) = menu.candidates.get(index).cloned() else {
            self.menu = Some(menu);
            return;
        };
        menu.index = index;
        // Back to the line as typed, then complete it afresh: the token to replace
        // is the one the user wrote, not the one the last step inserted.
        self.chars = menu.original.clone();
        self.cursor = menu.original_cursor;
        self.replace_token(&candidate);
        self.menu = Some(menu);
    }

    /// The next candidate, wrapping around. False when no menu is open.
    pub fn menu_next(&mut self) -> bool {
        let Some(menu) = self.menu.as_ref() else {
            return false;
        };
        let index = (menu.index + 1) % menu.candidates.len();
        self.show_candidate(index);
        true
    }

    /// The previous candidate, wrapping around. False when no menu is open.
    pub fn menu_previous(&mut self) -> bool {
        let Some(menu) = self.menu.as_ref() else {
            return false;
        };
        let index = if menu.index == 0 {
            menu.candidates.len() - 1
        } else {
            menu.index - 1
        };
        self.show_candidate(index);
        true
    }

    /// Leave the menu, keeping whatever it put on the line.
    pub fn menu_close(&mut self) -> bool {
        self.menu.take().is_some()
    }

    /// Leave the menu and put the line back as it was typed.
    pub fn menu_cancel(&mut self) -> bool {
        let Some(menu) = self.menu.take() else {
            return false;
        };
        self.chars = menu.original;
        self.cursor = menu.original_cursor;
        true
    }

    /// Replace the token under the cursor, keeping the rest of the line.
    ///
    /// The cursor moves to just after the replacement, so completing a token in
    /// the middle of a command line, a query term, say, leaves the arguments
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
    /// Nothing was there to complete from.
    None,
    /// One match: it is on the line, with a space after it.
    Completed,
    /// Several: the line now holds as much as they agree on.
    Extended,
    /// Several, and no more to agree on: offered as a menu, first one on the line.
    Ambiguous(Vec<String>),
    /// Nothing was typed to complete, or *where* it was typed offers these: listed
    /// above the prompt, with the line left exactly as it was.
    Listed(Vec<String>),
    /// Nothing starts with what was typed. These come closest, and the line is left
    /// exactly as it was typed, because a guess must not overwrite typing.
    Fuzzy(Vec<String>),
}

/// How many fuzzy matches are worth showing. More than this is a wall of names.
pub const FUZZY_LIMIT: usize = 12;

/// The shortest token worth matching fuzzily: one letter matches almost everything.
const FUZZY_MINIMUM: usize = 2;

/// A small journal to try the app on, for a first visit with nothing to upload.
///
/// Deliberately tiny and deliberately dated in the past: it is a sample, and the
/// point of `demo` is that every command in `hledger help` works immediately
/// rather than that the numbers mean anything. It includes a second file so that
/// `include` resolution is exercised too, and covers a few commodities, tags and
/// a price so that reports which group by those have something to group.
pub const DEMO_JOURNAL: &str = "\
; Demo journal, loaded by the `demo` command. Replace it with `upload`.
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


/// Split a command line into arguments the way a shell does.
///
/// This exists because hledger's own documented syntax needs it: a period
/// expression with a space in it is one argument, `balance -p "this year"`, and
/// splitting on whitespace handed hledger `"this` and `year"`, which it could not
/// parse. The app is not a shell, but its command line is one, and an argument the
/// user quoted has to arrive whole and without its quotes.
///
/// Both quote styles are understood and both are removed. Outside quotes a
/// backslash escapes the next character; inside double quotes it escapes `"` and
/// `\`; single quotes are literal, as in a shell. An unclosed quote is an error
/// rather than a guess, treating the rest of the line as one argument would run
/// something the user did not write.
pub fn tokenize(line: &str) -> Result<Vec<String>, String> {
    let mut arguments: Vec<String> = Vec::new();
    let mut current = String::new();
    // `""` is a real, empty argument, so what matters is whether a token has been
    // started, not whether it has characters yet.
    let mut started = false;
    let mut quote: Option<char> = None;
    let mut characters = line.chars().peekable();

    while let Some(character) = characters.next() {
        match quote {
            Some('\'') => {
                if character == '\'' {
                    quote = None;
                } else {
                    current.push(character);
                }
            }
            Some(_) => match character {
                '"' => quote = None,
                '\\' => match characters.next() {
                    Some(escaped @ ('"' | '\\')) => current.push(escaped),
                    // A backslash before anything else is a backslash.
                    Some(other) => {
                        current.push('\\');
                        current.push(other);
                    }
                    None => current.push('\\'),
                },
                _ => current.push(character),
            },
            None => match character {
                open @ ('\'' | '"') => {
                    quote = Some(open);
                    started = true;
                }
                '\\' => match characters.next() {
                    Some(escaped) => {
                        current.push(escaped);
                        started = true;
                    }
                    None => {
                        return Err(format!(
                            "A line ending in {} has nothing to escape.",
                            bold("\\")
                        ))
                    }
                },
                space if space.is_whitespace() => {
                    if started {
                        arguments.push(std::mem::take(&mut current));
                        started = false;
                    }
                }
                _ => {
                    current.push(character);
                    started = true;
                }
            },
        }
    }

    if let Some(open) = quote {
        let (name, needed) = if open == '"' { ("double", "\"") } else { ("single", "'") };
        return Err(format!(
            "A {name} quote is not closed. Add the {needed} it needs."
        ));
    }
    if started {
        arguments.push(current);
    }
    Ok(arguments)
}

/// The first argument of a line, and everything after it, untouched.
///
/// Aliases replace the command word and nothing else, so the rest has to survive
/// byte for byte: rebuilding it from tokens would throw away the user's quoting,
/// and `bal -p "this year"` has to keep the quotes it was given.
pub fn split_first_token(line: &str) -> (String, String) {
    let trimmed = line.trim_start();
    let mut quote: Option<char> = None;
    let mut escaped = false;

    for (index, character) in trimmed.char_indices() {
        if escaped {
            escaped = false;
            continue;
        }
        match quote {
            Some('"') => match character {
                '\\' => escaped = true,
                '"' => quote = None,
                _ => {}
            },
            Some(_) => {
                if character == '\'' {
                    quote = None;
                }
            }
            None => match character {
                '\\' => escaped = true,
                open @ ('\'' | '"') => quote = Some(open),
                space if space.is_whitespace() => {
                    let (head, rest) = trimmed.split_at(index);
                    return (first_value(head), rest.trim_start().to_string());
                }
                _ => {}
            },
        }
    }
    (first_value(trimmed), String::new())
}

/// The unquoted value of a lone token.
fn first_value(token: &str) -> String {
    tokenize(token)
        .ok()
        .and_then(|arguments| arguments.into_iter().next())
        .unwrap_or_default()
}

/// One argument, with any quoting removed.
///
/// The app's own commands take a single path, address or number, and a path can
/// have a space in it, an uploaded file is named whatever it was named. Refusing
/// two arguments rather than guessing which one was meant keeps `journal a b` from
/// quietly reading `a`.
pub fn single_argument(rest: &str) -> Result<Option<String>, String> {
    let arguments = tokenize(rest)?;
    if arguments.len() > 1 {
        return Err(format!(
            "{} is more than one argument. Quote it if it has a space.",
            bold(rest)
        ));
    }
    Ok(arguments.into_iter().next())
}


/// A paste, split into the lines it contains.
///
/// Terminals deliver a paste as one string with newlines in it, which otherwise
/// ends up inserted into the line being edited, a journal snippet pasted into a
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


/// Commands that change the journal hledger reads, refused before anything runs.
///
/// hledger writes to a journal in exactly two places: `add`, which prompts for entries
/// and can never work here because the engine gets no input, and `import`, which
/// appends the transactions found in a file. Refusing them with a reason beats letting
/// them report success and then discarding what they wrote.
const WRITERS: &[&str] = &["add", "import"];

/// Why `command` cannot run, when it is one of hledger's writers.
///
/// `writable` says whether the loaded files came from an `open`ed directory and can be
/// written back. It changes the reason, not the refusal: `add` is refused regardless
/// (no stdin), and `import` is refused regardless (not enabled).
pub fn read_only_refusal(command: &str, writable: bool) -> Option<String> {
    let (head, _) = split_first_token(command);
    if !WRITERS.contains(&head.as_str()) {
        return None;
    }
    if head == "add" {
        return Some(format!(
            "{} asks questions as it goes, and the engine gets no input to answer them. \
             Add the entry in {} instead.",
            bold("add"),
            bold("edit")
        ));
    }
    if writable {
        Some(format!(
            "{} is not enabled yet; {} the journal in a window instead.",
            bold("import"),
            bold("edit")
        ))
    } else {
        Some(format!(
            "{} writes to the journal, and this session is read-only. Reports, {} and {} all \
             work; the journal itself is never changed.",
            bold("import"),
            bold("-o FILE"),
            bold("download")
        ))
    }
}

/// The loaded file an `-o` in `argv` would write over, if any.
///
/// Writing a report to a file is how data gets out, and is allowed. Writing it over a
/// loaded journal is not: a report that replaced the journal would change every report
/// after it, and this session is read-only.
pub fn output_over(paths: &[String], argv: &[String]) -> Option<String> {
    // The engine sees the mount at `data/`; the app names the same file without it.
    let mounted = |target: &str| {
        let path = target.trim().trim_start_matches("./");
        let path = path.strip_prefix("data/").unwrap_or(path);
        path.trim_start_matches('/').to_string()
    };

    for (index, argument) in argv.iter().enumerate() {
        let target = match argument.as_str() {
            "-o" | "--output-file" => argv.get(index + 1).map(String::as_str),
            other => other
                .strip_prefix("--output-file=")
                .or_else(|| other.strip_prefix("-o").filter(|rest| !rest.is_empty())),
        };
        if let Some(target) = target {
            let wanted = mounted(target);
            if let Some(clash) = paths.iter().find(|path| **path == wanted) {
                return Some(clash.clone());
            }
        }
    }
    None
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
/// The first `=` separates name from expansion, so an expansion may contain `=`,
/// as queries do, and the name may not contain spaces, because that is what makes
/// it a name.
pub fn parse_alias(text: &str) -> AliasEdit {
    let Some((name, expansion)) = text.split_once('=') else {
        return AliasEdit::Bad(format!(
            "Write it as {}, for example {}.",
            bold("alias name=command"),
            bold(&format!("alias {text}=..."))
        ));
    };
    let name = name.trim();
    let expansion = expansion.trim();
    if name.is_empty() || name.contains(char::is_whitespace) {
        return AliasEdit::Bad(format!(
            "An alias name cannot be empty or contain spaces. Try {}.",
            bold("alias bal=balance --tree")
        ));
    }
    if expansion.is_empty() {
        return AliasEdit::Bad(format!(
            "{} would expand to nothing. Try {}.",
            bold(name),
            bold(&format!("alias {name}=balance --tree"))
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
    let mut line = line.trim().to_string();
    let mut first: Option<(String, String)> = None;

    // An alias may point at another alias, and did not: `alias y=q` handed hledger the
    // word `q` and hledger said it had never heard of it. This keeps expanding until the
    // first word is one nothing answers to, and stops at a limit so two aliases pointing
    // at each other end with an answer instead of hanging the terminal.
    for _ in 0..MAX_ALIAS_DEPTH {
        let (head, rest) = split_first_token(&line);
        let Some((name, expansion)) = aliases
            .iter()
            .find(|(name, _)| name == &head)
            .map(|(name, expansion)| (name.clone(), expansion.clone()))
        else {
            break;
        };
        if first.is_none() {
            first = Some((name, expansion.clone()));
        }
        line = if rest.trim().is_empty() {
            expansion
        } else {
            format!("{expansion} {}", rest.trim())
        };
    }

    (line, first)
}

/// How many aliases deep an expansion goes before it is left alone.
///
/// A chain of aliases is useful; two that point at each other are a loop, and a loop has to
/// end somewhere.
const MAX_ALIAS_DEPTH: usize = 8;

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
/// walks forward rather than sticking on the match it just showed, and a line
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
pub fn isearch_prompt(query: &str, failed: bool) -> String {
    let label = if failed {
        "(failed reverse-i-search)"
    } else {
        "(reverse-i-search)"
    };
    format!("{} {}: ", dim(label), bold(query))
}

/// Read an on/off argument, accepting the spellings people actually type.
pub fn parse_switch(text: &str) -> Result<bool, String> {
    match text.trim().to_lowercase().as_str() {
        "on" | "yes" | "true" | "1" | "enable" | "enabled" => Ok(true),
        "off" | "no" | "false" | "0" | "disable" | "disabled" => Ok(false),
        other => Err(format!(
            "{} is not on or off. Try {}.",
            bold(other),
            bold("screenreader on")
        )),
    }
}

/// Read a font size from a command argument, clamped to the usable range.
///
/// Clamping rather than refusing on purpose: `font 100` plainly means "as big as
/// it goes", and the keyboard shortcuts already clamp.
pub fn font_size(text: &str) -> Result<u32, String> {
    let trimmed = text.trim();
    if trimmed.is_empty() {
        return Err(format!(
            "Give a size in pixels, like {}.",
            bold("font 18")
        ));
    }
    match trimmed.parse::<u32>() {
        Ok(size) => Ok(size.clamp(MIN_FONT, MAX_FONT)),
        Err(_) => Err(format!(
            "{} is not a number. Give a size in pixels, like {} ({} to {}).",
            bold(trimmed),
            bold("font 18"),
            MIN_FONT, MAX_FONT
        )),
    }
}

// The pieces live next door, re-exported so `terminal::bold` and the rest are still one
// namespace to the rest of the app.
mod commands;
mod messages;
mod text;

pub use commands::*;
pub use messages::*;
pub use text::*;

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
        // What goes into the history is the caller's decision now, see
        // `only_commands_go_into_the_history`, so this is about the line itself.
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
        assert_eq!(e.complete(&everything()), Completion::Completed);
        assert_eq!(e.line(), "cashflow ");
    }

    #[test]
    fn tab_extends_to_the_common_prefix_then_lists() {
        let mut e = Editor::default();
        e.insert("pr");
        // prices / print / print-unique agree up to "pri", so Tab extends that
        // far and stops.
        assert_eq!(e.complete(&everything()), Completion::Extended);
        assert_eq!(e.line(), "pri");

        // A second Tab has nothing left to extend, so it lists the options and
        // offers the first of them.
        match e.complete(&everything()) {
            Completion::Ambiguous(options) => {
                assert!(options.contains(&"print".to_string()));
                assert!(options.contains(&"print-unique".to_string()));
            }
            other => panic!("expected an ambiguous completion, got {other:?}"),
        }
        assert_eq!(e.line(), "prices", "the first candidate goes on the line");
    }

    #[test]
    fn tab_ignores_case_in_both_directions() {
        // Typed in the wrong case, completed in the right one: what goes on the line
        // is the account's own spelling, not the typed one.
        let mut e = Editor::default();
        e.insert("EXP");
        let offered = options(&["expenses:food", "expenses:rent"]);
        assert_eq!(e.complete(&offered), Completion::Extended);
        assert_eq!(e.line(), "expenses:");

        let mut e = Editor::default();
        e.insert("BaLaNcE");
        assert_eq!(e.complete(&options(&["balance"])), Completion::Completed);
        assert_eq!(e.line(), "balance ");
    }

    #[test]
    fn a_case_insensitive_match_still_extends_the_token_that_was_typed() {
        // The common prefix has to come from the candidates, not from the typed
        // token, or completing "ex" against two expenses would leave "ex".
        let mut e = Editor::default();
        e.insert("ex");
        assert_eq!(
            e.complete(&options(&["Expenses:food", "expenses:rent"])),
            Completion::Extended
        );
        assert_eq!(e.line(), "Expenses:");
    }

    #[test]
    fn when_nothing_starts_with_the_token_the_closest_names_are_offered() {
        let mut e = Editor::default();
        e.insert("bnc");
        let offered = options(&["balance", "income", "expenses:food"]);
        match e.complete(&offered) {
            Completion::Fuzzy(closest) => {
                assert_eq!(closest, vec!["balance".to_string()], "bnc is balance as a subsequence");
            }
            other => panic!("expected closest names, got {other:?}"),
        }
        // The point of the whole thing: a guess is offered, never typed over what
        // someone wrote.
        assert_eq!(e.line(), "bnc", "the line is left exactly as it was typed");
    }

    #[test]
    fn a_fuzzy_list_is_ranked_best_first_and_capped() {
        let offered = options(&["housing:food", "expenses:food", "food:snacks"]);
        assert_eq!(
            fuzzy_matches("food", &offered, FUZZY_LIMIT),
            vec![
                "food:snacks".to_string(),
                "housing:food".to_string(),
                "expenses:food".to_string()
            ],
            "the earliest match wins: all three contain food, food:snacks at the start, \
             then housing:food, then expenses:food"
        );

        let many: Vec<String> = (0..40).map(|index| format!("account{index}bnc")).collect();
        assert_eq!(fuzzy_matches("bnc", &many, FUZZY_LIMIT).len(), FUZZY_LIMIT);
        assert_eq!(fuzzy_matches("bnc", &many, FUZZY_LIMIT)[0], "account0bnc");
    }

    #[test]
    fn a_letter_or_two_is_not_worth_guessing_at() {
        let offered = options(&["balance", "income"]);
        // One letter matches nearly everything, so it is not offered as a guess.
        let mut e = Editor::default();
        e.insert("z");
        assert_eq!(e.complete(&offered), Completion::None);

        // Nothing resembles it either.
        let mut e = Editor::default();
        e.insert("qqqq");
        assert_eq!(e.complete(&offered), Completion::None);
    }

    #[test]
    fn the_closest_names_are_shown_without_opening_a_menu() {
        // A menu would put its first candidate on the line. Closest names must not:
        // there is nothing to step through until the line has been changed to match
        // it, and Tab never changes the line for a guess.
        let mut e = Editor::default();
        e.insert("bnc");
        let _ = e.complete(&options(&["balance", "income"]));
        assert!(!e.menu_next(), "no menu was opened");
    }

    fn options(items: &[&str]) -> Vec<String> {
        items.iter().map(|item| (*item).to_string()).collect()
    }

    /// Everything a line can be completed from, as one list.
    fn everything() -> Vec<String> {
        everything_with(&[])
    }

    fn everything_with(paths: &[String]) -> Vec<String> {
        let mut all = starting_words();
        all.extend(argument_words(paths));
        all
    }

    #[test]
    fn tab_on_an_empty_line_lists_the_commands_instead_of_guessing() {
        let mut e = Editor::default();
        match e.complete(&starting_words()) {
            Completion::Listed(offered) => {
                assert_eq!(
                    offered[0], "upload",
                    "the app's own commands come first: they are the ones worth learning"
                );
                assert!(offered.contains(&"balance".to_string()));
                assert!(
                    !offered.iter().any(|word| word.starts_with('-')),
                    "a flag cannot start a line, so it is not offered as one"
                );
            }
            other => panic!("expected a list, got {other:?}"),
        }
        assert_eq!(
            e.line(),
            "",
            "an empty line stays empty: Tab must never type a guess into it"
        );
    }

    #[test]
    fn tab_after_a_command_lists_what_can_follow_it() {
        let mut e = Editor::default();
        e.insert("balance ");
        assert_eq!(e.words_before_token(), ["balance"]);
        let offered = argument_words(&[]);
        match e.complete(&offered) {
            Completion::Listed(listed) => {
                assert!(listed.iter().any(|word| word.starts_with("--")), "the flags are there");
                assert!(!listed.contains(&"balance".to_string()), "a command does not follow one");
            }
            other => panic!("expected a list, got {other:?}"),
        }
        assert_eq!(e.line(), "balance ", "the line is left alone");
    }

    #[test]
    fn the_first_word_is_where_the_commands_go() {
        let mut e = Editor::default();
        assert!(e.words_before_token().is_empty());
        e.insert("bal");
        assert!(e.words_before_token().is_empty(), "still the first word");
        e.insert(" ");
        assert_eq!(e.words_before_token(), ["bal"], "past it now");
    }

    #[test]
    fn an_alias_may_point_at_another_alias() {
        let aliases = vec![
            ("q".to_string(), "balance expenses".to_string()),
            ("y".to_string(), "q".to_string()),
        ];
        // `y` is `q` is `balance expenses`, and the note names the one that was typed.
        let (line, used) = expand_alias("y", &aliases);
        assert_eq!(line, "balance expenses");
        assert_eq!(used, Some(("y".to_string(), "q".to_string())));

        // Arguments survive the whole chain.
        let (line, _) = expand_alias("y --depth 1", &aliases);
        assert_eq!(line, "balance expenses --depth 1");

        // A chain that ends at a word nothing answers to stops there.
        let (line, _) = expand_alias("y", &[("y".to_string(), "q".to_string())]);
        assert_eq!(line, "q");
    }

    #[test]
    fn aliases_that_point_at_each_other_stop() {
        // The limit, not a hang: the terminal has to come back.
        let aliases = vec![
            ("a".to_string(), "b".to_string()),
            ("b".to_string(), "a".to_string()),
        ];
        let (line, used) = expand_alias("a", &aliases);
        assert!(line == "a" || line == "b", "{line}");
        assert!(used.is_some());
    }

    #[test]
    fn find_searches_the_same_way_a_slash_does() {
        // One search, two ways to ask for it: the pager spelling and the word.
        assert_eq!(classify("find cash"), Command::Search(Some("cash")));
        assert_eq!(classify("/cash"), Command::Search(Some("cash")));
        // Bare, both mean "the last search again". The app reads an empty term that way,
        // so this asserts the meaning rather than the shape the variant happens to take:
        // the two spellings do not produce the same variant, and should not have to.
        for line in ["find", "/"] {
            match classify(line) {
                Command::Search(term) => assert!(
                    term.unwrap_or("").trim().is_empty(),
                    "{line} should repeat the last search, got {term:?}"
                ),
                other => panic!("{line} was {other:?}"),
            }
        }
    }

    #[test]
    fn a_menu_steps_through_the_candidates_and_escape_puts_the_line_back() {
        let offered = options(&["balance", "balancesheet", "balancesheetequity"]);
        let mut e = Editor::default();
        e.insert("balance");

        // "balance" cannot be extended, so the menu opens with the first candidate.
        assert!(matches!(e.complete(&offered), Completion::Ambiguous(_)));
        assert_eq!(e.line(), "balance");

        assert!(e.menu_next());
        assert_eq!(e.line(), "balancesheet");
        assert!(e.menu_next());
        assert_eq!(e.line(), "balancesheetequity");
        // Wrapping round at the end, as a menu does.
        assert!(e.menu_next());
        assert_eq!(e.line(), "balance");
        assert!(e.menu_previous());
        assert_eq!(e.line(), "balancesheetequity");

        // Escape puts back exactly what was typed, cursor included.
        assert!(e.menu_cancel());
        assert_eq!(e.line(), "balance");
        assert_eq!(e.cursor(), 7);
        // And it is over: no menu is left to step through.
        assert!(!e.menu_next());
        assert!(!e.menu_previous());
        assert!(!e.menu_cancel());
    }

    #[test]
    fn stepping_through_a_menu_completes_the_token_that_was_typed() {
        // Each step has to complete the token the user wrote, not the candidate the
        // step before inserted, or the word would grow a little every time.
        let offered = options(&["bal", "balance", "balancesheet"]);
        let mut e = Editor::default();
        e.insert("bal");

        assert!(matches!(e.complete(&offered), Completion::Ambiguous(_)));
        assert_eq!(e.line(), "bal");
        e.menu_next();
        assert_eq!(e.line(), "balance");
        e.menu_next();
        assert_eq!(e.line(), "balancesheet");
        e.menu_next();
        assert_eq!(e.line(), "bal", "and round again, from the original");
    }

    #[test]
    fn a_menu_keeps_the_completion_when_it_is_closed_by_anything_else() {
        let offered = options(&["balance", "balancesheet"]);
        let mut e = Editor::default();
        e.insert("balance");
        assert!(matches!(e.complete(&offered), Completion::Ambiguous(_)));
        assert!(e.menu_next());
        assert_eq!(e.line(), "balancesheet");

        // Typing something else is the app's cue to close the menu; the completion
        // it chose stays on the line.
        assert!(e.menu_close());
        assert_eq!(e.line(), "balancesheet");
        assert!(!e.menu_close());
    }

    #[test]
    fn a_plugin_word_starts_a_line_and_its_own_words_follow_it() {
        let sources = Sources {
            plugins: vec!["chart".to_string()],
            owner: Some(("chart".to_string(), vec!["sankey".to_string(), "income".to_string()])),
            accounts: vec!["expenses:food".to_string()],
            aliases: vec!["bal".to_string()],
            ..Sources::default()
        };
        // At the start of a line, the plugin is a command like any other.
        let (words, heading) = completion(&[], "ch", &sources);
        assert!(words.contains(&"chart".to_string()));
        assert!(words.contains(&"balance".to_string()));
        assert_eq!(heading, "Commands you can run:");

        // Right after its word, only what it takes, and the list says how to read about them.
        let (words, heading) = completion(&["chart".to_string()], "", &sources);
        assert_eq!(words, ["sankey", "income"]);
        assert!(heading.contains("chart?"), "{heading}");

        // Typing narrows from everything that can go there, its words first.
        let (words, _) = completion(&["chart".to_string()], "exp", &sources);
        assert_eq!(&words[..2], ["sankey", "income"]);
        assert!(words.contains(&"expenses:food".to_string()));
        assert!(!words.contains(&"bal".to_string()), "an alias is not a chart argument");

        // After any other command, a plugin's words are not offered at all.
        let other = Sources { owner: None, ..sources };
        let (words, heading) = completion(&["balance".to_string()], "", &other);
        assert!(!words.contains(&"sankey".to_string()));
        assert!(words.contains(&"bal".to_string()));
        assert_eq!(heading, "Flags, accounts and paths:");
    }

    #[test]
    fn the_words_before_the_cursor_are_the_command_and_its_arguments() {
        let mut editor = Editor::default();
        editor.insert("chart top exp");
        assert_eq!(editor.words_before_token(), ["chart", "top"]);
        assert_eq!(editor.token(), "exp");
        let mut fresh = Editor::default();
        fresh.insert("chart ");
        assert_eq!(fresh.words_before_token(), ["chart"]);
        assert_eq!(fresh.token(), "");
        assert!(Editor::default().words_before_token().is_empty());
    }

    #[test]
    fn candidates_are_listed_in_columns_that_fit() {
        let items = options(&["upload", "screenreader", "journal", "demo"]);

        let lines = format_columns(&items, 40);
        assert_eq!(lines.len(), 2, "{lines:?}");
        for line in &lines {
            assert!(line.chars().count() <= 40, "{line}");
        }
        // Column-major, as `ls` lays them out: the widest item pads its column.
        assert!(lines[0].starts_with("upload "), "{lines:?}");
        assert!(lines[1].starts_with("screenreader"), "{lines:?}");
        for item in &items {
            assert!(lines.iter().any(|line| line.contains(item.as_str())), "{item}");
        }

        // Too narrow for two columns: one per line, and nothing is cut off.
        let narrow = format_columns(&items, 4);
        assert_eq!(narrow.len(), 4, "{narrow:?}");
        assert!(narrow.contains(&"screenreader".to_string()), "{narrow:?}");

        assert!(format_columns(&[], 40).is_empty());
    }

    #[test]
    fn completion_offers_something_for_a_bare_tab_and_for_paths() {
        // A bare Tab has nothing to complete from, so it lists what can be typed
        // there rather than choosing one of them for you.
        let mut e = Editor::default();
        assert!(matches!(e.complete(&everything()), Completion::Listed(_)));

        let mut e = Editor::default();
        e.insert("books/2024");
        let paths = vec!["books/2024.journal".to_string()];
        assert_eq!(e.complete(&everything_with(&paths)), Completion::Completed);
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
        assert_eq!(e.complete(&everything()), Completion::Completed);
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
        assert_eq!(classify("open"), Command::Open);
        assert_eq!(classify("reopen"), Command::Reopen);
        assert_eq!(classify("clear"), Command::Clear);
        assert_eq!(classify("?"), Command::Help(None));
        // A question mark after a word asks for that word's help, and the word is the
        // whole of what is between them: `open?` is not a command called `open?`.
        assert_eq!(classify("open?"), Command::Help(Some("open")));
        assert_eq!(classify("balance?"), Command::Help(Some("balance")));
        // The question first reads the same way.
        assert_eq!(classify("? open"), Command::Help(Some("open")));
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
    fn the_writers_are_refused_with_a_reason() {
        assert!(read_only_refusal("balance", false).is_none());
        assert!(read_only_refusal("balance --depth 2", false).is_none());
        // A word that merely starts the same is a different word.
        assert!(read_only_refusal("importing", false).is_none());
        assert!(read_only_refusal("adding value", false).is_none());

        // `add` is refused regardless: the engine has no input.
        let add = read_only_refusal("add", false).expect("a writer");
        assert!(add.contains("no input"), "{add}");
        assert!(add.contains("edit"), "{add}");
        let add = read_only_refusal("add", true).expect("a writer");
        assert!(add.contains("no input"), "{add}");

        // `import` is refused read-only with the read-only reason, and writable
        // with the not-enabled reason.
        for command in ["import data/statement.csv", "   import"] {
            let refusal = read_only_refusal(command, false).expect(command);
            assert!(refusal.contains("read-only"), "{refusal}");
            assert!(refusal.contains("journal"), "{refusal}");

            let refusal = read_only_refusal(command, true).expect(command);
            assert!(refusal.contains("not enabled"), "{refusal}");
        }
    }

    #[test]
    fn a_report_may_not_be_written_over_a_loaded_journal() {
        let paths = vec![
            "hledger.journal".to_string(),
            "books/2024.journal".to_string(),
        ];
        let argv = |parts: &[&str]| parts.iter().map(|part| (*part).to_string()).collect::<Vec<_>>();

        assert_eq!(
            output_over(&paths, &argv(&["hledger", "balance", "-o", "hledger.journal"])),
            Some("hledger.journal".to_string())
        );
        // The engine's own view of the same file is the same file.
        assert_eq!(
            output_over(
                &paths,
                &argv(&["hledger", "print", "--output-file", "data/books/2024.journal"])
            ),
            Some("books/2024.journal".to_string())
        );
        // A name nobody loaded is a new file, which is allowed.
        assert!(output_over(&paths, &argv(&["hledger", "print", "--output-file=x.journal"])).is_none());

        // A new name is the ordinary case, and so is no output file at all.
        assert!(output_over(&paths, &argv(&["hledger", "balance", "-o", "out.csv"])).is_none());
        assert!(output_over(&paths, &argv(&["hledger", "balance", "--output-file=out.csv"])).is_none());
        assert!(output_over(&paths, &argv(&["hledger", "balance"])).is_none());
        assert!(output_over(&paths, &argv(&["hledger", "balance", "-o"])).is_none());
    }

    #[test]
    fn the_apps_own_words_are_wrapped_and_nothing_else_is() {
        // A line that fits is returned exactly, spacing and all: the banner lines up its
        // command column with runs of spaces, and collapsing those would ruin it.
        let aligned = "upload      add journal files";
        assert_eq!(wrap_to(aligned, 40), aligned);
        assert_eq!(wrap_to("", 40), "");

        // Too long, and it breaks at the spaces rather than in the middle of a word.
        let wrapped = wrap_to("the statement and the journal part at this line", 20);
        for line in wrapped.split("\r\n") {
            assert!(line.chars().count() <= 20, "over the width: {line:?}");
        }
        assert!(!wrapped.contains("statem\n"), "{wrapped:?}");
        assert!(
            wrapped.split_whitespace().collect::<Vec<_>>().join(" ")
                == "the statement and the journal part at this line",
            "wrapping lost or reordered words: {wrapped:?}"
        );

        // Escape sequences take no columns and are carried through untouched.
        let styled = bold("hledger-anywhere") + "  " + &dim("a terminal for hledger");
        let kept = wrap_to(&styled, 100);
        assert_eq!(kept, styled);
        let narrow = wrap_to(&styled, 22);
        for line in narrow.split("\r\n") {
            assert!(plain(line).chars().count() <= 22, "{line:?}");
        }
        assert_eq!(narrow.matches(BOLD).count(), 1, "the bold escape was split");

        // Blank lines stay blank, and line breaks already there are kept.
        assert_eq!(wrap_to("one\r\n\r\ntwo", 40), "one\r\n\r\ntwo");
        assert!(wrap_to("a few words that will not fit", 0).lines().count() > 1);
    }

    #[test]
    fn what_the_terminal_says_has_no_backticks_and_no_em_dashes() {
        // Two house rules, of the kind that rot silently: a command in a message is
        // bold rather than quoted, and there are no em dashes in anything the user
        // reads. Every message the terminal can produce is sampled here.
        let samples = [
            welcome("1.52.4", 100),
            crate::help::overview(&[], 100),
            prompt_for(None),
            prompt_for(Some("2024.journal")),
            isearch_prompt("bal", false),
            isearch_prompt("bal", true),
            resumed(2, "hledger.journal"),
            demo_loaded(2, "hledger.journal"),
            files_arrived(
                "Uploaded",
                &["a.journal".to_string()],
                &[("b.png".to_string(), "binary".to_string())],
                Some("a.journal"),
            ),
            files_arrived("Uploaded", &[], &[], None),
            file_list(&["a.journal".to_string()], Some("a.journal")),
            file_list(&[], None),
            download_list(&[]),
            download_list(&["out.csv".to_string()]),
            wrote_note(&[("out.csv".to_string(), 12, false)]),
            alias_list(&[]),
            alias_list(&[("bal".to_string(), "balance".to_string())]),
            alias_note("bal", "balance"),
            quoted("my file.journal"),
            shadowing_note("balance", "a different balance"),
        ];
        // The refusals matter as much as the greetings: they are read at the moment
        // someone is already confused about what they typed.
        let refusals = [
            tokenize("balance 'this year").expect_err("unclosed"),
            single_argument("two files").expect_err("two"),
            parse_switch("maybe").expect_err("a switch"),
            font_size("large").expect_err("a number"),
            read_only_refusal("import data/statement.csv", false).expect("a writer"),
            plugin_list(&[], &[]),
            plugin_list(
                &[("chart".to_string(), "open a balance chart".to_string())],
                &[("/plugins/plugins.json".to_string(), true)],
            ),
            no_journal(),
            bundled_returns("/plugins/plugins.json"),
            plugin_installed("./p.json", &["chart".to_string()], &["bad: no name".to_string()]),
            plugin_removed("./p.json", 2),
            plugin_usage("nonsense"),
            settings_list(&[("font".to_string(), "14px".to_string())]),
            settings_exported("hledger-anywhere-settings.json", 1024),
            settings_imported(&["font".to_string()], &["font 900 is outside 8 to 32".to_string()]),
            settings_usage("nonsense"),
            theme_list(
                &[("default".to_string(), "built in".to_string())],
                "default"
            ),
            theme_applied("midnight", "from chart"),
            theme_usage("nonsense", &["default".to_string()]),
            match parse_alias("nonsense") {
                AliasEdit::Bad(message) => message,
                other => panic!("{other:?}"),
            },
        ];
        let check = |text: &str| {
            let visible = plain(text);
            assert!(
                !visible.contains('`'),
                "a backtick reached the terminal: {visible:?}"
            );
            assert!(
                !visible.contains('\u{2014}'),
                "an em dash reached the terminal: {visible:?}"
            );
        };
        for text in samples.into_iter().chain(refusals) {
            check(&text);
        }
        // Every command's own page, so the detail text is held to the same rule as the
        // overview: no markdown that a terminal would print literally.
        for entry in crate::help::ENTRIES {
            check(&crate::help::page(entry, 100));
        }
    }

    #[test]
    fn a_remembered_folder_says_how_to_take_it_back() {
        // The hint is the only thing that tells anyone `reopen` exists, and it is
        // read at the moment a folder has quietly stopped being writable.
        let text = plain(&folder_remembered());
        assert!(text.contains("remembered"), "{text}");
        assert!(text.contains("reopen"), "{text}");
        assert!(text.contains("open"), "{text}");
    }

    #[test]
    fn banners_say_what_is_loaded_and_what_to_do() {
        let cold = welcome("1.52.4", 100);
        let visible = plain(&cold);
        assert!(visible.contains("1.52.4"), "{visible}");
        assert!(visible.contains("upload"), "{visible}");
        assert!(visible.contains("open"), "a folder on disk must be discoverable");
        assert!(visible.contains("demo"), "the sample journal must be discoverable");
        // The state of the journal is not the greeting's to claim any more: it is
        // written once the cache has been read.
        assert!(!visible.contains("No journal is loaded yet."), "{visible}");
        assert!(plain(&no_journal()).contains("No journal is loaded yet."));
        // A banner, not a sentence: the title carries weight, the asides recede.
        assert!(
            cold.contains(BOLD) && cold.contains(&dim_escape()),
            "{cold:?}"
        );

        // Flush left, like the messages and the prompt that follow it. An indented
        // banner above a flush-left "No journal is loaded yet." was the complaint.
        for line in visible.lines() {
            assert!(
                !line.starts_with(' '),
                "the banner is indented: {line:?}"
            );
        }
        // And it ends with a blank line, so the status under it is its own thing.
        assert!(visible.ends_with("\r\n\r\n") || visible.ends_with("\n\n"), "{visible:?}");

        // The command summaries line up in one column.
        let starts: Vec<usize> = ["upload", "open", "demo", "?"]
            .iter()
            .filter_map(|word| {
                let entry = crate::help::find(word)?;
                let line = visible
                    .lines()
                    .find(|line| line.starts_with(entry.usage) && line.contains(entry.summary))?;
                line.find(entry.summary)
            })
            .collect();
        assert_eq!(starts.len(), 4, "{visible}");
        assert!(
            starts.windows(2).all(|pair| pair[0] == pair[1]),
            "the command column is ragged: {visible}"
        );

        // Narrow enough and each description drops under its command rather than
        // wrapping into the gutter, so no line runs past the screen by padding.
        let narrow = plain(&welcome("1.52.4", 24));
        assert!(narrow.contains("upload\r\n  add journal files"), "{narrow}");

        let back = plain(&resumed(3, "books/hledger.journal"));
        assert!(back.contains("Resumed 3 files"), "{back}");
        assert!(back.contains("books/hledger.journal"), "{back}");

        let up = plain(&files_arrived(
            "Uploaded",
            &["hledger.journal".to_string()],
            &[("logo.png".to_string(), "binary".to_string())],
            Some("hledger.journal"),
        ));
        assert!(up.contains("Uploaded 1 file."), "{up}");
        assert!(up.contains("skipped logo.png: binary"), "{up}");
        assert!(up.contains("balance"), "{up}");

        let nothing = plain(&files_arrived("Uploaded", &["data.csv".to_string()], &[], None));
        assert!(nothing.contains("None of those is a journal"), "{nothing}");

        // Two files, two plurals: "file(s)" is a form letter, not a terminal.
        let two = plain(&files_arrived(
            "Uploaded",
            &["a.journal".to_string(), "b.journal".to_string()],
            &[],
            Some("a.journal"),
        ));
        assert!(two.contains("Uploaded 2 files."), "{two}");
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
        // The visible text is what matters here; the styling around it is checked
        // once, at the end, rather than repeated in every case.
        assert_eq!(plain(&prompt_for(Some("hledger.journal"))), "hledger.journal » ");
        assert_eq!(plain(&prompt_for(Some("books/2024.journal"))), "2024.journal » ");
        assert_eq!(
            plain(&prompt_for(Some("/data/deep/path.journal"))),
            "path.journal » "
        );
        assert_eq!(plain(&prompt_for(None)), "no journal » ");
        // A path with no name in it says the same as no journal at all, rather than
        // leaving a dangling separator.
        assert_eq!(plain(&prompt_for(Some("books/"))), "no journal » ");

        // Dim for what is being read, the accent colour for the marker to type
        // after: a flat `$ ` was the whole complaint.
        let prompt = prompt_for(Some("2024.journal"));
        assert!(
            prompt.contains(&dim_escape()) && prompt.contains(&accent_escape()),
            "{prompt:?}"
        );
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
        // Readline's prompt in the terminal's own clothes: the state is dim, the
        // query is bold, and a search that found nothing says so.
        let found = isearch_prompt("bal", false);
        assert_eq!(plain(&found), "(reverse-i-search) bal: ");
        assert!(found.contains(BOLD), "{found:?}");

        assert_eq!(plain(&isearch_prompt("", false)), "(reverse-i-search) : ");
        assert_eq!(
            plain(&isearch_prompt("bal", true)),
            "(failed reverse-i-search) bal: "
        );
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
        // And that it is available, with the command that gets a copy, and how long
        // it lasts: nothing a command writes is kept beyond the visit.
        assert!(plain(&note).contains("download bal.csv"), "{note}");
        assert!(note.contains("while this visit lasts"), "{note}");
    }


    #[test]
    fn a_count_always_says_how_many() {
        assert_eq!(count(0, "file", "files"), "0 files");
        assert_eq!(count(1, "file", "files"), "1 file");
        assert_eq!(count(2, "file", "files"), "2 files");
        assert_eq!(count(1, "plugin", "plugins"), "1 plugin");
        assert_eq!(count(3, "repository", "repositories"), "3 repositories");
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
    fn a_quoted_argument_stays_one_argument_without_its_quotes() {
        // The bug this exists for: hledger's periods have spaces in them, and only
        // a quoted argument can carry one.
        assert_eq!(
            tokenize("balance -p \"this year\"").expect("tokens"),
            ["balance", "-p", "this year"]
        );
        assert_eq!(
            tokenize("balance -p 'from 2024-01 to 2024-12'").expect("tokens"),
            ["balance", "-p", "from 2024-01 to 2024-12"]
        );
        // Quotes in the middle of a word are just concatenation.
        assert_eq!(
            tokenize("date:'this year'").expect("tokens"),
            ["date:this year"]
        );
        assert_eq!(tokenize("  balance   --tree  ").expect("tokens"), ["balance", "--tree"]);
        assert!(tokenize("").expect("tokens").is_empty());

        // An empty quoted argument is an argument, and survives.
        assert_eq!(tokenize("print \"\"").expect("tokens"), ["print", ""]);

        // Escapes: outside quotes anything can be escaped, and inside double
        // quotes the quote itself can.
        assert_eq!(tokenize("a\\ b").expect("tokens"), ["a b"]);
        assert_eq!(tokenize("\"a \\\"b\\\"\"").expect("tokens"), ["a \"b\""]);
        // A single quote cannot be escaped inside single quotes, a shell cannot
        // either, and this refuses rather than guessing at what was meant.
        assert!(tokenize("'it\\'s'").is_err());
        // A backslash in single quotes is literal, as in a shell.
        assert_eq!(tokenize("'a\\b'").expect("tokens"), ["a\\b"]);
        // And a backslash that escapes something ordinary keeps both characters.
        assert_eq!(tokenize("\"a\\nb\"").expect("tokens"), ["a\\nb"]);
        // The chart plugin writes a payee's exact match this way, a regular expression
        // whose backslashes must reach hledger: its quote() and this have to agree.
        assert_eq!(
            tokenize("balance --pivot payee expenses \"payee:^tiket\\\\.com$\" -O csv").expect("tokens"),
            ["balance", "--pivot", "payee", "expenses", "payee:^tiket\\.com$", "-O", "csv"]
        );
        assert_eq!(
            tokenize("\"payee:^A \\\\| B \\\\(1\\\\)$\"").expect("tokens"),
            ["payee:^A \\| B \\(1\\)$"]
        );

        // An unclosed quote is an error that says which one it is, rather than a
        // guess that runs something the user did not write.
        for (line, expected) in [
            ("balance -p \"this year", "double quote is not closed"),
            ("balance -p 'this year", "single quote is not closed"),
        ] {
            let complaint = tokenize(line).expect_err(line);
            assert!(complaint.contains(expected), "{line}: {complaint}");
        }
        assert!(tokenize("balance \\").is_err());
    }

    #[test]
    fn the_first_argument_is_taken_without_disturbing_the_rest() {
        assert_eq!(
            split_first_token("bal -p \"this year\""),
            ("bal".to_string(), "-p \"this year\"".to_string())
        );
        assert_eq!(
            split_first_token("  balance  "),
            ("balance".to_string(), String::new())
        );
        // Quotes around the command word do not survive into the name compared
        // against the aliases.
        assert_eq!(split_first_token("\"bal\" --tree").0, "bal");
        // A quoted first argument keeps its spaces, and the rest is still verbatim.
        assert_eq!(
            split_first_token("\"two words\" rest").1,
            "rest".to_string()
        );
    }

    #[test]
    fn an_apps_own_command_takes_one_argument_or_says_so() {
        assert_eq!(single_argument("out.csv").expect("one"), Some("out.csv".to_string()));
        assert_eq!(single_argument("").expect("none"), None);
        // A quoted path with a space is one argument, which is how a file whose
        // name has a space is named at all.
        assert_eq!(
            single_argument("\"my file.journal\"").expect("one"),
            Some("my file.journal".to_string())
        );
        let complaint = single_argument("two files").expect_err("two");
        assert!(complaint.contains("more than one argument"), "{complaint}");
        assert!(single_argument("\"unclosed").is_err());
    }

    #[test]
    fn an_alias_keeps_the_quoting_of_what_follows_it() {
        let aliases = vec![("bal".to_string(), "balance --tree".to_string())];
        let (line, used) = expand_alias("bal -p \"this year\"", &aliases);
        assert_eq!(line, "balance --tree -p \"this year\"");
        assert!(used.is_some());

        // Without an alias the line is handed on exactly as written, quotes and all.
        let (line, used) = expand_alias("balance -p \"this year\"", &aliases);
        assert_eq!(line, "balance -p \"this year\"");
        assert_eq!(used, None);
    }




    #[test]
    fn a_suggested_command_quotes_a_path_that_needs_it() {
        // A suggestion is something to paste back, so it has to be one argument:
        // `download spaced name.journal` would be refused as more than one.
        assert_eq!(quoted("out.csv"), "out.csv");
        assert_eq!(quoted("my file.journal"), "\"my file.journal\"");

        let note = wrote_note(&[("my file.csv".to_string(), 12, false)]);
        assert!(plain(&note).contains("download \"my file.csv\""), "{note}");
    }

    #[test]
    fn a_word_no_plugin_owns_is_hledger_s() {
        // The vocabulary is the app's own words only. Everything else, including a
        // word a plugin would own, reaches the app as an hledger command line, and
        // the app asks the registry before handing it on.
        assert_eq!(
            classify("balance expenses -M"),
            Command::Hledger("balance expenses -M")
        );
        assert_eq!(classify("reporting"), Command::Hledger("reporting"));
        let plugins = crate::plugins::Registry::default();
        assert!(plugins.owner("reporting").is_none());
        assert!(plugins.owner("balance -M").is_none());
    }

    #[test]
    fn the_help_mentions_every_command_the_app_owns() {
        // The help is the only place the vocabulary is written down, so a command
        // that is classified but not documented is a command nobody will find. The
        // plugins' words count: they are commands the user types.
        let plugins = crate::plugins::Registry::default();
        let text = plain(&crate::help::overview(&plugins.help_entries(), 100));
        for word in words() {
            assert!(text.contains(word.as_str()), "help does not mention {word}");
        }
    }

    /// Everything the user can type as one of the app's own commands.
    fn words() -> Vec<String> {
        COMMANDS.iter().map(|word| (*word).to_string()).collect()
    }

    #[test]
    fn the_readme_documents_every_command_the_app_owns() {
        // Documentation drifts silently: this README once described the deployed site
        // as HTTP-only and drag-and-drop as unwired long after both had changed. The
        // command table is the part a test can hold to account, so it is, plugins
        // included.
        let readme = include_str!("../../README.md");
        for word in words() {
            assert!(
                readme.contains(&format!("| `{word}")),
                "the README has no table row for {word}"
            );
        }
    }

    #[test]
    fn the_file_list_marks_the_one_in_use() {
        let files = ["a.journal".to_string(), "b.journal".to_string()];
        let text = plain(&file_list(&files, Some("b.journal")));
        assert!(text.contains("2 files loaded"), "{text}");
        assert!(text.contains("  a.journal"), "{text}");
        assert!(text.contains(" * b.journal"), "{text}");
        assert!(text.contains("journal <path>"), "{text}");

        let empty = plain(&file_list(&[], None));
        assert!(empty.contains("No journal files are loaded"), "{empty}");
        assert!(empty.contains("upload"), "{empty}");
    }
}
