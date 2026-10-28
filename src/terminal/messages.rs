//! Everything the app says, as pure functions that return the text to print.
//!
//! Together because they share one voice: short, lower case, nothing a terminal would
//! have to quote, and no em dashes.

use super::{accent, bold, dim};

/// What `theme` prints: the themes on offer, and which one is in use.
pub fn theme_list(themes: &[(String, String)], current: &str) -> String {
    let mut text = format!("{}\r\n", bold("Themes"));
    let width = themes
        .iter()
        .map(|(name, _)| name.chars().count())
        .max()
        .unwrap_or(0)
        .max(current.chars().count());
    for (name, from) in themes {
        let marker = if name == current { "*" } else { " " };
        let running = if name == current {
            format!(" {}", dim("(in use)"))
        } else {
            String::new()
        };
        text.push_str(&format!(
            " {} {}  {}{running}\r\n",
            accent(marker),
            bold(&format!("{name:<width$}")),
            dim(from)
        ));
    }
    text.push_str(&format!(
        "\r\n{} selects one and keeps it; plugin themes come from the repositories you install.\r\n",
        bold("theme <name>")
    ));
    text
}

/// What `theme <name>` prints when a theme is applied.
pub fn theme_applied(name: &str, from: &str) -> String {
    format!(
        "Theme {}{}. {}\r\n",
        bold(name),
        if from.is_empty() {
            String::new()
        } else {
            format!(" {}", dim(from))
        },
        dim("The terminal, the page behind it, and the app's own text.")
    )
}

/// What `theme` says about a name nothing offers.
pub fn theme_usage(name: &str, available: &[String]) -> String {
    format!(
        "There is no theme called {}. {}\r\n",
        bold(name),
        if available.is_empty() {
            "None are installed: {} lists them.".to_string()
        } else {
            format!("{} lists them; available now: {}.", bold("theme"), available.join(", "))
        }
    )
}

/// What `plugins` prints: what is installed, and the repositories it came from.
/// A plugin's summary, for one that took a word hledger also answers to.
pub fn shadowing_note(name: &str, summary: &str) -> String {
    format!("{summary}; hledger {name} still runs hledger's own")
}

pub fn plugin_list(installed: &[(String, String)], repositories: &[(String, bool)]) -> String {
    let mut text = String::new();
    if installed.is_empty() {
        text.push_str(
            "No plugins are installed. A plugin adds commands, and comes from a repository \
             you name.\r\n",
        );
    } else {
        text.push_str(&format!(
            "{}, {}\r\n",
            bold(&count(installed.len(), "plugin", "plugins")),
            dim("installed")
        ));
        for (name, summary) in installed {
            text.push_str(&format!(
                "  {}  {}\r\n",
                bold(&format!("{name:<14}")),
                dim(summary)
            ));
        }
    }

    if repositories.is_empty() {
        text.push_str(&format!(
            "\r\nAdd one with {}.\r\n",
            bold("plugins add <url or path>")
        ));
    } else {
        text.push_str(&format!("\r\n{}\r\n", bold("Repositories")));
        for (repository, bundled) in repositories {
            text.push_str(&format!(
                "  {repository}{}\r\n",
                if *bundled {
                    format!("  {}", dim("bundled"))
                } else {
                    String::new()
                }
            ));
        }
        text.push_str(&format!(
            "\r\n{} reads them again; {} forgets one.\r\n",
            bold("plugins reload"),
            bold("plugins remove <url>")
        ));
    }
    text
}

/// What `plugins add` prints when a repository has been read.
pub fn plugin_installed(url: &str, registered: &[String], refused: &[String]) -> String {
    let mut text = String::new();
    if registered.is_empty() {
        text.push_str(&format!("{} has no plugin this app can use.\r\n", bold(url)));
    } else {
        text.push_str(&format!(
            "Read {} from {}: {}.\r\n",
            count(registered.len(), "plugin", "plugins"),
            bold(url),
            registered
                .iter()
                .map(|name| bold(name))
                .collect::<Vec<String>>()
                .join(", ")
        ));
    }
    for complaint in refused {
        text.push_str(&format!("  {} {complaint}\r\n", dim("refused:")));
    }
    // Said once, when a repository is added: a plugin is code running in this page.
    text.push_str(&format!(
        "{}\r\n",
        dim("A plugin is code running in this page, so install repositories you trust.")
    ));
    text
}

/// What `plugins remove` prints.
pub fn plugin_removed(url: &str, count_: usize) -> String {
    if count_ == 0 {
        format!("Nothing was installed from {}.\r\n", bold(url))
    } else {
        format!(
            "Forgot {} that came from {}.\r\n",
            count(count_, "plugin", "plugins"),
            bold(url)
        )
    }
}

/// What `plugins remove` adds when the repository came with the app.
pub fn bundled_returns(url: &str) -> String {
    format!(
        "{}\r\n",
        dim(&format!(
            "{url} is bundled: it is installed again on the next visit."
        ))
    )
}

/// What `plugins` says about something that is not one of its own arguments.
pub fn plugin_usage(word: &str) -> String {
    format!(
        "{} is not a plugins command. {} lists what is installed, {} reads a repository, \
         and {} forgets one.\r\n",
        bold(word),
        bold("plugins"),
        bold("plugins add <url or path>"),
        bold("plugins remove <url>")
    )
}

/// What `settings` prints: what is remembered, and how to move it.
pub fn settings_list(rows: &[(String, String)]) -> String {
    let mut text = format!(
        "{}, {}\r\n",
        bold("Settings"),
        dim("remembered between visits")
    );
    let width = rows
        .iter()
        .map(|(label, _)| label.chars().count())
        .max()
        .unwrap_or(0);
    for (label, value) in rows {
        text.push_str(&format!(
            "  {}  {}\r\n",
            bold(&format!("{label:<width$}")),
            value
        ));
    }
    text.push_str(&format!(
        "\r\n{} writes them to a file you can keep, and {} reads one back, \
         opening the file picker for it.\r\n",
        bold("settings export"),
        bold("settings import")
    ));
    text
}

/// What `settings export` says once the file is on its way to the browser.
pub fn settings_exported(path: &str, bytes: usize) -> String {
    format!(
        "Wrote {} ({}). Check your downloads; it carries everything above, plugin settings \
         and repositories included.\r\n",
        bold(path),
        bytes_label(bytes)
    )
}

/// What `settings import` says: what it applied, and what it could not use.
pub fn settings_imported(applied: &[String], dropped: &[String]) -> String {
    let mut text = if applied.is_empty() {
        "Nothing was applied.\r\n".to_string()
    } else {
        format!(
            "Applied {}: {}.\r\n",
            count(applied.len(), "setting", "settings"),
            applied.join(", ")
        )
    };
    for complaint in dropped {
        text.push_str(&format!("  {} {complaint}\r\n", dim("could not use:")));
    }
    text
}

/// What `settings` says about an argument it does not know.
pub fn settings_usage(word: &str) -> String {
    format!(
        "{} is not a settings command. {} shows them, {} writes them to a file, and {} \
         reads one back.\r\n",
        bold(word),
        bold("settings"),
        bold("settings export"),
        bold("settings import <path>")
    )
}

/// What the terminal prints when `alias` is given the list of them.
pub fn alias_list(aliases: &[(String, String)]) -> String {
    if aliases.is_empty() {
        return format!(
            "No aliases yet. {} makes {} run {}.\r\n",
            bold("alias bal=balance --tree"),
            bold("bal"),
            bold("balance --tree")
        );
    }
    let mut text = format!("{}:\r\n", bold("Aliases"));
    for (name, expansion) in aliases {
        text.push_str(&format!("  {name} = {expansion}\r\n"));
    }
    text.push_str(&format!("Remove one with {}.\r\n", bold("unalias <name>")));
    text
}

/// The note printed when a command was expanded, so it is never a surprise that
/// something other than what was typed ran.
pub fn alias_note(name: &str, expansion: &str) -> String {
    format!("[{name} {} {expansion}]", dim("runs"))
}

/// What the terminal prints after a run that wrote files.
///
/// Writing instead of printing is what `-o` is for, and the file only exists
/// inside the run's in-memory mount, so saying where it went matters more than
/// usual: without this the command looks like it did nothing.
/// A path as something the user can type back.
///
/// Quoted when it has a space in it, because every command the app suggests is one
/// the user can paste straight back in: `download "spaced name.journal"`, not
/// `download spaced name.journal`, which would be two arguments and refused.
pub fn quoted(path: &str) -> String {
    if path.chars().any(char::is_whitespace) {
        format!("\"{path}\"")
    } else {
        path.to_string()
    }
}

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
        ". Take a copy with {} while this visit lasts]",
        bold(&format!(
            "download {}",
            quoted(names.first().copied().unwrap_or(""))
        ))
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
        // "Written" rather than "downloaded": the file is in the engine's
        // filesystem and has not been saved anywhere yet.
        return format!(
            "Nothing has been written yet. {} on a command writes a file, for example {}.\r\n",
            bold("-o FILE"),
            bold("balance -O csv -o balance.csv")
        );
    }
    let mut text = String::from("Written by commands this session:\r\n");
    for path in files {
        text.push_str(&format!("  {path}\r\n"));
    }
    text.push_str(&format!(
        "Save one with {}.\r\n",
        bold("download <path>")
    ));
    text
}

/// The prompt: what is being read, and a marker to type after.
///
/// A bare `$ ` said nothing, and the journal being read is the one piece of the
/// terminal's state that is easy to lose track of. The name is dimmed so it recedes,
/// and the marker carries the accent colour so the eye finds the line to type on.
pub fn prompt_for(main: Option<&str>) -> String {
    let label = match main {
        Some(path) => {
            let name = path.rsplit('/').next().unwrap_or(path);
            if name.is_empty() {
                "no journal".to_string()
            } else {
                name.to_string()
            }
        }
        None => "no journal".to_string(),
    };
    format!("{} {} ", dim(&label), accent("»"))
}

/// What the terminal prints after loading the demo.
pub fn demo_loaded(files: usize, main: &str) -> String {
    format!(
        "Loaded the sample journal ({files} files), reading {}.\r\n",
        bold(main)
    )
}

/// A count and its noun, spelled for the count.
pub fn count(n: usize, singular: &str, plural: &str) -> String {
    if n == 1 {
        format!("1 {singular}")
    } else {
        format!("{n} {plural}")
    }
}

/// The greeting, and the only place the app explains itself before a journal is
/// loaded.
///
/// Flush left, like everything printed after it: what this is, then the few commands
/// worth typing first, in one aligned column.
pub fn welcome(engine: &str, width: usize) -> String {
    // The starters come from the help table rather than a second copy of the list, so
    // the banner cannot describe a command differently from the page that command
    // opens. A word with no entry is skipped rather than showing a blank row.
    let rows: Vec<(&str, &str)> = ["upload", "open", "demo", "?"]
        .iter()
        .filter_map(|word| crate::help::find(word))
        .map(|entry| (entry.usage, entry.summary))
        .collect();
    let form_width = rows
        .iter()
        .map(|(form, _)| form.chars().count())
        .max()
        .unwrap_or(0);

    let mut text = String::new();
    // The engine's version rides on the title line when there is room for it, so the
    // banner opens with one line rather than two.
    let title = "hledger-anywhere";
    if title.chars().count() + 2 + engine.chars().count() <= width {
        text.push_str(&format!("{}  {}\r\n", bold(title), dim(engine)));
    } else {
        text.push_str(&format!("{}\r\n{}\r\n", bold(title), dim(engine)));
    }
    text.push_str(&format!(
        "{}\r\n\r\n",
        dim("A terminal for hledger, running entirely in this tab.")
    ));
    text.push_str("Drop journal files on this window, or type:\r\n");
    // On a narrow screen a padded column would wrap into its own gutter, so the
    // description moves under its command, indented once, instead.
    let narrow = rows
        .iter()
        .any(|(_, summary)| form_width + 2 + summary.chars().count() > width);
    for (form, summary) in rows {
        if narrow {
            text.push_str(&format!("{}\r\n  {}\r\n", bold(form), dim(summary)));
        } else {
            text.push_str(&format!(
                "{}  {}\r\n",
                bold(&format!("{form:<form_width$}")),
                dim(summary)
            ));
        }
    }
    // A blank line, so whatever is reported next reads as a separate thing.
    text.push_str("\r\n");
    text
}

/// What the terminal says when there is nothing to report a journal from.
///
/// Separate from the greeting because the greeting is written once the cache has been
/// read: whether a journal is loaded is not known before that, and saying there is none
/// and then resuming one is a lie told quickly.
pub fn no_journal() -> String {
    format!("{}\r\n", dim("No journal is loaded yet."))
}

/// What the terminal prints when files came back from a previous visit.
pub fn resumed(count: usize, main: &str) -> String {
    format!(
        "Resumed {count} files, reading {}. Type {} to list or change them.\r\n",
        bold(main),
        bold("journal")
    )
}

/// What the terminal prints when a folder is remembered but its write access has
/// to be granted again.
///
/// A browser drops a directory handle's write permission when the page reloads and
/// will only give it back on a gesture, so the app has to ask for one by name.
pub fn folder_remembered() -> String {
    format!(
        "Your folder is remembered. Type {} to grant write access again and read it \
         from disk, or {} to choose another.\r\n",
        bold("reopen"),
        bold("open")
    )
}

/// What the terminal prints after files arrive, from wherever they came.
///
/// `source` is the verb: files are uploaded, dropped or read from a folder, and saying
/// "Uploaded" after `open` would be a lie about where they went.
pub fn files_arrived(
    source: &str,
    loaded: &[String],
    skipped: &[(String, String)],
    main: Option<&str>,
) -> String {
    let noun = count(loaded.len(), "file", "files");
    let mut text = format!("{source} {noun}.\r\n");
    for path in loaded {
        text.push_str(&format!("  {path}\r\n"));
    }
    for (path, reason) in skipped {
        text.push_str(&format!("  {} {path}: {reason}\r\n", dim("skipped")));
    }
    match main {
        Some(main) => text.push_str(&format!(
            "Reading {}. Type {} for a report, or {} for the rest.\r\n",
            bold(main),
            bold("balance"),
            bold("?")
        )),
        None => text.push_str(&format!(
            "{}\r\n",
            dim(
                "None of those is a journal (.journal, .hledger or .j), so hledger has \
                 nothing to read yet."
            )
        )),
    }
    text
}

/// What the terminal prints for `journal` with no argument.
pub fn file_list(files: &[String], main: Option<&str>) -> String {
    if files.is_empty() {
        return format!(
            "No journal files are loaded. Drop them on this window, or type {}.\r\n",
            bold("upload")
        );
    }
    let noun = count(files.len(), "file", "files");
    let mut text = format!("{noun} loaded:\r\n");
    for path in files {
        let marker = if Some(path.as_str()) == main {
            accent("*")
        } else {
            " ".to_string()
        };
        text.push_str(&format!(" {marker} {path}\r\n"));
    }
    text.push_str(&format!(
        "{} {} {} {}.\r\n",
        dim("Marked"),
        accent("*"),
        dim("is the file hledger reads. Change it with"),
        bold("journal <path>")
    ));
    text
}


