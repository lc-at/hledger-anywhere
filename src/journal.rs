//! Choosing which uploaded file hledger should read.
//!
//! Pure: no browser, no engine. Uploading a folder of journal files raises a
//! question the user should not have to answer every time — *which one is the
//! journal?* — and getting it wrong produces hledger's "no such file" rather than
//! a report, so the rules are worth stating once and testing here rather than
//! being buried in the upload handler.
//!
//! Deciding this is only a default. `journal <path>` overrides it, and the
//! terminal always says which file it chose.

// Natively this module exists for its tests: the only code that uses it is
// wasm-gated, so its items look unused to `cargo test`'s build.
#![cfg_attr(not(target_arch = "wasm32"), allow(dead_code))]

use crate::hledger::JournalFile;

/// Names hledger's own tooling looks for, in preference order.
const CONVENTIONAL_NAMES: [&str; 3] = ["hledger.journal", ".hledger.journal", "hledger.hledger"];

/// Whether a path is one hledger would accept as a journal.
pub fn is_journal_path(path: &str) -> bool {
    let lower = path.to_ascii_lowercase();
    lower.ends_with(".journal") || lower.ends_with(".hledger") || lower.ends_with(".j")
}

/// The file name without its directories.
fn basename(path: &str) -> &str {
    path.rsplit('/').next().unwrap_or(path)
}

/// How deeply nested a path is; a shallower file is the more likely root.
fn depth(path: &str) -> usize {
    path.matches('/').count()
}

/// The paths a journal's `include` directives mention.
///
/// Deliberately loose: an `include` line's operand is taken as written, comments
/// stripped. It only has to be good enough to tell a root journal from a leaf.
fn includes(contents: &str) -> Vec<String> {
    contents
        .lines()
        .filter_map(|line| {
            let line = line.split(';').next().unwrap_or("").trim();
            let rest = line.strip_prefix("include")?;
            // `include` must be the whole word: `included` is not a directive.
            if !rest.starts_with(char::is_whitespace) {
                return None;
            }
            let target = rest.trim().trim_matches('"');
            (!target.is_empty()).then(|| target.to_string())
        })
        .collect()
}

/// Whether `target` names `file`, allowing for a relative path.
fn names_file(target: &str, file: &str) -> bool {
    let target = target.trim_start_matches("./");
    let file = file.trim_start_matches("./");
    target == file || target == basename(file) || file.ends_with(&format!("/{target}"))
}

/// Choose the journal to read from the uploaded files.
///
/// In order: the file that includes the most other uploaded files (a multi-file
/// setup's root is the one that pulls the rest in); a conventional name; the only
/// journal-shaped file; the shallowest of several. `None` means nothing uploaded
/// looks like a journal at all, which the caller reports rather than guessing.
pub fn choose_main(files: &[JournalFile]) -> Option<String> {
    let mut journals: Vec<&JournalFile> = files
        .iter()
        .filter(|file| is_journal_path(&file.path))
        .collect();
    if journals.is_empty() {
        return None;
    }
    if journals.len() == 1 {
        return Some(journals[0].path.clone());
    }

    // Shallowest first, then alphabetically, so every later rule is deterministic.
    journals.sort_by(|left, right| {
        depth(&left.path)
            .cmp(&depth(&right.path))
            .then_with(|| left.path.cmp(&right.path))
    });

    let mut best: Option<(usize, &JournalFile)> = None;
    for file in &journals {
        let score = includes(&file.contents)
            .iter()
            .filter(|target| {
                journals
                    .iter()
                    .any(|other| other.path != file.path && names_file(target, &other.path))
            })
            .count();
        if score > 0 && best.is_none_or(|(best_score, _)| score > best_score) {
            best = Some((score, file));
        }
    }
    if let Some((_, file)) = best {
        return Some(file.path.clone());
    }

    for name in CONVENTIONAL_NAMES {
        if let Some(file) = journals.iter().find(|file| basename(&file.path) == name) {
            return Some(file.path.clone());
        }
    }

    Some(journals[0].path.clone())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn file(path: &str, contents: &str) -> JournalFile {
        JournalFile::new(path, contents)
    }

    #[test]
    fn a_single_journal_needs_no_guessing() {
        let files = [file("books.journal", ""), file("notes.txt", "x")];
        assert_eq!(choose_main(&files).as_deref(), Some("books.journal"));
    }

    #[test]
    fn the_root_of_an_include_graph_wins_over_its_leaves() {
        // The root is the file that pulls the others in, whatever it is called.
        let files = [
            file("2024.journal", "2024-01-01 x\n    a  1\n    b  -1\n"),
            file("root.journal", "include 2024.journal\ninclude 2025.journal\n"),
            file("2025.journal", "2025-01-01 y\n    a  1\n    b  -1\n"),
        ];
        assert_eq!(choose_main(&files).as_deref(), Some("root.journal"));
    }

    #[test]
    fn an_include_matches_a_bare_name_or_a_relative_path() {
        let files = [
            file("books/2024.journal", ""),
            file("root.journal", "include books/2024.journal\n"),
        ];
        assert_eq!(choose_main(&files).as_deref(), Some("root.journal"));

        let files = [
            file("books/2024.journal", ""),
            file("root.journal", "include 2024.journal\n"),
        ];
        assert_eq!(choose_main(&files).as_deref(), Some("root.journal"));
    }

    #[test]
    fn included_is_not_an_include_directive() {
        let files = [
            file("a.journal", "included b.journal\n"),
            file("b.journal", ""),
            file("hledger.journal", ""),
        ];
        // No real include, so the conventional name is what decides.
        assert_eq!(choose_main(&files).as_deref(), Some("hledger.journal"));
    }

    #[test]
    fn a_conventional_name_beats_an_arbitrary_one() {
        let files = [file("aaa.journal", ""), file("hledger.journal", "")];
        assert_eq!(choose_main(&files).as_deref(), Some("hledger.journal"));
    }

    #[test]
    fn otherwise_the_shallowest_journal_wins_deterministically() {
        let files = [
            file("books/deep/2024.journal", ""),
            file("books/2025.journal", ""),
        ];
        assert_eq!(choose_main(&files).as_deref(), Some("books/2025.journal"));

        // Same depth: alphabetical, so the answer never changes between runs.
        let files = [file("b.journal", ""), file("a.journal", "")];
        assert_eq!(choose_main(&files).as_deref(), Some("a.journal"));
    }

    #[test]
    fn nothing_journal_shaped_means_no_guess() {
        let files = [file("notes.txt", "x"), file("data.csv", "a,b")];
        assert_eq!(choose_main(&files), None);
        assert_eq!(choose_main(&[]), None);
    }

    #[test]
    fn every_hledger_journal_extension_is_recognised() {
        assert!(is_journal_path("a.journal"));
        assert!(is_journal_path("a.hledger"));
        assert!(is_journal_path("a.j"));
        assert!(is_journal_path("A.JOURNAL"));
        assert!(!is_journal_path("a.journal.bak"));
        assert!(!is_journal_path("journal"));
    }
}
