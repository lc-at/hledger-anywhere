//! `host.refresh()`: reading an opened folder again after something else edited it.
//!
//! A plugin window can sit beside an outside editor working on the same folder. When
//! it asks, every file the folder mounted is stat'ed on disk; a file whose size or
//! modification time moved is read again and replaces the copy in memory, and a file
//! that can no longer be read is reported and left as it was.
//!
//! The browser half lives in the app; what is decided here is pure, so `cargo test`
//! covers it: whether a stat means "changed", and the report a plugin gets back.

/// A file's size and modification time, as the File System Access API reports them.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Stat {
    pub size: u64,
    pub last_modified: f64,
}

/// Whether the file on disk is not the one last read or written.
///
/// The same test a save makes before writing, so after a refresh has taken in every
/// changed file, a save no longer refuses on account of the outside edit.
pub fn differs(known: Stat, on_disk: Stat) -> bool {
    known.size != on_disk.size || known.last_modified != on_disk.last_modified
}

/// What became of one mounted file when the folder was read again.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Outcome {
    /// Same size and modification time as last known.
    Unchanged,
    /// Read again from disk; the copy in memory was replaced.
    Changed,
    /// Deleted, renamed, or no longer readable as a journal; left as it was.
    Missing,
    /// The browser refused for another reason, such as a withdrawn permission; left
    /// as it was, and the reason goes in the report's `error`.
    Failed(String),
}

/// What `host.refresh()` resolves with, before it becomes a JavaScript object.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Report {
    pub changed: Vec<String>,
    pub missing: Vec<String>,
    /// Something unexpected, reported rather than thrown so the promise never rejects.
    pub error: Option<String>,
}

impl Report {
    /// Note what became of `path`.
    pub fn record(&mut self, path: &str, outcome: Outcome) {
        match outcome {
            Outcome::Unchanged => {}
            Outcome::Changed => self.changed.push(path.to_string()),
            Outcome::Missing => self.missing.push(path.to_string()),
            Outcome::Failed(reason) => {
                let line = format!("{path}: {reason}");
                self.error = Some(match self.error.take() {
                    Some(earlier) => format!("{earlier}; {line}"),
                    None => line,
                });
            }
        }
    }

    /// Whether anything in memory was replaced, so the engine and the stored session
    /// have to be told.
    pub fn any_changed(&self) -> bool {
        !self.changed.is_empty()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn stat(size: u64, last_modified: f64) -> Stat {
        Stat {
            size,
            last_modified,
        }
    }

    #[test]
    fn an_identical_stat_is_not_a_change() {
        assert!(!differs(
            stat(120, 1_700_000_000_000.0),
            stat(120, 1_700_000_000_000.0)
        ));
    }

    #[test]
    fn a_new_size_is_a_change() {
        assert!(differs(stat(120, 5.0), stat(121, 5.0)));
    }

    #[test]
    fn a_new_modification_time_is_a_change_even_at_the_same_size() {
        // An editor replacing one digit keeps the size; only the time moves.
        assert!(differs(stat(120, 5.0), stat(120, 6.0)));
    }

    #[test]
    fn the_report_sorts_outcomes_and_skips_unchanged_files() {
        let mut report = Report::default();
        report.record("a.journal", Outcome::Unchanged);
        report.record("b.journal", Outcome::Changed);
        report.record("c.journal", Outcome::Missing);
        report.record("d.journal", Outcome::Changed);
        assert_eq!(report.changed, ["b.journal", "d.journal"]);
        assert_eq!(report.missing, ["c.journal"]);
        assert_eq!(report.error, None);
        assert!(report.any_changed());
    }

    #[test]
    fn failures_are_collected_into_one_error() {
        let mut report = Report::default();
        report.record("a.journal", Outcome::Failed("permission withdrawn".into()));
        report.record("b.journal", Outcome::Failed("busy".into()));
        assert_eq!(
            report.error.as_deref(),
            Some("a.journal: permission withdrawn; b.journal: busy")
        );
        assert!(report.changed.is_empty() && report.missing.is_empty());
        assert!(!report.any_changed());
    }

    #[test]
    fn a_report_with_only_missing_files_changed_nothing() {
        let mut report = Report::default();
        report.record("gone.journal", Outcome::Missing);
        assert!(!report.any_changed());
        assert_eq!(Report::default().changed.len(), 0);
    }
}
