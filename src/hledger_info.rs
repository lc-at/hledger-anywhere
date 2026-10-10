//! What the pinned engine is, baked in at build time by `build.rs`.
//!
//! `wasm.lock` is the single source of truth for which hledger artifact the app
//! runs against. Reading it into the binary means the terminal can say which
//! engine it is running, and a mismatch between the fetched binary and the lock
//! file is visible to the user rather than mysterious.

// Natively this module exists for its tests: the only code that uses it is
// wasm-gated, so its items look unused to `cargo test`'s build.
#![cfg_attr(not(target_arch = "wasm32"), allow(dead_code))]

/// The hledger version the pinned wasm build was made from.
pub const HLEDGER_VERSION: &str = env!("HLEDGER_WASM_HLEDGER_VERSION");

/// SHA-256 of the pinned artifact, as recorded in `wasm.lock`.
pub const SHA256: &str = env!("HLEDGER_WASM_SHA256");

/// The engine version as the user should see it in the banner.
pub fn version() -> &'static str {
    if HLEDGER_VERSION.is_empty() {
        "unknown version"
    } else {
        HLEDGER_VERSION
    }
}

/// A one-line description of the engine, for the app's own help.
///
/// The checksum is included because "which build are you running?" is the first
/// question worth answering about a pinned binary, and the answer has to come
/// from the binary rather than from a document that may have moved on.
pub fn describe() -> String {
    if SHA256.is_empty() {
        return format!("hledger {}", version());
    }
    let short = SHA256.get(..12).unwrap_or(SHA256);
    format!("hledger {} · wasm sha256 {short}…", version())
}

/// The engine's URL, with its checksum as a version.
///
/// A URL that changes when the bytes change is what lets the service worker serve
/// 13 MB from the cache without ever asking the network: for an immutable URL
/// there is no such thing as a stale answer. Without it, either every visit
/// revalidates the whole engine or a new one can be missed.
pub fn engine_url() -> String {
    if SHA256.is_empty() {
        "/wasm/hledger.wasm".to_string()
    } else {
        format!("/wasm/hledger.wasm?v={SHA256}")
    }
}

/// The service worker's URL, carrying the same version, so its cache is named
/// after the engine it is caching and old caches are dropped.
pub fn service_worker_url() -> String {
    format!(
        "/sw.js?v={}",
        if SHA256.is_empty() { "dev" } else { SHA256 }
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_lock_file_reached_the_binary() {
        // `build.rs` always sets these, possibly empty. A version that is present
        // must look like one, so a broken lock parse is caught here rather than
        // appearing in the banner.
        if !HLEDGER_VERSION.is_empty() {
            assert!(
                HLEDGER_VERSION.starts_with(char::is_numeric),
                "unexpected version: {HLEDGER_VERSION}"
            );
        }
        if !SHA256.is_empty() {
            assert_eq!(SHA256.len(), 64, "unexpected sha256: {SHA256}");
        }
    }

    #[test]
    fn a_missing_version_says_so_rather_than_being_blank() {
        assert!(!version().is_empty());
    }

    #[test]
    fn the_engine_and_the_worker_are_both_versioned_by_the_checksum() {
        let engine = engine_url();
        assert!(engine.starts_with("/wasm/hledger.wasm"), "{engine}");
        let worker = service_worker_url();
        assert!(worker.starts_with("/sw.js?v="), "{worker}");
        if !SHA256.is_empty() {
            assert!(engine.ends_with(SHA256), "the engine URL must carry the checksum");
            assert!(worker.ends_with(SHA256), "the worker URL must carry it too");
        }
    }

    #[test]
    fn the_engine_description_names_the_build() {
        let text = describe();
        assert!(text.starts_with("hledger "), "{text}");
        if !SHA256.is_empty() {
            assert!(text.contains(&SHA256[..12]), "{text}");
        }
    }
}
