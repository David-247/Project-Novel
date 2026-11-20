//! AI tutor network proxy (Phase 5). `ai_fetch` is the app's only path to the network: the webview's
//! fetch shim (`src/features/ai-tutor/net/tauri-fetch.ts`) sends a method, a path, allowlisted
//! headers and a body; Rust picks the host from the connection's provider, adds the credential
//! itself and streams the response back over a Tauri channel. The CSP stays closed.
//!
//! ## Connection resolver (the seam `connections.rs` fills)
//!
//! `ai_fetch` names a connection by id. A [`ConnectionResolver`] turns that id into a
//! [`ResolvedConnection`]: the provider's descriptor (`providers.rs`), the saved base URL (used only
//! by providers without a fixed host: ollama, lmstudio, custom) and the secret, if any. The resolver
//! is the only thing that touches persisted connections or the keychain:
//!
//! ```ignore
//! pub trait ConnectionResolver: Send + Sync + 'static {
//!     fn resolve(&self, connection_id: &str) -> Result<ResolvedConnection, AiError>;
//! }
//! ```
//!
//! `resolve` may block (keychain); it runs on a blocking thread. Return `AiError::not_connected()`
//! for an unknown or signed-out connection. Install one with `AiState::new(resolver)` or swap it at
//! runtime with [`AiState::set_resolver`]. The app's resolver is `connections::FileResolver` (`app_resolver`,
//! installed in `lib.rs`); tests inject their own.

pub mod connections;
pub mod fetch;
pub mod history;
pub mod keychain;
pub mod oauth;
pub mod providers;

use std::collections::{HashMap, VecDeque};
use std::sync::{Arc, Mutex, RwLock};

use serde::{Deserialize, Serialize};
use tauri::ipc::Channel;
use tauri::{AppHandle, Manager, Runtime, State};
use tokio::sync::watch;

pub use providers::ProviderDescriptor;

/// Error returned to the webview. `kind` is one of "not_connected" | "blocked_host" | "bad_request"
/// | "auth" | "rate_limit" | "network" | "provider" | "cancelled". The message is for people and
/// never contains a secret (fetch.rs redacts it).
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct AiError {
    pub kind: &'static str,
    pub message: String,
}

impl AiError {
    pub fn new(kind: &'static str, message: impl Into<String>) -> Self {
        AiError { kind, message: message.into() }
    }
    pub fn not_connected() -> Self {
        Self::new("not_connected", "This AI connection is not set up. Connect a provider in Settings.")
    }
    pub fn bad_request(message: impl Into<String>) -> Self {
        Self::new("bad_request", message)
    }
    pub fn cancelled() -> Self {
        Self::new("cancelled", "The request was cancelled.")
    }
}

impl std::fmt::Display for AiError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}: {}", self.kind, self.message)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
pub enum Method {
    #[serde(rename = "GET")]
    Get,
    #[serde(rename = "POST")]
    Post,
}

/// What the webview may ask for: no host, no credential.
#[derive(Debug, Clone, Deserialize)]
pub struct AiRequest {
    pub method: Method,
    /// Path and query, appended to the provider's base URL. Must start with `/` and must not contain
    /// `://`, `..` or `\` (fetch.rs).
    pub path: String,
    /// Only allowlisted names are forwarded (fetch.rs `FORWARDED_HEADERS`); the rest are dropped.
    #[serde(default)]
    pub headers: Vec<(String, String)>,
    #[serde(default)]
    pub body: Option<String>,
}

/// Streamed to the webview: `head` once, then `chunk`s (base64 bytes), then `end`; or `error`
/// (also returned by the command) at any point.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum AiFetchEvent {
    Head { status: u16, headers: Vec<(String, String)> },
    Chunk { data: String },
    End,
    Error { kind: &'static str, message: String },
}

/// A stored credential. Debug never prints it; nothing serializes it.
#[derive(Clone)]
pub struct Secret(String);

impl Secret {
    pub fn new(value: impl Into<String>) -> Self {
        Secret(value.into())
    }
    pub fn expose(&self) -> &str {
        &self.0
    }
}

impl std::fmt::Debug for Secret {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("Secret(***)")
    }
}

/// Everything `ai_fetch` needs about a connection.
#[derive(Debug, Clone)]
pub struct ResolvedConnection {
    pub provider: &'static ProviderDescriptor,
    /// The saved base URL; used only when the provider has no fixed `base_url`.
    pub base_url: Option<String>,
    pub secret: Option<Secret>,
    /// The user accepted plain `http` for a non-loopback host (a LAN server). Ignored for https and
    /// loopback hosts.
    pub insecure_http_accepted: bool,
}

/// Turns a connection id into its provider, saved base URL and secret (see the module docs).
pub trait ConnectionResolver: Send + Sync + 'static {
    fn resolve(&self, connection_id: &str) -> Result<ResolvedConnection, AiError>;
}

/// A resolver that knows no connection (`AiState::default`, until `lib.rs` installs the real one).
pub struct NoConnections;

impl ConnectionResolver for NoConnections {
    fn resolve(&self, _connection_id: &str) -> Result<ResolvedConnection, AiError> {
        Err(AiError::not_connected())
    }
}

/// How many cancels for not-yet-registered requests are remembered (a cancel can overtake its
/// `ai_fetch` invoke).
const EARLY_CANCELS: usize = 64;

#[derive(Default)]
struct Inflight {
    running: HashMap<u32, watch::Sender<bool>>,
    early_cancels: VecDeque<u32>,
}

/// App state: the HTTP client, the connection resolver and the requests in flight (by id).
pub struct AiState {
    client: reqwest::Client,
    resolver: RwLock<Arc<dyn ConnectionResolver>>,
    inflight: Mutex<Inflight>,
}

impl AiState {
    pub fn new(resolver: Arc<dyn ConnectionResolver>) -> Self {
        AiState { client: fetch::client(), resolver: RwLock::new(resolver), inflight: Mutex::default() }
    }

    /// The proxy's HTTP client (no redirects, no system proxy), shared with the OAuth code exchange.
    pub fn http_client(&self) -> reqwest::Client {
        self.client.clone()
    }

    /// Replace the resolver (`lib.rs` installs the connections file + keychain resolver at startup).
    pub fn set_resolver(&self, resolver: Arc<dyn ConnectionResolver>) {
        *self.resolver.write().unwrap_or_else(|e| e.into_inner()) = resolver;
    }

    /// Run one request: resolve the connection, stream the response through `emit` (which returns
    /// false once nobody listens), and report any failure both as an `Error` event and as `Err`.
    pub async fn fetch<F>(&self, request_id: u32, connection_id: &str, req: AiRequest, mut emit: F) -> Result<(), AiError>
    where
        F: FnMut(AiFetchEvent) -> bool + Send,
    {
        let result = self.fetch_inner(request_id, connection_id, req, &mut emit).await;
        if let Err(e) = &result {
            emit(AiFetchEvent::Error { kind: e.kind, message: e.message.clone() });
        }
        result
    }

    async fn fetch_inner(
        &self,
        request_id: u32,
        connection_id: &str,
        req: AiRequest,
        emit: &mut (dyn FnMut(AiFetchEvent) -> bool + Send),
    ) -> Result<(), AiError> {
        let cancel = self.register(request_id)?;
        let _registration = Registration { state: self, request_id };
        let resolver = self.resolver.read().unwrap_or_else(|e| e.into_inner()).clone();
        let id = connection_id.to_owned();
        let conn = tokio::task::spawn_blocking(move || resolver.resolve(&id))
            .await
            .map_err(|_| AiError::new("not_connected", "The AI connection could not be read."))??;
        fetch::run(&self.client, &conn, req, cancel, emit).await
    }

    fn register(&self, request_id: u32) -> Result<watch::Receiver<bool>, AiError> {
        let mut inflight = self.inflight.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(i) = inflight.early_cancels.iter().position(|&id| id == request_id) {
            inflight.early_cancels.remove(i);
            return Err(AiError::cancelled());
        }
        if inflight.running.contains_key(&request_id) {
            return Err(AiError::bad_request("This request id is already in use."));
        }
        let (tx, rx) = watch::channel(false);
        inflight.running.insert(request_id, tx);
        Ok(rx)
    }

    /// Cancel a request. A cancel for an id not (yet) running is remembered, so a request whose
    /// invoke arrives after its cancel never starts. True if a running request was cancelled.
    pub fn cancel(&self, request_id: u32) -> bool {
        let mut inflight = self.inflight.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(tx) = inflight.running.get(&request_id) {
            let _ = tx.send(true);
            return true;
        }
        if inflight.early_cancels.len() == EARLY_CANCELS {
            inflight.early_cancels.pop_front();
        }
        inflight.early_cancels.push_back(request_id);
        false
    }
}

impl Default for AiState {
    fn default() -> Self {
        AiState::new(default_resolver())
    }
}

/// Removes a request from the in-flight table when its fetch ends (however it ends).
struct Registration<'a> {
    state: &'a AiState,
    request_id: u32,
}

impl Drop for Registration<'_> {
    fn drop(&mut self) {
        let mut inflight = self.state.inflight.lock().unwrap_or_else(|e| e.into_inner());
        inflight.running.remove(&self.request_id);
    }
}

/// The app's resolver: saved connections plus the keychain.
pub fn app_resolver(connections_file: std::path::PathBuf) -> Arc<dyn ConnectionResolver> {
    Arc::new(connections::FileResolver::new(connections_file, Arc::new(keychain::KeyringStore)))
}

fn default_resolver() -> Arc<dyn ConnectionResolver> {
    Arc::new(NoConnections)
}

// ---- Commands ----------------------------------------------------------------------------------

/// Proxy one provider request (see the module docs). Resolves when the response has ended; every
/// failure is sent as an `error` event and also returned.
#[tauri::command]
pub async fn ai_fetch(
    state: State<'_, AiState>,
    request_id: u32,
    connection_id: String,
    req: AiRequest,
    on_event: Channel<AiFetchEvent>,
) -> Result<(), AiError> {
    state.fetch(request_id, &connection_id, req, |e| on_event.send(e).is_ok()).await
}

/// Abort a request started by `ai_fetch` (also before it has registered).
#[tauri::command]
pub fn ai_fetch_cancel(state: State<'_, AiState>, request_id: u32) {
    state.cancel(request_id);
}

// ---- Secrets and connections (Task 2) ---------------------------------------------------------------

fn connections_file<R: Runtime>(app: &AppHandle<R>) -> Result<std::path::PathBuf, AiError> {
    app.path()
        .app_data_dir()
        .map(|d| d.join(connections::CONNECTIONS_FILE))
        .map_err(|_| AiError::bad_request("The app data folder is not available."))
}

/// Keychain and file I/O block: run them off the async command thread.
async fn blocking<T: Send + 'static>(f: impl FnOnce() -> Result<T, AiError> + Send + 'static) -> Result<T, AiError> {
    tokio::task::spawn_blocking(f)
        .await
        .map_err(|_| AiError::new("not_connected", "The AI connection could not be read."))?
}

/// Store a saved connection's credential in the OS keychain, bound to its provider, auth and origin
/// (save the connection first). There is no command that reads it back.
#[tauri::command]
pub async fn ai_secret_set<R: Runtime>(app: AppHandle<R>, connection_id: String, secret: String) -> Result<(), AiError> {
    let path = connections_file(&app)?;
    blocking(move || connections::set_connection_secret(&path, &keychain::KeyringStore, &connection_id, &secret)).await
}

#[tauri::command]
pub async fn ai_secret_delete(connection_id: String) -> Result<(), AiError> {
    blocking(move || keychain::delete_secret(&keychain::KeyringStore, &connection_id)).await
}

/// True if the keychain holds a credential for the connection.
#[tauri::command]
pub async fn ai_secret_has<R: Runtime>(app: AppHandle<R>, connection_id: String) -> Result<bool, AiError> {
    let path = connections_file(&app)?;
    blocking(move || connections::has_connection_secret(&path, &keychain::KeyringStore, &connection_id)).await
}

#[tauri::command]
pub async fn ai_connections_get<R: Runtime>(app: AppHandle<R>) -> Result<Vec<connections::Connection>, AiError> {
    let path = connections_file(&app)?;
    blocking(move || connections::load_connections(&path)).await
}

/// Validate and replace the saved connections (atomic; see `connections.rs`).
#[tauri::command]
pub async fn ai_connections_save<R: Runtime>(
    app: AppHandle<R>,
    connections: Vec<connections::Connection>,
) -> Result<(), AiError> {
    let path = connections_file(&app)?;
    blocking(move || connections::save_connections(&path, &keychain::KeyringStore, connections)).await
}

/// Add a connection, or replace the saved one with its id; the others stay as they are on disk
/// (Settings edits through this, so it can never drop a connection it has not seen).
#[tauri::command]
pub async fn ai_connection_upsert<R: Runtime>(app: AppHandle<R>, connection: connections::Connection) -> Result<(), AiError> {
    let path = connections_file(&app)?;
    blocking(move || connections::upsert_connection(&path, &keychain::KeyringStore, connection)).await
}

/// Remove one connection and its key; the others stay as they are on disk.
#[tauri::command]
pub async fn ai_connection_remove<R: Runtime>(app: AppHandle<R>, connection_id: String) -> Result<(), AiError> {
    let path = connections_file(&app)?;
    blocking(move || connections::remove_connection(&path, &keychain::KeyringStore, &connection_id)).await
}

// ---- Chat history (Task 8) -------------------------------------------------------------------------

fn history_root<R: Runtime>(app: &AppHandle<R>) -> Result<std::path::PathBuf, AiError> {
    app.path()
        .app_data_dir()
        .map(|d| d.join(history::HISTORY_DIR))
        .map_err(|_| AiError::bad_request("The app data folder is not available."))
}

#[tauri::command]
pub async fn tutor_history_list<R: Runtime>(app: AppHandle<R>, project_id: String) -> Result<Vec<history::ChatSummary>, AiError> {
    let root = history_root(&app)?;
    blocking(move || history::list(&root, &project_id)).await
}

#[tauri::command]
pub async fn tutor_history_load<R: Runtime>(app: AppHandle<R>, project_id: String, chat_id: String) -> Result<history::Chat, AiError> {
    let root = history_root(&app)?;
    blocking(move || history::load(&root, &project_id, &chat_id)).await
}

#[tauri::command]
pub async fn tutor_history_save<R: Runtime>(app: AppHandle<R>, project_id: String, chat: history::Chat) -> Result<(), AiError> {
    let root = history_root(&app)?;
    blocking(move || history::save(&root, &project_id, &chat)).await
}

/// Delete one chat, or all of the project's chats (`chat_id` absent).
#[tauri::command]
pub async fn tutor_history_delete<R: Runtime>(app: AppHandle<R>, project_id: String, chat_id: Option<String>) -> Result<(), AiError> {
    let root = history_root(&app)?;
    blocking(move || history::delete(&root, &project_id, chat_id.as_deref())).await
}

#[tauri::command]
pub async fn tutor_history_clear_all<R: Runtime>(app: AppHandle<R>) -> Result<(), AiError> {
    let root = history_root(&app)?;
    blocking(move || history::clear_all(&root)).await
}
