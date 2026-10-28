//! Escape sequences, colours, and turning text into something the terminal can draw.
//!
//! Everything here counts columns rather than bytes, because an escape sequence is not
//! width: wrapping and the prompt's redraw both depend on that.


/// Bold. Used for anything the user can type.
pub const BOLD: &str = "\u{1b}[1m";

/// Dim, as the app ships with it: faint, in the terminal's own foreground colour.
const DEFAULT_DIM: &str = "\u{1b}[2m";

/// Red, for failures.
pub const RED: &str = "\u{1b}[31m";

/// Dim red, for the exit status of a command that failed.
pub const DIM_RED: &str = "\u{1b}[2;31m";

/// The accent colour the rest of the interface uses, as a 256-colour amber.
pub const DEFAULT_ACCENT: &str = "\u{1b}[38;5;214m";

/// Back to normal.
pub const RESET: &str = "\u{1b}[0m";

thread_local! {
    /// The escapes the app writes its own accent and asides in.
    ///
    /// A theme replaces these. They live here rather than being passed to every message
    /// function, because none of those functions care where the colour came from, and
    /// threading a theme through all of them would be noise.
    static STYLE: std::cell::RefCell<(String, String)> =
        std::cell::RefCell::new((DEFAULT_ACCENT.to_string(), DEFAULT_DIM.to_string()));
}

/// Paint the app's own text in a theme's colours.
///
/// Both arguments are the escape that starts the colour, so a theme can be any colour a
/// terminal understands, not only the ones this file knows how to build.
pub fn set_style(accent: String, dim: String) {
    STYLE.with(|style| *style.borrow_mut() = (accent, dim));
}

/// The escape that starts the app's accent colour, for a whole line of its own.
pub fn accent_escape() -> String {
    STYLE.with(|style| style.borrow().0.clone())
}

/// The escape that starts the app's dim colour, for a whole line of its own.
pub fn dim_escape() -> String {
    STYLE.with(|style| style.borrow().1.clone())
}

/// A command, or any other text worth the user's eye.
pub fn bold(text: &str) -> String {
    format!("{BOLD}{text}{RESET}")
}

/// An aside: how to use something, or what just happened.
pub fn dim(text: &str) -> String {
    format!("{}{text}{RESET}", dim_escape())
}

/// The accent colour, for the prompt's marker and little else.
pub fn accent(text: &str) -> String {
    format!("{}{text}{RESET}", accent_escape())
}

/// What a line looks like once the terminal has rendered it.
///
/// The app records what it printed so that searching the scrollback can skip its own
/// messages. Those records have to be the *visible* text, because that is what
/// xterm's buffer holds: an escape sequence in the record would never match the
/// screen and the messages would start being searchable again.
pub fn plain(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut characters = text.chars().peekable();
    while let Some(character) = characters.next() {
        if character != '\u{1b}' {
            out.push(character);
            continue;
        }
        // CSI: parameters and intermediates, then a final byte in @ to ~. Anything
        // else after an escape is a two-character sequence, which is dropped too.
        if let Some('[') = characters.next() {
            for next in characters.by_ref() {
                if ('\u{40}'..='\u{7e}').contains(&next) {
                    break;
                }
            }
        }
    }
    out
}

/// Wrap the app's own prose to `width` columns.
///
/// Only the app's words go through this. A report from hledger laid itself out and must
/// not be touched, and neither must a table the app aligned. A line that already fits is
/// returned exactly as it is, so alignment survives; only a line too long for the screen
/// is broken, at the spaces, with its escape sequences kept whole and counted as nothing.
pub fn wrap_to(text: &str, width: usize) -> String {
    // A floor, so a nonsensical width cannot make one-word lines.
    let width = width.max(10);
    let mut out = String::with_capacity(text.len() + text.len() / 8);
    for (index, line) in text.split('\n').enumerate() {
        if index > 0 {
            out.push_str("\r\n");
        }
        let line = line.strip_suffix('\r').unwrap_or(line);
        if plain(line).chars().count() <= width {
            out.push_str(line);
            continue;
        }
        let mut column = 0;
        let mut started = false;
        for word in line.split(' ').filter(|word| !word.is_empty()) {
            let size = plain(word).chars().count();
            if started && column + 1 + size > width {
                out.push_str("\r\n");
                column = 0;
                started = false;
            }
            if started {
                out.push(' ');
                column += 1;
            }
            out.push_str(word);
            column += size;
            started = true;
        }
    }
    out
}

/// The largest stdout written to the terminal, in bytes.
///
/// `hledger print` on a real journal is tens of megabytes, and writing that to
/// xterm.js stalls the tab for minutes. Cutting it is a visible, explainable lie;
/// freezing is not.
pub const MAX_OUTPUT_BYTES: usize = 2 * 1024 * 1024;

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
            "[output truncated after {} MB of {megabytes:.1} MB, `-o out.csv` writes the \
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
