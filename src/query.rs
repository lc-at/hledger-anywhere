//! Table controls: a query string and a sort order (pure).
//!
//! Both are the kind of logic that looks trivial and is not. Splitting a query
//! on whitespace breaks `payee:"coffee shop"`, which is exactly the sort of query
//! people write; and "put the numbers largest first" is a decision worth writing
//! down once rather than re-deriving per panel.

// The consumers are the wasm-only panels; see the same note in `journal`.
#![cfg_attr(not(target_arch = "wasm32"), allow(dead_code))]

use std::cmp::Ordering;

/// Which way a sorted column runs.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SortDir {
    Ascending,
    Descending,
}

impl SortDir {
    /// What clicking the same column again should do.
    pub fn flipped(self) -> Self {
        match self {
            SortDir::Ascending => SortDir::Descending,
            SortDir::Descending => SortDir::Ascending,
        }
    }

    /// The glyph shown on the active column's header.
    pub const fn glyph(self) -> &'static str {
        match self {
            SortDir::Ascending => "▲",
            SortDir::Descending => "▼",
        }
    }

    /// Apply this direction to an ordering.
    fn apply(self, ordering: Ordering) -> Ordering {
        match self {
            SortDir::Ascending => ordering,
            SortDir::Descending => ordering.reverse(),
        }
    }
}

/// Sort `rows` with a comparator, in the given direction.
///
/// A comparator rather than a key function because the columns of one table do
/// not share a key type: sorting accounts by name is a string comparison and
/// sorting them by balance is a decimal one, and making both produce one key type
/// only invites a pointless enum.
///
/// `sort_by` is stable, so equal rows keep the order the report put them in —
/// which for a balance report means rows do not shuffle when the key does not
/// distinguish them.
pub fn sort_by_cmp<T, F>(rows: &mut [T], compare: F, dir: SortDir)
where
    F: Fn(&T, &T) -> Ordering,
{
    rows.sort_by(|left, right| dir.apply(compare(left, right)));
}

/// Split a query string into hledger arguments.
///
/// Double quotes group terms containing spaces and are removed, because these
/// are passed as argv — there is no shell to strip them, so leaving them in would
/// make hledger look for a payee literally called `"coffee shop"`.
///
/// Blank space is not an argument, and an unterminated quote simply runs to the
/// end rather than being an error: a half-typed query should still do something
/// sensible while the user is still typing it.
pub fn query_args(query: &str) -> Vec<String> {
    let mut args = Vec::new();
    let mut current = String::new();
    let mut quoted = false;

    for character in query.chars() {
        match character {
            '"' => quoted = !quoted,
            whitespace if whitespace.is_whitespace() && !quoted => {
                if !current.is_empty() {
                    args.push(std::mem::take(&mut current));
                }
            }
            other => current.push(other),
        }
    }
    if !current.is_empty() {
        args.push(current);
    }
    args
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_plain_query_splits_on_whitespace() {
        assert_eq!(
            query_args("date:thismonth exp:food"),
            vec!["date:thismonth", "exp:food"]
        );
    }

    #[test]
    fn a_quoted_term_keeps_its_space_and_loses_its_quotes() {
        // The case that makes naive splitting wrong: hledger wants this as one
        // argument, and the quotes are shell syntax we have already replaced.
        assert_eq!(
            query_args(r#"payee:"coffee shop" exp:food"#),
            vec!["payee:coffee shop", "exp:food"]
        );
    }

    #[test]
    fn surrounding_whitespace_is_not_an_argument() {
        assert_eq!(query_args("   cur:usd   "), vec!["cur:usd"]);
        assert_eq!(query_args("a   b"), vec!["a", "b"]);
        assert_eq!(query_args(""), Vec::<String>::new());
        assert_eq!(query_args("     "), Vec::<String>::new());
    }

    #[test]
    fn an_unterminated_quote_runs_to_the_end() {
        // Half-typed, while the user is still typing: still one usable argument.
        assert_eq!(
            query_args(r#"payee:"coffee"#),
            vec!["payee:coffee"]
        );
    }

    #[test]
    fn a_quoted_empty_pattern_reduces_to_the_bare_term() {
        // This is exactly what a shell does with `desc:""`, and hledger reads a
        // bare `desc:` as "an empty description" — which is the query being
        // written. Passing the quotes through instead would ask for a
        // description literally containing two quote characters.
        assert_eq!(query_args(r#"desc:"""#), vec!["desc:"]);
    }

    #[test]
    fn sorting_honours_direction_and_stability() {
        let mut rows = vec![3, 1, 2];
        sort_by_cmp(&mut rows, |a, b| a.cmp(b), SortDir::Ascending);
        assert_eq!(rows, vec![1, 2, 3]);

        sort_by_cmp(&mut rows, |a, b| a.cmp(b), SortDir::Descending);
        assert_eq!(rows, vec![3, 2, 1]);

        // Equal keys keep their original relative order.
        let mut tied = vec![("b", 1), ("a", 1), ("c", 0)];
        sort_by_cmp(&mut tied, |a, b| a.1.cmp(&b.1), SortDir::Ascending);
        assert_eq!(tied, vec![("c", 0), ("b", 1), ("a", 1)]);
    }

    #[test]
    fn direction_flips_and_names_its_glyph() {
        assert_eq!(SortDir::Ascending.flipped(), SortDir::Descending);
        assert_eq!(SortDir::Descending.flipped(), SortDir::Ascending);
        assert_eq!(SortDir::Ascending.glyph(), "▲");
        assert_eq!(SortDir::Descending.glyph(), "▼");
    }
}
