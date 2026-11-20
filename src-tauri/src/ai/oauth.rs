//! Sign in with OpenRouter: OAuth PKCE with a loopback redirect (design "Network and credentials").
//!
//! `ai_oauth_start("openrouter")` (any provider whose descriptor has a `sign_in`) makes a code verifier and its S256 challenge, binds a one-shot
//! listener on `127.0.0.1` (a random port), and opens the system browser (from Rust; the webview has
//! no open-URL capability) at the descriptor's `sign_in.auth_url` (`providers.rs`) with
//! `callback_url=http://127.0.0.1:<port>/callback`.
//! A random one-time `state` nonce goes with it; OpenRouter returns it unchanged on the callback
//! (ruling R16: a callback without it, or with another, is refused).
//!
//! The listener serves exactly one request, then closes (or gives up after five minutes). That request
//! must be `GET /callback?code=..&state=<nonce>`; anything else ends the sign-in with an error. The
//! code is exchanged here, in Rust (a POST to the descriptor's `sign_in.keys_url` with the verifier),
//! and the key goes straight to the keychain under a new saved connection. The key never reaches the
//! webview: the `ai-oauth-result` event carries `{ ok, connectionId?, error? }` only. Neither the code
//! nor the key appears in any error message or log line.

use std::net::Ipv4Addr;
use std::path::Path;
use std::sync::Mutex;
use std::time::Duration;

use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine as _;
use reqwest::Url;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Runtime, State};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::watch;
use tokio::task::JoinSet;

use super::connections::{self, Connection, ConnectionAuth};
use super::keychain::{SecretStore, MAX_SECRET_BYTES};
use super::{AiError, AiState, Secret};

/// The event the webview listens to for the sign-in's outcome.
pub const RESULT_EVENT: &str = "ai-oauth-result";
/// How long the browser has to come back.
pub const CALLBACK_TIMEOUT: Duration = Duration::from_secs(5 * 60);
/// How long a connection that opened may take to send its request line and headers.
const REQUEST_TIMEOUT: Duration = Duration::from_secs(10);
/// Connections whose request head is still being read at once; more are closed unread.
const MAX_PENDING_CONNECTIONS: usize = 16;
/// The pause after a failed accept before the next one.
const ACCEPT_RETRY: Duration = Duration::from_millis(50);
/// Longest request head read (the callback is one short GET).
const MAX_REQUEST_BYTES: usize = 8 * 1024;
const MAX_CODE_CHARS: usize = 1024;
/// How long the code exchange may take.
const EXCHANGE_TIMEOUT: Duration = Duration::from_secs(30);
const CALLBACK_PATH: &str = "/callback";

/// The page the browser shows after the callback. No script; it only says where to go.
const DONE_PAGE: &str = "<!doctype html><html lang=\"en\"><head><meta charset=\"utf-8\"><title>Novel</title></head>\
<body style=\"font-family:system-ui,sans-serif;margin:3rem;line-height:1.5\"><h1>Return to Novel</h1>\
<p>Novel is finishing the sign-in. You can close this tab and go back to Novel.</p></body></html>";
const FAILED_PAGE: &str = "<!doctype html><html lang=\"en\"><head><meta charset=\"utf-8\"><title>Novel</title></head>\
<body style=\"font-family:system-ui,sans-serif;margin:3rem;line-height:1.5\"><h1>The sign-in did not finish</h1>\
<p>Close this tab, return to Novel and try again.</p></body></html>";

// ---- PKCE -----------------------------------------------------------------------------------------

/// `bytes` random bytes from the OS, base64url without padding.
pub fn random_token(bytes: usize) -> Result<String, AiError> {
    use ring::rand::SecureRandom as _;
    let mut buf = vec![0u8; bytes];
    ring::rand::SystemRandom::new()
        .fill(&mut buf)
        .map_err(|_| AiError::new("auth", "The sign-in could not start: no secure random numbers."))?;
    Ok(URL_SAFE_NO_PAD.encode(buf))
}

/// RFC 7636 S256: base64url(SHA-256(verifier)), no padding.
pub fn challenge_s256(verifier: &str) -> String {
    URL_SAFE_NO_PAD.encode(ring::digest::digest(&ring::digest::SHA256, verifier.as_bytes()))
}

/// A code verifier (32 random bytes: 43 characters, inside RFC 7636's 43..=128) and its challenge.
pub struct Pkce {
    pub verifier: String,
    pub challenge: String,
}

impl std::fmt::Debug for Pkce {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("Pkce(***)")
    }
}

pub fn new_pkce() -> Result<Pkce, AiError> {
    let verifier = random_token(32)?;
    let challenge = challenge_s256(&verifier);
    Ok(Pkce { verifier, challenge })
}

/// The provider's authorization page (`sign_in.auth_url`) for this sign-in.
pub fn auth_url(base: &str, port: u16, challenge: &str, state: &str) -> String {
    let mut url = Url::parse(base).expect("a static https URL from providers.rs");
    url.query_pairs_mut()
        .append_pair("callback_url", &format!("http://127.0.0.1:{port}{CALLBACK_PATH}"))
        .append_pair("code_challenge", challenge)
        .append_pair("code_challenge_method", "S256")
        .append_pair("state", state);
    url.into()
}

// ---- The loopback callback -------------------------------------------------------------------------

fn refused(message: &str) -> AiError {
    AiError::new("auth", message)
}

/// Equal without an early exit (the nonce is compared to what a local caller sent).
fn same(a: &str, b: &str) -> bool {
    a.len() == b.len() && a.bytes().zip(b.bytes()).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

/// The authorization code in a callback request head, if the request is exactly
/// `GET /callback?...` with this sign-in's `state` and one `code`. Errors never contain the code.
pub fn parse_callback(head: &str, nonce: &str) -> Result<String, AiError> {
    let line = head.lines().next().unwrap_or_default();
    let mut parts = line.split(' ');
    let (method, target, version) = (parts.next().unwrap_or_default(), parts.next().unwrap_or_default(), parts.next());
    if method != "GET" || !version.is_some_and(|v| v.starts_with("HTTP/")) || parts.next().is_some() {
        return Err(refused("The sign-in reply was not the one Novel expected. Try again."));
    }
    if !target.starts_with('/') {
        return Err(refused("The sign-in reply was not the one Novel expected. Try again."));
    }
    let url = Url::parse(&format!("http://127.0.0.1{target}"))
        .map_err(|_| refused("The sign-in reply was not the one Novel expected. Try again."))?;
    if url.path() != CALLBACK_PATH {
        return Err(refused("The sign-in reply was not the one Novel expected. Try again."));
    }
    let (mut states, mut codes) = (Vec::new(), Vec::new());
    for (k, v) in url.query_pairs() {
        match k.as_ref() {
            "state" => states.push(v.into_owned()),
            "code" => codes.push(v.into_owned()),
            _ => {}
        }
    }
    // No code at all: the writer denied access (OpenRouter then sends no `state` either, per its OAuth
    // doc), or the page was opened by hand. Refused either way; the parameters are never echoed (M2).
    if codes.is_empty() {
        return Err(refused("OpenRouter did not grant access. Try again if you meant to sign in."));
    }
    if states.len() != 1 || !same(&states[0], nonce) {
        return Err(refused("The sign-in reply did not belong to this sign-in, so Novel ignored it. Try again."));
    }
    match codes.as_slice() {
        [code] if !code.is_empty() && code.chars().count() <= MAX_CODE_CHARS && !code.chars().any(char::is_control) => {
            Ok(code.clone())
        }
        _ => Err(refused("The sign-in reply was not the one Novel expected. Try again.")),
    }
}

/// Read one request head (up to the blank line), bounded in size and time.
async fn read_head(stream: &mut TcpStream) -> Option<String> {
    let mut buf = Vec::with_capacity(1024);
    let mut chunk = [0u8; 1024];
    let read = async {
        loop {
            let n = stream.read(&mut chunk).await.ok()?;
            if n == 0 {
                return None;
            }
            buf.extend_from_slice(&chunk[..n]);
            if buf.windows(4).any(|w| w == b"\r\n\r\n") || buf.windows(2).any(|w| w == b"\n\n") {
                return Some(());
            }
            if buf.len() > MAX_REQUEST_BYTES {
                return Some(());
            }
        }
    };
    tokio::time::timeout(REQUEST_TIMEOUT, read).await.ok()??;
    Some(String::from_utf8_lossy(&buf).into_owned())
}

async fn respond(stream: &mut TcpStream, status: &str, page: &str) {
    let response = format!(
        "HTTP/1.1 {status}\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\n\
Content-Security-Policy: default-src 'none'; style-src 'unsafe-inline'\r\nCache-Control: no-store\r\n\
Referrer-Policy: no-referrer\r\nConnection: close\r\n\r\n{page}",
        page.len()
    );
    let _ = stream.write_all(response.as_bytes()).await;
    let _ = stream.shutdown().await;
}

/// Why a pending sign-in stopped early.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Stop {
    Running,
    /// The writer cancelled (reported).
    Cancelled,
    /// A newer sign-in replaced this one (not reported: the newer one reports).
    Superseded,
}

/// Wait for the one callback request and return its code. The first connection whose request head
/// arrives decides: a valid callback gets the "return to Novel" page, anything else a refusal and an
/// error. Heads are read concurrently (M4), so a connection that sends nothing (a browser preconnect,
/// any local process) cannot hold up the real callback; one that closes or stays silent for
/// `REQUEST_TIMEOUT` simply does not count. The listener, and every connection still being read, is
/// closed when this returns.
pub async fn wait_for_callback(
    listener: TcpListener,
    nonce: &str,
    timeout: Duration,
    mut stop: watch::Receiver<Stop>,
) -> Result<String, AiError> {
    let wait = async {
        let mut pending: JoinSet<Option<(TcpStream, String)>> = JoinSet::new();
        loop {
            tokio::select! {
                accepted = listener.accept() => match accepted {
                    Ok((stream, peer)) => {
                        // More silent connections than this are dropped unread.
                        if peer.ip().is_loopback() && pending.len() < MAX_PENDING_CONNECTIONS {
                            pending.spawn(async move {
                                let mut stream = stream;
                                read_head(&mut stream).await.map(|head| (stream, head))
                            });
                        }
                    }
                    // A persistent accept error (out of file handles) must not spin a core (M3).
                    Err(_) => tokio::time::sleep(ACCEPT_RETRY).await,
                },
                Some(done) = pending.join_next(), if !pending.is_empty() => {
                    let Ok(Some((mut stream, head))) = done else { continue };
                    return match parse_callback(&head, nonce) {
                        Ok(code) => {
                            respond(&mut stream, "200 OK", DONE_PAGE).await;
                            Ok(code)
                        }
                        Err(e) => {
                            let status = if head.starts_with("GET ") { "400 Bad Request" } else { "405 Method Not Allowed" };
                            respond(&mut stream, status, FAILED_PAGE).await;
                            Err(e)
                        }
                    };
                }
            }
        }
    };
    let stopped = async {
        loop {
            if *stop.borrow_and_update() != Stop::Running {
                return *stop.borrow();
            }
            if stop.changed().await.is_err() {
                // Nobody can stop it any more: wait for the timeout.
                std::future::pending::<()>().await;
            }
        }
    };
    tokio::select! {
        r = tokio::time::timeout(timeout, wait) => r.unwrap_or_else(|_| Err(refused("The sign-in timed out. Try again."))),
        s = stopped => Err(stop_error(s)),
    }
}

fn stop_error(s: Stop) -> AiError {
    match s {
        Stop::Superseded => AiError::new("superseded", "A newer sign-in replaced this one."),
        _ => AiError::cancelled(),
    }
}

/// Ok while the sign-in is still wanted. Checked again after the code exchange, so Cancel Sign-in
/// pressed while the browser had already come back still adds nothing (M1).
pub fn still_wanted(stop: &watch::Receiver<Stop>) -> Result<(), AiError> {
    match *stop.borrow() {
        Stop::Running => Ok(()),
        s => Err(stop_error(s)),
    }
}

// ---- The code exchange -------------------------------------------------------------------------------

#[derive(Deserialize)]
struct KeyReply {
    key: Option<String>,
}

/// Trade the code (and the verifier) for the user's API key. Errors say what failed, never the code,
/// the verifier or a body that could echo them.
pub async fn exchange_code(client: &reqwest::Client, url: &str, code: &str, verifier: &str) -> Result<Secret, AiError> {
    let body = serde_json::json!({ "code": code, "code_verifier": verifier, "code_challenge_method": "S256" });
    let send = client.post(url).header("content-type", "application/json").body(body.to_string()).send();
    let res = tokio::time::timeout(EXCHANGE_TIMEOUT, send)
        .await
        .map_err(|_| AiError::new("network", "OpenRouter did not answer in time. Try again."))?
        .map_err(|_| AiError::new("network", "Novel could not reach OpenRouter. Check your connection and try again."))?;
    let status = res.status();
    if !status.is_success() {
        return Err(AiError::new("auth", format!("OpenRouter refused the sign-in (HTTP {}). Try again.", status.as_u16())));
    }
    let bytes = tokio::time::timeout(EXCHANGE_TIMEOUT, res.bytes())
        .await
        .map_err(|_| AiError::new("network", "OpenRouter did not answer in time. Try again."))?
        .map_err(|_| AiError::new("network", "The answer from OpenRouter was cut off. Try again."))?;
    let reply: KeyReply =
        serde_json::from_slice(&bytes).map_err(|_| AiError::new("provider", "OpenRouter's answer could not be read. Try again."))?;
    match reply.key {
        Some(k) if !k.trim().is_empty() && k.len() <= MAX_SECRET_BYTES / 2 && !k.chars().any(char::is_control) => Ok(Secret::new(k)),
        _ => Err(AiError::new("provider", "OpenRouter's answer had no usable key. Try again.")),
    }
}

// ---- Saving the signed-in connection -------------------------------------------------------------------

/// A label not used yet: `name`, else "`name` 2", ...
fn free_label(list: &[Connection], name: &str) -> String {
    let taken = |l: &str| list.iter().any(|c| c.label == l);
    if !taken(name) {
        return name.into();
    }
    (2..).map(|n| format!("{name} {n}")).find(|l| !taken(l)).expect("unbounded")
}

/// Add a connection of `provider` signed in with OAuth and store `key` for it. Returns its id. If the
/// key cannot be stored, the connection is taken out again.
pub fn save_signed_in(path: &Path, secrets: &dyn SecretStore, provider: &str, name: &str, key: &Secret) -> Result<String, AiError> {
    // One load-modify-write with the key stored inside it: no webview save can interleave (I1).
    let _lock = connections::write_lock();
    let mut list = connections::load_connections(path)?;
    let id = loop {
        let id = format!("{provider}-{}", random_token(9)?.replace(['-', '_'], "x"));
        if !list.iter().any(|c| c.id == id) {
            break id;
        }
    };
    list.push(Connection {
        id: id.clone(),
        provider: provider.into(),
        label: free_label(&list, name),
        auth: ConnectionAuth::Oauth,
        base_url: None,
        default_model: None,
        tool_support: None,
        insecure_http_accepted: None,
        extra: Default::default(),
    });
    connections::save_locked(path, secrets, list)?;
    if let Err(e) = connections::set_connection_secret(path, secrets, &id, key.expose()) {
        let rest: Vec<Connection> = connections::load_connections(path)?.into_iter().filter(|c| c.id != id).collect();
        let _ = connections::save_locked(path, secrets, rest);
        return Err(e);
    }
    Ok(id)
}

// ---- Commands --------------------------------------------------------------------------------------

/// What the webview hears (`ai-oauth-result`). Never a key or a code.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct OauthResult {
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub connection_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

/// The sign-in in progress, if any (one at a time: a new one replaces it).
#[derive(Default)]
pub struct OauthState {
    pending: Mutex<Option<(u64, watch::Sender<Stop>)>>,
    next: Mutex<u64>,
}

impl OauthState {
    fn begin(&self) -> (u64, watch::Receiver<Stop>) {
        let id = {
            let mut n = self.next.lock().unwrap_or_else(|e| e.into_inner());
            *n += 1;
            *n
        };
        let (tx, rx) = watch::channel(Stop::Running);
        if let Some((_, old)) = self.pending.lock().unwrap_or_else(|e| e.into_inner()).replace((id, tx)) {
            let _ = old.send(Stop::Superseded);
        }
        (id, rx)
    }

    fn cancel(&self) {
        if let Some((_, tx)) = self.pending.lock().unwrap_or_else(|e| e.into_inner()).take() {
            let _ = tx.send(Stop::Cancelled);
        }
    }

    fn finish(&self, id: u64) {
        let mut pending = self.pending.lock().unwrap_or_else(|e| e.into_inner());
        if pending.as_ref().is_some_and(|(p, _)| *p == id) {
            *pending = None;
        }
    }
}

/// Open an https page in the system browser.
fn open_in_browser(url: &str) -> Result<(), AiError> {
    if !url.starts_with("https://") {
        return Err(AiError::bad_request("Only https pages are opened."));
    }
    open::that_detached(url).map_err(|_| AiError::new("network", "Novel could not open your web browser."))
}

/// Start "Sign in with OpenRouter": open the browser and wait (in the background) for the callback.
/// Resolves once the browser was asked to open; the outcome arrives as the `ai-oauth-result` event.
#[tauri::command]
pub async fn ai_oauth_start<R: Runtime>(
    app: AppHandle<R>,
    ai: State<'_, AiState>,
    oauth: State<'_, OauthState>,
    provider: String,
) -> Result<(), AiError> {
    let sign_in = super::providers::descriptor(&provider)
        .and_then(|d| d.sign_in)
        .ok_or_else(|| AiError::bad_request("This provider has no sign-in."))?;
    let path = super::connections_file(&app)?;
    let pkce = new_pkce()?;
    let nonce = random_token(16)?;
    let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0))
        .await
        .map_err(|_| AiError::new("network", "The sign-in could not start: no local port is free."))?;
    let port = listener.local_addr().map_err(|_| AiError::new("network", "The sign-in could not start."))?.port();
    let (id, stop) = oauth.begin();
    if let Err(e) = open_in_browser(&auth_url(sign_in.auth_url, port, &pkce.challenge, &nonce)) {
        oauth.finish(id);
        return Err(e);
    }
    let client = ai.http_client();
    let app2 = app.clone();
    tauri::async_runtime::spawn(async move {
        let outcome = async {
            let wanted = stop.clone();
            let code = wait_for_callback(listener, &nonce, CALLBACK_TIMEOUT, stop).await?;
            let key = exchange_code(&client, sign_in.keys_url, &code, &pkce.verifier).await?;
            // Cancelled (or replaced) during the exchange: the key is dropped, nothing is saved (M1).
            still_wanted(&wanted)?;
            super::blocking(move || save_signed_in(&path, &super::keychain::KeyringStore, &provider, sign_in.name, &key)).await
        }
        .await;
        use tauri::Manager as _;
        app2.state::<OauthState>().finish(id);
        let result = match outcome {
            Ok(connection_id) => OauthResult { ok: true, connection_id: Some(connection_id), error: None },
            Err(e) if e.kind == "superseded" => return,
            Err(e) => OauthResult { ok: false, connection_id: None, error: Some(e.message) },
        };
        let _ = app2.emit(RESULT_EVENT, result);
    });
    Ok(())
}

/// Stop a sign-in that is waiting for the browser (it reports `ok: false`, cancelled).
#[tauri::command]
pub fn ai_oauth_cancel(oauth: State<'_, OauthState>) {
    oauth.cancel();
}

/// Open the provider's "create an API key" page (the allowlisted `key_url` in `providers.rs`).
#[tauri::command]
pub fn ai_open_key_page(provider: String) -> Result<(), AiError> {
    let url = super::providers::descriptor(&provider)
        .and_then(|d| d.key_url)
        .ok_or_else(|| AiError::bad_request("This provider has no key page."))?;
    open_in_browser(url)
}

#[cfg(test)]
mod tests {
    use super::super::keychain::testing::MemoryStore;
    use super::*;

    #[test]
    fn pkce_challenge_is_s256() {
        // RFC 7636, Appendix B (also checked with Python hashlib).
        assert_eq!(challenge_s256("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"), "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM");
        let p = new_pkce().unwrap();
        assert_eq!(p.verifier.len(), 43);
        assert!(p.verifier.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_'));
        assert_eq!(p.challenge, challenge_s256(&p.verifier));
        assert_ne!(new_pkce().unwrap().verifier, p.verifier);
        assert_eq!(format!("{p:?}"), "Pkce(***)");
    }

    #[test]
    fn auth_url_names_the_loopback_callback_and_the_challenge() {
        let base = super::super::providers::descriptor("openrouter").unwrap().sign_in.unwrap().auth_url;
        let url = Url::parse(&auth_url(base, 51423, "CHAL", "NONCE")).unwrap();
        assert_eq!(url.origin().ascii_serialization(), "https://openrouter.ai");
        assert_eq!(url.path(), "/auth");
        let q: Vec<(String, String)> = url.query_pairs().map(|(k, v)| (k.into_owned(), v.into_owned())).collect();
        assert_eq!(
            q,
            [
                ("callback_url".into(), "http://127.0.0.1:51423/callback".into()),
                ("code_challenge".into(), "CHAL".into()),
                ("code_challenge_method".into(), "S256".into()),
                ("state".into(), "NONCE".into()),
            ]
        );
    }

    const GOOD: &str = "GET /callback?code=the-code&state=n0nce HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n";

    #[test]
    fn callback_parsing() {
        assert_eq!(parse_callback(GOOD, "n0nce").unwrap(), "the-code");
        // OpenRouter may order the parameters either way.
        assert_eq!(parse_callback("GET /callback?state=n0nce&code=c2 HTTP/1.1\r\n\r\n", "n0nce").unwrap(), "c2");
        for (head, why) in [
            ("POST /callback?code=c&state=n0nce HTTP/1.1\r\n\r\n", "not a GET"),
            ("GET /other?code=c&state=n0nce HTTP/1.1\r\n\r\n", "another path"),
            ("GET /callback/x?code=c&state=n0nce HTTP/1.1\r\n\r\n", "a sub path"),
            ("GET /favicon.ico HTTP/1.1\r\n\r\n", "favicon"),
            ("GET /callback?code=c HTTP/1.1\r\n\r\n", "no state"),
            ("GET /callback?code=c&state=n0nce&state=n0nce HTTP/1.1\r\n\r\n", "two states"),
            ("GET /callback?state=n0nce HTTP/1.1\r\n\r\n", "no code (denied)"),
            ("GET /callback?code=&state=n0nce HTTP/1.1\r\n\r\n", "empty code"),
            ("GET /callback?code=a&code=b&state=n0nce HTTP/1.1\r\n\r\n", "two codes"),
            ("GET http://evil.example/callback?code=c&state=n0nce HTTP/1.1\r\n\r\n", "absolute target"),
            ("garbage", "not HTTP"),
            ("", "empty"),
        ] {
            assert!(parse_callback(head, "n0nce").is_err(), "{why}");
        }
    }

    #[test]
    fn a_denial_says_access_was_not_granted() {
        // OpenRouter sends no `state` when the writer denies access (its OAuth doc).
        for head in ["GET /callback?error=access_denied HTTP/1.1



", "GET /callback HTTP/1.1



", "GET /callback?state=n0nce HTTP/1.1



"] {
            let e = parse_callback(head, "n0nce").unwrap_err();
            assert!(e.message.contains("did not grant access"), "{head}: {}", e.message);
            assert!(!e.message.contains("access_denied"));
        }
        // A code with the wrong state is still the foreign-reply message.
        assert!(parse_callback("GET /callback?code=c&state=x HTTP/1.1



", "n0nce").unwrap_err().message.contains("did not belong"));
    }

    #[test]
    fn a_cancel_after_the_callback_still_stops_the_save() {
        let (tx, rx) = running();
        assert!(still_wanted(&rx).is_ok());
        tx.send(Stop::Cancelled).unwrap();
        assert_eq!(still_wanted(&rx).unwrap_err().kind, "cancelled");
        let (tx, rx) = running();
        tx.send(Stop::Superseded).unwrap();
        assert_eq!(still_wanted(&rx).unwrap_err().kind, "superseded");
    }

    #[tokio::test]
    async fn an_idle_connection_does_not_hold_up_the_callback() {
        let (l, port) = listener().await;
        let (_tx, rx) = running();
        let wait = tokio::spawn(async move { wait_for_callback(l, "n0nce", Duration::from_secs(30), rx).await });
        // A preconnect that never sends anything, kept open.
        let _idle = TcpStream::connect((Ipv4Addr::LOCALHOST, port)).await.unwrap();
        let started = std::time::Instant::now();
        let page = send(port, GOOD).await;
        assert!(page.starts_with("HTTP/1.1 200"), "{page}");
        assert_eq!(wait.await.unwrap().unwrap(), "the-code");
        assert!(started.elapsed() < Duration::from_secs(3), "waited {:?}", started.elapsed());
    }

    #[test]
    fn callback_errors_never_contain_the_code() {
        for head in [
            "GET /callback?code=SECRET-CODE&state=wrong HTTP/1.1\r\n\r\n",
            "GET /nope?code=SECRET-CODE&state=n0nce HTTP/1.1\r\n\r\n",
            "PUT /callback?code=SECRET-CODE&state=n0nce HTTP/1.1\r\n\r\n",
        ] {
            let e = parse_callback(head, "n0nce").unwrap_err();
            assert!(!e.message.contains("SECRET-CODE") && !format!("{e:?}").contains("SECRET-CODE"));
        }
    }

    async fn listener() -> (TcpListener, u16) {
        let l = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).await.unwrap();
        let port = l.local_addr().unwrap().port();
        (l, port)
    }

    /// Send one raw request and return the response text.
    async fn send(port: u16, request: &str) -> String {
        let mut s = TcpStream::connect((Ipv4Addr::LOCALHOST, port)).await.unwrap();
        s.write_all(request.as_bytes()).await.unwrap();
        let mut out = String::new();
        let _ = s.read_to_string(&mut out).await;
        out
    }

    fn running() -> (watch::Sender<Stop>, watch::Receiver<Stop>) {
        watch::channel(Stop::Running)
    }

    #[tokio::test]
    async fn callback_rejects_state_mismatch() {
        let (l, port) = listener().await;
        let (_tx, rx) = running();
        let wait = tokio::spawn(async move { wait_for_callback(l, "right-nonce", Duration::from_secs(5), rx).await });
        let page = send(port, "GET /callback?code=c&state=wrong-nonce HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n").await;
        assert!(page.starts_with("HTTP/1.1 400"), "{page}");
        assert!(!page.contains("<script"));
        let err = wait.await.unwrap().unwrap_err();
        assert_eq!(err.kind, "auth");
        // Served one request, then closed: a second (even a valid one) finds nobody listening.
        assert!(TcpStream::connect((Ipv4Addr::LOCALHOST, port)).await.is_err());
    }

    #[tokio::test]
    async fn callback_accepts_one_valid_request_then_closes() {
        let (l, port) = listener().await;
        let (_tx, rx) = running();
        let wait = tokio::spawn(async move { wait_for_callback(l, "n0nce", Duration::from_secs(5), rx).await });
        // A connection that sends nothing and closes is not the callback.
        drop(TcpStream::connect((Ipv4Addr::LOCALHOST, port)).await.unwrap());
        let page = send(port, GOOD).await;
        assert!(page.starts_with("HTTP/1.1 200"), "{page}");
        assert!(page.contains("Return to Novel") && !page.contains("<script"));
        assert!(page.contains("Content-Security-Policy: default-src 'none'"));
        assert_eq!(wait.await.unwrap().unwrap(), "the-code");
        assert!(TcpStream::connect((Ipv4Addr::LOCALHOST, port)).await.is_err());
    }

    #[tokio::test]
    async fn callback_rejects_post_and_other_paths() {
        for req in ["POST /callback?code=c&state=n0nce HTTP/1.1\r\nContent-Length: 0\r\n\r\n", "GET /other?code=c&state=n0nce HTTP/1.1\r\n\r\n"] {
            let (l, port) = listener().await;
            let (_tx, rx) = running();
            let wait = tokio::spawn(async move { wait_for_callback(l, "n0nce", Duration::from_secs(5), rx).await });
            let page = send(port, req).await;
            assert!(page.starts_with("HTTP/1.1 4"), "{page}");
            assert!(wait.await.unwrap().is_err(), "{req}");
        }
    }

    #[tokio::test]
    async fn callback_times_out_and_can_be_cancelled() {
        let (l, _) = listener().await;
        let (_tx, rx) = running();
        let err = wait_for_callback(l, "n", Duration::from_millis(50), rx).await.unwrap_err();
        assert!(err.message.contains("timed out"));

        let (l, _) = listener().await;
        let (tx, rx) = running();
        let wait = tokio::spawn(async move { wait_for_callback(l, "n", Duration::from_secs(5), rx).await });
        tx.send(Stop::Cancelled).unwrap();
        assert_eq!(wait.await.unwrap().unwrap_err().kind, "cancelled");

        let (l, _) = listener().await;
        let (tx, rx) = running();
        let wait = tokio::spawn(async move { wait_for_callback(l, "n", Duration::from_secs(5), rx).await });
        tx.send(Stop::Superseded).unwrap();
        assert_eq!(wait.await.unwrap().unwrap_err().kind, "superseded");
    }

    #[test]
    fn a_new_sign_in_supersedes_the_pending_one() {
        let s = OauthState::default();
        let (a, rx_a) = s.begin();
        let (b, rx_b) = s.begin();
        assert_eq!(*rx_a.borrow(), Stop::Superseded);
        assert_eq!(*rx_b.borrow(), Stop::Running);
        s.finish(a); // an old flow ending does not clear the new one
        s.cancel();
        assert_eq!(*rx_b.borrow(), Stop::Cancelled);
        s.finish(b);
    }

    /// A one-request HTTP server answering `status` and `body`; returns its URL and the request it saw.
    async fn mock_server(status: &'static str, body: &'static str) -> (String, tokio::task::JoinHandle<String>) {
        let (l, port) = listener().await;
        let task = tokio::spawn(async move {
            let (mut s, _) = l.accept().await.unwrap();
            let mut buf = vec![0u8; 16 * 1024];
            let mut seen = Vec::new();
            loop {
                let n = s.read(&mut buf).await.unwrap();
                seen.extend_from_slice(&buf[..n]);
                let text = String::from_utf8_lossy(&seen);
                if let Some(i) = text.find("\r\n\r\n") {
                    let len = text[..i]
                        .lines()
                        .find_map(|l| l.to_ascii_lowercase().strip_prefix("content-length:").map(|v| v.trim().parse::<usize>().unwrap()))
                        .unwrap_or(0);
                    if seen.len() >= i + 4 + len || n == 0 {
                        break;
                    }
                }
            }
            let reply = format!("HTTP/1.1 {status}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len());
            s.write_all(reply.as_bytes()).await.unwrap();
            String::from_utf8_lossy(&seen).into_owned()
        });
        (format!("http://127.0.0.1:{port}/api/v1/auth/keys"), task)
    }

    #[tokio::test]
    async fn exchange_posts_code_and_verifier_and_returns_the_key() {
        let (url, seen) = mock_server("200 OK", r#"{"key":"sk-or-v1-abc","user_id":"u"}"#).await;
        let key = exchange_code(&super::super::fetch::client(), &url, "the-code", "the-verifier").await.unwrap();
        assert_eq!(key.expose(), "sk-or-v1-abc");
        let request = seen.await.unwrap();
        assert!(request.starts_with("POST /api/v1/auth/keys "));
        let body: serde_json::Value = serde_json::from_str(request.split("\r\n\r\n").nth(1).unwrap()).unwrap();
        assert_eq!(body, serde_json::json!({ "code": "the-code", "code_verifier": "the-verifier", "code_challenge_method": "S256" }));
    }

    #[tokio::test]
    async fn exchange_errors_never_contain_the_code_or_the_body() {
        for (status, body) in [("403 Forbidden", r#"{"error":"bad code SECRET-CODE"}"#), ("200 OK", r#"{"nope":"SECRET-CODE"}"#), ("200 OK", "SECRET-CODE")] {
            let (url, _) = mock_server(status, body).await;
            let e = exchange_code(&super::super::fetch::client(), &url, "SECRET-CODE", "SECRET-VERIFIER").await.unwrap_err();
            for s in ["SECRET-CODE", "SECRET-VERIFIER"] {
                assert!(!e.message.contains(s) && !format!("{e:?}").contains(s), "{status}: {}", e.message);
            }
        }
    }

    #[test]
    fn signed_in_key_goes_to_the_keychain_not_the_file() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join(connections::CONNECTIONS_FILE);
        let secrets = MemoryStore::default();
        let a = save_signed_in(&path, &secrets, "openrouter", "OpenRouter", &Secret::new("sk-or-TOP-SECRET")).unwrap();
        let b = save_signed_in(&path, &secrets, "openrouter", "OpenRouter", &Secret::new("sk-or-OTHER")).unwrap();
        assert_ne!(a, b);
        let list = connections::load_connections(&path).unwrap();
        assert_eq!(list.iter().map(|c| c.label.as_str()).collect::<Vec<_>>(), ["OpenRouter", "OpenRouter 2"]);
        assert!(list.iter().all(|c| c.provider == "openrouter" && c.auth == ConnectionAuth::Oauth));
        let text = std::fs::read_to_string(&path).unwrap();
        assert!(!text.contains("TOP-SECRET") && !text.contains("sk-or-OTHER"));
        assert!(connections::has_connection_secret(&path, &secrets, &a).unwrap());
        let resolver = connections::FileResolver::new(path.clone(), std::sync::Arc::new(secrets));
        use super::super::ConnectionResolver as _;
        assert_eq!(resolver.resolve(&a).unwrap().secret.unwrap().expose(), "sk-or-TOP-SECRET");
    }
}
