//! A browser-side cache of the loaded journal snapshot (wasm-only).
//!
//! # This is a cache, never the source of truth
//!
//! Everything here exists to save a returning visitor one directory pick. The
//! journal itself remains the user's files on disk: nothing in this module is
//! ever authoritative, and no caller may treat a store failure as an error
//! state. A missing, empty, stale or undecodable snapshot must degrade to
//! exactly the same experience as a first visit — "pick a directory again" —
//! while a browser that simply has no usable IndexedDB (private mode, storage
//! disabled, quota exhausted) must behave as though persistence were never
//! requested.
//!
//! That is why every entry point returns `Result<_, idb::Error>` instead of
//! panicking, why the `load_*` decoders skip unreadable records rather than
//! failing the whole load, and why nothing here uses `unwrap`/`expect` on an
//! IDB result. The recommended caller shape is:
//!
//! ```ignore
//! match JournalStore::open().await {
//!     Ok(store) => match store.load_snapshot().await {
//!         Ok(files) if !files.is_empty() => state.publish_files(files, 0),
//!         _ => { /* pick a directory, as on a first visit */ }
//!     },
//!     Err(_) => { /* caching unavailable; pick a directory */ }
//! }
//! ```
//!
//! # Schema
//!
//! Database `hledger-anywhere`, version 1, with two object stores:
//!
//! * `files` — keyed by `path`; one record per mounted [`JournalFile`], so the
//!   snapshot is a faithful copy of the picked directory.
//! * `meta` — keyed by `key`; a single `last_session` record describing the
//!   snapshot ([`SessionMeta`]).
//!
//! Records are round-tripped as JSON strings through `serde_json`:
//! [`StoredFile`] mirrors the fields of [`JournalFile`] (which is a pure model
//! type and deliberately does not derive `Serialize`), and the metadata record
//! is the serialised [`SessionMeta`] with the store's keyPath field added.

use idb::DatabaseEvent;
use serde::{Deserialize, Serialize};
use wasm_bindgen::JsValue;

use crate::hledger::JournalFile;

/// Name of the IndexedDB database.
const DB_NAME: &str = "hledger-anywhere";

/// Schema version. Bump only alongside a migration in `open`.
const DB_VERSION: u32 = 1;

/// Object store holding one record per mounted file, keyed by `path`.
const FILES_STORE: &str = "files";

/// Object store holding small session metadata records, keyed by `key`.
const META_STORE: &str = "meta";

/// The single metadata record this module writes.
const META_KEY: &str = "last_session";

/// KeyPath of the `files` store: the [`StoredFile`] field used as the key.
const FILES_KEY_PATH: &str = "path";

/// KeyPath of the `meta` store.
const META_KEY_PATH: &str = "key";

/// What the last successful snapshot looked like.
///
/// Deliberately small: it is a hint for the UI ("last opened 2 minutes ago, 4
/// files, main journal `hledger.journal`"), never data the app depends on.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct SessionMeta {
    /// Wall-clock time of the save, in milliseconds since the Unix epoch.
    ///
    /// `f64` because that is what `Date.now()` yields; serialising it as an
    /// integer would lose nothing today but would also be a pointless
    /// conversion on every save.
    pub saved_at_ms: f64,
    /// How many files the snapshot holds.
    pub file_count: usize,
    /// Path of the main journal within the snapshot.
    pub main_journal: String,
}

/// Serialisable mirror of [`JournalFile`].
///
/// `JournalFile` lives in the pure hledger module and does not derive serde;
/// keeping the mirror here means this workstream touches no file outside
/// `src/storage/`, and it decouples the on-disk schema from a type other code
/// may want to change.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
struct StoredFile {
    /// Relative path within the mounted directory; also the store's key.
    path: String,
    /// The file's text.
    contents: String,
}

impl From<&JournalFile> for StoredFile {
    fn from(file: &JournalFile) -> Self {
        StoredFile {
            path: file.path.clone(),
            contents: file.contents.clone(),
        }
    }
}

impl From<StoredFile> for JournalFile {
    fn from(file: StoredFile) -> Self {
        JournalFile::new(file.path, file.contents)
    }
}

/// A connection to the snapshot cache.
pub struct JournalStore {
    db: idb::Database,
}

impl JournalStore {
    /// Open (creating on first use) the snapshot database.
    ///
    /// A browser with no usable IndexedDB — private mode, storage disabled —
    /// fails here, and the caller is expected to carry on without a cache.
    pub async fn open() -> Result<JournalStore, idb::Error> {
        let factory = idb::Factory::new()?;
        let mut request = factory.open(DB_NAME, Some(DB_VERSION))?;

        // Runs once, inside the version-change transaction. Creating a store
        // that already exists aborts the upgrade, so the existing set is
        // checked first; and a failure to read the database handle is not
        // propagated (the closure cannot return a `Result`), which simply lets
        // the open request fail — the caller treats that as "no cache".
        request.on_upgrade_needed(|event| {
            let Ok(db) = event.database() else {
                return;
            };
            let existing = db.store_names();
            for (name, key_path) in [(FILES_STORE, FILES_KEY_PATH), (META_STORE, META_KEY_PATH)] {
                if existing.iter().any(|store| store == name) {
                    continue;
                }
                let mut params = idb::ObjectStoreParams::new();
                params.key_path(Some(idb::KeyPath::new_single(key_path)));
                let _ = db.create_object_store(name, params);
            }
        });

        let db = request.await?;
        Ok(JournalStore { db })
    }

    /// Replace the cached snapshot with exactly `files`.
    ///
    /// One read/write transaction covers the clear and every put, so a failure
    /// part-way through leaves the previous snapshot intact rather than a
    /// half-written mixture of two journals.
    pub async fn save_snapshot(&self, files: &[JournalFile]) -> Result<(), idb::Error> {
        let transaction = self
            .db
            .transaction(&[FILES_STORE], idb::TransactionMode::ReadWrite)?;

        {
            let store = transaction.object_store(FILES_STORE)?;
            store.clear()?.await?;
            for file in files {
                let value = json_to_js(&to_json(&StoredFile::from(file))?)?;
                store.put(&value, None)?.await?;
            }
        }

        // Resolves once the transaction has committed (or with the reason it
        // aborted), which is the only signal that the snapshot is durable.
        transaction.await?;
        Ok(())
    }

    /// Load the cached snapshot, or an empty vector when there is none.
    ///
    /// Individual records that cannot be decoded are skipped: a cache that has
    /// drifted from the current schema should cost one directory pick, not a
    /// failed load.
    pub async fn load_snapshot(&self) -> Result<Vec<JournalFile>, idb::Error> {
        let transaction = self
            .db
            .transaction(&[FILES_STORE], idb::TransactionMode::ReadOnly)?;

        let records = {
            let store = transaction.object_store(FILES_STORE)?;
            store.get_all(None, None)?.await?
        };
        transaction.await?;

        let mut files: Vec<JournalFile> = records
            .iter()
            .filter_map(decode_json::<StoredFile>)
            .map(JournalFile::from)
            .collect();
        // Object-store order is by key; sorting explicitly keeps the result
        // deterministic even if the schema ever stops keying on `path`.
        files.sort_by(|left, right| left.path.cmp(&right.path));
        Ok(files)
    }

    /// Record what the current snapshot is.
    pub async fn save_meta(&self, meta: &SessionMeta) -> Result<(), idb::Error> {
        // The `meta` store's keyPath is `key`, so the record has to carry that
        // property; everything beside it is the serialised `SessionMeta`, which
        // ignores the extra field on the way back in.
        let value = json_to_js(&to_json(meta)?)?;
        js_sys::Reflect::set(
            &value,
            &JsValue::from_str(META_KEY_PATH),
            &JsValue::from_str(META_KEY),
        )
        .map_err(|error| idb::Error::UnexpectedJsType("a metadata record", error))?;

        let transaction = self
            .db
            .transaction(&[META_STORE], idb::TransactionMode::ReadWrite)?;
        {
            let store = transaction.object_store(META_STORE)?;
            store.put(&value, None)?.await?;
        }
        transaction.await?;
        Ok(())
    }

    /// Read the last snapshot's metadata.
    ///
    /// `Ok(None)` means "no snapshot has been recorded", whether because none
    /// was ever saved or because the record could not be decoded. Both callers
    /// treat it identically.
    pub async fn load_meta(&self) -> Result<Option<SessionMeta>, idb::Error> {
        let transaction = self
            .db
            .transaction(&[META_STORE], idb::TransactionMode::ReadOnly)?;
        let record = {
            let store = transaction.object_store(META_STORE)?;
            store.get(JsValue::from_str(META_KEY))?.await?
        };
        transaction.await?;

        Ok(record.as_ref().and_then(decode_json::<SessionMeta>))
    }
}

/// Serialise a value to JSON, reporting a serde failure through the crate's
/// error type so the public signatures stay free of `serde_json`.
fn to_json<T: Serialize>(value: &T) -> Result<String, idb::Error> {
    serde_json::to_string(value).map_err(|error| {
        idb::Error::UnexpectedJsType("a JSON string", JsValue::from_str(&error.to_string()))
    })
}

/// Parse a JSON string into the JS value IndexedDB stores.
fn json_to_js(json: &str) -> Result<JsValue, idb::Error> {
    js_sys::JSON::parse(json).map_err(|error| idb::Error::UnexpectedJsType("a JSON string", error))
}

/// Decode a stored JS record back into `T`, or `None` if it is not the shape
/// this version of the app expects.
fn decode_json<T: for<'de> Deserialize<'de>>(value: &JsValue) -> Option<T> {
    let json = js_sys::JSON::stringify(value).ok()?;
    let json = JsValue::from(json).as_string()?;
    serde_json::from_str(&json).ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    // These run under a wasm test target only: the whole module is wasm-gated
    // in `main.rs`, so native `cargo test` never compiles them. They are still
    // type-checked by `cargo clippy --target wasm32-unknown-unknown
    // --all-targets`.

    fn meta() -> SessionMeta {
        SessionMeta {
            saved_at_ms: 1_700_000_000_000.0,
            file_count: 4,
            main_journal: "hledger.journal".to_string(),
        }
    }

    #[test]
    fn session_meta_round_trips_through_json() {
        let json = to_json(&meta()).expect("serialising meta must succeed");
        let decoded: SessionMeta = serde_json::from_str(&json).expect("must decode");
        assert_eq!(decoded, meta());
    }

    #[test]
    fn session_meta_tolerates_the_stores_extra_key_field() {
        // That is exactly what `save_meta` writes: the serialised meta plus the
        // keyPath field. Decoding must ignore it.
        let json = r#"{"saved_at_ms":1.0,"file_count":1,"main_journal":"a.journal","key":"last_session"}"#;
        let decoded: SessionMeta = serde_json::from_str(json).expect("must decode");
        assert_eq!(decoded.main_journal, "a.journal");
        assert_eq!(decoded.file_count, 1);
    }

    #[test]
    fn session_meta_tolerates_missing_and_unknown_fields() {
        // Unknown fields are ignored; a missing field is a decode failure the
        // caller turns into "no snapshot", never a panic.
        let json = r#"{"saved_at_ms":2.0,"file_count":0,"main_journal":"x","future":true}"#;
        assert!(serde_json::from_str::<SessionMeta>(json).is_ok());
        assert!(serde_json::from_str::<SessionMeta>(r#"{"file_count":0}"#).is_err());
        assert!(serde_json::from_str::<SessionMeta>("not json").is_err());
    }

    #[test]
    fn a_stored_file_maps_back_to_a_journal_file() {
        let file = JournalFile::new("books/2024.journal", "2024-01-01 * payee\n");
        let stored = StoredFile::from(&file);
        assert_eq!(stored.path, "books/2024.journal");

        let json = to_json(&stored).expect("serialising a file must succeed");
        // The store's keyPath needs a top-level `path` property.
        assert!(json.contains("\"path\""));
        let decoded: StoredFile = serde_json::from_str(&json).expect("must decode");
        assert_eq!(JournalFile::from(decoded), file);
    }

    #[test]
    fn json_helper_round_trips_through_a_js_value() {
        // Exercises the exact path the IDB calls use, including stringify.
        let source = StoredFile::from(&JournalFile::new("a.journal", "include b.journal\n"));
        let value = json_to_js(&to_json(&source).expect("must serialise")).expect("must parse");
        let decoded: StoredFile = decode_json(&value).expect("must decode");
        assert_eq!(decoded, source);
    }

    #[test]
    fn decode_json_rejects_values_that_are_not_json_records() {
        assert!(decode_json::<StoredFile>(&JsValue::from_f64(3.0)).is_none());
        assert!(decode_json::<StoredFile>(&JsValue::NULL).is_none());
    }

    #[test]
    fn meta_key_is_the_documented_one() {
        assert_eq!(META_KEY, "last_session");
        assert_eq!(FILES_KEY_PATH, "path");
    }
}
