//! What a typed line means, and what it could become.
//!
//! The app's own vocabulary, the hledger commands it passes through, and completion:
//! Tab has to know both, or it offers words that do not exist.

use super::{FLAGS, FUZZY_MINIMUM, HLEDGER_COMMANDS};

/// What a typed line means.
///
/// A few words are the app's own: loading files, the terminal itself, and the account
/// it can read. Everything else is hledger's, verbatim, which is the point of putting a
/// real CLI in a browser.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Command<'a> {
    /// Open the file picker and mount the files chosen.
    Upload,
    /// Open a directory on disk through the File System Access API, keeping the
    /// paths and the handles so its files can be edited.
    Open,
    /// Take back the folder an earlier `open` was granted, re-granting write
    /// access after a reload dropped it.
    Reopen,
    /// Show or change which uploaded file is the journal.
    Journal(Option<&'a str>),
    /// Wipe the screen.
    Clear,
    /// The app's own help: everything for no argument, one command's page for a word.
    Help(Option<&'a str>),
    /// Load a small built-in journal, so the app can be tried without one.
    Demo,
    /// `/term`, find `term` in the scrollback, or the last term when blank.
    Search(Option<&'a str>),
    /// `n` / `N`, repeat the last search, forwards / backwards.
    SearchAgain(bool),
    /// `download <path>`, save a file hledger wrote in the last run.
    Download(Option<&'a str>),
    /// `alias` lists them; `alias name=expansion` sets one.
    Alias(Option<&'a str>),
    /// `unalias name` removes one.
    Unalias(Option<&'a str>),
    /// `font [size]` shows or sets the terminal font size.
    Font(Option<&'a str>),
    /// `screenreader [on|off]` shows or sets the accessibility tree.
    ScreenReader(Option<&'a str>),
    /// `plugins` lists the installed plugins; `add`, `remove` and `reload` change them.
    Plugins(Option<&'a str>),
    /// `settings` shows what is remembered; `export` and `import` move it between visits.
    Settings(Option<&'a str>),
    /// `theme [name]` lists the themes on offer, or selects one.
    Theme(Option<&'a str>),
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
    // A question mark after a word asks for that word's help: `open?` explains the
    // app's own command, `chart?` a plugin's, and `balance?` asks hledger itself with
    // `--help`. On its own, `?` is the overview.
    if head == "?" {
        // `? open` is accepted as well as `open?`: one is the question first, the
        // other the command first, and both read as "tell me about this".
        return Command::Help(rest.split_whitespace().next());
    }
    if let Some(word) = head.strip_suffix('?')
        && !word.is_empty()
        && !word.contains('?')
    {
        return Command::Help(Some(word));
    }
    match head {
        "upload" => Command::Upload,
        "open" => Command::Open,
        "reopen" => Command::Reopen,
        "journal" => Command::Journal((!rest.is_empty()).then_some(rest)),
        "clear" => Command::Clear,
        "demo" => Command::Demo,
        "download" => Command::Download((!rest.is_empty()).then_some(rest)),
        "alias" => Command::Alias((!rest.is_empty()).then_some(rest)),
        "font" => Command::Font((!rest.is_empty()).then_some(rest)),
        "screenreader" => Command::ScreenReader((!rest.is_empty()).then_some(rest)),
        "plugins" => Command::Plugins((!rest.is_empty()).then_some(rest)),
        "settings" => Command::Settings((!rest.is_empty()).then_some(rest)),
        "theme" => Command::Theme((!rest.is_empty()).then_some(rest)),
        "unalias" => Command::Unalias((!rest.is_empty()).then_some(rest)),
        // Vim's vocabulary, because it is the one people already know for
        // scrolling back through output. `n` and `N` are not hledger commands, so
        // nothing is shadowed; `/` alone repeats the last search.
        "find" => Command::Search((!rest.trim().is_empty()).then_some(rest)),
        "n" => Command::SearchAgain(false),
        "N" => Command::SearchAgain(true),
        _ if trimmed.starts_with('/') => Command::Search(Some(trimmed[1..].trim())),
        _ => Command::Hledger(trimmed),
    }
}

/// Lay candidates out in columns, the way a shell lists them.
///
/// Column-major, like `ls`: each column is a run down the list, so reading down and
/// then across finds things in alphabetical order. The widest item decides how many
/// columns fit, and when only one does, one per line, so nothing is ever cut.
pub fn format_columns(items: &[String], width: usize) -> Vec<String> {
    if items.is_empty() {
        return Vec::new();
    }
    let gap = 2;
    let widest = items
        .iter()
        .map(|item| item.chars().count())
        .max()
        .unwrap_or(0);
    let per_row = ((width + gap) / (widest + gap)).max(1);
    let rows = items.len().div_ceil(per_row);

    let mut lines = Vec::with_capacity(rows);
    for row in 0..rows {
        let mut line = String::new();
        for column in 0..per_row {
            let Some(item) = items.get(column * rows + row) else {
                break;
            };
            if column > 0 {
                line.push_str(&" ".repeat(gap));
            }
            line.push_str(&format!("{item:<widest$}"));
        }
        lines.push(line.trim_end().to_string());
    }
    lines
}

/// Every word completion can offer: the app's commands, hledger's, the common
/// flags, and the uploaded file paths.
/// The commands the app answers to itself. Everything else is hledger's.
///
/// One list, because three things have to agree about it: completion offers these
/// first, the `?` help is expected to describe them, and the README is expected to
/// document them. Tests check the last two against this.
pub const COMMANDS: &[&str] = &[
    "upload",
    "open",
    "reopen",
    "journal",
    "clear",
    "?",
    "demo",
    "download",
    "alias",
    "unalias",
    "font",
    "screenreader",
    "plugins",
    "settings",
    "theme",
    "find",
];

/// The words a line can start with: the app's own commands, then hledger's reports.
///
/// In that order rather than alphabetically, because this is also the list Tab shows on
/// an empty line, and the app's own commands are the ones worth learning first.
pub fn starting_words() -> Vec<String> {
    let mut all: Vec<String> = COMMANDS.iter().map(|word| (*word).to_string()).collect();
    all.extend(HLEDGER_COMMANDS.iter().map(|word| (*word).to_string()));
    all
}

/// Where the words Tab offers come from, gathered by the caller, which is the only side that
/// knows what has arrived: accounts load in the background, and plugins at runtime.
#[derive(Default)]
pub struct Sources {
    /// Every plugin's word, which can start a line as the app's own commands can.
    pub plugins: Vec<String>,
    /// The plugin that owns this line, if one does, and the words it said it takes.
    pub owner: Option<(String, Vec<String>)>,
    /// The loaded file paths.
    pub paths: Vec<String>,
    pub accounts: Vec<String>,
    pub aliases: Vec<String>,
}

/// What Tab can offer at the cursor, and the heading for the list it shows.
///
/// The start of a line takes a command: the app's, hledger's, or a plugin's. After a plugin's
/// word, the words that plugin takes come first, and right after the word they are all that is
/// offered: `chart <Tab>` lists the questions chart answers, not three hundred flags and
/// accounts. Further along, and after any other command, it is flags, accounts and paths.
/// A plugin's words are offered on its own lines only, not after every command.
pub fn completion(before: &[String], token: &str, sources: &Sources) -> (Vec<String>, String) {
    if before.is_empty() {
        let mut words = starting_words();
        words.extend(sources.plugins.iter().cloned());
        return (words, "Commands you can run:".to_string());
    }
    let mut words = Vec::new();
    let mut heading = "Flags, accounts and paths:".to_string();
    if let Some((name, takes)) = &sources.owner {
        words.extend(takes.iter().cloned());
        if before.len() == 1 && token.is_empty() && !takes.is_empty() {
            return (words, format!("What {name} takes ({name}? says what each one does):"));
        }
        heading = format!("What {name} takes, then accounts and flags:");
    }
    words.extend(argument_words(&sources.paths));
    words.extend(sources.accounts.iter().cloned());
    if sources.owner.is_none() {
        words.extend(sources.aliases.iter().cloned());
    }
    (words, heading)
}

/// The words that can follow: report and query flags, then the loaded file paths.
///
/// Accounts, aliases and plugin words are added by the caller, which is the only side
/// that knows whether they have arrived yet.
pub fn argument_words(paths: &[String]) -> Vec<String> {
    let mut all: Vec<String> = FLAGS.iter().map(|word| (*word).to_string()).collect();
    all.extend(paths.iter().cloned());
    all
}

/// Whether two characters are the same letter, whatever their case.
fn same_ignoring_case(left: char, right: char) -> bool {
    left == right || left.to_lowercase().eq(right.to_lowercase())
}

/// Whether `candidate` starts with `token`, ignoring case.
///
/// An empty token matches everything, which is what makes a bare Tab list the
/// commands rather than doing nothing.
pub fn starts_with_ignoring_case(candidate: &str, token: &str) -> bool {
    let mut letters = candidate.chars();
    token
        .chars()
        .all(|wanted| letters.next().is_some_and(|found| same_ignoring_case(found, wanted)))
}

/// As much as every value agrees on, ignoring case, spelled the first value's way.
///
/// The spelling matters: completing `EXP` against `expenses:food` and
/// `expenses:rent` should leave `expenses:`, not `EXPenses:`.
pub fn common_prefix_ignoring_case(values: &[&String]) -> String {
    let Some(first) = values.first() else {
        return String::new();
    };
    let mut shared = first.chars().count();
    for value in values.iter().skip(1) {
        shared = shared.min(
            first
                .chars()
                .zip(value.chars())
                .take_while(|(a, b)| same_ignoring_case(*a, *b))
                .count(),
        );
    }
    first.chars().take(shared).collect()
}

/// The names that come closest to `token` without starting with it.
///
/// "Closest" is a subsequence match, scored so that the useful ones come first: a
/// name that contains the token as a run beats one with the letters scattered, a
/// letter that starts a word (`:` in an account path, say) is worth more than one in
/// the middle, and between equals the shorter name wins. Sorted best first, and
/// capped, because a list nobody reads is not help.
pub fn fuzzy_matches(token: &str, candidates: &[String], limit: usize) -> Vec<String> {
    let needle: Vec<char> = token.chars().collect();
    if needle.len() < FUZZY_MINIMUM {
        return Vec::new();
    }
    let mut scored: Vec<(i32, &String)> = candidates
        .iter()
        .filter_map(|candidate| fuzzy_score(&needle, candidate).map(|score| (score, candidate)))
        .collect();
    scored.sort_by(|(left, a), (right, b)| right.cmp(left).then_with(|| a.cmp(b)));

    let mut best: Vec<String> = Vec::new();
    for (_, candidate) in scored {
        if !best.iter().any(|seen| seen == candidate) {
            best.push(candidate.clone());
        }
        if best.len() == limit {
            break;
        }
    }
    best
}

/// How well `token` matches `candidate` as a subsequence, or `None` if it does not.
fn fuzzy_score(needle: &[char], candidate: &str) -> Option<i32> {
    let letters: Vec<char> = candidate.to_lowercase().chars().collect();
    let wanted: Vec<char> = needle.iter().flat_map(|c| c.to_lowercase()).collect();
    let mut score = 0;
    let mut cursor = 0;
    let mut previous: Option<usize> = None;
    for letter in &wanted {
        let found = cursor + letters[cursor..].iter().position(|c| c == letter)?;
        // Letters next to each other are a better sign than letters far apart.
        let expected = previous.map_or(0, |index| index + 1);
        score -= found as i32 - expected as i32;
        if found == 0 || starts_a_word(&letters, found) {
            score += 8;
        }
        previous = Some(found);
        cursor = found + 1;
    }
    // A run of the token inside the name is the strongest sign of all.
    if wanted.len() <= letters.len()
        && letters.windows(wanted.len()).any(|window| window == wanted.as_slice())
    {
        score += 20;
    }
    // Between equals, the shorter name is the likelier one.
    score -= letters.len() as i32 / 4;
    Some(score)
}

/// Whether the letter at `index` begins a word: the start of the name, or just after
/// a separator. Account names are paths, so `f` in `expenses:food` starts one.
fn starts_a_word(letters: &[char], index: usize) -> bool {
    matches!(
        letters.get(index.wrapping_sub(1)),
        None | Some(':') | Some('-') | Some('_') | Some(' ') | Some('.') | Some('/')
    )
}
