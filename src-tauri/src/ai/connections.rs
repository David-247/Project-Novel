//! Persisted AI connections: `ai-connections.json` in the app data dir (never in a project folder,
//! never a secret: keys live in the OS keychain, see `keychain.rs`). The file is
//! `{ "version": 1, "connections": [...] }`; unknown keys are kept, at the top level and on each
//! connection. [`FileResolver`] is the app's [`ConnectionResolver`]: it reads the file and the
//! keychain for each `ai_fetch`.

use std::collections::BTreeMap;
use std::fs;
use std::io::ErrorKind;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use reqwest::Url;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

use super::keychain::{SecretStore, MAX_ID_BYTES};
use super::{providers, AiError, ConnectionResolver, ResolvedConnection};

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

/// Validate and atomically save `connections`, keeping the file's unknown top-level keys. Secrets
/// of connections that are no longer listed are deleted (best effort).
pub fn save_connections(path: &Path, secrets: &dyn SecretStore, connections: Vec<Connection>) -> Result<(), AiError> {
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
        for gone in old.connections.iter().filter(|c| !file.connections.iter().any(|n| n.id == c.id)) {
            let _ = secrets.delete(&gone.id);
        }
    }
    Ok(())
}

fn text_ok(s: &str, max: usize) -> bool {
    !s.trim().is_empty() && s.chars().count() <= max && !s.chars().any(char::is_control)
}

fn validate(mut connections: Vec<Connection>) -> Result<Vec<Connection>, AiError> {
    if connections.len() > MAX_CONNECTIONS {
        return Err(AiError::bad_request("Too many AI connections."));
    }
    for c in connections.iter_mut() {
        if c.id.len() > MAX_ID_BYTES || !text_ok(&c.id, MAX_ID_BYTES) {
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
                let stored = self.secrets.get(connection_id)?;
                // A hosted provider cannot work without its credential; a custom endpoint's key is optional.
                if stored.is_none() && provider.base_url.is_some() {
                    return Err(AiError::not_connected());
                }
                stored
            }
        };
        Ok(ResolvedConnection { provider, base_url, secret, insecure_http_accepted })
    }
}

#[cfg(test)]
mod tests {
    use super::super::fetch;
    use super::super::keychain::testing::MemoryStore;
    use super::super::keychain::set_secret;
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
        set_secret(f.secrets.as_ref(), "c1", secret).unwrap();
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
        set_secret(f.secrets.as_ref(), "c1", "sk-1").unwrap();
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
        set_secret(f.secrets.as_ref(), "c1", "k1").unwrap();
        set_secret(f.secrets.as_ref(), "c2", "k2").unwrap();
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
        set_secret(f.secrets.as_ref(), "c1", "k").unwrap();
        let r = f.resolver().resolve("c1").unwrap();
        assert_eq!(r.provider.id, "openai");
    }
}
