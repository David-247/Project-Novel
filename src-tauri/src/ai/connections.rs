//! Persisted AI connections: `ai-connections.json` in the app data dir (never in a project folder,
//! never a secret: keys live in the OS keychain, see `keychain.rs`). The file is
//! `{ "version": 1, "connections": [...] }`; unknown keys are kept, at the top level and on each
//! connection. [`FileResolver`] is the app's [`ConnectionResolver`]: it reads the file and the
//! keychain for each `ai_fetch`.

use std::collections::BTreeMap;
use std::fs;
use std::io::ErrorKind;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, MutexGuard};

use reqwest::Url;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

use super::keychain::{SecretStore, MAX_ID_BYTES};
use super::{providers, AiError, ConnectionResolver, ResolvedConnection, Secret};

/// File name inside the app data dir.
pub const CONNECTIONS_FILE: &str = "ai-connections.json";
const FILE_VERSION: u32 = 1;
/// Larger files are read as empty (the real file is a few KB).
const MAX_FILE_BYTES: u64 = 1024 * 1024;
const MAX_CONNECTIONS: usize = 100;
const MAX_TEXT_CHARS: usize = 200;
const MAX_URL_CHARS: usize = 2048;
/// Providers whose host is the user's saved base URL.
const USER_HOSTED: &[&str] = &["ollama", "lmstudio", "custom"];

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
pub enum ConnectionAuth {
    #[serde(rename = "api_key")]
    ApiKey,
    #[serde(rename = "oauth")]
    Oauth,
    #[serde(rename = "none")]
    None,
}

/// One saved connection (the TS `Connection`). Holds no secret.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Connection {
    pub id: String,
    pub provider: String,
    pub label: String,
    pub auth: ConnectionAuth,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub base_url: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub default_model: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tool_support: Option<BTreeMap<String, bool>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub insecure_http_accepted: Option<bool>,
    /// Unknown keys, written back unchanged.
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

#[derive(Debug, Serialize, Deserialize)]
struct ConnectionsFile {
    version: u32,
    connections: Vec<Connection>,
    #[serde(flatten)]
    extra: Map<String, Value>,
}

fn read_file(path: &Path) -> Result<Option<ConnectionsFile>, AiError> {
    match fs::metadata(path) {
        Ok(m) if m.len() > MAX_FILE_BYTES => return Ok(None),
        Ok(_) => {}
        Err(e) if e.kind() == ErrorKind::NotFound => return Ok(None),
        Err(_) => return Err(AiError::bad_request("The AI connections file could not be read.")),
    }
    match fs::read_to_string(path) {
        // A damaged file reads as no connections; the next save replaces it.
        Ok(text) => Ok(serde_json::from_str(&text).ok()),
        Err(e) if e.kind() == ErrorKind::NotFound || e.kind() == ErrorKind::InvalidData => Ok(None),
        Err(_) => Err(AiError::bad_request("The AI connections file could not be read.")),
    }
}

/// The saved connections (empty when there is no file or it is damaged).
pub fn load_connections(path: &Path) -> Result<Vec<Connection>, AiError> {
    Ok(read_file(path)?.map(|f| f.connections).unwrap_or_default())
}

/// Serialises every load-modify-write of the connections file: the webview's saves, upserts and
/// removes, and the sign-in's append + key (oauth.rs). Without it a write built from an older read
/// could drop a connection another writer had just added, and delete its key.
static WRITES: Mutex<()> = Mutex::new(());

/// Hold this across a whole load-modify-write of the connections file (never across a network call).
pub fn write_lock() -> MutexGuard<'static, ()> {
    WRITES.lock().unwrap_or_else(|e| e.into_inner())
}

/// Validate and atomically save `connections`, keeping the file's unknown top-level keys. Secrets
/// of connections that are no longer listed are deleted (best effort). Tests only: the app edits one
/// connection at a time ([`upsert_connection`], [`remove_connection`]), so it can never drop one it has
/// not seen (a sign-in that finished meanwhile).
#[cfg(test)]
pub fn save_connections(path: &Path, secrets: &dyn SecretStore, connections: Vec<Connection>) -> Result<(), AiError> {
    let _lock = write_lock();
    save_locked(path, secrets, connections)
}

/// Add `connection`, or replace the saved one with its id, leaving every other connection (and its
/// key) as it is on disk. The webview edits through this, so it can never drop a connection it has
/// not seen yet (a sign-in that finished meanwhile).
pub fn upsert_connection(path: &Path, secrets: &dyn SecretStore, connection: Connection) -> Result<(), AiError> {
    let _lock = write_lock();
    let mut list = load_connections(path)?;
    match list.iter_mut().find(|c| c.id == connection.id) {
        Some(slot) => *slot = connection,
        None => list.push(connection),
    }
    save_locked(path, secrets, list)
}

/// Remove one connection (and its key); the others stay as they are on disk. A missing id is fine.
pub fn remove_connection(path: &Path, secrets: &dyn SecretStore, connection_id: &str) -> Result<(), AiError> {
    let _lock = write_lock();
    let list: Vec<Connection> = load_connections(path)?.into_iter().filter(|c| c.id != connection_id).collect();
    save_locked(path, secrets, list)
}

/// Validate and atomically save the whole list, for a caller that already holds [`write_lock`]. Secrets
/// of connections that are gone or re-pointed are deleted (best effort).
pub fn save_locked(path: &Path, secrets: &dyn SecretStore, connections: Vec<Connection>) -> Result<(), AiError> {
    let connections = validate(connections)?;
    let existing = read_file(path)?;
    let extra = existing.as_ref().map(|f| f.extra.clone()).unwrap_or_default();
    let file = ConnectionsFile { version: FILE_VERSION, connections, extra };
    let text = serde_json::to_string_pretty(&file).map_err(|_| AiError::bad_request("The connections could not be saved."))?;
    if let Some(dir) = path.parent() {
        fs::create_dir_all(dir).map_err(|_| AiError::bad_request("The AI connections folder could not be created."))?;
    }
    crate::storage::write_atomic(path, text.as_bytes())
        .map_err(|_| AiError::bad_request("The AI connections could not be saved."))?;
    if let Some(old) = existing {
        for before in &old.connections {
            // Removed, or re-pointed (provider, auth or origin): the stored key must not follow it.
            let kept = file.connections.iter().find(|n| n.id == before.id).is_some_and(|n| binding(n) == binding(before));
            if !kept {
                let _ = secrets.delete(&before.id);
            }
        }
    }
    Ok(())
}

/// What a stored secret is tied to: the provider, the auth kind and the origin (scheme, host, port) its
/// requests go to. A saved connection whose binding differs from the secret's gets no secret.
fn binding(c: &Connection) -> String {
    let origin_of = |u: &str| Url::parse(u).map(|u| u.origin().ascii_serialization()).unwrap_or_default();
    let origin = match providers::descriptor(&c.provider) {
        Some(d) => match d.base_url {
            Some(fixed) => origin_of(fixed),
            None => c.base_url.as_deref().map(origin_of).unwrap_or_default(),
        },
        None => String::new(),
    };
    let auth = match c.auth {
        ConnectionAuth::ApiKey => "api_key",
        ConnectionAuth::Oauth => "oauth",
        ConnectionAuth::None => "none",
    };
    format!("{}|{auth}|{origin}", c.provider)
}

/// The keychain value: the secret with its binding, as JSON. Only Rust reads it.
fn wrap(c: &Connection, secret: &str) -> String {
    serde_json::json!({ "v": 1, "b": binding(c), "s": secret }).to_string()
}

/// The secret inside a keychain value, if the value is bound to exactly this connection's binding.
fn unwrap_for(c: &Connection, stored: &str) -> Option<Secret> {
    let v: Value = serde_json::from_str(stored).ok()?;
    (v["v"] == 1 && v["b"] == binding(c).as_str()).then(|| v["s"].as_str().map(Secret::new))?
}

fn find(path: &Path, connection_id: &str) -> Result<Connection, AiError> {
    load_connections(path)?.into_iter().find(|c| c.id == connection_id).ok_or_else(AiError::not_connected)
}

/// Store the secret of a saved connection, bound to its provider, auth and origin. The connection
/// must be saved first.
pub fn set_connection_secret(path: &Path, secrets: &dyn SecretStore, connection_id: &str, secret: &str) -> Result<(), AiError> {
    // The raw secret is checked here: the wrapper is never empty.
    super::keychain::check_secret(secret)?;
    let c = find(path, connection_id)?;
    super::keychain::set_secret(secrets, connection_id, &wrap(&c, secret))
}

/// [`set_connection_secret`] inside one [`write_lock`]: the connection cannot be removed between the
/// check that it is saved and the keychain write (a refreshed token record, a renewed sign-in).
pub fn replace_secret(path: &Path, secrets: &dyn SecretStore, connection_id: &str, secret: &str) -> Result<(), AiError> {
    let _lock = write_lock();
    set_connection_secret(path, secrets, connection_id, secret)
}

/// The connection was re-pointed (provider, auth or origin) or removed after its secret was read: a
/// secret derived from the old one (a refreshed token record) is dropped, never bound to the new target.
pub fn changed_meanwhile() -> AiError {
    AiError::new("not_connected", "This AI connection was changed while its sign-in was being renewed. Sign in again if you still need it.")
}

/// [`replace_secret`], only if the saved connection still has `expected_binding` (what the old secret
/// was read for). Otherwise nothing is written and the error is [`changed_meanwhile`].
pub fn replace_bound_secret(path: &Path, secrets: &dyn SecretStore, connection_id: &str, expected_binding: &str, secret: &str) -> Result<(), AiError> {
    super::keychain::check_secret(secret)?;
    let _lock = write_lock();
    // Removed: changed. A file that cannot be read is an ordinary failure (the caller keeps the record).
    let c = find(path, connection_id).map_err(|e| if e == AiError::not_connected() { changed_meanwhile() } else { e })?;
    if binding(&c) != expected_binding {
        return Err(changed_meanwhile());
    }
    super::keychain::set_secret(secrets, connection_id, &wrap(&c, secret))
}

/// The saved connection and its secret, if the keychain holds one bound to it. Rust-only (sign-out
/// revocation, renewing a sign-in); no command returns it.
pub fn connection_secret(path: &Path, secrets: &dyn SecretStore, connection_id: &str) -> Result<Option<(Connection, Secret)>, AiError> {
    let Ok(c) = find(path, connection_id) else { return Ok(None) };
    let secret = secrets.get(connection_id)?.and_then(|s| unwrap_for(&c, s.expose()));
    Ok(secret.map(|s| (c, s)))
}

/// True if the connection is saved and the keychain holds a secret bound to it as it is now.
pub fn has_connection_secret(path: &Path, secrets: &dyn SecretStore, connection_id: &str) -> Result<bool, AiError> {
    let Ok(c) = find(path, connection_id) else { return Ok(false) };
    Ok(secrets.get(connection_id)?.is_some_and(|s| unwrap_for(&c, s.expose()).is_some()))
}

fn text_ok(s: &str, max: usize) -> bool {
    !s.trim().is_empty() && s.chars().count() <= max && !s.chars().any(char::is_control)
}

fn validate(mut connections: Vec<Connection>) -> Result<Vec<Connection>, AiError> {
    if connections.len() > MAX_CONNECTIONS {
        return Err(AiError::bad_request("Too many AI connections."));
    }
    for c in connections.iter_mut() {
        // `#` is reserved for the keychain's split-secret parts (`<id>#<slot>#<k>`, keychain.rs).
        if c.id.len() > MAX_ID_BYTES || !text_ok(&c.id, MAX_ID_BYTES) || c.id.contains('#') {
            return Err(AiError::bad_request("A connection id is not valid."));
        }
        if providers::descriptor(&c.provider).is_none() {
            return Err(AiError::bad_request("A connection names an unknown provider."));
        }
        if !text_ok(&c.label, MAX_TEXT_CHARS) {
            return Err(AiError::bad_request("A connection label is empty, too long or has control characters."));
        }
        if c.default_model.as_deref().is_some_and(|m| !text_ok(m, MAX_TEXT_CHARS)) {
            return Err(AiError::bad_request("A connection's default model is not valid."));
        }
        if USER_HOSTED.contains(&c.provider.as_str()) {
            if let Some(url) = c.base_url.as_deref() {
                let url = url.trim().to_owned();
                check_base_url(&url)?;
                c.base_url = Some(url);
            }
        } else {
            // A hosted provider has a fixed host: a saved base URL is dropped.
            c.base_url = None;
            c.insecure_http_accepted = None;
        }
    }
    let mut ids: Vec<&str> = connections.iter().map(|c| c.id.as_str()).collect();
    ids.sort_unstable();
    if ids.windows(2).any(|w| w[0] == w[1]) {
        return Err(AiError::bad_request("Two connections have the same id."));
    }
    Ok(connections)
}

/// A saved base URL: http or https, a host, and no userinfo, query or fragment.
pub fn check_base_url(raw: &str) -> Result<(), AiError> {
    let bad = |why: &str| AiError::bad_request(format!("The address is not valid: {why}."));
    if raw.is_empty() || raw.chars().count() > MAX_URL_CHARS || raw.chars().any(|c| c.is_control() || c == ' ') {
        return Err(bad("it is empty, too long or has spaces"));
    }
    let url = Url::parse(raw).map_err(|_| bad("it is not a URL"))?;
    if !matches!(url.scheme(), "http" | "https") {
        return Err(bad("it must start with http:// or https://"));
    }
    if url.host_str().is_none_or(str::is_empty) {
        return Err(bad("it has no host"));
    }
    if !url.username().is_empty() || url.password().is_some() {
        return Err(bad("it must not contain a user name or password"));
    }
    if url.query().is_some() || raw.contains('?') {
        return Err(bad("it must not contain a query (?)"));
    }
    if url.fragment().is_some() || raw.contains('#') {
        return Err(bad("it must not contain a fragment (#)"));
    }
    Ok(())
}

/// The real resolver: `ai-connections.json` + the keychain, read on every request.
pub struct FileResolver {
    path: PathBuf,
    secrets: Arc<dyn SecretStore>,
}

impl FileResolver {
    pub fn new(path: PathBuf, secrets: Arc<dyn SecretStore>) -> Self {
        FileResolver { path, secrets }
    }
}

impl ConnectionResolver for FileResolver {
    fn resolve(&self, connection_id: &str) -> Result<ResolvedConnection, AiError> {
        let connection = load_connections(&self.path)?
            .into_iter()
            .find(|c| c.id == connection_id)
            .ok_or_else(AiError::not_connected)?;
        let provider = providers::descriptor(&connection.provider).ok_or_else(AiError::not_connected)?;
        let (base_url, insecure_http_accepted) = if provider.base_url.is_none() {
            (connection.base_url.clone(), connection.insecure_http_accepted == Some(true))
        } else {
            (None, false)
        };
        let secret = match connection.auth {
            ConnectionAuth::None => None,
            ConnectionAuth::ApiKey | ConnectionAuth::Oauth => {
                // A secret bound to another provider, auth or origin is not released.
                let stored = self.secrets.get(connection_id)?.and_then(|s| unwrap_for(&connection, s.expose()));
                // A hosted provider cannot work without its credential; a custom endpoint's key is optional.
                if stored.is_none() && provider.base_url.is_some() {
                    return Err(AiError::not_connected());
                }
                stored
            }
        };
        Ok(ResolvedConnection { provider, base_url, secret, insecure_http_accepted, binding: binding(&connection) })
    }

    fn store_secret(&self, connection_id: &str, expected_binding: &str, secret: &Secret) -> Result<(), AiError> {
        replace_bound_secret(&self.path, self.secrets.as_ref(), connection_id, expected_binding, secret.expose())
    }
}

#[cfg(test)]
mod tests {
    use super::super::fetch;
    use super::super::keychain::testing::MemoryStore;
    use super::*;

    fn conn(id: &str, provider: &str, base_url: Option<&str>) -> Connection {
        Connection {
            id: id.into(),
            provider: provider.into(),
            label: format!("{provider} connection"),
            auth: ConnectionAuth::ApiKey,
            base_url: base_url.map(str::to_owned),
            default_model: None,
            tool_support: None,
            insecure_http_accepted: None,
            extra: Map::new(),
        }
    }

    struct Fixture {
        dir: tempfile::TempDir,
        secrets: Arc<MemoryStore>,
    }

    impl Fixture {
        fn new() -> Self {
            Fixture { dir: tempfile::tempdir().unwrap(), secrets: Arc::new(MemoryStore::default()) }
        }
        fn path(&self) -> PathBuf {
            self.dir.path().join(CONNECTIONS_FILE)
        }
        fn save(&self, list: Vec<Connection>) -> Result<(), AiError> {
            save_connections(&self.path(), self.secrets.as_ref(), list)
        }
        fn set_secret(&self, id: &str, secret: &str) -> Result<(), AiError> {
            set_connection_secret(&self.path(), self.secrets.as_ref(), id, secret)
        }
        fn has_secret(&self, id: &str) -> bool {
            has_connection_secret(&self.path(), self.secrets.as_ref(), id).unwrap()
        }
        fn resolver(&self) -> FileResolver {
            FileResolver::new(self.path(), self.secrets.clone())
        }
    }

    fn target(c: &ResolvedConnection) -> Result<Url, AiError> {
        fetch::target_url(c, "/models")
    }

    #[test]
    fn connections_file_never_contains_secret() {
        let f = Fixture::new();
        f.save(vec![conn("c1", "anthropic", None), conn("c2", "custom", Some("https://llm.example.com/v1"))]).unwrap();
        let secret = "sk-ant-TOP-SECRET-123";
        f.set_secret("c1", secret).unwrap();
        // Saving again after the secret exists must not pick it up either.
        f.save(load_connections(&f.path()).unwrap()).unwrap();
        let bytes = fs::read(f.path()).unwrap();
        assert!(!String::from_utf8_lossy(&bytes).contains("TOP-SECRET"));
        assert!(!String::from_utf8_lossy(&bytes).contains(secret));
        // The resolver finds the secret in the keychain, not the file.
        assert_eq!(f.resolver().resolve("c1").unwrap().secret.unwrap().expose(), secret);
    }

    #[test]
    fn http_lan_without_acceptance_is_blocked() {
        let f = Fixture::new();
        f.save(vec![conn("lan", "ollama", Some("http://192.168.1.20:11434/v1"))]).unwrap();
        let resolved = f.resolver().resolve("lan").unwrap();
        assert_eq!(target(&resolved).unwrap_err().kind, "blocked_host");
        // Also a named host, and a public IP.
        for url in ["http://nas.local:11434", "http://example.com/v1", "http://8.8.8.8"] {
            f.save(vec![conn("lan", "custom", Some(url))]).unwrap();
            assert_eq!(target(&f.resolver().resolve("lan").unwrap()).unwrap_err().kind, "blocked_host", "{url}");
        }
        // Accepted: allowed.
        let mut accepted = conn("lan", "ollama", Some("http://192.168.1.20:11434/v1"));
        accepted.insecure_http_accepted = Some(true);
        f.save(vec![accepted]).unwrap();
        let url = target(&f.resolver().resolve("lan").unwrap()).unwrap();
        assert_eq!(url.as_str(), "http://192.168.1.20:11434/v1/models");
        // https on a LAN host needs no acceptance.
        f.save(vec![conn("lan", "custom", Some("https://192.168.1.20/v1"))]).unwrap();
        assert!(target(&f.resolver().resolve("lan").unwrap()).is_ok());
    }

    #[test]
    fn http_localhost_allowed() {
        let f = Fixture::new();
        for url in [
            "http://localhost:11434",
            "http://127.0.0.1:1234/v1",
            "http://127.1.2.3",
            "http://[::1]:8080/v1",
            "http://LOCALHOST/v1",
        ] {
            f.save(vec![conn("local", "lmstudio", Some(url))]).unwrap();
            let resolved = f.resolver().resolve("local").unwrap();
            assert!(target(&resolved).is_ok(), "{url}");
        }
    }

    #[test]
    fn only_localhost_and_loopback_literals_are_loopback() {
        let f = Fixture::new();
        for url in ["http://foo.localhost:11434", "http://localhost.example.com", "http://127.0.0.1.nip.io", "http://[::ffff:192.168.1.5]"] {
            f.save(vec![conn("l", "custom", Some(url))]).unwrap();
            assert_eq!(target(&f.resolver().resolve("l").unwrap()).unwrap_err().kind, "blocked_host", "{url}");
        }
    }

    #[test]
    fn hosted_provider_ignores_base_url() {
        let f = Fixture::new();
        // Saving drops the base URL of a hosted provider (and any acceptance flag) ...
        let mut hosted = conn("c1", "openai", Some("http://evil.example/v1"));
        hosted.insecure_http_accepted = Some(true);
        f.save(vec![hosted]).unwrap();
        let saved = load_connections(&f.path()).unwrap();
        assert_eq!(saved[0].base_url, None);
        assert_eq!(saved[0].insecure_http_accepted, None);
        // ... and a hand-edited file naming one is ignored when resolving.
        let text = r#"{"version":1,"connections":[{"id":"c1","provider":"openai","label":"x","auth":"api_key","baseUrl":"http://evil.example/v1","insecureHttpAccepted":true}]}"#;
        fs::write(f.path(), text).unwrap();
        f.set_secret("c1", "sk-1").unwrap();
        let resolved = f.resolver().resolve("c1").unwrap();
        assert_eq!(resolved.base_url, None);
        assert_eq!(target(&resolved).unwrap().as_str(), "https://api.openai.com/v1/models");
    }

    #[test]
    fn base_url_is_validated_on_save() {
        let f = Fixture::new();
        for bad in [
            "http://host/v1?key=1",
            "http://host/v1?",
            "http://host/v1#frag",
            "http://host/v1#",
            "http://user:pw@host/v1",
            "http://user@host/v1",
            "ftp://host/v1",
            "file:///etc/passwd",
            "javascript:alert(1)",
            "not a url",
            "host/v1",
            "",
            "http://",
        ] {
            let err = f.save(vec![conn("c1", "custom", Some(bad))]).unwrap_err();
            assert_eq!(err.kind, "bad_request", "{bad}");
        }
        assert!(!f.path().exists(), "nothing was written");
        for good in ["http://localhost:11434", "https://llm.example.com/v1", "http://192.168.0.5:1234/v1/"] {
            f.save(vec![conn("c1", "custom", Some(good))]).unwrap();
        }
    }

    #[test]
    fn rejects_unknown_provider_duplicates_and_bad_fields() {
        let f = Fixture::new();
        assert!(f.save(vec![conn("c1", "nope", None)]).is_err());
        assert!(f.save(vec![conn("c1", "openai", None), conn("c1", "xai", None)]).is_err());
        assert!(f.save(vec![conn("", "openai", None)]).is_err());
        assert!(f.save(vec![conn("X#1", "openai", None)]).is_err(), "an id with # would alias a keychain part");
        let mut c = conn("c1", "openai", None);
        c.label = "\u{7}label".into();
        assert!(f.save(vec![c]).is_err());
    }

    #[test]
    fn unknown_keys_survive_a_round_trip_and_damage_reads_as_empty() {
        let f = Fixture::new();
        let text = r#"{"version":1,"future":{"a":1},"connections":[{"id":"c1","provider":"openai","label":"x","auth":"api_key","note":"keep","toolSupport":{"m":true}}]}"#;
        fs::write(f.path(), text).unwrap();
        let list = load_connections(&f.path()).unwrap();
        assert_eq!(list[0].extra["note"], "keep");
        f.save(list).unwrap();
        let saved: Value = serde_json::from_slice(&fs::read(f.path()).unwrap()).unwrap();
        assert_eq!(saved["future"]["a"], 1);
        assert_eq!(saved["connections"][0]["note"], "keep");
        assert_eq!(saved["connections"][0]["toolSupport"]["m"], true);
        fs::write(f.path(), "{ not json").unwrap();
        assert!(load_connections(&f.path()).unwrap().is_empty());
    }

    #[test]
    fn removing_a_connection_deletes_its_secret() {
        let f = Fixture::new();
        f.save(vec![conn("c1", "openai", None), conn("c2", "xai", None)]).unwrap();
        f.set_secret("c1", "k1").unwrap();
        f.set_secret("c2", "k2").unwrap();
        f.save(vec![conn("c2", "xai", None)]).unwrap();
        assert!(f.secrets.get("c1").unwrap().is_none());
        assert!(f.secrets.get("c2").unwrap().is_some());
    }

    #[test]
    fn resolver_requires_a_connection_and_a_hosted_credential() {
        let f = Fixture::new();
        f.save(vec![conn("c1", "openai", None), conn("custom", "custom", Some("https://x.example/v1"))]).unwrap();
        assert_eq!(f.resolver().resolve("missing").unwrap_err().kind, "not_connected");
        assert_eq!(f.resolver().resolve("c1").unwrap_err().kind, "not_connected", "no key stored yet");
        // A custom endpoint's key is optional.
        assert!(f.resolver().resolve("custom").unwrap().secret.is_none());
        f.set_secret("c1", "k").unwrap();
        let r = f.resolver().resolve("c1").unwrap();
        assert_eq!(r.provider.id, "openai");
    }

    fn assert_secret_dropped_on_change(change: impl FnOnce(&mut Connection), what: &str) {
        let f = Fixture::new();
        f.save(vec![conn("c1", "custom", Some("https://llm.example.com/v1"))]).unwrap();
        f.set_secret("c1", "sk-live").unwrap();
        assert!(f.has_secret("c1"));
        let mut changed = conn("c1", "custom", Some("https://llm.example.com/v1"));
        change(&mut changed);
        f.save(vec![changed]).unwrap();
        assert!(f.secrets.get("c1").unwrap().is_none(), "{what}: the secret survived");
        assert!(!f.has_secret("c1"), "{what}");
    }

    #[test]
    fn changing_provider_auth_or_origin_deletes_the_secret() {
        assert_secret_dropped_on_change(|c| c.provider = "ollama".into(), "provider");
        assert_secret_dropped_on_change(|c| c.auth = ConnectionAuth::Oauth, "auth");
        assert_secret_dropped_on_change(|c| c.base_url = Some("https://attacker.example/v1".into()), "host");
        assert_secret_dropped_on_change(|c| c.base_url = Some("http://llm.example.com/v1".into()), "scheme");
        assert_secret_dropped_on_change(|c| c.base_url = Some("https://llm.example.com:8443/v1".into()), "port");
        assert_secret_dropped_on_change(|c| c.base_url = None, "base url removed");
    }

    #[test]
    fn hosted_connection_re_pointed_at_a_custom_host_loses_its_key() {
        let f = Fixture::new();
        f.save(vec![conn("c1", "anthropic", None)]).unwrap();
        f.set_secret("c1", "sk-ant-live").unwrap();
        f.save(vec![conn("c1", "custom", Some("https://attacker.example"))]).unwrap();
        assert!(f.secrets.get("c1").unwrap().is_none());
        assert!(f.resolver().resolve("c1").unwrap().secret.is_none(), "custom has an optional key: none is sent");
    }

    #[test]
    fn path_only_change_keeps_the_secret() {
        let f = Fixture::new();
        f.save(vec![conn("c1", "custom", Some("https://llm.example.com/v1"))]).unwrap();
        f.set_secret("c1", "sk-live").unwrap();
        let mut c = conn("c1", "custom", Some("https://LLM.example.com:443/other/path/"));
        c.label = "renamed".into();
        c.default_model = Some("m".into());
        f.save(vec![c]).unwrap();
        assert_eq!(f.resolver().resolve("c1").unwrap().secret.unwrap().expose(), "sk-live");
        assert!(f.has_secret("c1"));
    }

    #[test]
    fn resolver_refuses_a_secret_bound_to_another_origin_or_provider() {
        let f = Fixture::new();
        f.save(vec![conn("c1", "custom", Some("https://llm.example.com/v1"))]).unwrap();
        f.set_secret("c1", "sk-live").unwrap();
        // The file is edited behind save's back (a compromised webview cannot do this, but a hand edit can).
        for edited in [
            r#"{"id":"c1","provider":"custom","label":"x","auth":"api_key","baseUrl":"https://attacker.example/v1"}"#,
            r#"{"id":"c1","provider":"openai","label":"x","auth":"api_key"}"#,
            r#"{"id":"c1","provider":"custom","label":"x","auth":"oauth","baseUrl":"https://llm.example.com/v1"}"#,
        ] {
            fs::write(f.path(), format!(r#"{{"version":1,"connections":[{edited}]}}"#)).unwrap();
            // Custom: key optional, so it resolves without one; hosted: not connected.
            let r = f.resolver().resolve("c1");
            match r {
                Ok(c) => assert!(c.secret.is_none(), "{edited}"),
                Err(e) => assert_eq!(e.kind, "not_connected", "{edited}"),
            }
            assert!(!f.has_secret("c1"), "{edited}");
        }
        // A raw (unbound) keychain value is never released either.
        f.save(vec![conn("c1", "openai", None)]).unwrap();
        f.secrets.set("c1", "sk-raw").unwrap();
        assert_eq!(f.resolver().resolve("c1").unwrap_err().kind, "not_connected");
    }

    #[test]
    fn empty_secret_is_rejected() {
        let f = Fixture::new();
        f.save(vec![conn("c1", "openai", None)]).unwrap();
        assert_eq!(f.set_secret("c1", "").unwrap_err().kind, "bad_request");
        assert!(f.secrets.get("c1").unwrap().is_none());
        assert!(!f.has_secret("c1"));
        assert_eq!(f.resolver().resolve("c1").unwrap_err().kind, "not_connected");
    }

    #[test]
    fn oversized_secret_is_rejected() {
        let f = Fixture::new();
        f.save(vec![conn("c1", "openai", None)]).unwrap();
        let at_cap = "k".repeat(super::super::keychain::MAX_SECRET_BYTES);
        assert_eq!(f.set_secret("c1", &(at_cap.clone() + "k")).unwrap_err().kind, "bad_request");
        assert_eq!(f.set_secret("c1", &at_cap).unwrap_err().kind, "bad_request", "the wrapped value is over the cap too");
        assert!(f.secrets.get("c1").unwrap().is_none());
    }

    #[test]
    fn upsert_keeps_connections_it_never_saw() {
        let f = Fixture::new();
        f.save(vec![conn("a", "custom", Some("https://a.example/v1")), conn("b", "openrouter", None)]).unwrap();
        f.set_secret("a", "ka").unwrap();
        f.set_secret("b", "kb").unwrap();
        // The webview edits "a" from a list that never had "b".
        let mut a = conn("a", "custom", Some("https://a.example/v1"));
        a.label = "renamed".into();
        upsert_connection(&f.path(), f.secrets.as_ref(), a).unwrap();
        let ids: Vec<_> = load_connections(&f.path()).unwrap().into_iter().map(|c| (c.id, c.label)).collect();
        assert_eq!(ids, [("a".to_owned(), "renamed".to_owned()), ("b".to_owned(), "openrouter connection".to_owned())]);
        assert!(f.has_secret("a") && f.has_secret("b"));
        // A new one is appended; re-pointing "a" drops only a's key.
        upsert_connection(&f.path(), f.secrets.as_ref(), conn("c", "openai", None)).unwrap();
        upsert_connection(&f.path(), f.secrets.as_ref(), conn("a", "custom", Some("https://elsewhere.example/v1"))).unwrap();
        assert_eq!(load_connections(&f.path()).unwrap().len(), 3);
        assert!(!f.has_secret("a") && f.has_secret("b"));
        // Validation still applies to the merged list.
        assert!(upsert_connection(&f.path(), f.secrets.as_ref(), conn("d", "nope", None)).is_err());
    }

    #[test]
    fn remove_deletes_only_that_connection_and_its_secret() {
        let f = Fixture::new();
        f.save(vec![conn("a", "openai", None), conn("b", "xai", None)]).unwrap();
        f.set_secret("a", "ka").unwrap();
        f.set_secret("b", "kb").unwrap();
        remove_connection(&f.path(), f.secrets.as_ref(), "a").unwrap();
        assert_eq!(load_connections(&f.path()).unwrap().iter().map(|c| c.id.as_str()).collect::<Vec<_>>(), ["b"]);
        assert!(f.secrets.get("a").unwrap().is_none());
        assert!(f.has_secret("b"));
        remove_connection(&f.path(), f.secrets.as_ref(), "missing").unwrap();
    }

    #[test]
    fn concurrent_writers_lose_nothing() {
        // Each thread adds its own connection through a full load-modify-write; with the shared lock
        // none overwrites another's.
        let f = Arc::new(Fixture::new());
        let threads: Vec<_> = (0..8)
            .map(|i| {
                let f = f.clone();
                std::thread::spawn(move || {
                    for k in 0..5 {
                        upsert_connection(&f.path(), f.secrets.as_ref(), conn(&format!("t{i}-{k}"), "openai", None)).unwrap();
                    }
                })
            })
            .collect();
        for t in threads {
            t.join().unwrap();
        }
        assert_eq!(load_connections(&f.path()).unwrap().len(), 40);
    }

    #[test]
    fn setting_a_secret_needs_a_saved_connection() {
        let f = Fixture::new();
        assert_eq!(f.set_secret("nope", "k").unwrap_err().kind, "not_connected");
        assert!(f.secrets.get("nope").unwrap().is_none());
    }

    #[test]
    fn a_stored_secret_must_match_the_connection_it_was_read_for() {
        let f = Fixture::new();
        let mut plan = conn("p1", "chatgpt", None);
        plan.auth = ConnectionAuth::Oauth;
        f.save(vec![plan.clone()]).unwrap();
        f.set_secret("p1", "RECORD-1").unwrap();
        let r = f.resolver();
        let read = r.resolve("p1").unwrap();
        // Unchanged: the replacement is stored, bound as before.
        r.store_secret("p1", &read.binding, &Secret::new("RECORD-2")).unwrap();
        assert_eq!(r.resolve("p1").unwrap().secret.unwrap().expose(), "RECORD-2");
        // Re-pointed (provider, auth or origin) after the read: refused, nothing stored for the new target.
        let mut evil = conn("p1", "custom", Some("https://evil.example/v1"));
        evil.auth = ConnectionAuth::Oauth;
        let mut api_key = plan.clone();
        api_key.auth = ConnectionAuth::ApiKey;
        for changed in [evil, api_key] {
            f.save(vec![plan.clone()]).unwrap();
            f.set_secret("p1", "RECORD-2").unwrap();
            upsert_connection(&f.path(), f.secrets.as_ref(), changed.clone()).unwrap();
            assert_eq!(r.store_secret("p1", &read.binding, &Secret::new("RECORD-3")), Err(changed_meanwhile()), "{changed:?}");
            assert!(f.secrets.get("p1").unwrap().is_none(), "{changed:?}");
            assert!(r.resolve("p1").map(|c| c.secret.is_none()).unwrap_or(true), "{changed:?}");
        }
        // Removed after the read: refused too.
        f.save(vec![plan.clone()]).unwrap();
        remove_connection(&f.path(), f.secrets.as_ref(), "p1").unwrap();
        assert_eq!(r.store_secret("p1", &read.binding, &Secret::new("RECORD-4")), Err(changed_meanwhile()));
        assert!(f.secrets.get("p1").unwrap().is_none());
    }
}
