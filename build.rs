//! Bakes `wasm.lock` into the build as compile-time environment variables.
//!
//! `wasm.lock` is the single source of truth for which hledger WASM artifact the
//! app runs against. Reading it here (rather than duplicating the values in Rust
//! or probing at runtime) means:
//!
//!   * the argv flavor is always consistent with the artifact that was fetched;
//!   * the UI can report the exact expected hledger version and checksum, so a
//!     mismatch between the fetched binary and the lock file is visible;
//!   * changing the lock file alone is enough to retarget the build.
//!
//! The parser is intentionally tiny and mirrors the awk parser in
//! scripts/fetch-hledger-wasm.sh: flat `key = "value"` pairs.

use std::path::Path;

/// Keys we lift out of `wasm.lock`, in the `[hledger-wasm]` table.
const KEYS: [&str; 5] = ["flavor", "hledger_version", "ghc_version", "size", "sha256"];

fn main() {
    println!("cargo:rerun-if-changed=wasm.lock");

    let lock_path = Path::new("wasm.lock");
    let contents = std::fs::read_to_string(lock_path).unwrap_or_default();

    for key in KEYS {
        let value = read_key(&contents, key).unwrap_or_default();
        println!(
            "cargo:rustc-env=HLEDGER_WASM_{}={}",
            key.to_ascii_uppercase(),
            value
        );
    }
}

/// Extract `key = "value"` from a flat lock file, ignoring comments.
///
/// Later occurrences win, matching the "last assignment" intuition of a config
/// file; in practice each key appears once.
fn read_key(contents: &str, want: &str) -> Option<String> {
    let mut found = None;
    for raw in contents.lines() {
        // Strip comments, then split on the first '='.
        let line = raw.split('#').next().unwrap_or("");
        let Some((key, value)) = line.split_once('=') else {
            continue;
        };
        if key.trim() != want {
            continue;
        }
        let value = value.trim().trim_matches('"').trim();
        found = Some(value.to_string());
    }
    found
}

#[cfg(test)]
mod tests {
    use super::read_key;

    const SAMPLE: &str = r#"
# a comment with = signs and "quotes"
[hledger-wasm]
flavor = "hledger-cli"
hledger_version = "1.52.4"   # trailing comment
size = 17653240
url = ""
"#;

    #[test]
    fn reads_quoted_and_unquoted_values() {
        assert_eq!(read_key(SAMPLE, "flavor").as_deref(), Some("hledger-cli"));
        assert_eq!(read_key(SAMPLE, "hledger_version").as_deref(), Some("1.52.4"));
        assert_eq!(read_key(SAMPLE, "size").as_deref(), Some("17653240"));
    }

    #[test]
    fn empty_value_is_not_none() {
        // An explicitly empty key must stay distinguishable from a missing key,
        // otherwise the UI cannot tell "no url configured" from "unset".
        assert_eq!(read_key(SAMPLE, "url").as_deref(), Some(""));
        assert_eq!(read_key(SAMPLE, "nope"), None);
    }

    #[test]
    fn comment_equals_signs_do_not_confuse_parsing() {
        // The comment line contains '=' and quotes; it must be ignored.
        assert_eq!(read_key("x = 1\n# a = \"b\"\n", "a"), None);
        assert_eq!(read_key("x = 1\n# a = \"b\"\n", "x").as_deref(), Some("1"));
    }
}
