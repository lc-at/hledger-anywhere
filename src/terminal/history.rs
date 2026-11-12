//! The command history: Ctrl+R's fuzzy finder, and the `history` command.
//!
//! Ctrl+R works the way fzf's does in a shell: a query line, and under it every past command
//! that matches, best first, with the letters that matched lit. Typing narrows the list,
//! the arrows (or Ctrl+P and Ctrl+N, Ctrl+K and Ctrl+J, Ctrl+R again) move through it, and
//! Enter puts the chosen command on the prompt to run or change. Everything here is pure: the
//! matching, the ranking and the lines drawn, so all of it is tested without a terminal.

use super::text::{accent_escape, dim, BOLD, RESET};

/// One past command that matches the query, and where.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Match {
    pub entry: String,
    /// The characters that matched, as indexes into the entry's characters, for lighting.
    pub positions: Vec<usize>,
    pub score: i64,
}

/// What a character is worth when it matches, and the bonuses and penalties around it.
const SCORE_MATCH: i64 = 16;
const BONUS_BOUNDARY: i64 = 8;
const BONUS_CONSECUTIVE: i64 = 6;
const BONUS_FIRST: i64 = 4;
const PENALTY_GAP_START: i64 = 3;
const PENALTY_GAP: i64 = 1;

/// Whether the character before `at` ends a word, so a match at `at` starts one: the start
/// of the line, or after a space, an account separator or punctuation.
fn starts_word(chars: &[char], at: usize) -> bool {
    at == 0
        || matches!(
            chars[at - 1],
            ' ' | ':' | '-' | '_' | '.' | '/' | '=' | '"' | '\'' | '(' | ','
        )
}

/// How well one term matches `chars`, and where, or `None` if it does not.
///
/// A term is fuzzy, its letters in order with anything between, the way fzf reads one; a
/// term that starts with `'` must appear as it is written, `^` anchors it to the start and a
/// trailing `$` to the end. Case is ignored unless the term has a capital in it, which is
/// fzf's "smart case". The fuzzy match is fzf's first algorithm: the leftmost place the
/// letters can be found, then tightened from the right, so the window is as short as it can
/// be and a run of letters together scores as one.
fn term_match(term: &str, chars: &[char]) -> Option<(i64, Vec<usize>)> {
    let (exact, term) = match term.strip_prefix('\'') {
        Some(rest) => (true, rest),
        None => (false, term),
    };
    let (prefix, term) = match term.strip_prefix('^') {
        Some(rest) => (true, rest),
        None => (false, term),
    };
    let (suffix, term) = match term.strip_suffix('$') {
        Some(rest) if !rest.is_empty() => (true, rest),
        _ => (false, term),
    };
    if term.is_empty() {
        return Some((0, Vec::new()));
    }
    let smart = term.chars().any(char::is_uppercase);
    let fold = |c: char| if smart { c } else { c.to_lowercase().next().unwrap_or(c) };
    let wanted: Vec<char> = term.chars().map(fold).collect();
    let text: Vec<char> = chars.iter().copied().map(fold).collect();

    if exact || prefix || suffix {
        let starts: Vec<usize> = if prefix {
            vec![0]
        } else if suffix {
            vec![text.len().saturating_sub(wanted.len())]
        } else {
            (0..text.len()).collect()
        };
        for start in starts {
            if start + wanted.len() <= text.len() && text[start..start + wanted.len()] == wanted[..] {
                let positions: Vec<usize> = (start..start + wanted.len()).collect();
                return Some((score(chars, &positions), positions));
            }
        }
        return None;
    }

    // Forward: the leftmost place every letter can be found, in order.
    let mut at = 0;
    let mut end = 0;
    for letter in &wanted {
        let found = at + text[at..].iter().position(|c| c == letter)?;
        end = found;
        at = found + 1;
    }
    // Backward from where the last letter was found: the latest each letter can start, which
    // is the shortest window holding them all.
    let mut positions = vec![0; wanted.len()];
    let mut at = end + 1;
    for (index, letter) in wanted.iter().enumerate().rev() {
        let found = text[..at].iter().rposition(|c| c == letter)?;
        positions[index] = found;
        at = found;
    }
    Some((score(chars, &positions), positions))
}

/// What a set of matched positions is worth.
fn score(chars: &[char], positions: &[usize]) -> i64 {
    let mut total = 0;
    let mut previous: Option<usize> = None;
    for &at in positions {
        total += SCORE_MATCH;
        if starts_word(chars, at) {
            total += BONUS_BOUNDARY;
        }
        match previous {
            Some(before) if at == before + 1 => total += BONUS_CONSECUTIVE,
            Some(before) => total -= PENALTY_GAP_START + PENALTY_GAP * (at - before - 2) as i64,
            None => {
                if at == 0 {
                    total += BONUS_FIRST;
                }
            }
        }
        previous = Some(at);
    }
    total
}

/// Every past command matching `query`, best first.
///
/// Each command is listed once, at its most recent use. The query's words must all match
/// (fzf's extended search: `bal exp` finds `balance expenses`); between two equally good
/// matches the more recent comes first, and a shorter command breaks a tie after that. With
/// nothing typed, it is simply the history, newest first.
pub fn history_matches(history: &[String], query: &str) -> Vec<Match> {
    let terms: Vec<&str> = query.split_whitespace().collect();
    let mut seen = std::collections::HashSet::new();
    let mut out: Vec<(Match, usize)> = Vec::new();
    for (age, entry) in history.iter().rev().enumerate() {
        if !seen.insert(entry.as_str()) {
            continue;
        }
        let chars: Vec<char> = entry.chars().collect();
        let mut positions = Vec::new();
        let mut total = 0;
        let mut matched = true;
        for term in &terms {
            match term_match(term, &chars) {
                Some((points, found)) => {
                    total += points;
                    positions.extend(found);
                }
                None => {
                    matched = false;
                    break;
                }
            }
        }
        if !matched {
            continue;
        }
        positions.sort_unstable();
        positions.dedup();
        out.push((Match { entry: entry.clone(), positions, score: total }, age));
    }
    out.sort_by(|(left, left_age), (right, right_age)| {
        right
            .score
            .cmp(&left.score)
            .then(left_age.cmp(right_age))
            .then(left.entry.chars().count().cmp(&right.entry.chars().count()))
    });
    out.into_iter().map(|(found, _)| found).collect()
}

/// The first row of the list to draw, so the selected one is always in view.
pub fn scroll_to(selected: usize, offset: usize, height: usize) -> usize {
    let height = height.max(1);
    if selected < offset {
        selected
    } else if selected >= offset + height {
        selected + 1 - height
    } else {
        offset
    }
}

/// What the finder looks like on screen, below the prompt line it replaces.
pub struct Picker<'a> {
    pub query: &'a str,
    pub matches: &'a [Match],
    pub selected: usize,
    pub offset: usize,
    /// How many distinct commands there are to search, for the count.
    pub total: usize,
    pub width: usize,
    /// How many rows of matches to show at most.
    pub height: usize,
}

/// The label the query is typed after.
pub const PICKER_PROMPT: &str = "history> ";

/// The lines that draw the finder, and the column the cursor goes back to on the first.
///
/// The query comes first, where the prompt was, with how many match out of how many; under
/// it the matches, best first, the selected one marked and bold, each letter that matched in
/// the accent colour. A command too long for the screen is cut with an ellipsis rather than
/// wrapped, because a wrapped line would throw the count of lines to move back up over.
pub fn picker_lines(view: &Picker) -> (Vec<String>, usize) {
    let width = view.width.max(20);
    let count = dim(&format!("  {}/{}", view.matches.len(), view.total));
    let query = view.query.chars().take(width.saturating_sub(PICKER_PROMPT.len() + 12)).collect::<String>();
    let mut lines = vec![format!("{}{PICKER_PROMPT}{RESET}{query}{count}", accent_escape())];
    let column = PICKER_PROMPT.len() + query.chars().count();
    if view.matches.is_empty() {
        lines.push(dim(if view.total == 0 {
            "  no history yet: commands you run are kept here"
        } else {
            "  nothing matches"
        }));
        return (lines, column);
    }
    let room = width.saturating_sub(3);
    for (index, found) in view.matches.iter().enumerate().skip(view.offset).take(view.height.max(1)) {
        let selected = index == view.selected;
        let chars: Vec<char> = found.entry.chars().collect();
        let cut = chars.len() > room;
        let shown = if cut { room.saturating_sub(1) } else { chars.len() };
        let base = if selected { BOLD } else { "" };
        let mut line = String::new();
        line.push_str(&if selected {
            format!("{}▌{RESET} ", accent_escape())
        } else {
            "  ".to_string()
        });
        line.push_str(base);
        for (at, character) in chars.iter().take(shown).enumerate() {
            if found.positions.binary_search(&at).is_ok() {
                line.push_str(&format!("{}{character}{RESET}{base}", accent_escape()));
            } else {
                line.push(*character);
            }
        }
        if cut {
            line.push('…');
        }
        line.push_str(RESET);
        lines.push(line);
    }
    (lines, column)
}

/// The `history` command's listing: every command kept, oldest first and numbered, the way
/// a shell's `history` prints it; with words, only those containing them all.
pub fn history_listing(history: &[String], filter: Option<&str>) -> String {
    if history.is_empty() {
        return "No history yet: the commands you run are kept here, the last thousand of them, \
                and Ctrl+R searches them."
            .to_string();
    }
    let words: Vec<String> = filter
        .unwrap_or("")
        .split_whitespace()
        .map(str::to_lowercase)
        .collect();
    let width = history.len().to_string().len();
    let lines: Vec<String> = history
        .iter()
        .enumerate()
        .filter(|(_, entry)| {
            let lower = entry.to_lowercase();
            words.iter().all(|word| lower.contains(word.as_str()))
        })
        .map(|(index, entry)| format!("{}  {entry}", dim(&format!("{:>width$}", index + 1))))
        .collect();
    if lines.is_empty() {
        return format!(
            "No command in the history contains {}.",
            filter.unwrap_or("").trim()
        );
    }
    lines.join("\n")
}

#[cfg(test)]
mod tests {
    use super::super::text::plain;
    use super::*;

    fn history(entries: &[&str]) -> Vec<String> {
        entries.iter().map(|entry| (*entry).to_string()).collect()
    }

    fn found(history: &[String], query: &str) -> Vec<String> {
        history_matches(history, query).into_iter().map(|hit| hit.entry).collect()
    }

    #[test]
    fn nothing_typed_is_the_history_newest_first_each_command_once() {
        let kept = history(&["balance", "print", "balance", "stats"]);
        assert_eq!(found(&kept, ""), ["stats", "balance", "print"]);
    }

    #[test]
    fn letters_in_order_match_and_a_tight_run_ranks_first() {
        let kept = history(&["register expenses", "balance expenses", "bal", "print"]);
        // b..l..x across balance expenses, and bal as a run in two of them.
        let matches = found(&kept, "blx");
        assert_eq!(matches, ["balance expenses"]);
        // A run at the start of a word beats the same letters scattered.
        let kept = history(&["b a l", "balance"]);
        assert_eq!(found(&kept, "bal")[0], "balance");
    }

    #[test]
    fn every_word_of_the_query_must_match_somewhere() {
        let kept = history(&["balance assets", "balance expenses", "register expenses"]);
        assert_eq!(found(&kept, "bal exp"), ["balance expenses"]);
        assert_eq!(found(&kept, "exp bal"), ["balance expenses"]);
        assert!(found(&kept, "bal zzz").is_empty());
    }

    #[test]
    fn exact_prefix_and_suffix_terms_are_fzfs() {
        let kept = history(&["balance expenses", "register expenses -M", "print expenses"]);
        assert_eq!(found(&kept, "'ses -"), ["register expenses -M"]);
        assert_eq!(found(&kept, "^print"), ["print expenses"]);
        assert_eq!(found(&kept, "expenses$").len(), 2);
        // An exact term does not match letters spread apart.
        assert!(found(&kept, "'bxp").is_empty());
    }

    #[test]
    fn case_is_ignored_unless_the_query_has_a_capital() {
        let kept = history(&["balance Assets", "balance assets:cash"]);
        assert_eq!(found(&kept, "assets").len(), 2);
        assert_eq!(found(&kept, "Assets"), ["balance Assets"]);
    }

    #[test]
    fn between_equals_the_more_recent_wins() {
        let kept = history(&["balance food", "balance fuel"]);
        // Both match "balance" equally; the newer is first.
        assert_eq!(found(&kept, "balance"), ["balance fuel", "balance food"]);
    }

    #[test]
    fn the_positions_lit_are_the_letters_that_matched() {
        let kept = history(&["balance expenses"]);
        let hit = &history_matches(&kept, "bex")[0];
        let chars: Vec<char> = hit.entry.chars().collect();
        let lit: String = hit.positions.iter().map(|&at| chars[at]).collect();
        assert_eq!(lit, "bex");
        // The tightest window: the x is the one in expenses, and the e right before it.
        assert_eq!(hit.positions, vec![0, 8, 9]);
    }

    #[test]
    fn the_list_scrolls_to_keep_the_selection_in_view() {
        assert_eq!(scroll_to(0, 0, 5), 0);
        assert_eq!(scroll_to(4, 0, 5), 0);
        assert_eq!(scroll_to(5, 0, 5), 1);
        assert_eq!(scroll_to(2, 3, 5), 2);
        assert_eq!(scroll_to(3, 0, 0), 3);
    }

    #[test]
    fn the_finder_draws_its_query_count_and_matches_with_the_selection_marked() {
        let kept = history(&["balance expenses", "balance assets", "print"]);
        let matches = history_matches(&kept, "bal");
        let (lines, column) = picker_lines(&Picker {
            query: "bal",
            matches: &matches,
            selected: 1,
            offset: 0,
            total: 3,
            width: 80,
            height: 10,
        });
        let shown: Vec<String> = lines.iter().map(|line| plain(line)).collect();
        assert_eq!(shown[0], "history> bal  2/3");
        assert_eq!(column, "history> bal".len());
        assert_eq!(shown[1], "  balance assets");
        assert_eq!(shown[2], "▌ balance expenses");
        assert!(lines[2].contains(BOLD), "{:?}", lines[2]);
        assert!(lines[1].contains(&accent_escape()), "the matched letters are lit");
    }

    #[test]
    fn a_long_command_is_cut_to_the_screen_not_wrapped() {
        let long = "balance ".repeat(20);
        let kept = vec![long.trim().to_string()];
        let matches = history_matches(&kept, "");
        let (lines, _) = picker_lines(&Picker { query: "", matches: &matches, selected: 0, offset: 0, total: 1, width: 40, height: 5 });
        let line = plain(&lines[1]);
        assert_eq!(line.chars().count(), 2 + 37);
        assert!(line.ends_with('…'), "{line}");
    }

    #[test]
    fn an_empty_finder_says_why() {
        let (lines, _) = picker_lines(&Picker { query: "", matches: &[], selected: 0, offset: 0, total: 0, width: 80, height: 5 });
        assert!(plain(&lines[1]).contains("no history yet"));
        let (lines, _) = picker_lines(&Picker { query: "zz", matches: &[], selected: 0, offset: 0, total: 4, width: 80, height: 5 });
        assert_eq!(plain(&lines[1]).trim(), "nothing matches");
        assert_eq!(plain(&lines[0]), "history> zz  0/4");
    }

    #[test]
    fn the_history_command_lists_everything_numbered_or_what_contains_the_words() {
        let kept = history(&["balance", "print expenses", "register expenses"]);
        assert_eq!(plain(&history_listing(&kept, None)), "1  balance\n2  print expenses\n3  register expenses");
        assert_eq!(plain(&history_listing(&kept, Some("EXP reg"))), "3  register expenses");
        assert!(history_listing(&kept, Some("nothing")).contains("No command in the history contains nothing"));
        assert!(history_listing(&[], None).starts_with("No history yet"));
        // Numbers line up when there are more than nine.
        let many: Vec<String> = (1..=12).map(|n| format!("cmd{n}")).collect();
        assert!(plain(&history_listing(&many, None)).starts_with(" 1  cmd1\n"));
    }
}
