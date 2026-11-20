//! AI tutor network proxy (Phase 5). `ai_fetch` is the app's only path to the network: the webview's
//! fetch shim (`src/features/ai-tutor/net/tauri-fetch.ts`) sends a method, a path, allowlisted
//! headers and a body; Rust picks the host from the connection's provider, adds the credential
//! itself and streams the response back over a Tauri channel. The CSP stays closed.
//!
//! ## Connection resolver (the seam Task 2 fills)
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
//! runtime with [`AiState::set_resolver`]. Until Task 2, the app's resolver knows no connections
//! (debug builds also accept the spike connection, see `spike_resolver`); tests inject their own.

pub mod fetch;
pub mod providers;

use std::collections::{HashMap, VecDeque};
use std::sync::{Arc, Mutex, RwLock};

use serde::{Deserialize, Serialize};
use tauri::ipc::Channel;
use tauri::State;
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
    #[allow(dead_code)] // Task 2 (keychain) creates secrets; tests do now.
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
}

/// Turns a connection id into its provider, saved base URL and secret (see the module docs).
pub trait ConnectionResolver: Send + Sync + 'static {
    fn resolve(&self, connection_id: &str) -> Result<ResolvedConnection, AiError>;
}

/// The resolver before Task 2: no connection exists.
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

    /// Replace the resolver (Task 2 installs the connections file + keychain resolver).
    #[allow(dead_code)] // Task 2 calls it.
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

fn default_resolver() -> Arc<dyn ConnectionResolver> {
    #[cfg(debug_assertions)]
    if let Some(r) = spike_resolver() {
        return Arc::new(r);
    }
    Arc::new(NoConnections)
}

// ---- Spike (Task 1, debug builds only; removed in Task 9) -----------------------------------------

/// Env var naming an OpenAI-compatible base URL for the spike connection `"spike"` (debug builds).
#[cfg(debug_assertions)]
const SPIKE_BASE_URL_ENV: &str = "NOVEL_AI_SPIKE_BASE_URL";

#[cfg(debug_assertions)]
struct SpikeResolver(String);

#[cfg(debug_assertions)]
impl ConnectionResolver for SpikeResolver {
    fn resolve(&self, connection_id: &str) -> Result<ResolvedConnection, AiError> {
        if connection_id != "spike" {
            return Err(AiError::not_connected());
        }
        let provider = providers::descriptor("custom").ok_or_else(AiError::not_connected)?;
        Ok(ResolvedConnection { provider, base_url: Some(self.0.clone()), secret: None })
    }
}

#[cfg(debug_assertions)]
fn spike_resolver() -> Option<SpikeResolver> {
    std::env::var(SPIKE_BASE_URL_ENV).ok().filter(|v| !v.is_empty()).map(SpikeResolver)
}

/// Debug builds with the spike env var set: true, so the webview runs `__tutorSpike()` at startup.
#[tauri::command]
pub fn ai_spike_autorun() -> bool {
    #[cfg(debug_assertions)]
    return spike_resolver().is_some();
    #[cfg(not(debug_assertions))]
    false
}

/// Debug builds: print one spike result line to the terminal.
#[tauri::command]
pub fn ai_spike_log(line: String) {
    #[cfg(debug_assertions)]
    println!("[tutor-spike] {line}");
    #[cfg(not(debug_assertions))]
    let _ = line;
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
