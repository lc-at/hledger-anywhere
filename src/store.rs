//! The uploaded files, cached in the browser (wasm-only).
//!
//! # This is a cache, never the source of truth
//!
//! Everything here exists to save a returning visitor one upload. The journal
//! remains the user's files on disk: nothing in this module is authoritative, and
//! no caller may treat a store failure as an error state. A missing, empty, stale
//! or undecodable snapshot must degrade to exactly the experience of a first
//! visit, "type upload", while a browser with no usable IndexedDB (private
//! mode, storage disabled, quota exhausted) must behave as though persistence had
//! never been requested.
//!
//! That is why every entry point returns `Result<_, idb::Error>` rather than
//! panicking, why the loaders skip unreadable records instead of failing whole,
//! and why nothing here unwraps an IDB result.
//!
//! # Schema
//!
//! Database `hledger-anywhere`, version 1, with two object stores:
//!
//! * `files`, keyed by `path`; one record per mounted file.
//! * `meta`, keyed by `key`; one `terminal_session` record naming the journal.
//!
//! This is the same database and the same `files` shape the earlier panel-based
//! app used, deliberately and without a version bump: a visitor who already has a
//! snapshot gets it back rather than having to upload again. The old app's
//! `last_session` metadata record is simply ignored.

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

/// Object store holding small metadata records, keyed by `key`.
const META_STORE: &str = "meta";

/// The metadata record this module writes.
const SESSION_KEY: &str = "terminal_session";

/// KeyPath of the `files` store: the field used as the key.
const FILES_KEY_PATH: &str = "path";

/// KeyPath of the `meta` store.
const META_KEY_PATH: &str = "key";

/// What the last session looked like: which file hledger was reading.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct Session {
    /// Uploaded path of the journal, if one was chosen.
    pub main_journal: Option<String>,
}

/// Serialisable mirror of [`JournalFile`].
///
/// `JournalFile` is a pure model type and deliberately does not derive serde;
/// mirroring it here keeps the stored schema independent of a type other code may
/// want to change.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
struct StoredFile {
    path: String,
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
pub struct Store {
    db: idb::Database,
}

impl Store {
    /// Open (creating on first use) the snapshot database.
    ///
    /// A browser with no usable IndexedDB fails here, and the caller carries on
    /// without a cache.
    pub async fn open() -> Result<Store, idb::Error> {
        let factory = idb::Factory::new()?;
        let mut request = factory.open(DB_NAME, Some(DB_VERSION))?;

        // Runs once, inside the version-change transaction. Creating a store that
        // already exists aborts the upgrade, so the existing set is checked first.
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
        Ok(Store { db })
    }

    /// Replace the cached files with exactly `files`.
    ///
    /// One read/write transaction covers the clear and every put, so a failure
    /// part-way through leaves the previous snapshot intact rather than a
    /// half-written mixture of two uploads.
    pub async fn save_files(&self, files: &[JournalFile]) -> Result<(), idb::Error> {
        let transaction = self
            .db
            .transaction(&[FILES_STORE], idb::TransactionMode::ReadWrite)?;
        {
            let store = transaction.object_store(FILES_STORE)?;
            store.clear()?.await?;
            for file in files {
                let value = json_to_js(&to_json(&StoredFile::from(file))?)?;
                let _ = store.put(&value, None)?.await?;
            }
        }
        transaction.await?;
        Ok(())
    }

    /// Load the cached files, or an empty vector when there are none.
    ///
    /// Records that cannot be decoded are skipped: a cache that has drifted from
    /// the current schema should cost one upload, not a failed start.
    pub async fn load_files(&self) -> Result<Vec<JournalFile>, idb::Error> {
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
        // Object-store order is by key; sorting keeps the result deterministic.
        files.sort_by(|left, right| left.path.cmp(&right.path));
        Ok(files)
    }

    /// Record which journal is being read.
    pub async fn save_session(&self, session: &Session) -> Result<(), idb::Error> {
        // The `meta` store's keyPath is `key`, so the record carries that
        // property; the rest is the serialised `Session`, which ignores the extra
        // field on the way back in.
        let value = json_to_js(&to_json(session)?)?;
        js_sys::Reflect::set(
            &value,
            &JsValue::from_str(META_KEY_PATH),
            &JsValue::from_str(SESSION_KEY),
        )
        .map_err(|error| idb::Error::UnexpectedJsType("a metadata record", error))?;

        let transaction = self
            .db
            .transaction(&[META_STORE], idb::TransactionMode::ReadWrite)?;
        {
            let store = transaction.object_store(META_STORE)?;
            let _ = store.put(&value, None)?.await?;
        }
        transaction.await?;
        Ok(())
    }

    /// Read the last session, or a default one.
    pub async fn load_session(&self) -> Result<Session, idb::Error> {
        let transaction = self
            .db
            .transaction(&[META_STORE], idb::TransactionMode::ReadOnly)?;
        let record = {
            let store = transaction.object_store(META_STORE)?;
            store.get(JsValue::from_str(SESSION_KEY))?.await?
        };
        transaction.await?;
        Ok(record.as_ref().and_then(decode_json::<Session>).unwrap_or_default())
    }
}

/// Serialise a value to JSON, reporting failure through the IDB error type so the
/// public signatures stay free of `serde_json`.
fn to_json<T: Serialize>(value: &T) -> Result<String, idb::Error> {
    serde_json::to_string(value).map_err(|error| {
        idb::Error::UnexpectedJsType("a JSON string", JsValue::from_str(&error.to_string()))
    })
}

/// Parse a JSON string into the JS value IndexedDB stores.
fn json_to_js(json: &str) -> Result<JsValue, idb::Error> {
    js_sys::JSON::parse(json).map_err(|error| idb::Error::UnexpectedJsType("a JSON string", error))
}

/// Decode a stored JS record into `T`, or `None` if it is not the shape this
/// version expects.
fn decode_json<T: for<'de> Deserialize<'de>>(value: &JsValue) -> Option<T> {
    let json = js_sys::JSON::stringify(value).ok()?;
    let json = JsValue::from(json).as_string()?;
    serde_json::from_str(&json).ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    // These run under a wasm test target only: the module is wasm-gated in
    // `main.rs`, so native `cargo test` never compiles them. They are still
    // type-checked by `cargo clippy --target wasm32-unknown-unknown --all-targets`.

    #[test]
    fn a_session_round_trips_and_tolerates_the_stores_key_field() {
        let session = Session {
            main_journal: Some("books/hledger.journal".to_string()),
        };
        let json = to_json(&session).expect("must serialise");
        assert_eq!(
            serde_json::from_str::<Session>(&json).expect("must decode"),
            session
        );

        // That is what `save_session` writes: the session plus the keyPath field.
        let stored = format!(
            "{{\"main_journal\":\"a.journal\",\"key\":\"{SESSION_KEY}\"}}"
        );
        let decoded: Session = serde_json::from_str(&stored).expect("must ignore the key");
        assert_eq!(decoded.main_journal.as_deref(), Some("a.journal"));
    }

    #[test]
    fn a_session_missing_fields_decodes_to_nothing_remembered() {
        // An older or truncated record must not fail the load: "nothing
        // remembered" is exactly the first-visit experience.
        let decoded: Session = serde_json::from_str("{}").expect("must decode");
        assert_eq!(decoded, Session::default());
        assert!(serde_json::from_str::<Session>("not json").is_err());
    }

    #[test]
    fn a_stored_file_maps_back_to_a_journal_file() {
        let file = JournalFile::new("hledger.journal", "2024-01-01 * payee\n");
        let stored = StoredFile::from(&file);
        let json = to_json(&stored).expect("must serialise");
        // The store's keyPath needs a top-level `path` property.
        assert!(json.contains("\"path\""));
        let decoded: StoredFile = serde_json::from_str(&json).expect("must decode");
        assert_eq!(JournalFile::from(decoded), file);
    }

    #[test]
    fn the_json_helpers_round_trip_through_a_js_value() {
        let source = StoredFile::from(&JournalFile::new("a.journal", "include b.journal\n"));
        let value = json_to_js(&to_json(&source).expect("must serialise")).expect("must parse");
        assert_eq!(decode_json::<StoredFile>(&value), Some(source));
    }

    #[test]
    fn decode_json_rejects_values_that_are_not_records() {
        assert!(decode_json::<StoredFile>(&JsValue::from_f64(3.0)).is_none());
        assert!(decode_json::<StoredFile>(&JsValue::NULL).is_none());
    }

    #[test]
    fn the_schema_names_are_the_documented_ones() {
        assert_eq!(FILES_KEY_PATH, "path");
        assert_eq!(META_KEY_PATH, "key");
        assert_eq!(SESSION_KEY, "terminal_session");
        assert_eq!(DB_NAME, "hledger-anywhere");
        assert_eq!(DB_VERSION, 1);
    }
}
