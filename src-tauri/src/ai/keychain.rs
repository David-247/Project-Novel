//! Secrets in the OS keychain (Windows Credential Manager, macOS Keychain). Service `"Novel AI
//! Tutor"`, account = the connection id. Nothing here (or anywhere) reads a secret back to the
//! webview: the only reader is the connection resolver, in Rust.
//!
//! Errors never carry the secret: a keychain failure is mapped to a fixed message by its kind and
//! the platform error text is dropped.

use super::{AiError, Secret};

/// The keychain service name.
pub const SERVICE: &str = "Novel AI Tutor";

/// Longest secret accepted (sanity bound; the platform has its own, smaller one).
pub const MAX_SECRET_BYTES: usize = 16 * 1024;
/// Longest connection id accepted.
pub const MAX_ID_BYTES: usize = 128;

/// Where secrets live. The app uses [`KeyringStore`]; tests use the keyring crate's mock or an
/// in-memory store.
pub trait SecretStore: Send + Sync + 'static {
    fn set(&self, connection_id: &str, secret: &str) -> Result<(), AiError>;
    /// `Ok(None)` when there is no secret for the connection.
    fn get(&self, connection_id: &str) -> Result<Option<Secret>, AiError>;
    /// Deleting a missing secret is not an error.
    fn delete(&self, connection_id: &str) -> Result<(), AiError>;
}

/// The OS keychain through the `keyring` crate. A secret longer than one keychain entry holds (Windows
/// Credential Manager: 2,560 bytes, stored as UTF-16, so 1,280 characters) is split over several
/// entries (see [`chunked_set`]); a ChatGPT sign-in's token record is that long.
pub struct KeyringStore;

/// One OS keychain entry per account, no splitting.
struct RawKeyring;

fn entry(account: &str) -> Result<keyring::Entry, AiError> {
    keyring::Entry::new(SERVICE, account).map_err(|e| keychain_error(&e))
}

/// A fixed message per failure kind. The keyring error's own text is never used.
fn keychain_error(e: &keyring::Error) -> AiError {
    let message = match e {
        keyring::Error::NoStorageAccess(_) => "The system keychain is locked or not available.",
        keyring::Error::TooLong(..) => "The credential is too long for the system keychain.",
        keyring::Error::Invalid(..) => "The credential cannot be stored in the system keychain.",
        keyring::Error::BadEncoding(_) => "The stored credential could not be read.",
        _ => "The system keychain could not be used.",
    };
    AiError::new("auth", message)
}

impl SecretStore for RawKeyring {
    fn set(&self, account: &str, secret: &str) -> Result<(), AiError> {
        entry(account)?.set_password(secret).map_err(|e| keychain_error(&e))
    }

    fn get(&self, account: &str) -> Result<Option<Secret>, AiError> {
        match entry(account)?.get_password() {
            Ok(s) => Ok(Some(Secret::new(s))),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(e) => Err(keychain_error(&e)),
        }
    }

    fn delete(&self, account: &str) -> Result<(), AiError> {
        match entry(account)?.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(e) => Err(keychain_error(&e)),
        }
    }
}

impl SecretStore for KeyringStore {
    fn set(&self, connection_id: &str, secret: &str) -> Result<(), AiError> {
        chunked_set(&RawKeyring, connection_id, secret)
    }

    fn get(&self, connection_id: &str) -> Result<Option<Secret>, AiError> {
        chunked_get(&RawKeyring, connection_id)
    }

    fn delete(&self, connection_id: &str) -> Result<(), AiError> {
        chunked_delete(&RawKeyring, connection_id)
    }
}

// ---- Splitting a long secret over several entries --------------------------------------------------

/// UTF-16 units per entry: under Windows' 1,280, with room for the head's prefix.
pub const CHUNK_UNITS: usize = 1000;
/// Most entries one secret may use (`MAX_SECRET_BYTES` fits).
const MAX_CHUNKS: usize = 40;
/// The first entry of a split secret starts with this, then the part count and `:`. No stored value
/// starts so otherwise: every value is a binding wrapper, JSON starting with `{` (connections.rs).
const CHUNK_HEAD: &str = "novel-chunked:1:";

fn part_account(connection_id: &str, k: usize) -> String {
    format!("{connection_id}#{k}")
}

/// The part count and first piece of a split secret's head entry (None: not split).
fn parts_of(head: &str) -> Option<(usize, &str)> {
    let rest = head.strip_prefix(CHUNK_HEAD)?;
    let (n, first) = rest.split_once(':')?;
    let n: usize = n.parse().ok()?;
    (2..=MAX_CHUNKS).contains(&n).then_some((n, first))
}

/// Pieces of at most `CHUNK_UNITS` UTF-16 units, never cut inside a character.
fn split(secret: &str) -> Vec<&str> {
    let mut parts = Vec::new();
    let (mut start, mut units) = (0, 0);
    for (i, c) in secret.char_indices() {
        if units + c.len_utf16() > CHUNK_UNITS {
            parts.push(&secret[start..i]);
            start = i;
            units = 0;
        }
        units += c.len_utf16();
    }
    parts.push(&secret[start..]);
    parts
}

/// Store `secret` under `connection_id`, split over `connection_id#1`, `#2`, ... when it is long. Parts
/// of an earlier, longer value that are no longer needed are deleted.
pub fn chunked_set(raw: &dyn SecretStore, connection_id: &str, secret: &str) -> Result<(), AiError> {
    let old_parts = match raw.get(connection_id).ok().flatten() {
        Some(old) => parts_of(old.expose()).map_or(1, |(n, _)| n),
        None => 1,
    };
    let parts = split(secret);
    if parts.len() > MAX_CHUNKS {
        return Err(AiError::bad_request("The credential is empty or too long."));
    }
    if parts.len() == 1 {
        raw.set(connection_id, secret)?;
    } else {
        // The parts first, the head last: a reader never finds a new head whose parts are missing.
        for (k, part) in parts.iter().enumerate().skip(1) {
            raw.set(&part_account(connection_id, k), part)?;
        }
        raw.set(connection_id, &format!("{CHUNK_HEAD}{}:{}", parts.len(), parts[0]))?;
    }
    for k in parts.len()..old_parts {
        let _ = raw.delete(&part_account(connection_id, k));
    }
    Ok(())
}

/// The secret under `connection_id`, put back together. A split secret with a missing part reads as
/// an unreadable credential.
pub fn chunked_get(raw: &dyn SecretStore, connection_id: &str) -> Result<Option<Secret>, AiError> {
    let Some(head) = raw.get(connection_id)? else { return Ok(None) };
    let Some((n, first)) = parts_of(head.expose()) else { return Ok(Some(head)) };
    let mut whole = String::from(first);
    for k in 1..n {
        match raw.get(&part_account(connection_id, k))? {
            Some(part) => whole.push_str(part.expose()),
            None => return Err(AiError::new("auth", "The stored credential could not be read.")),
        }
    }
    Ok(Some(Secret::new(whole)))
}

/// Delete the secret and every part of it. Deleting a missing secret is not an error.
pub fn chunked_delete(raw: &dyn SecretStore, connection_id: &str) -> Result<(), AiError> {
    if let Some(head) = raw.get(connection_id).ok().flatten() {
        if let Some((n, _)) = parts_of(head.expose()) {
            for k in 1..n {
                let _ = raw.delete(&part_account(connection_id, k));
            }
        }
    }
    raw.delete(connection_id)
}

fn check_id(connection_id: &str) -> Result<(), AiError> {
    if connection_id.is_empty() || connection_id.len() > MAX_ID_BYTES || connection_id.chars().any(char::is_control) {
        return Err(AiError::bad_request("The connection id is not valid."));
    }
    Ok(())
}

/// A secret must not be empty or oversized.
pub fn check_secret(secret: &str) -> Result<(), AiError> {
    if secret.is_empty() || secret.len() > MAX_SECRET_BYTES {
        return Err(AiError::bad_request("The credential is empty or too long."));
    }
    Ok(())
}

/// Store a secret for a connection (replacing any earlier one).
pub fn set_secret(store: &dyn SecretStore, connection_id: &str, secret: &str) -> Result<(), AiError> {
    check_id(connection_id)?;
    check_secret(secret)?;
    store.set(connection_id, secret)
}

pub fn delete_secret(store: &dyn SecretStore, connection_id: &str) -> Result<(), AiError> {
    check_id(connection_id)?;
    store.delete(connection_id)
}

#[cfg(test)]
pub fn has_secret(store: &dyn SecretStore, connection_id: &str) -> Result<bool, AiError> {
    check_id(connection_id)?;
    Ok(store.get(connection_id)?.is_some())
}

#[cfg(test)]
pub mod testing {
    use std::collections::HashMap;
    use std::sync::Mutex;

    use super::*;

    /// An in-memory store (the keyring mock keeps no state between `Entry` values).
    #[derive(Default)]
    pub struct MemoryStore(pub Mutex<HashMap<String, String>>);

    impl SecretStore for MemoryStore {
        fn set(&self, id: &str, secret: &str) -> Result<(), AiError> {
            self.0.lock().unwrap().insert(id.to_owned(), secret.to_owned());
            Ok(())
        }
        fn get(&self, id: &str) -> Result<Option<Secret>, AiError> {
            Ok(self.0.lock().unwrap().get(id).cloned().map(Secret::new))
        }
        fn delete(&self, id: &str) -> Result<(), AiError> {
            self.0.lock().unwrap().remove(id);
            Ok(())
        }
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use super::testing::MemoryStore;
    use super::*;

    #[test]
    fn secret_round_trip_has_delete() {
        let store = MemoryStore::default();
        assert!(!has_secret(&store, "c1").unwrap());
        set_secret(&store, "c1", "sk-abc").unwrap();
        assert!(has_secret(&store, "c1").unwrap());
        assert_eq!(store.get("c1").unwrap().unwrap().expose(), "sk-abc");
        set_secret(&store, "c1", "sk-def").unwrap();
        assert_eq!(store.get("c1").unwrap().unwrap().expose(), "sk-def");
        delete_secret(&store, "c1").unwrap();
        assert!(!has_secret(&store, "c1").unwrap());
        delete_secret(&store, "c1").unwrap(); // deleting a missing secret is fine
    }

    #[test]
    fn rejects_bad_ids_and_empty_secrets() {
        let store = MemoryStore::default();
        for id in ["", "a\nb", &"x".repeat(MAX_ID_BYTES + 1)] {
            assert_eq!(set_secret(&store, id, "k").unwrap_err().kind, "bad_request");
            assert!(has_secret(&store, id).is_err());
            assert!(delete_secret(&store, id).is_err());
        }
        assert_eq!(set_secret(&store, "c1", "").unwrap_err().kind, "bad_request");
    }

    #[test]
    fn a_long_secret_is_split_and_put_back_together() {
        let raw = MemoryStore::default();
        // Over four entries, with a two-unit character straddling the first boundary.
        let long = format!("{{{}\u{1F600}{}}}", "a".repeat(CHUNK_UNITS - 2), "b".repeat(CHUNK_UNITS * 2));
        chunked_set(&raw, "c1", &long).unwrap();
        {
            let map = raw.0.lock().unwrap();
            assert_eq!(map.len(), 4, "{:?}", map.keys().collect::<Vec<_>>());
            // Every entry fits Windows' 1,280 UTF-16 units.
            assert!(map.values().all(|v| v.encode_utf16().count() < 1280));
            assert!(map["c1"].starts_with("novel-chunked:1:4:"));
        }
        assert_eq!(chunked_get(&raw, "c1").unwrap().unwrap().expose(), long);
        // A short value replaces it, and the spare parts go.
        chunked_set(&raw, "c1", "{short}").unwrap();
        assert_eq!(raw.0.lock().unwrap().len(), 1);
        assert_eq!(chunked_get(&raw, "c1").unwrap().unwrap().expose(), "{short}");
        // Delete removes every part.
        chunked_set(&raw, "c1", &long).unwrap();
        chunked_delete(&raw, "c1").unwrap();
        assert!(raw.0.lock().unwrap().is_empty());
        assert!(chunked_get(&raw, "c1").unwrap().is_none());
        chunked_delete(&raw, "c1").unwrap();
        // A short secret is one plain entry, as before.
        chunked_set(&raw, "c2", "{\"v\":1}").unwrap();
        assert_eq!(raw.0.lock().unwrap()["c2"], "{\"v\":1}");
    }

    #[test]
    fn a_split_secret_with_a_missing_part_is_unreadable() {
        let raw = MemoryStore::default();
        chunked_set(&raw, "c1", &"x".repeat(CHUNK_UNITS * 2 + 1)).unwrap();
        raw.0.lock().unwrap().remove("c1#2");
        let e = chunked_get(&raw, "c1").unwrap_err();
        assert_eq!(e.kind, "auth");
        assert!(!e.message.contains("xxxx"));
        assert!(chunked_set(&raw, "c2", &"y".repeat(CHUNK_UNITS * (MAX_CHUNKS + 1))).is_err());
    }

    /// Through the real `KeyringStore` on the keyring crate's mock credential builder (never the OS
    /// keychain). The mock keeps no state between `Entry` values, so a stored secret cannot be read
    /// back here (that is what `MemoryStore` covers); this checks the wiring and that errors say
    /// nothing about the secret.
    #[test]
    fn keyring_store_on_the_mock_builder() {
        keyring::set_default_credential_builder(keyring::mock::default_credential_builder());
        let store: Arc<dyn SecretStore> = Arc::new(KeyringStore);
        let secret = "sk-very-secret-value";
        set_secret(store.as_ref(), "c1", secret).unwrap();
        assert!(!has_secret(store.as_ref(), "c1").unwrap());
        delete_secret(store.as_ref(), "c1").unwrap();
        for e in [
            keyring::Error::NoStorageAccess(Box::new(std::io::Error::other(secret))),
            keyring::Error::PlatformFailure(Box::new(std::io::Error::other(secret))),
            keyring::Error::BadEncoding(secret.as_bytes().to_vec()),
            keyring::Error::TooLong(secret.to_owned(), 1),
            keyring::Error::Invalid(secret.to_owned(), secret.to_owned()),
        ] {
            let mapped = keychain_error(&e);
            assert!(!mapped.message.contains("secret"), "{}", mapped.message);
            assert!(!format!("{mapped:?}").contains(secret));
        }
    }
}
