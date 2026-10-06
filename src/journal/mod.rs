//! The accounting model, and the rules for choosing which file to analyse.
//!
//! Everything here is pure: it decodes hledger's JSON, models money faithfully,
//! and decides which of the user's files is the journal to run reports against.
//! No DOM, no wasm, so `cargo test` covers all of it.

// Consumers are the wasm-only panels; see the same note in `journal::model`.
#![cfg_attr(not(target_arch = "wasm32"), allow(dead_code))]

pub mod model;
pub mod money;
pub mod reports;

/// Extensions hledger reads as a journal.
const JOURNAL_EXTENSIONS: [&str; 3] = ["journal", "hledger", "j"];

/// Conventional names for a journal, most specific first.
const CONVENTIONAL_NAMES: [&str; 4] = [
    "hledger.journal",
    "main.journal",
    ".hledger.journal",
    "hledger.hledger",
];

/// The name of the generated root used when the choice is ambiguous.
///
/// The leading underscores keep it clear of a real file the user might have, and
/// the `.journal` extension makes hledger read it as one.
pub const SYNTHETIC_ROOT: &str = "__hledger_anywhere_root.journal";

/// A loaded file, reduced to what choosing a main journal needs.
#[derive(Clone, Copy, Debug)]
pub struct Candidate<'a> {
    /// Path relative to the loaded directory's root, with `/` separators.
    pub path: &'a str,
    pub contents: &'a str,
}

/// How the engine should be pointed at the user's journal.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum MainJournal {
    /// Analyse an existing file, by its path within the loaded directory.
    File(String),
    /// Analyse a generated root that `include`s the other files.
    Synthetic { path: String, contents: String },
}

impl MainJournal {
    /// The path reports should use, i.e. the value passed to `-f`.
    pub fn path(&self) -> &str {
        match self {
            MainJournal::File(path) => path,
            MainJournal::Synthetic { path, .. } => path,
        }
    }

    /// Extra file to add to the virtual filesystem, if any.
    pub fn extra_file(&self) -> Option<(&str, &str)> {
        match self {
            MainJournal::File(_) => None,
            MainJournal::Synthetic { path, contents } => Some((path, contents)),
        }
    }
}

/// Whether a path looks like an hledger journal, by extension.
pub fn is_journal_path(path: &str) -> bool {
    match path.rsplit_once('.') {
        Some((_, extension)) => {
            let extension = extension.to_ascii_lowercase();
            JOURNAL_EXTENSIONS.contains(&extension.as_str())
        }
        None => false,
    }
}

/// The last path component.
fn basename(path: &str) -> &str {
    match path.rsplit_once('/') {
        Some((_, name)) => name,
        None => path,
    }
}

/// How many directories deep a path is.
fn depth(path: &str) -> usize {
    path.matches('/').count()
}

/// Resolve a path against the directory of the file that referenced it, the way
/// hledger resolves `include`.
fn resolve_relative(from_path: &str, target: &str) -> String {
    if target.starts_with('/') {
        return normalise(target);
    }
    match from_path.rsplit_once('/') {
        Some((directory, _)) => normalise(&format!("{directory}/{target}")),
        None => normalise(target),
    }
}

/// Collapse `.` and `..` segments. Purely textual, which is all this needs.
fn normalise(path: &str) -> String {
    let mut parts: Vec<&str> = Vec::new();
    for part in path.split('/') {
        match part {
            "" | "." => {}
            ".." => {
                parts.pop();
            }
            other => parts.push(other),
        }
    }
    parts.join("/")
}

/// The paths named by `include` directives.
///
/// Deliberately a line scanner rather than a real parser: it only has to be good
/// enough to spot that a file pulls in others, and it must never fail on a
/// journal it does not fully understand.
pub fn include_targets(contents: &str) -> Vec<String> {
    let mut targets = Vec::new();
    for line in contents.lines() {
        let line = line.trim();
        if line.is_empty() || line.starts_with(';') || line.starts_with('#') {
            continue;
        }
        let Some(rest) = line.strip_prefix("include") else {
            continue;
        };
        // `include` must be followed by whitespace, so `included` is not a match.
        if !rest.starts_with([' ', '\t']) {
            continue;
        }
        let target = rest.trim().trim_matches('"');
        if !target.is_empty() {
            targets.push(target.to_string());
        }
    }
    targets
}

/// Does `target`, as written in `from_path`, name any of the other candidates?
fn references_other(target: &str, from_path: &str, journals: &[&Candidate<'_>], itself: &str) -> bool {
    let resolved = resolve_relative(from_path, target);
    let target_name = basename(target);
    journals.iter().any(|candidate| {
        if candidate.path == itself {
            return false;
        }
        candidate.path == resolved || basename(candidate.path) == target_name
    })
}

/// Choose the journal to analyse from the files in a loaded directory.
///
/// The order of preference is deliberate, and each step exists because the
/// previous one can be ambiguous:
///
/// 1. **A file that includes the others.** In a multi-file setup the root is the
///    file that pulls the rest in, and following it preserves the user's own
///    include graph instead of guessing at one.
/// 2. **A conventional name.** `hledger.journal` and friends are what hledger's
///    own tooling looks for.
/// 3. **A single shallowest file.** With exactly one candidate at the top level
///    there is nothing to choose between.
/// 4. **A generated root that includes them all.** Genuinely ambiguous input
///    still has to produce something, and the Journals panel lets the user
///    override the guess.
///
/// Returns `None` only when the directory has no journal-shaped file at all.
pub fn resolve_main_journal(files: &[Candidate<'_>]) -> Option<MainJournal> {
    let mut journals: Vec<&Candidate<'_>> = files
        .iter()
        .filter(|candidate| is_journal_path(candidate.path))
        .collect();

    match journals.len() {
        0 => return None,
        1 => return Some(MainJournal::File(journals[0].path.to_string())),
        _ => {}
    }

    // Shallowest first, then alphabetically, so every later rule is deterministic.
    journals.sort_by(|a, b| {
        depth(a.path)
            .cmp(&depth(b.path))
            .then_with(|| a.path.cmp(b.path))
    });

    // 1. The file that includes the most other picked files.
    let mut best: Option<(usize, &Candidate<'_>)> = None;
    for candidate in &journals {
        let score = include_targets(candidate.contents)
            .iter()
            .filter(|target| references_other(target, candidate.path, &journals, candidate.path))
            .count();
        if score > 0 && best.is_none_or(|(best_score, _)| score > best_score) {
            best = Some((score, candidate));
        }
    }
    if let Some((_, candidate)) = best {
        return Some(MainJournal::File(candidate.path.to_string()));
    }

    // 2. A conventional name.
    for name in CONVENTIONAL_NAMES {
        if let Some(candidate) = journals.iter().find(|c| basename(c.path) == name) {
            return Some(MainJournal::File(candidate.path.to_string()));
        }
    }

    // 3. A single file at the shallowest depth.
    let shallowest = depth(journals[0].path);
    let top: Vec<&&Candidate<'_>> = journals
        .iter()
        .filter(|candidate| depth(candidate.path) == shallowest)
        .collect();
    if let [only] = top[..] {
        return Some(MainJournal::File(only.path.to_string()));
    }

    // 4. Ambiguous: generate a root that includes everything, in the sorted
    //    order, so the result is at least stable and reviewable.
    let mut contents = String::from(
        "; Generated by hledger-anywhere.\n\
         ; This directory contains several journal files and none of them\n\
         ; includes the others, so every one is included here. Pick a different\n\
         ; main journal in the Journals panel if that is not what you want.\n",
    );
    for candidate in &journals {
        contents.push_str("include ");
        contents.push_str(candidate.path);
        contents.push('\n');
    }
    Some(MainJournal::Synthetic {
        path: SYNTHETIC_ROOT.to_string(),
        contents,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn candidate<'a>(path: &'a str, contents: &'a str) -> Candidate<'a> {
        Candidate { path, contents }
    }

    fn file(path: &str) -> MainJournal {
        MainJournal::File(path.to_string())
    }

    #[test]
    fn recognises_journal_extensions_case_insensitively() {
        assert!(is_journal_path("a.journal"));
        assert!(is_journal_path("a.hledger"));
        assert!(is_journal_path("a.j"));
        assert!(is_journal_path("dir/SUB.JOURNAL"));
        assert!(!is_journal_path("a.rules"));
        assert!(!is_journal_path("a.csv"));
        assert!(!is_journal_path("journal"));
        assert!(!is_journal_path("a.journal.bak"));
    }

    #[test]
    fn reads_include_directives_but_not_lookalikes() {
        let contents = "\
; include commented.journal
# include hashed.journal
include real.journal
  include indented.journal
included.journal
include \"quoted path.journal\"
include
";
        assert_eq!(
            include_targets(contents),
            vec!["real.journal", "indented.journal", "quoted path.journal"]
        );
    }

    #[test]
    fn resolves_includes_relative_to_the_including_file() {
        assert_eq!(resolve_relative("a.journal", "b.journal"), "b.journal");
        assert_eq!(resolve_relative("dir/a.journal", "b.journal"), "dir/b.journal");
        assert_eq!(resolve_relative("a/b/c.journal", "../d.journal"), "a/d.journal");
        assert_eq!(resolve_relative("dir/a.journal", "sub/b.journal"), "dir/sub/b.journal");
        assert_eq!(resolve_relative("dir/a.journal", "/abs.journal"), "abs.journal");
    }

    #[test]
    fn no_journal_files_means_no_choice() {
        let files = [candidate("notes.txt", "hello"), candidate("data.csv", "a,b")];
        assert_eq!(resolve_main_journal(&files), None);
        assert_eq!(resolve_main_journal(&[]), None);
    }

    #[test]
    fn a_single_journal_is_used_directly() {
        let files = [
            candidate("notes.txt", ""),
            candidate("books.journal", "2024-01-01 x\n"),
        ];
        assert_eq!(resolve_main_journal(&files), Some(file("books.journal")));
    }

    #[test]
    fn prefers_the_file_that_includes_the_others() {
        // The root is not the shallowest file and has no conventional name, but
        // it is the one that pulls everything together.
        let files = [
            candidate("aaa.journal", "2024-01-01 a\n    x  1\n    y\n"),
            candidate("zzz.journal", "2024-01-01 z\n    p  1\n    q\n"),
            candidate("sub/root.journal", "include ../aaa.journal\ninclude ../zzz.journal\n"),
        ];
        assert_eq!(
            resolve_main_journal(&files),
            Some(file("sub/root.journal")),
            "the including file is the root even though it is nested deeper"
        );
    }

    #[test]
    fn an_include_of_an_unpicked_file_does_not_win() {
        // `include` pointing outside the loaded set says nothing about which
        // picked file is the root, so the conventional name should decide.
        let files = [
            candidate("hledger.journal", "include /somewhere/else.journal\n"),
            candidate("other.journal", "2024-01-01 x\n    a  1\n    b\n"),
        ];
        assert_eq!(resolve_main_journal(&files), Some(file("hledger.journal")));
    }

    #[test]
    fn prefers_a_conventional_name_at_any_depth() {
        let files = [
            candidate("alpha.journal", ""),
            candidate("books/main.journal", ""),
        ];
        assert_eq!(resolve_main_journal(&files), Some(file("books/main.journal")));
    }

    #[test]
    fn falls_back_to_the_shallowest_unique_file() {
        // No includes and no conventional names: the lone top-level file wins.
        let files = [candidate("books.journal", ""), candidate("sub/other.journal", "")];
        assert_eq!(resolve_main_journal(&files), Some(file("books.journal")));
    }

    #[test]
    fn generates_a_root_when_the_choice_is_genuinely_ambiguous() {
        let files = [
            candidate("b.journal", ""),
            candidate("a.journal", ""),
            candidate("notes.txt", "not a journal"),
        ];
        match resolve_main_journal(&files).expect("a choice must be made") {
            MainJournal::Synthetic { path, contents } => {
                assert_eq!(path, SYNTHETIC_ROOT);
                // Sorted shallowest-then-alphabetical, so the output is stable.
                assert!(contents.contains("include a.journal\n"));
                assert!(contents.contains("include b.journal\n"));
                assert!(
                    contents.find("a.journal") < contents.find("b.journal"),
                    "includes should be in sorted order"
                );
                assert!(!contents.contains("notes.txt"), "non-journals are not included");
            }
            other => panic!("expected a synthetic root, got {other:?}"),
        }
    }

    #[test]
    fn ties_break_alphabetically_so_the_result_is_stable() {
        let files = [candidate("z.journal", ""), candidate("y.journal", "")];
        let first = resolve_main_journal(&files);
        let second = resolve_main_journal(&files);
        assert_eq!(first, second);
        // Two files at the same shallow depth with no other signal: synthetic.
        assert!(matches!(first, Some(MainJournal::Synthetic { .. })));
    }

    #[test]
    fn main_journal_exposes_the_path_the_engine_needs() {
        let synthetic = MainJournal::Synthetic {
            path: SYNTHETIC_ROOT.to_string(),
            contents: "include a.journal\n".to_string(),
        };
        assert_eq!(synthetic.path(), SYNTHETIC_ROOT);
        assert_eq!(synthetic.extra_file(), Some((SYNTHETIC_ROOT, "include a.journal\n")));
        assert_eq!(file("a.journal").extra_file(), None);
        assert_eq!(file("a.journal").path(), "a.journal");
    }
}
