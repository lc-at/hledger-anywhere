//! The scrollback's bookkeeping: what was written, and how much of it is kept.
//!
//! A reload puts the last visit's screen back above the fresh banner, and what goes back
//! is what this holds: every chunk written to the terminal, in the order it was written,
//! escape sequences included, trimmed to [`MAX_CAPTURE_BYTES`] so the copy in
//! `localStorage` stays the tail of the screen rather than an archive of the visit.
//!
//! Nothing here knows about a browser. The half that talks to xterm is `view.rs`, behind
//! the wasm gate, and this is the half `cargo test` can see: bookkeeping that only ever
//! compiled for wasm was bookkeeping no test had ever run against.
//!
//! Every write reaches `push`, the replayed screen included: what a reload puts back
//! is the screen itself, so one visit adds one boot to it and the cap — not a path
//! that skips the capture — is what keeps the stored copy bounded. `push` is the one
//! way in.

use std::collections::VecDeque;

/// The most captured text kept for the next visit, in bytes.
///
/// `localStorage` is about 5 MB, shared with the settings, the history and the
/// session's files, and xterm's own scrollback is 50_000 rows: the capture is
/// the persistent tail of the screen, not an archive of the visit.
const MAX_CAPTURE_BYTES: usize = 512 * 1024;

/// Everything written since the mount or the last [`Capture::clear`], in the chunks it
/// was given, so a reload can put the screen back with its colours intact.
#[derive(Default)]
pub struct Capture {
    /// The chunks themselves, oldest first.
    chunks: VecDeque<String>,
    /// The capture's size in bytes, kept so trimming costs only what it drops.
    bytes: usize,
}

impl Capture {
    /// The trim runs chunk by chunk, so a write costs what it appends and
    /// nothing else; only crossing the cap walks back over old chunks.
    pub fn push(&mut self, chunk: &str) {
        self.chunks.push_back(chunk.to_string());
        self.bytes += chunk.len();
        while self.bytes > MAX_CAPTURE_BYTES {
            let Some(oldest) = self.chunks.pop_front() else {
                break;
            };
            self.bytes -= oldest.len();
        }
    }

    /// What a save stores and the next visit replays. Reading it neither empties it nor
    /// grows it: only [`Capture::push`] adds, only [`Capture::clear`] takes away.
    pub fn as_text(&self) -> String {
        self.chunks.iter().map(String::as_str).collect()
    }

    /// Drop what is kept, count and all, so the next save stores only what is written
    /// after this — `clear` asked for the scrollback to be gone, the stored copy with it.
    pub fn clear(&mut self) {
        self.chunks.clear();
        self.bytes = 0;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn quarter(letter: char) -> String {
        letter.to_string().repeat(MAX_CAPTURE_BYTES / 4)
    }

    #[test]
    fn the_cap_is_exact_and_crossing_it_drops_oldest_chunks_whole() {
        let mut capture = Capture::default();
        for letter in ['a', 'b', 'c', 'd'] {
            capture.push(&quarter(letter));
        }
        // Four quarters are exactly the cap, and exactly the cap is kept: every byte
        // of it is still here, oldest chunk first.
        assert_eq!(capture.as_text().len(), MAX_CAPTURE_BYTES);
        assert!(capture.as_text().starts_with('a'));
        assert!(capture.as_text().ends_with('d'));

        // One byte past the cap and the oldest chunk goes, whole rather than trimmed:
        // what is left is the three newer quarters plus the byte, so the cap is
        // overshoot-free again but for the chunk that was dropped.
        capture.push("!");
        assert_eq!(capture.as_text().len(), MAX_CAPTURE_BYTES - MAX_CAPTURE_BYTES / 4 + 1);
        assert!(capture.as_text().starts_with('b'));
        assert!(capture.as_text().ends_with('!'));
    }

    #[test]
    fn one_chunk_larger_than_the_cap_keeps_nothing() {
        // The single write that is over the cap on its own: it does not fit, and there
        // is no older chunk to make room, so the capture holds nothing and the save
        // will remove the key rather than store a screen xterm cannot show whole.
        let mut capture = Capture::default();
        capture.push(&"x".repeat(MAX_CAPTURE_BYTES + 1));
        assert!(capture.as_text().is_empty());
    }

    #[test]
    fn the_text_reads_in_the_order_it_was_written() {
        let mut capture = Capture::default();
        capture.push("balance\r\n");
        capture.push("total    $1.00\r\n");
        capture.push("» ");
        assert_eq!(capture.as_text(), "balance\r\ntotal    $1.00\r\n» ");
    }

    #[test]
    fn clear_empties_it_and_the_count_kept_behind_it() {
        let mut capture = Capture::default();
        capture.push("a report\r\n");
        capture.push("» prompt");
        capture.clear();
        assert!(capture.as_text().is_empty());

        // A nearly-full cap must now fit untouched. The count is private and
        // invisible otherwise, so this is where it shows: were it still carrying what
        // the cleared text weighed, this push would cross the cap and drop itself.
        let fresh = "fresh".repeat(MAX_CAPTURE_BYTES / 5);
        capture.push(&fresh);
        assert_eq!(capture.as_text(), fresh);
    }

    #[test]
    fn reading_it_back_over_and_over_grows_nothing() {
        // A reload replays what a save read, and this pins the read: `as_text` neither
        // empties the capture nor grows it, so the same text is there after every
        // reload for as long as the visit goes. Growth has one way in, `push`, and a
        // replay coming through it adds one screen once — the next save's bytes, the
        // ones the cap above bounds — rather than the same bytes again and again.
        let mut capture = Capture::default();
        capture.push("what was on screen\r\n");
        let stored = capture.as_text();
        for _ in 0..3 {
            assert_eq!(capture.as_text(), stored);
        }
    }
}
