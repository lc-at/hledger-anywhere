//! Loading a journal from a remoteStorage account.
//!
//! [remoteStorage](https://remotestorage.io) is a protocol for storing a user's
//! data in an account they choose, so the journal follows them between devices
//! without this app running a server — which is the whole premise here. The
//! library is vendored and loaded lazily; see [`client`].
//!
//! This module is the part that can be reasoned about without a network or an
//! account: what a listing means, where the files go in the mount, and what has
//! still to be walked. Getting that right is most of the feature — the rest is
//! plumbing, and it is the part that cannot be tested without an account.

// Natively this module exists for its tests: the only code that uses it is
// wasm-gated, so its items look unused to `cargo test`'s build.
#![cfg_attr(not(target_arch = "wasm32"), allow(dead_code))]

#[cfg(target_arch = "wasm32")]
pub mod client;

/// One entry in a remoteStorage listing.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Entry {
    /// The path as the account reports it, always starting with a `/`.
    pub path: String,
    /// Folders end with a `/`; that trailing slash is the only thing that says so.
    pub is_dir: bool,
}

/// Decode the object `getListing()` resolves to.
///
/// The values are `true` for every entry when the library's cache is on, which is
/// the default, and may be metadata objects when it is off. Only the keys are
/// trusted, so both shapes work — and the trailing slash is what separates a
/// folder from a file.
pub fn parse_listing(listing: &serde_json::Value) -> Vec<Entry> {
    let Some(object) = listing.as_object() else {
        return Vec::new();
    };
    let mut entries: Vec<Entry> = object
        .keys()
        .filter(|path| !path.is_empty())
        .map(|path| Entry {
            path: normalise(path),
            is_dir: path.ends_with('/'),
        })
        .collect();
    entries.sort_by(|left, right| left.path.cmp(&right.path));
    entries.dedup_by(|left, right| left.path == right.path);
    entries
}

/// A path with exactly one leading slash and no trailing one, unless it is a
/// folder.
fn normalise(path: &str) -> String {
    let trimmed = path.trim_start_matches('/');
    if trimmed.is_empty() {
        "/".to_string()
    } else {
        format!("/{trimmed}")
    }
}

/// The directory to list for a user-typed argument.
///
/// `remote` with nothing lists the category; `remote books` lists a folder inside
/// it. A leading slash or a trailing one is accepted and ignored, because people
/// type both.
pub fn directory_for(argument: &str) -> String {
    let trimmed = argument.trim().trim_matches('/');
    if trimmed.is_empty() {
        CATEGORY.to_string()
    } else {
        format!("{CATEGORY}{trimmed}/")
    }
}

/// Where a remote file goes in the mount.
///
/// Paths are re-rooted at the category, so `/hledger/books/2024.journal` becomes
/// `books/2024.journal` — the same shape an upload produces, which is what keeps
/// `include` directives between remote files working. `None` means the path is
/// outside the category, which the walk should not have asked for.
pub fn mount_path(remote: &str) -> Option<String> {
    remote
        .strip_prefix(CATEGORY)
        .map(|rest| rest.trim_matches('/').to_string())
        .filter(|rest| !rest.is_empty())
}

/// Where a file from the mount goes in the account.
///
/// The inverse of [`mount_path`]: `bal.csv` becomes `/hledger/bal.csv`, so a file
/// hledger wrote with `-o` lands beside the journal it came from rather than in a
/// directory of its own making.
pub fn remote_path(local: &str) -> String {
    format!("{CATEGORY}{}", local.trim_start_matches('/'))
}

/// A path as the scoped client wants it.
///
/// The client is scoped at the category, so it already knows about `/hledger/` and
/// a path that repeats it lands in a folder of the same name inside itself — which
/// is exactly what happened the first time a file was written to a real server:
/// `/hledger/rt.csv` became `hledger/hledger/rt.csv` on disk.
pub fn scoped(path: &str) -> String {
    let without_category = path
        .trim_start_matches('/')
        .strip_prefix(CATEGORY.trim_matches('/'))
        .map(str::to_string)
        .unwrap_or_else(|| path.trim_start_matches('/').to_string());
    without_category
        .trim_start_matches('/')
        .to_string()
}

/// An entry path as the app knows it, with the category on the front.
///
/// A listing names its entries relative to **the folder that was listed**, not to
/// the scope root, so the folder has to be put back too. Assuming the scope root is
/// what made a file in a nested folder resolve to a path that does not exist — and
/// then be skipped as unreadable rather than loaded.
pub fn joined(directory: &str, key: &str) -> String {
    let key = key.trim_start_matches('/');
    if key.is_empty() {
        return directory.to_string();
    }
    format!(
        "{}{key}",
        directory.trim_end_matches('/').to_string() + "/"
    )
}

/// The folders directly inside `directory` that still have to be listed.
///
/// A listing gives one folder's contents, so reaching nested files means walking:
/// this is the "what next" of that walk, and it is the only part of it worth
/// testing.
pub fn subdirectories(entries: &[Entry], directory: &str) -> Vec<String> {
    let prefix = format!("{}/", directory.trim_end_matches('/'));
    let mut found: Vec<String> = entries
        .iter()
        .filter(|entry| entry.is_dir)
        .map(|entry| format!("{}/", entry.path.trim_end_matches('/')))
        .filter(|path| {
            // Directly inside, not the folder itself and not somewhere below it:
            // `getListing` is not recursive, and descending into a path that was
            // never listed would be a guess.
            path.starts_with(&prefix)
                && {
                    let rest = path[prefix.len()..].trim_end_matches('/');
                    !rest.is_empty() && !rest.contains('/')
                }
        })
        .collect();
    found.sort();
    found.dedup();
    found
}

/// The category this app claims and reads.
///
/// remoteStorage grants access per category, so the files have to live under one,
/// and this is it. Changing it is a one-line change here and nothing else.
pub const CATEGORY: &str = "/hledger/";

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn listing(paths: &[&str]) -> serde_json::Value {
        let mut object = serde_json::Map::new();
        for path in paths {
            object.insert((*path).to_string(), json!(true));
        }
        serde_json::Value::Object(object)
    }

    #[test]
    fn a_listing_is_read_from_its_keys_and_its_trailing_slashes() {
        let entries = parse_listing(&listing(&[
            "/hledger/a.journal",
            "/hledger/books/",
            "/hledger/books/2024.journal",
        ]));
        assert_eq!(
            entries,
            vec![
                Entry { path: "/hledger/a.journal".to_string(), is_dir: false },
                Entry { path: "/hledger/books/".to_string(), is_dir: true },
                Entry { path: "/hledger/books/2024.journal".to_string(), is_dir: false },
            ]
        );

        // Metadata instead of `true` is the other documented shape; only keys matter.
        let entries = parse_listing(&json!({
            "/hledger/a.journal": { "ETag": "x", "Content-Length": 12 },
        }));
        assert_eq!(entries.len(), 1);
        assert!(!entries[0].is_dir);

        // Anything that is not a listing is not an error, just nothing.
        assert!(parse_listing(&json!(null)).is_empty());
        assert!(parse_listing(&json!(["/hledger/a.journal"])).is_empty());
    }

    #[test]
    fn a_remote_path_is_rerooted_at_the_category() {
        assert_eq!(
            mount_path("/hledger/books/2024.journal").as_deref(),
            Some("books/2024.journal")
        );
        assert_eq!(mount_path("/hledger/a.journal").as_deref(), Some("a.journal"));
        // Outside the category, or the category itself, has no mount path.
        assert_eq!(mount_path("/elsewhere/a.journal"), None);
        assert_eq!(mount_path("/hledger/"), None);
        assert_eq!(mount_path("/hledger"), None);
    }

    #[test]
    fn a_directory_argument_becomes_a_path_inside_the_category() {
        assert_eq!(directory_for(""), CATEGORY);
        assert_eq!(directory_for("   "), CATEGORY);
        assert_eq!(directory_for("books"), "/hledger/books/");
        assert_eq!(directory_for("/books/"), "/hledger/books/");
        assert_eq!(directory_for("books/2024"), "/hledger/books/2024/");
    }

    #[test]
    fn the_walk_only_descends_into_direct_children() {
        let entries = parse_listing(&listing(&[
            "/hledger/a.journal",
            "/hledger/books/",
            "/hledger/books/deep/",
            "/hledger/books/deep/2024.journal",
            "/hledger/other/",
        ]));
        // From the category: the two folders directly inside it, not the one below.
        assert_eq!(
            subdirectories(&entries, CATEGORY),
            vec!["/hledger/books/", "/hledger/other/"]
        );
        // From a folder: its own children.
        assert_eq!(
            subdirectories(&entries, "/hledger/books/"),
            vec!["/hledger/books/deep/"]
        );
        // From a leaf folder: nothing to walk.
        assert!(subdirectories(&entries, "/hledger/books/deep/").is_empty());
    }

    #[test]
    fn a_path_is_scoped_without_doubling_the_category() {
        // The client already knows the category, so the category comes off.
        assert_eq!(scoped("/hledger/rt.csv"), "rt.csv");
        assert_eq!(scoped("/hledger/books/2024.journal"), "books/2024.journal");
        assert_eq!(scoped("/hledger/"), "");
        assert_eq!(scoped("/hledger"), "");
        assert_eq!(scoped(""), "");
        // A path that never mentioned the category is left alone.
        assert_eq!(scoped("rt.csv"), "rt.csv");

        // And the round trip holds, which is what keeps writes out of a folder
        // named after the category.
        for path in ["/hledger/rt.csv", "/hledger/books/deep/x.journal"] {
            let relative = scoped(path);
            let back = joined("/hledger/", &relative);
            assert_eq!(back, path, "round trip of {path}");
        }
    }

    #[test]
    fn a_listing_entry_is_joined_to_the_folder_that_was_listed() {
        // This is the bug that made a file in a nested folder disappear: entries
        // are named relative to the folder listed, not to the scope root.
        assert_eq!(joined("/hledger/", "hledger/"), "/hledger/hledger/");
        assert_eq!(joined("/hledger/", "kb.csv"), "/hledger/kb.csv");
        assert_eq!(joined("/hledger/hledger/", "rt.csv"), "/hledger/hledger/rt.csv");
        assert_eq!(
            joined("/hledger/books/", "deep/"),
            "/hledger/books/deep/"
        );
        assert_eq!(
            joined("/hledger/books/deep/", "2024.journal"),
            "/hledger/books/deep/2024.journal"
        );

        // A key with a leading slash is not a different file.
        assert_eq!(joined("/hledger/books/", "/deep/"), "/hledger/books/deep/");
        // And the folder itself is what you get for an empty key.
        assert_eq!(joined("/hledger/books/", ""), "/hledger/books/");
    }

    #[test]
    fn a_local_path_goes_back_under_the_category() {
        assert_eq!(remote_path("bal.csv"), "/hledger/bal.csv");
        assert_eq!(remote_path("books/2024.journal"), "/hledger/books/2024.journal");
        assert_eq!(remote_path("/bal.csv"), "/hledger/bal.csv");
        // Round trip: what was mounted comes back to where it came from.
        for path in ["a.journal", "books/deep/2025.journal"] {
            let remote = remote_path(path);
            assert_eq!(mount_path(&remote).as_deref(), Some(path));
        }
    }

    #[test]
    fn a_folder_is_recognised_by_its_trailing_slash_alone() {
        // "books" with no slash is a file called books. Getting this wrong would
        // either descend into files or read folders as journals.
        let entries = parse_listing(&listing(&["/hledger/books"]));
        assert!(!entries[0].is_dir);
        assert!(subdirectories(&entries, CATEGORY).is_empty());
    }
}
