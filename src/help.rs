//! The app's own help: the overview behind a bare `?`, and one page per command.
//!
//! Pure, so the text is tested rather than trusted. Two tests hold it together: every
//! word in [terminal::COMMANDS] has an entry here, and every entry names a word that
//! is really a command, so the list and the help cannot drift apart.
//!
//! Putting a question mark after a command reads its page: `open?`, `theme?`. That is
//! why the entries are keyed by the word alone: the form with its arguments is the
//! usage line, which is what the page shows first.

// Natively only the tests read most of this: the pages are printed by the wasm app, so
// the rendering functions look unused to `cargo test`'s build.
#![cfg_attr(not(target_arch = "wasm32"), allow(dead_code))]

use crate::terminal::{bold, dim};

/// One command's help.
pub struct Entry {
    /// The word alone, as [crate::terminal::COMMANDS] lists it.
    pub word: &'static str,
    /// The word with its arguments, as a person would type it.
    pub usage: &'static str,
    /// The section of the overview it belongs to.
    pub group: &'static str,
    /// One line for the overview and the terminal banner.
    pub summary: &'static str,
    /// The page: one or two sentences and nothing more, because a terminal is not a
    /// manual and the examples carry the rest.
    pub detail: &'static str,
    /// Commands worth trying, and what each one does.
    pub examples: &'static [(&'static str, &'static str)],
}

impl Entry {
    /// The overview's row for this command.
    pub fn row(&self) -> (String, String) {
        (self.usage.to_string(), self.summary.to_string())
    }
}

/// Every command the app answers to, in the order the overview shows them.
pub const ENTRIES: &[Entry] = &[
    Entry {
        word: "upload",
        usage: "upload",
        group: "Files",
        summary: "add journal files",
        detail: "Choose files and mount them. What is loaded is replaced rather than \
                 added to, so uploading the same set again is how you update it. Up to \
                 5 MB per file and 50 MB in total; anything binary, empty or too large \
                 is reported and skipped.",
        examples: &[("upload", "choose files to load")],
    },
    Entry {
        word: "open",
        usage: "open",
        group: "Files",
        summary: "open a folder on disk, editable",
        detail: "Choose a folder and keep the paths inside it, which is what a journal \
                 split into 2024.journal, 2025.journal and prices/ needs. The browser \
                 keeps the handle, so the files can be written back with edit. A \
                 browser without the File System Access API falls back to a read-only \
                 folder picker.",
        examples: &[("open", "pick a folder to read and edit")],
    },
    Entry {
        word: "reopen",
        usage: "reopen",
        group: "Files",
        summary: "take back the remembered folder, and write to it again",
        detail: "A browser drops a remembered folder's write access when the page \
                 reloads and only gives it back on a gesture you make, so reopen is \
                 that gesture: it asks for write access again and reads the folder from \
                 disk. open chooses a different folder.",
        examples: &[("reopen", "grant write access to the folder from last time")],
    },
    Entry {
        word: "journal",
        usage: "journal [path]",
        group: "Files",
        summary: "list the loaded files, or read a different one",
        detail: "With no argument, lists what is loaded and marks the one hledger reads. \
                 With a path, reads that one: -f is never needed, because the chosen \
                 file is exported as $LEDGER_FILE.",
        examples: &[
            ("journal", "list the loaded files"),
            ("journal books/2024.journal", "read a different one"),
        ],
    },
    Entry {
        word: "download",
        usage: "download <path>",
        group: "Files",
        summary: "save a file into your browser's downloads",
        detail: "Saves a file a command wrote, which is what -o is for when the output \
                 is too big for the terminal: balance -O csv -o balance.csv then \
                 download balance.csv.",
        examples: &[("download balance.csv", "save what the last -o wrote")],
    },
    Entry {
        word: "demo",
        usage: "demo",
        group: "Files",
        summary: "load the sample journal",
        detail: "Loads a small built-in journal in two files, so include resolves. The \
                 quickest way to see what a report looks like without having a journal \
                 to hand.",
        examples: &[("demo", "load the sample journal")],
    },
    Entry {
        word: "find",
        usage: "find <text>",
        group: "Reports",
        summary: "search everything printed so far; n and N step through it",
        detail: "Searches the whole scrollback, including what has scrolled off screen. \
                 /text is the same search for people who reach for a pager, and n \
                 and N move to the next and previous match.",
        examples: &[
            ("find rent", "search the scrollback"),
            ("/rent", "the same search"),
        ],
    },
    Entry {
        word: "alias",
        usage: "alias [name=command]",
        group: "Reports",
        summary: "make a name run a command; alias lists them",
        detail: "An alias is a word that expands to a command, which is useful for the \
                 reports worth keeping. The app says which alias expanded when one runs, \
                 so a mistyped alias cannot quietly run something else.",
        examples: &[
            ("alias", "list your aliases"),
            ("alias bal=balance --tree", "make bal run balance --tree"),
        ],
    },
    Entry {
        word: "unalias",
        usage: "unalias <name>",
        group: "Reports",
        summary: "remove one",
        detail: "Removes an alias defined with alias. alias on its own lists them.",
        examples: &[("unalias bal", "remove the bal alias")],
    },
    Entry {
        word: "plugins",
        usage: "plugins [add|remove|reload] [url]",
        group: "Reports",
        summary: "list the installed plugins, or add and remove repositories",
        detail: "A plugin is a command the app does not implement itself, fetched at \
                 runtime from a repository. The manifest is authoritative for the words, \
                 the help and the completion, so installing one costs a fetch and runs \
                 no code until a command of its own is used.",
        examples: &[
            ("plugins", "list what is installed"),
            ("plugins add /plugins/plugins.json", "install a repository"),
        ],
    },
    Entry {
        word: "settings",
        usage: "settings [export|import]",
        group: "Reports",
        summary: "show what is remembered, or export and import it as a file",
        detail: "Shows the settings kept in this browser, and moves them between visits \
                 or machines as a JSON file. An unreadable field is ignored rather than \
                 refused, so a file from a later version still applies what it can.",
        examples: &[
            ("settings", "show what is remembered"),
            ("settings export", "save it to a file"),
        ],
    },
    Entry {
        word: "theme",
        usage: "theme [name]",
        group: "Reports",
        summary: "list the colour themes, or select one; plugin themes included",
        detail: "A theme is a handful of colours by role: background, foreground, \
                 cursor, accent and dim. theme lists what is on offer, and \
                 theme <name> repaints the terminal, the page behind it and the app's \
                 own text without a reload.",
        examples: &[
            ("theme", "list the themes"),
            ("theme gruvbox", "select one"),
        ],
    },
    Entry {
        word: "clear",
        usage: "clear",
        group: "Reports",
        summary: "clear the screen",
        detail: "Clears the screen and the scrollback. What is loaded and what is \
                 remembered are untouched.",
        examples: &[("clear", "wipe the screen")],
    },
    Entry {
        word: "font",
        usage: "font [size]",
        group: "This terminal",
        summary: "show or set the font size",
        detail: "Sets the terminal font between 8 and 32 pixels and keeps it. Ctrl+= and \
                 Ctrl+- step it, and Ctrl+0 resets it, so the number is rarely needed.",
        examples: &[
            ("font", "show the current size"),
            ("font 18", "set it to 18px"),
        ],
    },
    Entry {
        word: "screenreader",
        usage: "screenreader [on|off]",
        group: "This terminal",
        summary: "turn the accessibility tree on or off",
        detail: "Without the accessibility tree, the terminal is a canvas of rows and a \
                 screen reader can say nothing useful about it. The setting is kept \
                 between visits.",
        examples: &[("screenreader on", "make the terminal readable to a screen reader")],
    },
    Entry {
        word: "?",
        usage: "?",
        group: "This terminal",
        summary: "this help; put ? after a command for that one",
        detail: "On its own, lists every command and key. Put a question mark after any \
                 command to read about that one instead: open?, theme?, and \
                 balance? for hledger's own commands.",
        examples: &[
            ("open?", "help for open"),
            ("balance?", "hledger's help for balance"),
        ],
    },
];

/// The entry for a word, if the app has one.
pub fn find(word: &str) -> Option<&'static Entry> {
    ENTRIES.iter().find(|entry| entry.word == word)
}

/// The help groups, in the order the entries declare them.
fn groups<'a, I>(entries: I) -> Vec<(&'static str, Vec<&'a Entry>)>
where
    I: IntoIterator<Item = &'a Entry>,
{
    let mut sections: Vec<(&'static str, Vec<&'a Entry>)> = Vec::new();
    for entry in entries {
        match sections.iter_mut().find(|(heading, _)| *heading == entry.group) {
            Some((_, rows)) => rows.push(entry),
            None => sections.push((entry.group, vec![entry])),
        }
    }
    sections
}

/// What a bare ? prints: the commands by group, the plugins among them, the keys, and
/// one thing worth trying first.
///
/// plugins are (word, group, summary), which is what the registry knows about them.
pub fn overview(plugins: &[(&str, &str, &str)], width: usize) -> String {
    let mut text = String::new();
    text.push_str(&format!("{}\r\n", bold("hledger-anywhere")));
    for line in wrap(
        "Everything you type goes to hledger unchanged, and -f is never needed: the loaded \
         files are mounted, and the one being read is exported as $LEDGER_FILE.",
        width,
    ) {
        text.push_str(&format!("{}\r\n", dim(&line)));
    }
    text.push_str("\r\n");

    // The app's own commands by group, with the plugins merged into the group they ask
    // for, and a group of their own when the core does not have one.
    let mut sections: Vec<(&str, Vec<(String, String)>)> = groups(ENTRIES.iter())
        .into_iter()
        .map(|(heading, rows)| (heading, rows.into_iter().map(Entry::row).collect()))
        .collect();
    for (word, group, summary) in plugins {
        let row = (word.to_string(), summary.to_string());
        match sections.iter_mut().find(|(heading, _)| heading == group) {
            Some((_, rows)) => rows.push(row),
            None => sections.push((group, vec![row])),
        }
    }
    for (heading, rows) in sections {
        text.push_str(&format!("{}\r\n", bold(heading)));
        // As wide as the widest form in this section, never narrower than the old
        // fixed column. A fixed width breaks as soon as a form outgrows it, and one
        // already had: plugins [add|remove|reload] [url] pushed its description out of
        // line with the rest of the section.
        let width = rows
            .iter()
            .map(|(form, _)| form.chars().count())
            .max()
            .unwrap_or(0)
            .max(18);
        for (form, description) in rows {
            text.push_str(&format!(
                "  {}  {}\r\n",
                bold(&format!("{form:<width$}")),
                dim(&description)
            ));
        }
        text.push_str("\r\n");
    }

    text.push_str(&format!("{}\r\n", bold("Keys")));
    for line in [
        "Enter runs a command. Tab completes commands, flags, accounts, aliases and paths,",
        "ignoring case. A second Tab offers a menu: Tab and Shift+Tab step through it,",
        "Escape undoes it. Tab on an empty line lists the commands you can run; when the",
        "start of a word matches nothing, the closest names are listed instead. Either way",
        "the line is left exactly as you typed it.",
        "Up and Down recall history. Ctrl+C stops a running command, or clears the line.",
        "Ctrl+A and Ctrl+E are the ends of the line, Ctrl+B and Ctrl+F move by character,",
        "Alt+B and Alt+F by word. Ctrl+K, Ctrl+U and Ctrl+W cut to the end, the start and",
        "by word; Ctrl+Y pastes the last cut. Ctrl+R searches the history as you type,",
        "Ctrl+T swaps the two characters around the cursor, Ctrl+D deletes forward,",
        "Ctrl+L clears the screen, and Ctrl+= and Ctrl+- change the font.",
    ] {
        for wrapped in wrap(line, width.saturating_sub(2)) {
            text.push_str(&format!("  {}\r\n", dim(&wrapped)));
        }
    }
    text.push_str(&format!(
        "\r\n  {} {}  or put a question mark after a command: {}\r\n",
        dim("New here? Try"),
        bold("demo"),
        bold("open?")
    ));
    text
}

/// One command's page, as printed by `open?`.
pub fn page(entry: &Entry, width: usize) -> String {
    page_parts(entry.usage, entry.detail, entry.examples, width)
}

/// A plugin's page, from what its manifest declares.
pub fn plugin_page(usage: &str, detail: &str, examples: &[(String, String)], width: usize) -> String {
    let examples: Vec<(&str, &str)> = examples
        .iter()
        .map(|(command, description)| (command.as_str(), description.as_str()))
        .collect();
    page_parts(usage, detail, &examples, width)
}

fn page_parts(usage: &str, detail: &str, examples: &[(&str, &str)], width: usize) -> String {
    let mut text = String::new();
    text.push_str(&format!("{}\r\n\r\n", bold(usage)));
    for line in wrap(detail, width) {
        text.push_str(&format!("{}\r\n", line));
    }
    if !examples.is_empty() {
        text.push_str(&format!("\r\n{}\r\n", bold("Examples")));
        let width = examples
            .iter()
            .map(|(command, _)| command.chars().count())
            .max()
            .unwrap_or(0);
        for (command, description) in examples {
            text.push_str(&format!(
                "  {}  {}\r\n",
                bold(&format!("{command:<width$}")),
                dim(description)
            ));
        }
    }
    text.push_str(&format!(
        "\r\n{} lists every command; {} reads another one.\r\n",
        bold("?"),
        bold("command?")
    ));
    text
}

/// A paragraph wrapped to `width` columns, never splitting a word unless the word is
/// longer than the line.
///
/// The terminal wraps at the column edge without knowing where the words are, which is
/// what turned a long sentence into "handle, s" on one line and "o the files" on the
/// next. The source's own newlines are ignored, so a paragraph can be written as one
/// string and still read well at any width.
fn wrap(text: &str, width: usize) -> Vec<String> {
    // A floor, so a nonsensical width from a tiny terminal cannot make one-word lines.
    let width = width.max(10);
    let mut lines = Vec::new();
    let mut line = String::new();
    for word in text.split_whitespace() {
        let extra = if line.is_empty() { 0 } else { 1 };
        if !line.is_empty() && line.chars().count() + extra + word.chars().count() > width {
            lines.push(std::mem::take(&mut line));
        }
        if !line.is_empty() {
            line.push(' ');
        }
        line.push_str(word);
    }
    if !line.is_empty() {
        lines.push(line);
    }
    lines
}

/// What word? says when nothing answers to word.
pub fn unknown(word: &str, closest: &[String]) -> String {
    let mut text = format!("There is no help for {}.\r\n", bold(word));
    if closest.is_empty() {
        text.push_str(&format!("\r\n{} lists every command.\r\n", bold("?")));
    } else {
        text.push_str(&format!(
            "\r\nClosest: {}. {} lists every command.\r\n",
            closest.join(", "),
            bold("?")
        ));
    }
    text
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::terminal::COMMANDS;

    #[test]
    fn every_command_has_a_page() {
        for word in COMMANDS {
            assert!(find(word).is_some(), "no help entry for {word}");
        }
    }

    #[test]
    fn every_page_names_a_real_command() {
        for entry in ENTRIES {
            assert!(
                COMMANDS.contains(&entry.word),
                "help entry {} is not a command",
                entry.word
            );
            assert!(!entry.summary.trim().is_empty(), "{} has no summary", entry.word);
            assert!(!entry.detail.trim().is_empty(), "{} has no detail", entry.word);
            assert!(
                entry.usage.starts_with(entry.word),
                "{} uses a usage line that does not start with it: {}",
                entry.word,
                entry.usage
            );
        }
    }

    #[test]
    fn a_page_shows_the_usage_and_the_ways_to_use_it() {
        let entry = find("open").expect("open has a page");
        let text = plain(&page(entry, 100));
        assert!(text.contains("open"), "{text}");
        assert!(text.contains("File System Access"), "{text}");
        assert!(text.contains("?"), "{text}");
    }

    #[test]
    fn a_paragraph_wraps_between_words() {
        let text = "one two three four five six seven eight";
        let lines = wrap(text, 16);
        assert!(lines.iter().all(|line| line.chars().count() <= 16), "{lines:?}");
        // Nothing is lost and no word is split: the words are only moved.
        assert_eq!(lines.join(" "), text);
        // A word longer than the whole line still gets its own, unsplit.
        assert_eq!(wrap("short supercalifragilistic", 10), ["short", "supercalifragilistic"]);
    }

    #[test]
    fn a_plugin_page_comes_from_its_manifest() {
        // A plugin documents itself in the manifest, so the page needs no module run.
        let text = plain(&plugin_page(
            "chart [preset|account]",
            "Opens a chart in its own window.",
            &[("chart spending".to_string(), "the usual case".to_string())],
            100,
        ));
        assert!(text.contains("chart [preset|account]"), "{text}");
        assert!(text.contains("own window"), "{text}");
        assert!(text.contains("chart spending"), "{text}");
    }

    #[test]
    fn the_overview_aligns_each_sections_columns() {
        let text = plain(&overview(&[], 100));
        // The Reports section's widest form is longer than the old fixed 18 columns,
        // so this is the case that used to break the alignment.
        let column = |needle: &str| {
            text.lines()
                .find(|line| line.contains(needle))
                .unwrap_or_else(|| panic!("no row for {needle}"))
                .find(needle)
                .expect("the needle is in the line it was found by")
        };
        let expected = column("list the installed plugins");
        assert_eq!(column("search everything printed so far"), expected);
        assert_eq!(column("make a name run a command"), expected);
        assert_eq!(column("show what is remembered"), expected);
    }

    #[test]
    fn the_overview_lists_commands_and_plugins_by_group() {
        let text = plain(&overview(&[("chart", "Reports", "open a balance chart")], 100));
        for heading in ["Files", "Reports", "This terminal", "Keys"] {
            assert!(text.contains(heading), "no {heading} section: {text}");
        }
        assert!(text.contains("chart"), "{text}");
        assert!(text.contains("open?"), "{text}");
    }

    #[test]
    fn a_plugin_with_a_group_of_its_own_gets_one() {
        let text = plain(&overview(&[("forecast", "Forecasts", "project balances")], 100));
        assert!(text.contains("Forecasts"), "{text}");
        assert!(text.contains("forecast"), "{text}");
    }

    #[test]
    fn an_unknown_word_says_so_and_offers_the_closest() {
        let text = plain(&unknown("opne", &["open".to_string(), "reopen".to_string()]));
        assert!(text.contains("no help for"), "{text}");
        assert!(text.contains("open"), "{text}");
    }

    fn plain(text: &str) -> String {
        crate::terminal::plain(text)
    }
}
