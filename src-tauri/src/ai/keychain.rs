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

/// The OS keychain through the `keyring` crate.
pub struct KeyringStore;

fn entry(connection_id: &str) -> Result<keyring::Entry, AiError> {
    keyring::Entry::new(SERVICE, connection_id).map_err(|e| keychain_error(&e))
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

impl SecretStore for KeyringStore {
    fn set(&self, connection_id: &str, secret: &str) -> Result<(), AiError> {
        entry(connection_id)?.set_password(secret).map_err(|e| keychain_error(&e))
    }

    fn get(&self, connection_id: &str) -> Result<Option<Secret>, AiError> {
        match entry(connection_id)?.get_password() {
            Ok(s) => Ok(Some(Secret::new(s))),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(e) => Err(keychain_error(&e)),
        }
    }

    fn delete(&self, connection_id: &str) -> Result<(), AiError> {
        match entry(connection_id)?.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(e) => Err(keychain_error(&e)),
        }
    }
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
