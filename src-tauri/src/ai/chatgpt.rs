//! Sign in with ChatGPT: the user's ChatGPT plan for the tutor, through OpenAI's documented flow for
//! open-source, locally run apps (read 2026-11-19; docs/research/chatgpt-sign-in.md):
//! https://developers.openai.com/siwc/token-sharing-open-source and its pages "Registration and
//! sign-in", "Accounts and sessions", "Token reference" and "Errors and recovery".
//!
//! Novel registers as itself. A first sign-in sends the documented registration entrypoint
//! (`client_id=dynamic_agent_client`) with `agent_name_hint=Novel` and this computer's host id;
//! OpenAI registers a client for that user and returns its own `client_id` on the callback. Novel never
//! uses another app's client id and never calls ChatGPT's backend endpoints: inference goes to the
//! public Responses API (the descriptor's `base_url`).
//!
//! - **Host id.** One per installation: `urn:uuid:<v4>` in `chatgpt-host.json` in the app data dir,
//!   made before the first sign-in and reused (an opaque identifier, not a secret or a credential).
//! - **The flow.** PKCE (S256), a fresh `state` and OIDC `nonce`, the loopback listener of `oauth.rs` on
//!   `127.0.0.1:<random port>/auth/callback`, the system browser opened from Rust. The code is exchanged
//!   here; the ID token's RS256 signature is checked against OpenAI's JWKS, with its issuer, audience
//!   (the issued client id), expiry and nonce. The plan scope must have been granted.
//! - **Storage.** The tokens, the issued client id and the account (`sub`, email) are one JSON record,
//!   the connection's secret in the OS keychain (split over entries when long, `keychain.rs`). Nothing
//!   of it reaches the webview, a file, a log line or an error message.
//! - **Use.** `ai_fetch` calls [`with_access_token`]: within five minutes of expiry the token is
//!   refreshed first (one refresh at a time; the rotating refresh token is replaced with the rest), and
//!   the access token goes out as `Authorization: Bearer`.
//! - **Sign out.** Removing the connection revokes the refresh token at OpenAI ([`revoke`]) and then
//!   deletes the record.
//! - **Sign in again.** For a saved connection the authorization reuses its issued client id (with
//!   `id_token_hint` and `login_hint`), and the new tokens replace the old only for the same account.
//! - **Known accounts.** OpenAI asks apps to keep the account/client mapping across sign-out and a
//!   declined plan scope, and to reuse the issued client id rather than register again. `chatgpt-host.json`
//!   (no secret: a public client's id, the account's `sub` and email) lists each account Novel registered,
//!   with the connection that uses it. Remove keeps the entry; Continue with ChatGPT reuses the one known
//!   account that has no connection (with `prompt=consent` if the plan was declined last time).

use std::net::Ipv4Addr;
use std::path::{Path, PathBuf};
use std::collections::BTreeMap;
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine as _;
use reqwest::Url;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::{AppHandle, Manager, Runtime};
use tokio::net::TcpListener;

use super::connections::{self, Connection};
use super::keychain::{KeyringStore, SecretStore};
use super::oauth::{self, OauthState, CALLBACK_TIMEOUT};
use super::providers::{self, PlanSignIn};
use super::{AiError, ConnectionResolver, ResolvedConnection, Secret};

/// The host id file in the app data dir.
pub const HOST_FILE: &str = "chatgpt-host.json";
/// How long a token request (exchange, refresh, keys, revoke) may take.
const REQUEST_TIMEOUT: Duration = Duration::from_secs(30);
/// Refresh when the access token has less than this left.
const REFRESH_MARGIN_SECS: i64 = 5 * 60;
/// Allowed clock difference when checking the ID token's expiry.
const CLOCK_SKEW_SECS: i64 = 60;
/// Longest token, client id or code accepted (sanity bound).
const MAX_TOKEN_CHARS: usize = 8 * 1024;
const MAX_ID_CHARS: usize = 256;
const MAX_CODE_CHARS: usize = 2048;
/// Longest response body read from a token endpoint.
const MAX_BODY_BYTES: usize = 64 * 1024;

fn now_secs() -> i64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs() as i64).unwrap_or(0)
}

fn token_ok(s: &str, max: usize) -> bool {
    !s.is_empty() && s.len() <= max && s.bytes().all(|b| b.is_ascii_graphic())
}

// ---- The host id ------------------------------------------------------------------------------------

#[derive(Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct HostFile {
    version: u32,
    host_id: String,
    #[serde(default)]
    accounts: Vec<KnownAccount>,
}

/// An account Novel registered a client for (`chatgpt-host.json`; nothing here is a secret).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct KnownAccount {
    pub sub: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub email: Option<String>,
    /// The client OpenAI issued for this account (a public client's id, not a credential).
    pub client_id: String,
    /// The saved connection that uses it; `None` after Remove or a declined plan scope.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub connection_id: Option<String>,
    /// The last sign-in declined the plan scope: the next one asks for consent again.
    #[serde(default)]
    pub plan_declined: bool,
    /// The last reuse came back with another account: the next new sign-in registers instead.
    #[serde(default)]
    pub skip: bool,
}

/// A random UUID (version 4) as `urn:uuid:...`, from the OS's secure random numbers.
pub fn new_host_id() -> Result<String, AiError> {
    use ring::rand::SecureRandom as _;
    let mut b = [0u8; 16];
    ring::rand::SystemRandom::new()
        .fill(&mut b)
        .map_err(|_| AiError::new("auth", "The sign-in could not start: no secure random numbers."))?;
    b[6] = (b[6] & 0x0f) | 0x40;
    b[8] = (b[8] & 0x3f) | 0x80;
    let h: String = b.iter().map(|x| format!("{x:02x}")).collect();
    Ok(format!("urn:uuid:{}-{}-{}-{}-{}", &h[0..8], &h[8..12], &h[12..16], &h[16..20], &h[20..32]))
}

fn host_id_ok(id: &str) -> bool {
    let Some(u) = id.strip_prefix("urn:uuid:") else { return false };
    u.len() == 36
        && u.char_indices().all(|(i, c)| if [8, 13, 18, 23].contains(&i) { c == '-' } else { c.is_ascii_hexdigit() && !c.is_ascii_uppercase() })
}

static HOST: Mutex<()> = Mutex::new(());

/// The host file as saved, or a new one (a new host id) when it is missing or damaged. Call under `HOST`.
fn load_host(path: &Path) -> Result<HostFile, AiError> {
    if let Ok(text) = std::fs::read_to_string(path) {
        if let Ok(f) = serde_json::from_str::<HostFile>(&text) {
            if f.version == 1 && host_id_ok(&f.host_id) {
                return Ok(f);
            }
        }
    }
    let f = HostFile { version: 1, host_id: new_host_id()?, accounts: Vec::new() };
    save_host(path, &f)?;
    Ok(f)
}

fn save_host(path: &Path, f: &HostFile) -> Result<(), AiError> {
    let text = serde_json::to_string_pretty(f).map_err(|_| AiError::bad_request("The sign-in could not start."))?;
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(|_| AiError::bad_request("The app data folder could not be created."))?;
    }
    crate::storage::write_atomic(path, text.as_bytes()).map_err(|_| AiError::bad_request("The ChatGPT host file could not be saved."))
}

/// This installation's host id: the saved one, else a new one, saved before it is first used.
pub fn host_id(path: &Path) -> Result<String, AiError> {
    let _lock = HOST.lock().unwrap_or_else(|e| e.into_inner());
    Ok(load_host(path)?.host_id)
}

/// Record (or update, by `sub`) an account and its issued client id.
pub fn remember_account(path: &Path, account: KnownAccount) -> Result<(), AiError> {
    let _lock = HOST.lock().unwrap_or_else(|e| e.into_inner());
    let mut f = load_host(path)?;
    // One connection per entry: a connection id moves with the account that now uses it.
    if let Some(c) = &account.connection_id {
        for a in f.accounts.iter_mut().filter(|a| a.sub != account.sub && a.connection_id.as_deref() == Some(c)) {
            a.connection_id = None;
        }
    }
    match f.accounts.iter_mut().find(|a| a.sub == account.sub) {
        Some(a) => *a = account,
        None => f.accounts.push(account),
    }
    save_host(path, &f)
}

/// A connection was removed: its account stays known, without a connection.
pub fn forget_connection(path: &Path, connection_id: &str) -> Result<(), AiError> {
    let _lock = HOST.lock().unwrap_or_else(|e| e.into_inner());
    let mut f = load_host(path)?;
    let mut changed = false;
    for a in f.accounts.iter_mut().filter(|a| a.connection_id.as_deref() == Some(connection_id)) {
        a.connection_id = None;
        changed = true;
    }
    if changed {
        save_host(path, &f)?;
    }
    Ok(())
}

fn skip_account(path: &Path, sub: &str) -> Result<(), AiError> {
    let _lock = HOST.lock().unwrap_or_else(|e| e.into_inner());
    let mut f = load_host(path)?;
    if let Some(a) = f.accounts.iter_mut().find(|a| a.sub == sub) {
        a.skip = true;
        save_host(path, &f)?;
    }
    Ok(())
}

/// The account a new sign-in should reuse: the one known account without a live connection (`live`:
/// the ids of the saved connections). None when there is no such account, or more than one.
pub fn reusable_account(path: &Path, live: &[String]) -> Result<Option<KnownAccount>, AiError> {
    let _lock = HOST.lock().unwrap_or_else(|e| e.into_inner());
    let f = load_host(path)?;
    let free: Vec<&KnownAccount> =
        f.accounts.iter().filter(|a| !a.skip && a.connection_id.as_ref().is_none_or(|c| !live.contains(c))).collect();
    Ok(match free.as_slice() {
        [one] => Some((*one).clone()),
        _ => None,
    })
}

// ---- The authorization request -----------------------------------------------------------------------

/// What a sign-in with a saved issued client id sends and checks: a saved connection's renewal, or a
/// known account without a connection (`connection_id` None).
#[derive(Clone)]
pub struct Reauth {
    pub connection_id: Option<String>,
    pub client_id: String,
    /// The account the connection belongs to: the new tokens must be for it.
    pub sub: String,
    pub id_token_hint: Option<String>,
    pub login_hint: Option<String>,
    /// Ask for consent again (the plan scope was declined last time; `prompt=consent`).
    pub prompt_consent: bool,
}

pub fn redirect_uri(plan: &PlanSignIn, port: u16) -> String {
    format!("http://127.0.0.1:{port}{}", plan.callback_path)
}

/// The authorization page for this sign-in (a first registration, or `reauth`).
pub fn authorize_url(plan: &PlanSignIn, port: u16, challenge: &str, state: &str, nonce: &str, host_id: &str, reauth: Option<&Reauth>) -> String {
    let mut url = Url::parse(plan.authorize_url).expect("a static https URL from providers.rs");
    {
        let mut q = url.query_pairs_mut();
        match reauth {
            None => {
                q.append_pair("client_id", plan.register_client);
                q.append_pair("agent_name_hint", plan.agent_name);
            }
            Some(r) => {
                q.append_pair("client_id", &r.client_id);
            }
        }
        q.append_pair("ext_agent_host_id", host_id);
        if let Some(r) = reauth {
            if let Some(h) = &r.id_token_hint {
                q.append_pair("id_token_hint", h);
            }
            if let Some(h) = &r.login_hint {
                q.append_pair("login_hint", h);
            }
            if r.prompt_consent {
                q.append_pair("prompt", "consent");
            }
        }
        q.append_pair("response_type", "code")
            .append_pair("redirect_uri", &redirect_uri(plan, port))
            .append_pair("scope", plan.scopes)
            .append_pair("resource", plan.resource)
            .append_pair("state", state)
            .append_pair("nonce", nonce)
            .append_pair("code_challenge_method", "S256")
            .append_pair("code_challenge", challenge);
    }
    url.into()
}

// ---- The callback ------------------------------------------------------------------------------------

/// What the browser brought back.
pub struct Callback {
    pub code: String,
    /// The issued client id (a first registration's, or the saved one on a renewal).
    pub client_id: String,
}

impl std::fmt::Debug for Callback {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("Callback(***)")
    }
}

const NOT_EXPECTED: &str = "The sign-in reply was not the one Novel expected. Try again.";
/// Error kinds of a sign-in (they reach the webview only as the message): the writer said no, or OpenAI
/// no longer knows the client id Novel sent.
pub const DENIED: &str = "denied";
pub const INVALID_CLIENT: &str = "invalid_client";
/// OpenAI answered this sign-in (after the `state` check) with a refusal other than the two above: an
/// `error` on the callback, another client id, or an OAuth error body from the token endpoint.
pub const OPENAI_REFUSED: &str = "openai_refused";
const STALE_CLIENT: &str = "ChatGPT no longer knows the registration Novel saved for this account, so Novel forgot it. Continue with ChatGPT again to sign in.";

/// The code and client id in a callback request head: exactly `GET <callback_path>?...` with this
/// sign-in's `state`, one code, and (on a first registration) the issued client id. On a renewal a
/// client id other than the saved one is refused. Errors never contain the code or the parameters.
pub fn parse_callback(head: &str, plan: &PlanSignIn, state: &str, saved_client: Option<&str>) -> Result<Callback, AiError> {
    let refused = oauth::refused;
    let line = head.lines().next().unwrap_or_default();
    let mut parts = line.split(' ');
    let (method, target, version) = (parts.next().unwrap_or_default(), parts.next().unwrap_or_default(), parts.next());
    if method != "GET" || !version.is_some_and(|v| v.starts_with("HTTP/")) || parts.next().is_some() || !target.starts_with('/') {
        return Err(refused(NOT_EXPECTED));
    }
    let url = Url::parse(&format!("http://127.0.0.1{target}")).map_err(|_| refused(NOT_EXPECTED))?;
    if url.path() != plan.callback_path {
        return Err(refused(NOT_EXPECTED));
    }
    let (mut states, mut codes, mut clients, mut errors) = (Vec::new(), Vec::new(), Vec::new(), Vec::new());
    for (k, v) in url.query_pairs() {
        match k.as_ref() {
            "state" => states.push(v.into_owned()),
            "code" => codes.push(v.into_owned()),
            "client_id" => clients.push(v.into_owned()),
            "error" => errors.push(v.into_owned()),
            _ => {}
        }
    }
    // The state first, even for an error ("validate state, stop the attempt").
    if states.len() != 1 || !oauth::same(&states[0], state) {
        return Err(refused("The sign-in reply did not belong to this sign-in, so Novel ignored it. Try again."));
    }
    if !errors.is_empty() {
        return Err(if errors.iter().any(|e| e == "access_denied") {
            AiError::new(DENIED, "You did not allow Novel to use your ChatGPT account. Try again if you meant to sign in.")
        } else if errors.iter().any(|e| e == "invalid_client" || e == "unauthorized_client") {
            AiError::new(INVALID_CLIENT, STALE_CLIENT)
        } else {
            AiError::new(OPENAI_REFUSED, "ChatGPT did not finish the sign-in. Try again.")
        });
    }
    let code = match codes.as_slice() {
        [c] if !c.is_empty() && c.chars().count() <= MAX_CODE_CHARS && !c.chars().any(char::is_control) => c.clone(),
        _ => return Err(refused(NOT_EXPECTED)),
    };
    let client_id = match (clients.as_slice(), saved_client) {
        ([], Some(saved)) => saved.to_owned(),
        ([c], Some(saved)) if c == saved => c.clone(),
        ([_], Some(_)) => return Err(AiError::new(OPENAI_REFUSED, "ChatGPT answered for another registration, so Novel saved nothing. Try again.")),
        ([c], None) if token_ok(c, MAX_ID_CHARS) && c != plan.register_client => c.clone(),
        _ => return Err(refused("ChatGPT did not finish registering Novel. Try again.")),
    };
    Ok(Callback { code, client_id })
}

// ---- Token requests ------------------------------------------------------------------------------------

#[derive(Deserialize)]
struct TokenReply {
    access_token: Option<String>,
    refresh_token: Option<String>,
    id_token: Option<String>,
    token_type: Option<String>,
    expires_in: Option<i64>,
    scope: Option<String>,
    earliest_refresh_at: Option<Value>,
}

/// A form POST to an OpenAI auth endpoint: the status and the body (bounded). Errors never contain the
/// form or the body.
async fn post_form(client: &reqwest::Client, url: &str, form: &[(&str, &str)]) -> Result<(u16, Vec<u8>), AiError> {
    let body = form.iter().map(|(k, v)| format!("{}={}", enc(k), enc(v))).collect::<Vec<_>>().join("&");
    let send = client
        .post(url)
        .header("content-type", "application/x-www-form-urlencoded")
        .header("accept", "application/json")
        .body(body)
        .send();
    let res = tokio::time::timeout(REQUEST_TIMEOUT, send)
        .await
        .map_err(|_| AiError::new("network", "ChatGPT did not answer in time. Try again."))?
        .map_err(|_| AiError::new("network", "Novel could not reach ChatGPT. Check your connection and try again."))?;
    let status = res.status().as_u16();
    let bytes = tokio::time::timeout(REQUEST_TIMEOUT, res.bytes())
        .await
        .map_err(|_| AiError::new("network", "ChatGPT did not answer in time. Try again."))?
        .map_err(|_| AiError::new("network", "The answer from ChatGPT was cut off. Try again."))?;
    Ok((status, bytes.iter().take(MAX_BODY_BYTES).copied().collect()))
}

/// `application/x-www-form-urlencoded` encoding of one name or value.
fn enc(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for b in s.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'.' | b'_' | b'*' => out.push(b as char),
            b' ' => out.push('+'),
            _ => out.push_str(&format!("%{b:02X}")),
        }
    }
    out
}

/// The OAuth `error` code of a refused token request, if its body has one.
fn error_code(body: &[u8]) -> Option<String> {
    let v: Value = serde_json::from_slice(body).ok()?;
    let code = v.get("error").and_then(|e| e.as_str().or_else(|| e.get("code").and_then(Value::as_str)))?;
    (code.len() <= 64 && code.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_')).then(|| code.to_owned())
}

impl std::fmt::Debug for Tokens {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("Tokens(***)")
    }
}

/// Tokens from a token endpoint, checked.
pub struct Tokens {
    pub access_token: String,
    pub refresh_token: Option<String>,
    pub id_token: Option<String>,
    pub expires_in: i64,
    pub scopes: Option<Vec<String>>,
    pub earliest_refresh_at: Option<i64>,
}

fn read_tokens(body: &[u8]) -> Result<Tokens, AiError> {
    let unreadable = || AiError::new("provider", "ChatGPT's answer could not be read. Try again.");
    let r: TokenReply = serde_json::from_slice(body).map_err(|_| unreadable())?;
    if r.token_type.as_deref().is_some_and(|t| !t.eq_ignore_ascii_case("bearer")) {
        return Err(unreadable());
    }
    let access_token = r.access_token.filter(|t| token_ok(t, MAX_TOKEN_CHARS)).ok_or_else(unreadable)?;
    let refresh_token = match r.refresh_token {
        Some(t) if token_ok(&t, MAX_TOKEN_CHARS) => Some(t),
        Some(_) => return Err(unreadable()),
        None => None,
    };
    let id_token = match r.id_token {
        Some(t) if token_ok(&t, MAX_TOKEN_CHARS) => Some(t),
        Some(_) => return Err(unreadable()),
        None => None,
    };
    let expires_in = r.expires_in.filter(|s| (1..=30 * 24 * 3600).contains(s)).unwrap_or(3600);
    let scopes = r.scope.map(|s| s.split(' ').filter(|x| !x.is_empty()).map(str::to_owned).collect());
    // Not described beyond its name; used only when it reads as a plausible Unix time.
    let earliest_refresh_at = r.earliest_refresh_at.and_then(|v| v.as_i64()).filter(|t| *t > 1_000_000_000 && *t < 100_000_000_000);
    Ok(Tokens { access_token, refresh_token, id_token, expires_in, scopes, earliest_refresh_at })
}

/// Trade the code for tokens (`authorization_code`, PKCE, no client secret: a public client).
pub async fn exchange_code(client: &reqwest::Client, plan: &PlanSignIn, client_id: &str, code: &str, verifier: &str, redirect_uri: &str) -> Result<Tokens, AiError> {
    let form = [
        ("grant_type", "authorization_code"),
        ("client_id", client_id),
        ("code", code),
        ("code_verifier", verifier),
        ("redirect_uri", redirect_uri),
        ("resource", plan.resource),
    ];
    let (status, body) = post_form(client, plan.token_url, &form).await?;
    if !(200..300).contains(&status) {
        return Err(match error_code(&body).as_deref() {
            Some("invalid_client" | "unauthorized_client") => AiError::new(INVALID_CLIENT, STALE_CLIENT),
            Some("invalid_grant") => AiError::new(OPENAI_REFUSED, "The sign-in code expired before Novel could use it. Try again."),
            // An OAuth error body: OpenAI refused this exchange.
            Some(_) => AiError::new(OPENAI_REFUSED, format!("ChatGPT refused the sign-in (HTTP {status}). Try again.")),
            // No error body (a proxy, an outage page): not known to be OpenAI's answer.
            None => AiError::new("auth", format!("ChatGPT refused the sign-in (HTTP {status}). Try again.")),
        });
    }
    let tokens = read_tokens(&body)?;
    if tokens.refresh_token.is_none() || tokens.id_token.is_none() {
        return Err(AiError::new("provider", "ChatGPT's answer was missing part of the sign-in. Try again."));
    }
    Ok(tokens)
}

// ---- The ID token ----------------------------------------------------------------------------------------

/// The verified account.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Identity {
    pub sub: String,
    pub email: Option<String>,
}

fn b64(part: &str) -> Option<Vec<u8>> {
    URL_SAFE_NO_PAD.decode(part.trim_end_matches('=')).ok()
}

/// Check an ID token: an RS256 signature by a key in `jwks` (OpenAI's published keys), the issuer, the
/// audience (the issued client id), the expiry (`now`, with a small skew), `iat`, and the nonce of this
/// sign-in. Returns the account.
pub fn verify_id_token(token: &str, jwks: &Value, plan: &PlanSignIn, client_id: &str, nonce: &str, now: i64) -> Result<Identity, AiError> {
    let bad = || AiError::new("auth", "ChatGPT's sign-in could not be verified, so Novel did not save it. Try again.");
    let mut parts = token.split('.');
    let (Some(h), Some(p), Some(sig), None) = (parts.next(), parts.next(), parts.next(), parts.next()) else { return Err(bad()) };
    let header: Value = serde_json::from_slice(&b64(h).ok_or_else(bad)?).map_err(|_| bad())?;
    if header["alg"] != "RS256" {
        return Err(bad());
    }
    let kid = header["kid"].as_str().ok_or_else(bad)?;
    let key = jwks["keys"]
        .as_array()
        .and_then(|keys| {
            keys.iter().find(|k| {
                k["kid"] == kid && k["kty"] == "RSA" && (k["alg"].is_null() || k["alg"] == "RS256") && (k["use"].is_null() || k["use"] == "sig")
            })
        })
        .ok_or_else(bad)?;
    let n = b64(key["n"].as_str().ok_or_else(bad)?).ok_or_else(bad)?;
    let e = b64(key["e"].as_str().ok_or_else(bad)?).ok_or_else(bad)?;
    let signature = b64(sig).ok_or_else(bad)?;
    let signed = &token[..h.len() + 1 + p.len()];
    ring::signature::RsaPublicKeyComponents { n: &n, e: &e }
        .verify(&ring::signature::RSA_PKCS1_2048_8192_SHA256, signed.as_bytes(), &signature)
        .map_err(|_| bad())?;
    let claims: Value = serde_json::from_slice(&b64(p).ok_or_else(bad)?).map_err(|_| bad())?;
    if claims["iss"] != plan.issuer {
        return Err(bad());
    }
    let aud_ok = match &claims["aud"] {
        Value::String(a) => a == client_id,
        Value::Array(list) if list.len() == 1 => list[0] == client_id,
        // Several audiences: OIDC Core 3.1.3.7 asks for `azp`, and it must be this client.
        Value::Array(list) => list.iter().any(|a| a == client_id) && claims["azp"] == client_id,
        _ => false,
    };
    if !aud_ok {
        return Err(bad());
    }
    let exp = claims["exp"].as_i64().ok_or_else(bad)?;
    let iat = claims["iat"].as_i64().ok_or_else(bad)?;
    if exp + CLOCK_SKEW_SECS < now || iat > now + CLOCK_SKEW_SECS {
        return Err(bad());
    }
    if !claims["nonce"].as_str().is_some_and(|n| oauth::same(n, nonce)) {
        return Err(bad());
    }
    let sub = claims["sub"].as_str().filter(|s| !s.is_empty() && s.len() <= MAX_ID_CHARS && !s.chars().any(char::is_control)).ok_or_else(bad)?;
    let email = claims["email"].as_str().filter(|s| !s.is_empty() && s.chars().count() <= 150 && !s.chars().any(char::is_control)).map(str::to_owned);
    Ok(Identity { sub: sub.to_owned(), email })
}

/// OpenAI's published signing keys (the JWKS).
pub async fn fetch_jwks(client: &reqwest::Client, url: &str) -> Result<Value, AiError> {
    let unreachable = || AiError::new("network", "Novel could not check the sign-in with ChatGPT. Try again.");
    let res = tokio::time::timeout(REQUEST_TIMEOUT, client.get(url).header("accept", "application/json").send())
        .await
        .map_err(|_| unreachable())?
        .map_err(|_| unreachable())?;
    if !res.status().is_success() {
        return Err(unreachable());
    }
    let bytes = tokio::time::timeout(REQUEST_TIMEOUT, res.bytes()).await.map_err(|_| unreachable())?.map_err(|_| unreachable())?;
    serde_json::from_slice(&bytes).map_err(|_| unreachable())
}

// ---- The stored record -------------------------------------------------------------------------------------

/// A plan sign-in's secret: the keychain value of its connection (inside the binding wrapper).
#[derive(Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TokenRecord {
    pub v: u32,
    /// The client OpenAI registered for this user (never the registration entrypoint).
    pub client_id: String,
    pub sub: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub email: Option<String>,
    pub access_token: String,
    pub refresh_token: String,
    /// Kept for `id_token_hint` on a later sign-in.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub id_token: Option<String>,
    /// Unix seconds.
    pub expires_at: i64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub earliest_refresh_at: Option<i64>,
    pub scopes: Vec<String>,
}

impl std::fmt::Debug for TokenRecord {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("TokenRecord(***)")
    }
}

impl TokenRecord {
    pub fn parse(secret: &Secret) -> Option<TokenRecord> {
        serde_json::from_str::<TokenRecord>(secret.expose()).ok().filter(|r| r.v == 1)
    }

    pub fn to_secret(&self) -> Secret {
        Secret::new(serde_json::to_string(self).expect("a token record serializes"))
    }

    pub fn plan_enabled(&self, plan: &PlanSignIn) -> bool {
        self.scopes.iter().any(|s| s == plan.plan_scope)
    }

    /// Due for a refresh: little time left (and, if OpenAI said when, not before that), or expired.
    pub fn needs_refresh(&self, now: i64) -> bool {
        let soon = self.expires_at - now <= REFRESH_MARGIN_SECS;
        let allowed = self.earliest_refresh_at.is_none_or(|t| now >= t);
        soon && (allowed || self.expires_at <= now)
    }
}

fn record_from(tokens: Tokens, client_id: String, identity: Identity, now: i64) -> Result<TokenRecord, AiError> {
    Ok(TokenRecord {
        v: 1,
        client_id,
        sub: identity.sub,
        email: identity.email,
        access_token: tokens.access_token,
        refresh_token: tokens.refresh_token.ok_or_else(|| AiError::new("provider", "ChatGPT's answer was missing part of the sign-in. Try again."))?,
        id_token: tokens.id_token,
        expires_at: now + tokens.expires_in,
        earliest_refresh_at: tokens.earliest_refresh_at,
        scopes: tokens.scopes.unwrap_or_default(),
    })
}

const SIGNED_OUT: &str = "Your ChatGPT sign-in has ended. In Settings ▸ AI Tutor, choose Sign In Again for this connection.";

/// Renew the tokens (`refresh_token` grant with the issued client id and the resource; no scope, so the
/// grant is kept). The replacement refresh token, expiry and scopes replace the old ones together.
pub async fn refresh(client: &reqwest::Client, plan: &PlanSignIn, record: &TokenRecord, now: i64) -> Result<TokenRecord, AiError> {
    let form = [
        ("grant_type", "refresh_token"),
        ("client_id", record.client_id.as_str()),
        ("refresh_token", record.refresh_token.as_str()),
        ("resource", plan.resource),
    ];
    let (status, body) = post_form(client, plan.token_url, &form).await?;
    if !(200..300).contains(&status) {
        let code = error_code(&body);
        return Err(match code.as_deref() {
            Some(
                "invalid_grant" | "invalid_refresh_token" | "token_expired" | "refresh_token_expired" | "refresh_token_invalidated"
                | "refresh_token_reused",
            ) => AiError::new("auth", SIGNED_OUT),
            Some("invalid_client") => {
                AiError::new("auth", "ChatGPT no longer knows this connection's registration. Remove the connection, then Continue with ChatGPT.")
            }
            _ if status == 401 => AiError::new("auth", SIGNED_OUT),
            _ if status >= 500 => AiError::new("provider", format!("ChatGPT could not renew the sign-in (HTTP {status}). Try again in a moment.")),
            _ => AiError::new("auth", format!("ChatGPT refused to renew the sign-in (HTTP {status}). Sign in again if this keeps happening.")),
        });
    }
    let t = read_tokens(&body)?;
    let mut next = record.clone();
    next.access_token = t.access_token;
    if let Some(r) = t.refresh_token {
        next.refresh_token = r;
    }
    if let Some(i) = t.id_token {
        next.id_token = Some(i);
    }
    next.expires_at = now + t.expires_in;
    next.earliest_refresh_at = t.earliest_refresh_at;
    if let Some(s) = t.scopes {
        next.scopes = s;
    }
    Ok(next)
}

/// One refresh at a time: the refresh token rotates, so two refreshes of one session must not race. Sign-out
/// and a renewed sign-in take it too, so neither can interleave with a refresh.
pub static REFRESH: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

/// Refreshed records the keychain refused to store, by connection id, with the connection binding they
/// were refreshed for: kept in memory (the refresh token has already rotated, so the stored one is spent)
/// and stored again on the next request, only while the connection still has that binding.
static PENDING: Mutex<BTreeMap<String, (String, TokenRecord)>> = Mutex::new(BTreeMap::new());

/// The kept record for `connection_id`, if it was refreshed for `binding`. One kept for another binding
/// (the connection was re-pointed) is dropped.
fn pending_get(connection_id: &str, binding: &str) -> Option<TokenRecord> {
    let mut pending = PENDING.lock().unwrap_or_else(|e| e.into_inner());
    match pending.get(connection_id) {
        Some((b, r)) if b == binding => Some(r.clone()),
        Some(_) => {
            pending.remove(connection_id);
            None
        }
        None => None,
    }
}

/// The kept record for `connection_id`, whatever it was refreshed for (sign-out revokes it).
fn pending_live(connection_id: &str) -> Option<TokenRecord> {
    PENDING.lock().unwrap_or_else(|e| e.into_inner()).get(connection_id).map(|(_, r)| r.clone())
}

fn pending_put(connection_id: &str, binding: &str, record: TokenRecord) {
    PENDING.lock().unwrap_or_else(|e| e.into_inner()).insert(connection_id.to_owned(), (binding.to_owned(), record));
}

fn pending_forget(connection_id: &str) {
    PENDING.lock().unwrap_or_else(|e| e.into_inner()).remove(connection_id);
}

fn read_record(conn: &ResolvedConnection) -> Result<TokenRecord, AiError> {
    conn.secret.as_ref().and_then(TokenRecord::parse).ok_or_else(|| AiError::new("auth", SIGNED_OUT))
}

/// The plan token may be sent only to the routes OpenAI documents for it (`allowed_paths`: `/responses`,
/// `/models`), whatever the webview asks.
pub fn check_path(plan: &PlanSignIn, path: &str) -> Result<(), AiError> {
    let route = path.split(['?', '#']).next().unwrap_or_default();
    if plan.allowed_paths.contains(&route) {
        Ok(())
    } else {
        Err(AiError::new("blocked_host", "Your ChatGPT plan can be used only for the tutor's chat and its model list."))
    }
}

async fn store(resolver: &Arc<dyn ConnectionResolver>, connection_id: &str, binding: &str, record: &TokenRecord) -> Result<(), AiError> {
    let (r, id, b, secret) = (resolver.clone(), connection_id.to_owned(), binding.to_owned(), record.to_secret());
    tokio::task::spawn_blocking(move || r.store_secret(&id, &b, &secret))
        .await
        .map_err(|_| AiError::new("auth", "The renewed sign-in could not be saved."))?
}

/// Store a refreshed record for the connection as it was read (`binding`). Stored: forgotten from
/// memory. Re-pointed or removed meanwhile: dropped, and the request fails. Any other failure: kept in
/// memory for the next request, and this one goes ahead.
async fn store_or_keep(resolver: &Arc<dyn ConnectionResolver>, connection_id: &str, binding: &str, record: &TokenRecord) -> Result<(), AiError> {
    match store(resolver, connection_id, binding, record).await {
        Ok(()) => {
            pending_forget(connection_id);
            Ok(())
        }
        Err(e) if e == connections::changed_meanwhile() => {
            pending_forget(connection_id);
            Err(e)
        }
        Err(_) => {
            pending_put(connection_id, binding, record.clone());
            Ok(())
        }
    }
}

/// `conn` with its token record replaced by the access token `ai_fetch` sends (refreshed and saved
/// first when it is due). Refused when the plan scope was not granted. If the keychain refuses the
/// refreshed record, this request still uses it and it is kept in memory until a store succeeds.
pub async fn with_access_token(
    client: &reqwest::Client,
    resolver: Arc<dyn ConnectionResolver>,
    connection_id: &str,
    conn: ResolvedConnection,
    plan: &PlanSignIn,
) -> Result<ResolvedConnection, AiError> {
    // Everything below is for the connection as it was read; a refreshed record is stored only while the
    // connection still has this binding (a webview that re-points it meanwhile gets nothing).
    let binding = conn.binding.clone();
    let mut record = match pending_get(connection_id, &binding) {
        Some(p) => p,
        None => read_record(&conn)?,
    };
    if !record.plan_enabled(plan) {
        return Err(AiError::new(
            "auth",
            "Novel was not allowed to use your ChatGPT plan. Choose Sign In Again for this connection and allow it, or use an API key.",
        ));
    }
    if pending_get(connection_id, &binding).is_some() || record.needs_refresh(now_secs()) {
        let _one = REFRESH.lock().await;
        // Another request may have refreshed (or stored) while this one waited: look again.
        record = match pending_get(connection_id, &binding) {
            Some(p) => {
                store_or_keep(&resolver, connection_id, &binding, &p).await?;
                p
            }
            None => {
                let (r, id) = (resolver.clone(), connection_id.to_owned());
                let latest = tokio::task::spawn_blocking(move || r.resolve(&id))
                    .await
                    .map_err(|_| AiError::new("not_connected", "The AI connection could not be read."))??;
                if latest.binding != binding {
                    return Err(connections::changed_meanwhile());
                }
                read_record(&latest)?
            }
        };
        if record.needs_refresh(now_secs()) {
            let next = refresh(client, plan, &record, now_secs()).await?;
            store_or_keep(&resolver, connection_id, &binding, &next).await?;
            record = next;
        }
    }
    Ok(ResolvedConnection { secret: Some(Secret::new(record.access_token)), ..conn })
}

// ---- Sign out ------------------------------------------------------------------------------------------------

/// The plan sign-in and token record of a saved connection, if it is one and the record can be read.
#[cfg(test)]
pub fn saved_sign_in(path: &Path, secrets: &dyn SecretStore, connection_id: &str) -> Result<Option<(PlanSignIn, TokenRecord)>, AiError> {
    let Some((c, secret)) = connections::connection_secret(path, secrets, connection_id)? else { return Ok(None) };
    let Some(plan) = providers::descriptor(&c.provider).and_then(|d| d.plan_sign_in) else { return Ok(None) };
    Ok(TokenRecord::parse(&secret).map(|r| (plan, r)))
}

/// What sign-out found before revoking.
enum SignOutRead {
    /// Not a plan connection (or not saved): nothing to sign out.
    NotPlan,
    /// A plan connection with no tokens stored.
    NoTokens,
    Tokens(Box<PlanSignIn>, Box<TokenRecord>),
    /// A plan connection whose tokens could not be read: the provider may still hold a live session.
    Unreadable,
}

fn read_for_sign_out(path: &Path, secrets: &dyn SecretStore, connection_id: &str) -> SignOutRead {
    let Ok(list) = connections::load_connections(path) else { return SignOutRead::Unreadable };
    let Some(c) = list.iter().find(|c| c.id == connection_id) else { return SignOutRead::NotPlan };
    let Some(plan) = providers::descriptor(&c.provider).and_then(|d| d.plan_sign_in) else { return SignOutRead::NotPlan };
    match connections::connection_secret(path, secrets, connection_id) {
        Ok(None) => SignOutRead::NoTokens,
        Ok(Some((_, secret))) => match TokenRecord::parse(&secret) {
            Some(r) => SignOutRead::Tokens(Box::new(plan), Box::new(r)),
            None => SignOutRead::Unreadable,
        },
        Err(_) => SignOutRead::Unreadable,
    }
}

/// Remove a connection; a plan sign-in is signed out first (its refresh token revoked). All of it under
/// `REFRESH`, so a refresh cannot rotate the token between the read and the revoke. Returns `None` when
/// there was nothing to sign out, else whether the provider confirmed (false also when the tokens could
/// not be read). The account stays known (`chatgpt-host.json`), without the connection.
pub async fn sign_out_and_remove(
    client: &reqwest::Client,
    path: PathBuf,
    host_path: PathBuf,
    secrets: Arc<dyn SecretStore>,
    connection_id: String,
) -> Result<Option<bool>, AiError> {
    sign_out_inner(client, None, path, host_path, secrets, connection_id).await
}

/// [`sign_out_and_remove`], with the plan's endpoints replaceable (tests).
async fn sign_out_inner(
    client: &reqwest::Client,
    plan_override: Option<&PlanSignIn>,
    path: PathBuf,
    host_path: PathBuf,
    secrets: Arc<dyn SecretStore>,
    connection_id: String,
) -> Result<Option<bool>, AiError> {
    let _one = REFRESH.lock().await;
    let (p, s, id) = (path.clone(), secrets.clone(), connection_id.clone());
    let read = super::blocking(move || Ok(read_for_sign_out(&p, s.as_ref(), &id))).await?;
    let revoked = match read {
        SignOutRead::NotPlan => None,
        SignOutRead::NoTokens => {
            pending_forget(&connection_id);
            None
        }
        SignOutRead::Tokens(plan, record) => {
            // A refreshed record the keychain refused is the live one.
            let live = pending_live(&connection_id).unwrap_or(*record);
            Some(revoke(client, plan_override.unwrap_or(&*plan), &live).await)
        }
        SignOutRead::Unreadable => Some(false),
    };
    pending_forget(&connection_id);
    let id = connection_id.clone();
    super::blocking(move || connections::remove_connection(&path, secrets.as_ref(), &id)).await?;
    if revoked.is_some() {
        let _ = super::blocking(move || forget_connection(&host_path, &connection_id)).await;
    }
    Ok(revoked)
}

/// Revoke the renewable session (the refresh token) at the provider. True when it confirmed (an empty
/// HTTP 200, also for a token that was already invalid). Network failures and 5xx are retried twice.
pub async fn revoke(client: &reqwest::Client, plan: &PlanSignIn, record: &TokenRecord) -> bool {
    let form = [
        ("token", record.refresh_token.as_str()),
        ("token_type_hint", "refresh_token"),
        ("client_id", record.client_id.as_str()),
    ];
    for attempt in 0..3u32 {
        if attempt > 0 {
            tokio::time::sleep(Duration::from_millis(500 * u64::from(attempt))).await;
        }
        match post_form(client, plan.revoke_url, &form).await {
            Ok((200, _)) => return true,
            Ok((s, _)) if s < 500 => return false,
            _ => {}
        }
    }
    false
}

// ---- The sign-in ------------------------------------------------------------------------------------------------

/// Save a renewed sign-in: replace the connection's record, only if it is still saved for this provider.
pub fn save_renewed(path: &Path, secrets: &dyn SecretStore, provider: &str, connection_id: &str, record: &TokenRecord) -> Result<String, AiError> {
    let saved: Vec<Connection> = connections::load_connections(path)?;
    if !saved.iter().any(|c| c.id == connection_id && c.provider == provider) {
        return Err(AiError::not_connected());
    }
    connections::replace_secret(path, secrets, connection_id, record.to_secret().expose())?;
    pending_forget(connection_id);
    Ok(connection_id.to_owned())
}

/// Code to tokens to a verified account (the network half of a sign-in).
pub async fn exchange_and_verify(
    client: &reqwest::Client,
    plan: &PlanSignIn,
    callback: &Callback,
    verifier: &str,
    redirect: &str,
    nonce: &str,
    now: i64,
) -> Result<(TokenRecord, Identity), AiError> {
    let tokens = exchange_code(client, plan, &callback.client_id, &callback.code, verifier, redirect).await?;
    let jwks = fetch_jwks(client, plan.jwks_url).await?;
    let id_token = tokens.id_token.clone().unwrap_or_default();
    let identity = verify_id_token(&id_token, &jwks, plan, &callback.client_id, nonce, now)?;
    let record = record_from(tokens, callback.client_id.clone(), identity.clone(), now)?;
    Ok((record, identity))
}

/// Paths and store a sign-in saves into.
pub struct SignInFiles<'a> {
    pub connections: &'a Path,
    pub host: &'a Path,
    pub secrets: &'a dyn SecretStore,
}

/// Save a verified sign-in (the storage half; call under `REFRESH`). The issued client id is kept as a
/// known account in every case where OpenAI asks for it: a granted plan (with the connection), a declined
/// plan (without one: the next sign-in reuses the client and asks for consent). Returns the connection id.
pub fn save_sign_in(
    files: &SignInFiles<'_>,
    provider: &str,
    plan: &PlanSignIn,
    reauth: Option<&Reauth>,
    record: TokenRecord,
    identity: &Identity,
) -> Result<String, AiError> {
    if let Some(r) = reauth {
        if !oauth::same(&r.sub, &identity.sub) {
            return Err(match &r.connection_id {
                Some(_) => AiError::new(
                    "auth",
                    "You signed in with a different ChatGPT account, so this connection was kept as it was. To add that account, use Continue with ChatGPT.",
                ),
                None => {
                    // Reusing a known account's client came back with another account: register next time.
                    skip_account(files.host, &r.sub)?;
                    AiError::new(
                        "auth",
                        "You signed in with a different ChatGPT account than the one Novel knows, so nothing was saved. Continue with ChatGPT again to add this account.",
                    )
                }
            });
        }
    }
    let known = |connection_id: Option<String>, plan_declined: bool| KnownAccount {
        sub: identity.sub.clone(),
        email: identity.email.clone(),
        client_id: record.client_id.clone(),
        connection_id,
        plan_declined,
        skip: false,
    };
    let renewing = reauth.and_then(|r| r.connection_id.clone());
    if !record.plan_enabled(plan) {
        remember_account(files.host, known(renewing, true))?;
        return Err(AiError::new(
            "auth",
            "You signed in, but did not allow Novel to use your ChatGPT plan, so no connection was added. Try again and allow it, or use an API key.",
        ));
    }
    let id = match &renewing {
        Some(id) => save_renewed(files.connections, files.secrets, provider, id, &record)?,
        None => oauth::save_signed_in(files.connections, files.secrets, provider, &connection_name(plan, identity), &record.to_secret())?,
    };
    remember_account(files.host, known(Some(id.clone()), false))?;
    Ok(id)
}

/// The new connection's name: "ChatGPT (email)" when the account has an email, else "ChatGPT".
fn connection_name(plan: &PlanSignIn, identity: &Identity) -> String {
    match &identity.email {
        Some(e) => format!("{} ({e})", plan.name),
        None => plan.name.to_owned(),
    }
}

fn reauth_for(path: &Path, provider: &str, connection_id: &str) -> Result<Reauth, AiError> {
    let missing = || AiError::bad_request("This connection has no ChatGPT sign-in to renew. Remove it, then Continue with ChatGPT.");
    let Some((c, secret)) = connections::connection_secret(path, &KeyringStore, connection_id)? else { return Err(missing()) };
    if c.provider != provider {
        return Err(missing());
    }
    let r = TokenRecord::parse(&secret).ok_or_else(missing)?;
    Ok(Reauth {
        connection_id: Some(connection_id.to_owned()),
        client_id: r.client_id,
        sub: r.sub,
        id_token_hint: r.id_token,
        login_hint: r.email,
        prompt_consent: false,
    })
}

/// A reuse of a known account's client (`connection_id` None) failed before anything was saved. Saved
/// state changes only for an answer that clearly came from OpenAI for this sign-in (after the `state`
/// check): a client OpenAI no longer knows is forgotten (the next sign-in registers anew), and any other
/// OpenAI refusal marks the account to be skipped next time, so a dead client is never retried forever.
/// A timeout, a local or transport error, a stray loopback request, a cancel or a no change nothing.
pub fn after_reuse_failure(host_path: &Path, reuse: &Reauth, e: &AiError) -> Result<(), AiError> {
    if reuse.connection_id.is_some() {
        return Ok(());
    }
    match e.kind {
        INVALID_CLIENT => forget_account(host_path, &reuse.sub),
        OPENAI_REFUSED => skip_account(host_path, &reuse.sub),
        _ => Ok(()),
    }
}

/// ChatGPT's callback, screened like OpenRouter's: another method or path, or a missing or foreign
/// `state`, is ignored (a 4xx, and the wait goes on); a request with this sign-in's `state` ends it.
pub fn classify_callback(head: &str, plan: &PlanSignIn, state: &str, saved_client: Option<&str>) -> oauth::Reply<Callback> {
    let url = match oauth::screen(head, plan.callback_path) {
        Ok(u) => u,
        Err(status) => return oauth::Reply::Ignore(status),
    };
    let states = oauth::params(&url, "state");
    if states.len() != 1 || !oauth::same(&states[0], state) {
        return oauth::Reply::Ignore("400 Bad Request");
    }
    oauth::Reply::Done(parse_callback(head, plan, state, saved_client))
}

/// Forget an account entirely (its client id is dead).
pub fn forget_account(path: &Path, sub: &str) -> Result<(), AiError> {
    let _lock = HOST.lock().unwrap_or_else(|e| e.into_inner());
    let mut f = load_host(path)?;
    let before = f.accounts.len();
    f.accounts.retain(|a| a.sub != sub);
    if f.accounts.len() != before {
        save_host(path, &f)?;
    }
    Ok(())
}

/// The email (or "") of the account Continue with ChatGPT would reuse, if any (`ai_oauth_reusable`).
pub fn reusable_email(path: &Path, host_path: &Path) -> Result<Option<String>, AiError> {
    Ok(reuse_for(path, host_path)?.map(|r| r.login_hint.unwrap_or_default()))
}

/// A new sign-in: the known account to reuse, if there is exactly one without a connection.
fn reuse_for(path: &Path, host_path: &Path) -> Result<Option<Reauth>, AiError> {
    let live: Vec<String> = connections::load_connections(path)?.into_iter().map(|c| c.id).collect();
    Ok(reusable_account(host_path, &live)?.map(|a| Reauth {
        connection_id: None,
        client_id: a.client_id,
        sub: a.sub,
        id_token_hint: None,
        login_hint: a.email,
        prompt_consent: a.plan_declined,
    }))
}

fn app_file<R: Runtime>(app: &AppHandle<R>, name: &str) -> Result<PathBuf, AiError> {
    app.path().app_data_dir().map(|d| d.join(name)).map_err(|_| AiError::bad_request("The app data folder is not available."))
}

/// Start "Sign in with ChatGPT" (`ai_oauth_start`): a first registration, or `connection_id`'s renewal.
/// Resolves once the browser was asked to open; the outcome arrives as the `ai-oauth-result` event.
pub async fn start<R: Runtime>(
    app: AppHandle<R>,
    client: reqwest::Client,
    oauth_state: &OauthState,
    provider: String,
    plan: PlanSignIn,
    connection_id: Option<String>,
    new_account: bool,
) -> Result<(), AiError> {
    let path = super::connections_file(&app)?;
    let host_path = app_file(&app, HOST_FILE)?;
    let (p, prov, hp) = (path.clone(), provider.clone(), host_path.clone());
    let reauth = match connection_id {
        Some(id) => Some(super::blocking(move || reauth_for(&p, &prov, &id)).await?),
        // "Use Another Account": no reuse this time, a fresh registration.
        None if new_account => None,
        None => super::blocking(move || reuse_for(&p, &hp)).await?,
    };
    let hp = host_path.clone();
    let host = super::blocking(move || host_id(&hp)).await?;
    let pkce = oauth::new_pkce()?;
    let state = oauth::random_token(16)?;
    let nonce = oauth::random_token(16)?;
    let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0))
        .await
        .map_err(|_| AiError::new("network", "The sign-in could not start: no local port is free."))?;
    let port = listener.local_addr().map_err(|_| AiError::new("network", "The sign-in could not start."))?.port();
    let (flow, stop) = oauth_state.begin();
    if let Err(e) = oauth::open_in_browser(&authorize_url(&plan, port, &pkce.challenge, &state, &nonce, &host, reauth.as_ref())) {
        oauth_state.finish(flow);
        return Err(e);
    }
    let app2 = app.clone();
    tauri::async_runtime::spawn(async move {
        let outcome = async {
            let wanted = stop.clone();
            let saved_client = reauth.as_ref().map(|r| r.client_id.clone());
            let verified = async {
                let callback = oauth::wait_for_reply(listener, CALLBACK_TIMEOUT, stop, |head| classify_callback(head, &plan, &state, saved_client.as_deref())).await?;
                let redirect = redirect_uri(&plan, port);
                exchange_and_verify(&client, &plan, &callback, &pkce.verifier, &redirect, &nonce, now_secs()).await
            }
            .await;
            let (record, identity) = match verified {
                Ok(v) => v,
                Err(e) => {
                    if let Some(r) = reauth.clone() {
                        let (hp, e2) = (host_path.clone(), e.clone());
                        let _ = super::blocking(move || after_reuse_failure(&hp, &r, &e2)).await;
                    }
                    return Err(e);
                }
            };
            // Cancelled (or replaced) meanwhile: the tokens are dropped, nothing is saved.
            oauth::still_wanted(&wanted)?;
            // Under REFRESH: a refresh of the connection being renewed cannot overwrite the new record.
            let _one = REFRESH.lock().await;
            super::blocking(move || {
                let files = SignInFiles { connections: &path, host: &host_path, secrets: &KeyringStore };
                save_sign_in(&files, &provider, &plan, reauth.as_ref(), record, &identity)
            })
            .await
        }
        .await;
        oauth::report(&app2, flow, outcome);
    });
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::super::keychain::testing::MemoryStore;
    use super::*;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    fn plan() -> PlanSignIn {
        providers::descriptor("chatgpt").unwrap().plan_sign_in.unwrap()
    }

    /// The plan with its auth endpoints on a local mock.
    fn plan_at(base: &str) -> PlanSignIn {
        let leak = |s: String| -> &'static str { Box::leak(s.into_boxed_str()) };
        PlanSignIn {
            token_url: leak(format!("{base}/oauth/token")),
            revoke_url: leak(format!("{base}/oauth/revoke")),
            jwks_url: leak(format!("{base}/jwks")),
            ..plan()
        }
    }

    fn query(url: &str) -> Vec<(String, String)> {
        Url::parse(url).unwrap().query_pairs().map(|(k, v)| (k.into_owned(), v.into_owned())).collect()
    }

    #[test]
    fn host_ids_are_uuid_v4_urns_saved_once() {
        let id = new_host_id().unwrap();
        assert!(host_id_ok(&id), "{id}");
        assert_eq!(&id[23..24], "4", "version 4: {id}");
        assert!("89ab".contains(&id[28..29]), "variant: {id}");
        assert_ne!(new_host_id().unwrap(), id);
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join(HOST_FILE);
        let first = host_id(&path).unwrap();
        assert_eq!(host_id(&path).unwrap(), first, "reused");
        let text = std::fs::read_to_string(&path).unwrap();
        assert!(text.contains(&first));
        // A damaged file gets a new id.
        std::fs::write(&path, "{\"version\":1,\"hostId\":\"me@example.com\"}").unwrap();
        let again = host_id(&path).unwrap();
        assert!(host_id_ok(&again) && again != first);
        for bad in ["urn:uuid:", "uuid:0000", "urn:uuid:ZZZZZZZZ-0000-4000-8000-000000000000"] {
            assert!(!host_id_ok(bad), "{bad}");
        }
    }

    #[test]
    fn a_first_sign_in_registers_novel_by_its_own_name() {
        let q = query(&authorize_url(&plan(), 51423, "CHAL", "STATE", "NONCE", "urn:uuid:h", None));
        let get = |k: &str| q.iter().find(|(n, _)| n == k).map(|(_, v)| v.as_str());
        assert_eq!(get("client_id"), Some("dynamic_agent_client"));
        assert_eq!(get("agent_name_hint"), Some("Novel"));
        assert_eq!(get("ext_agent_host_id"), Some("urn:uuid:h"));
        assert_eq!(get("redirect_uri"), Some("http://127.0.0.1:51423/auth/callback"));
        assert_eq!(get("scope"), Some("openid profile email offline_access resource.invoke chatgpt.tokens.use.direct"));
        assert_eq!(get("resource"), Some(plan().resource));
        assert_eq!(get("response_type"), Some("code"));
        assert_eq!((get("state"), get("nonce")), (Some("STATE"), Some("NONCE")));
        assert_eq!((get("code_challenge_method"), get("code_challenge")), (Some("S256"), Some("CHAL")));
        assert_eq!(get("id_token_hint"), None);
        let url = Url::parse(&authorize_url(&plan(), 1, "c", "s", "n", "h", None)).unwrap();
        assert_eq!(url.origin().ascii_serialization(), "https://auth.openai.com");
        assert_eq!(url.path(), "/api/accounts/authorize");
    }

    #[test]
    fn a_renewal_reuses_the_issued_client_and_sends_the_hints() {
        let mut r = Reauth {
            connection_id: Some("c".into()),
            client_id: "oaiapp_123".into(),
            sub: "s".into(),
            id_token_hint: Some("old.id.token".into()),
            login_hint: Some("a@example.com".into()),
            prompt_consent: false,
        };
        let q = query(&authorize_url(&plan(), 5, "c", "s", "n", "urn:uuid:h", Some(&r)));
        let get = |k: &str| q.iter().find(|(n, _)| n == k).map(|(_, v)| v.to_owned());
        assert_eq!(get("client_id").as_deref(), Some("oaiapp_123"));
        assert_eq!(get("agent_name_hint"), None, "only on a first registration");
        assert_eq!(get("id_token_hint").as_deref(), Some("old.id.token"));
        assert_eq!(get("login_hint").as_deref(), Some("a@example.com"));
        assert_eq!(get("ext_agent_host_id").as_deref(), Some("urn:uuid:h"));
        assert_eq!(get("prompt"), None);
        // After a declined plan scope the reuse asks for consent again.
        r.prompt_consent = true;
        let q = query(&authorize_url(&plan(), 5, "c", "s", "n", "urn:uuid:h", Some(&r)));
        assert!(q.contains(&("prompt".to_owned(), "consent".to_owned())));
    }

    #[test]
    fn callback_parsing() {
        let p = plan();
        let ok = parse_callback("GET /auth/callback?code=C&scope=openid&state=S&client_id=oaiapp_1 HTTP/1.1\r\n\r\n", &p, "S", None).unwrap();
        assert_eq!((ok.code.as_str(), ok.client_id.as_str()), ("C", "oaiapp_1"));
        // A renewal may omit the client id; the saved one is used.
        let r = parse_callback("GET /auth/callback?code=C&state=S HTTP/1.1\r\n\r\n", &p, "S", Some("oaiapp_1")).unwrap();
        assert_eq!(r.client_id, "oaiapp_1");
        for (head, saved, why) in [
            ("GET /auth/callback?code=C&state=S HTTP/1.1\r\n\r\n", None, "no issued client id on a registration"),
            ("GET /auth/callback?code=C&state=S&client_id=dynamic_agent_client HTTP/1.1\r\n\r\n", None, "the entrypoint is not an issued id"),
            ("GET /auth/callback?code=C&state=S&client_id=oaiapp_2 HTTP/1.1\r\n\r\n", Some("oaiapp_1"), "another registration"),
            ("GET /auth/callback?code=C&state=X&client_id=oaiapp_1 HTTP/1.1\r\n\r\n", None, "wrong state"),
            ("GET /auth/callback?code=C&client_id=oaiapp_1 HTTP/1.1\r\n\r\n", None, "no state"),
            ("GET /callback?code=C&state=S&client_id=oaiapp_1 HTTP/1.1\r\n\r\n", None, "/callback is not /auth/callback"),
            ("POST /auth/callback?code=C&state=S&client_id=oaiapp_1 HTTP/1.1\r\n\r\n", None, "not a GET"),
            ("GET /auth/callback?state=S&client_id=oaiapp_1 HTTP/1.1\r\n\r\n", None, "no code"),
            ("GET /auth/callback?code=A&code=B&state=S&client_id=oaiapp_1 HTTP/1.1\r\n\r\n", None, "two codes"),
            ("GET /auth/callback?code=C&state=S&client_id=a%20b HTTP/1.1\r\n\r\n", None, "a client id with a space"),
            ("GET http://evil.example/auth/callback?code=C&state=S HTTP/1.1\r\n\r\n", None, "absolute target"),
        ] {
            assert!(parse_callback(head, &p, "S", saved).is_err(), "{why}");
        }
    }

    #[test]
    fn a_denial_is_reported_after_the_state_check_and_never_echoed() {
        let p = plan();
        let e = parse_callback("GET /auth/callback?error=access_denied&state=S HTTP/1.1\r\n\r\n", &p, "S", None).unwrap_err();
        assert!(e.message.contains("did not allow"), "{}", e.message);
        assert!(!e.message.contains("access_denied"));
        let e = parse_callback("GET /auth/callback?error=access_denied&state=X HTTP/1.1\r\n\r\n", &p, "S", None).unwrap_err();
        assert!(e.message.contains("did not belong"));
        let e = parse_callback("GET /auth/callback?code=SECRET-CODE&state=X HTTP/1.1\r\n\r\n", &p, "S", None).unwrap_err();
        assert!(!format!("{e:?}").contains("SECRET-CODE"));
    }

    // ---- ID tokens: pre-signed fixtures (testdata/chatgpt-id-tokens.json; public key only) ----

    fn fixtures() -> Value {
        serde_json::from_str(include_str!("testdata/chatgpt-id-tokens.json")).unwrap()
    }

    fn token(name: &str) -> String {
        fixtures()["tokens"][name].as_str().unwrap_or_else(|| panic!("fixture {name}")).to_owned()
    }

    fn test_jwks() -> Value {
        // "other": a key too small for RS256 (a token naming it never verifies).
        serde_json::json!({ "keys": [
            { "kty": "RSA", "kid": "other", "use": "sig", "alg": "RS256", "n": "AQAB", "e": "AQAB" },
            fixtures()["jwk"],
        ]})
    }

    const NOW: i64 = 1_800_000_000;

    #[test]
    fn no_private_key_is_in_the_fixtures() {
        let text = include_str!("testdata/chatgpt-id-tokens.json");
        assert!(!text.contains("PRIVATE") && fixtures()["jwk"].get("d").is_none());
    }

    #[test]
    fn a_good_id_token_verifies() {
        let id = verify_id_token(&token("good"), &test_jwks(), &plan(), "oaiapp_1", "N0NCE", NOW).unwrap();
        assert_eq!(id, Identity { sub: "user-sub".into(), email: Some("writer@example.com".into()) });
        assert!(verify_id_token(&token("aud_string"), &test_jwks(), &plan(), "oaiapp_1", "N0NCE", NOW).is_ok());
        // Several audiences with azp = this client.
        assert!(verify_id_token(&token("multi_aud_azp"), &test_jwks(), &plan(), "oaiapp_1", "N0NCE", NOW).is_ok());
    }

    #[test]
    fn a_bad_id_token_is_refused() {
        let check = |token: &str, client: &str, nonce: &str, now: i64| verify_id_token(token, &test_jwks(), &plan(), client, nonce, now);
        let good = token("good");
        assert!(check(&good, "oaiapp_2", "N0NCE", NOW).is_err(), "audience");
        assert!(check(&good, "oaiapp_1", "OTHER", NOW).is_err(), "nonce");
        assert!(check(&good, "oaiapp_1", "N0NCE", NOW + 3600 + CLOCK_SKEW_SECS + 1).is_err(), "expired");
        for name in [
            "kid_unknown",         // unknown key
            "kid_other",           // a key that is not the signer's
            "iss_bad",             // another issuer
            "sub_empty",           // no account
            "iat_missing",         // no issue time
            "nonce_missing",       // no nonce
            "iat_future",          // issued an hour from now (M8)
            "multi_aud_no_azp",    // several audiences and no azp (M8)
            "multi_aud_azp_other", // azp names another client (M8)
        ] {
            assert!(check(&token(name), "oaiapp_1", "N0NCE", NOW).is_err(), "{name}");
        }
        // A tampered payload, an alg of none, garbage.
        let parts: Vec<&str> = good.split('.').collect();
        let mut evil: Value = serde_json::from_slice(&b64(parts[1]).unwrap()).unwrap();
        evil["sub"] = "attacker".into();
        let tampered = format!("{}.{}.{}", parts[0], URL_SAFE_NO_PAD.encode(evil.to_string()), parts[2]);
        assert!(check(&tampered, "oaiapp_1", "N0NCE", NOW).is_err(), "tampered");
        let none = format!("{}.{}.", URL_SAFE_NO_PAD.encode(r#"{"alg":"none","kid":"k1"}"#), parts[1]);
        assert!(check(&none, "oaiapp_1", "N0NCE", NOW).is_err(), "alg none");
        assert!(check("not-a-jwt", "oaiapp_1", "N0NCE", NOW).is_err());
    }

    #[test]
    fn the_plan_token_goes_only_to_the_documented_routes() {
        let p = plan();
        for ok in ["/responses", "/models", "/models?x=1"] {
            assert!(check_path(&p, ok).is_ok(), "{ok}");
        }
        for bad in ["/chat/completions", "/files", "/responses/abc", "/responsesx", "/v1/responses", "/models/gpt", ""] {
            assert_eq!(check_path(&p, bad).unwrap_err().kind, "blocked_host", "{bad}");
        }
    }

    // ---- Records and refresh ----

    fn record(expires_at: i64) -> TokenRecord {
        TokenRecord {
            v: 1,
            client_id: "oaiapp_1".into(),
            sub: "user-sub".into(),
            email: Some("writer@example.com".into()),
            access_token: "ACCESS-OLD".into(),
            refresh_token: "REFRESH-OLD".into(),
            id_token: Some("id.tok.en".into()),
            expires_at,
            earliest_refresh_at: None,
            scopes: vec!["openid".into(), "offline_access".into(), "resource.invoke".into(), "chatgpt.tokens.use.direct".into()],
        }
    }

    #[test]
    fn records_round_trip_and_never_print_tokens() {
        let r = record(NOW);
        assert_eq!(TokenRecord::parse(&r.to_secret()).unwrap(), r);
        assert_eq!(format!("{r:?}"), "TokenRecord(***)");
        assert!(TokenRecord::parse(&Secret::new("sk-plain-key")).is_none());
        assert!(r.plan_enabled(&plan()));
        let mut no_plan = r.clone();
        no_plan.scopes.retain(|s| s != "chatgpt.tokens.use.direct");
        assert!(!no_plan.plan_enabled(&plan()));
    }

    #[test]
    fn refresh_is_due_near_expiry() {
        assert!(!record(NOW + 3600).needs_refresh(NOW));
        assert!(record(NOW + 200).needs_refresh(NOW));
        assert!(record(NOW - 5).needs_refresh(NOW));
        let mut r = record(NOW + 200);
        r.earliest_refresh_at = Some(NOW + 100);
        assert!(!r.needs_refresh(NOW), "not before earliest_refresh_at");
        r.expires_at = NOW - 1;
        assert!(r.needs_refresh(NOW), "expired: refresh anyway");
    }

    /// A one-request HTTP server answering `status` and `body` at `path`; returns its base URL and the request it saw.
    async fn mock(status: &'static str, body: &'static str) -> (String, tokio::task::JoinHandle<String>) {
        let l = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).await.unwrap();
        let port = l.local_addr().unwrap().port();
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
        (format!("http://127.0.0.1:{port}"), task)
    }

    fn form_of(request: &str) -> Vec<(String, String)> {
        let body = request.split("\r\n\r\n").nth(1).unwrap();
        Url::parse(&format!("http://x/?{body}")).unwrap().query_pairs().map(|(k, v)| (k.into_owned(), v.into_owned())).collect()
    }

    #[tokio::test]
    async fn the_code_exchange_posts_the_documented_form() {
        let (base, seen) = mock(
            "200 OK",
            r#"{"access_token":"AT","refresh_token":"RT","id_token":"a.b.c","token_type":"Bearer","expires_in":3600,"scope":"openid chatgpt.tokens.use.direct"}"#,
        )
        .await;
        let p = plan_at(&base);
        let t = exchange_code(&super::super::fetch::client(), &p, "oaiapp_1", "CODE", "VERIFIER", "http://127.0.0.1:9/auth/callback").await.unwrap();
        assert_eq!((t.access_token.as_str(), t.refresh_token.as_deref()), ("AT", Some("RT")));
        assert_eq!(t.scopes.unwrap(), ["openid", "chatgpt.tokens.use.direct"]);
        let request = seen.await.unwrap();
        assert!(request.starts_with("POST /oauth/token "));
        assert!(request.to_ascii_lowercase().contains("content-type: application/x-www-form-urlencoded"));
        let form = form_of(&request);
        let want: Vec<(String, String)> = [
            ("grant_type", "authorization_code"),
            ("client_id", "oaiapp_1"),
            ("code", "CODE"),
            ("code_verifier", "VERIFIER"),
            ("redirect_uri", "http://127.0.0.1:9/auth/callback"),
            ("resource", plan().resource),
        ]
        .iter()
        .map(|(k, v)| (k.to_string(), v.to_string()))
        .collect();
        assert_eq!(form, want);
        assert!(!request.to_ascii_lowercase().contains("client_secret"));
    }

    #[tokio::test]
    async fn token_errors_never_echo_the_code_or_the_body() {
        for (status, body) in [
            ("400 Bad Request", r#"{"error":"invalid_grant","error_description":"SECRET-CODE"}"#),
            ("500 Internal Server Error", "SECRET-CODE"),
            ("200 OK", r#"{"nope":"SECRET-CODE"}"#),
        ] {
            let (base, _) = mock(status, body).await;
            let e = exchange_code(&super::super::fetch::client(), &plan_at(&base), "oaiapp_1", "SECRET-CODE", "SECRET-VERIFIER", "x").await.unwrap_err();
            for s in ["SECRET-CODE", "SECRET-VERIFIER"] {
                assert!(!format!("{e:?}").contains(s), "{status}: {}", e.message);
            }
        }
    }

    #[tokio::test]
    async fn refresh_replaces_the_rotating_token_with_the_rest() {
        let (base, seen) = mock("200 OK", r#"{"access_token":"ACCESS-NEW","refresh_token":"REFRESH-NEW","token_type":"Bearer","expires_in":3600,"scope":"openid chatgpt.tokens.use.direct"}"#).await;
        let next = refresh(&super::super::fetch::client(), &plan_at(&base), &record(NOW + 10), NOW).await.unwrap();
        assert_eq!((next.access_token.as_str(), next.refresh_token.as_str()), ("ACCESS-NEW", "REFRESH-NEW"));
        assert_eq!(next.expires_at, NOW + 3600);
        assert_eq!(next.client_id, "oaiapp_1");
        assert_eq!(next.id_token.as_deref(), Some("id.tok.en"), "kept for the hint");
        let form = form_of(&seen.await.unwrap());
        let get = |k: &str| form.iter().find(|(n, _)| n == k).map(|(_, v)| v.clone());
        assert_eq!(get("grant_type").as_deref(), Some("refresh_token"));
        assert_eq!(get("client_id").as_deref(), Some("oaiapp_1"), "the issued id, not the registration entrypoint");
        assert_eq!(get("refresh_token").as_deref(), Some("REFRESH-OLD"));
        assert_eq!(get("resource").as_deref(), Some(plan().resource));
        assert_eq!(get("scope"), None, "omitted to keep the grant");
    }

    #[tokio::test]
    async fn a_dead_refresh_token_asks_to_sign_in_again() {
        for body in [r#"{"error":"invalid_grant"}"#, r#"{"error":"refresh_token_reused"}"#] {
            let (base, _) = mock("400 Bad Request", body).await;
            let e = refresh(&super::super::fetch::client(), &plan_at(&base), &record(NOW), NOW).await.unwrap_err();
            assert_eq!(e.kind, "auth");
            assert!(e.message.contains("Sign In Again"), "{}", e.message);
            assert!(!e.message.contains("REFRESH-OLD"));
        }
    }

    /// A resolver over one in-memory connection, as `FileResolver` would give it.
    struct OneConnection {
        secret: Mutex<Secret>,
        stores: Mutex<u32>,
        fail_store: Mutex<bool>,
    }

    impl OneConnection {
        fn new(secret: Secret) -> Arc<Self> {
            Arc::new(OneConnection { secret: Mutex::new(secret), stores: Mutex::new(0), fail_store: Mutex::new(false) })
        }
    }

    impl ConnectionResolver for OneConnection {
        fn resolve(&self, _id: &str) -> Result<ResolvedConnection, AiError> {
            Ok(ResolvedConnection {
                provider: providers::descriptor("chatgpt").unwrap(),
                base_url: None,
                secret: Some(self.secret.lock().unwrap().clone()),
                insecure_http_accepted: false,
                binding: "chatgpt|oauth|test".into(),
            })
        }
        fn store_secret(&self, _id: &str, expected: &str, secret: &Secret) -> Result<(), AiError> {
            assert_eq!(expected, "chatgpt|oauth|test");
            if *self.fail_store.lock().unwrap() {
                return Err(AiError::new("auth", "The system keychain could not be used."));
            }
            *self.secret.lock().unwrap() = secret.clone();
            *self.stores.lock().unwrap() += 1;
            Ok(())
        }
    }

    #[tokio::test]
    async fn ai_fetch_sends_the_access_token_and_refreshes_when_due() {
        let client = super::super::fetch::client();
        // Fresh: no refresh, the access token replaces the record.
        let fresh = OneConnection::new(record(now_secs() + 3600).to_secret());
        let conn = fresh.resolve("c").unwrap();
        let out = with_access_token(&client, fresh.clone(), "c", conn, &plan()).await.unwrap();
        assert_eq!(out.secret.unwrap().expose(), "ACCESS-OLD");
        assert_eq!(*fresh.stores.lock().unwrap(), 0);
        // Due: refreshed, saved, and the new token is sent.
        let (base, _) = mock("200 OK", r#"{"access_token":"ACCESS-NEW","refresh_token":"REFRESH-NEW","expires_in":3600}"#).await;
        let due = OneConnection::new(record(now_secs() + 10).to_secret());
        let conn = due.resolve("c").unwrap();
        let out = with_access_token(&client, due.clone(), "c", conn, &plan_at(&base)).await.unwrap();
        assert_eq!(out.secret.unwrap().expose(), "ACCESS-NEW");
        assert_eq!(*due.stores.lock().unwrap(), 1);
        let saved = TokenRecord::parse(&due.secret.lock().unwrap()).unwrap();
        assert_eq!(saved.refresh_token, "REFRESH-NEW");
        // Without the plan scope nothing is sent.
        let mut no_plan = record(now_secs() + 3600);
        no_plan.scopes = vec!["openid".into()];
        let r = OneConnection::new(no_plan.to_secret());
        let conn = r.resolve("c").unwrap();
        assert_eq!(with_access_token(&client, r, "c", conn, &plan()).await.unwrap_err().kind, "auth");
    }

    #[tokio::test]
    async fn revoke_posts_the_refresh_token_with_the_issued_client() {
        let (base, seen) = mock("200 OK", "").await;
        assert!(revoke(&super::super::fetch::client(), &plan_at(&base), &record(NOW)).await);
        let request = seen.await.unwrap();
        assert!(request.starts_with("POST /oauth/revoke "));
        let form = form_of(&request);
        let get = |k: &str| form.iter().find(|(n, _)| n == k).map(|(_, v)| v.clone());
        assert_eq!(get("token").as_deref(), Some("REFRESH-OLD"));
        assert_eq!(get("token_type_hint").as_deref(), Some("refresh_token"));
        assert_eq!(get("client_id").as_deref(), Some("oaiapp_1"));
        let (base, _) = mock("400 Bad Request", "{}").await;
        assert!(!revoke(&super::super::fetch::client(), &plan_at(&base), &record(NOW)).await);
    }

    #[test]
    fn a_new_sign_in_and_a_renewal_are_saved_in_the_keychain_only() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join(connections::CONNECTIONS_FILE);
        let secrets = MemoryStore::default();
        let r = record(NOW);
        let id = oauth::save_signed_in(&path, &secrets, "chatgpt", "ChatGPT (writer@example.com)", &r.to_secret()).unwrap();
        let text = std::fs::read_to_string(&path).unwrap();
        for s in ["ACCESS-OLD", "REFRESH-OLD", "oaiapp_1", "id.tok.en"] {
            assert!(!text.contains(s), "{s} in the connections file");
        }
        let (plan_found, saved) = saved_sign_in(&path, &secrets, &id).unwrap().unwrap();
        assert_eq!(plan_found, plan());
        assert_eq!(saved, r);
        // A renewal replaces the record of that connection only.
        let mut renewed = r.clone();
        renewed.access_token = "ACCESS-RENEWED".into();
        save_renewed(&path, &secrets, "chatgpt", &id, &renewed).unwrap();
        assert_eq!(saved_sign_in(&path, &secrets, &id).unwrap().unwrap().1.access_token, "ACCESS-RENEWED");
        assert_eq!(save_renewed(&path, &secrets, "chatgpt", "gone", &renewed).unwrap_err().kind, "not_connected");
        // The resolver hands out the record (ai_fetch turns it into the access token).
        let resolver = connections::FileResolver::new(path.clone(), Arc::new(secrets));
        let conn = resolver.resolve(&id).unwrap();
        assert_eq!(TokenRecord::parse(conn.secret.as_ref().unwrap()).unwrap().access_token, "ACCESS-RENEWED");
        assert_eq!(conn.provider.base_url, Some("https://api.openai.com/v1"));
    }

    /// A local HTTP server answering `routes` (path, status, body), one request per connection, until
    /// dropped. Returns its base URL and the request lines it saw.
    async fn routed(routes: Vec<(&'static str, &'static str, String)>) -> (String, Arc<Mutex<Vec<String>>>) {
        let l = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).await.unwrap();
        let port = l.local_addr().unwrap().port();
        let seen = Arc::new(Mutex::new(Vec::new()));
        let log = seen.clone();
        tokio::spawn(async move {
            loop {
                let Ok((mut s, _)) = l.accept().await else { return };
                let mut buf = vec![0u8; 16 * 1024];
                let mut got = Vec::new();
                loop {
                    let n = s.read(&mut buf).await.unwrap_or(0);
                    got.extend_from_slice(&buf[..n]);
                    let text = String::from_utf8_lossy(&got);
                    if let Some(i) = text.find("\r\n\r\n") {
                        let len = text[..i]
                            .lines()
                            .find_map(|l| l.to_ascii_lowercase().strip_prefix("content-length:").map(|v| v.trim().parse::<usize>().unwrap()))
                            .unwrap_or(0);
                        if got.len() >= i + 4 + len {
                            break;
                        }
                    }
                    if n == 0 {
                        break;
                    }
                }
                let text = String::from_utf8_lossy(&got).into_owned();
                let line = text.lines().next().unwrap_or_default().to_owned();
                log.lock().unwrap().push(line.clone());
                let path = line.split(' ').nth(1).unwrap_or_default().to_owned();
                let (status, body) = routes.iter().find(|(p, _, _)| *p == path).map(|(_, st, b)| (*st, b.clone())).unwrap_or(("404 Not Found", String::new()));
                let reply = format!("HTTP/1.1 {status}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len());
                let _ = s.write_all(reply.as_bytes()).await;
            }
        });
        (format!("http://127.0.0.1:{port}"), seen)
    }

    fn token_reply(scope: &str) -> String {
        serde_json::json!({
            "access_token": "ACCESS-1", "refresh_token": "REFRESH-1", "id_token": token("good"),
            "token_type": "Bearer", "expires_in": 3600, "scope": scope,
        })
        .to_string()
    }

    #[tokio::test]
    async fn a_sign_in_exchanges_checks_the_id_token_against_the_keys_and_keeps_the_scopes() {
        let jwks = test_jwks().to_string();
        let (base, seen) = routed(vec![
            ("/oauth/token", "200 OK", token_reply("openid offline_access resource.invoke chatgpt.tokens.use.direct")),
            ("/jwks", "200 OK", jwks),
        ])
        .await;
        let cb = Callback { code: "CODE".into(), client_id: "oaiapp_1".into() };
        let (record, identity) = exchange_and_verify(&super::super::fetch::client(), &plan_at(&base), &cb, "V", "http://127.0.0.1:9/auth/callback", "N0NCE", NOW).await.unwrap();
        assert_eq!(identity.sub, "user-sub");
        assert_eq!((record.client_id.as_str(), record.access_token.as_str(), record.refresh_token.as_str()), ("oaiapp_1", "ACCESS-1", "REFRESH-1"));
        assert!(record.plan_enabled(&plan()));
        assert_eq!(seen.lock().unwrap().iter().map(|l| l.split(' ').take(2).collect::<Vec<_>>().join(" ")).collect::<Vec<_>>(), ["POST /oauth/token", "GET /jwks"]);
        // The wrong nonce fails the check: nothing to save.
        let (base, _) = routed(vec![("/oauth/token", "200 OK", token_reply("openid")), ("/jwks", "200 OK", test_jwks().to_string())]).await;
        assert!(exchange_and_verify(&super::super::fetch::client(), &plan_at(&base), &cb, "V", "x", "OTHER", NOW).await.is_err());
    }

    struct Files {
        dir: tempfile::TempDir,
        secrets: MemoryStore,
    }

    impl Files {
        fn new() -> Self {
            Files { dir: tempfile::tempdir().unwrap(), secrets: MemoryStore::default() }
        }
        fn conns(&self) -> PathBuf {
            self.dir.path().join(connections::CONNECTIONS_FILE)
        }
        fn host(&self) -> PathBuf {
            self.dir.path().join(HOST_FILE)
        }
        fn save(&self, reauth: Option<&Reauth>, record: TokenRecord, identity: &Identity) -> Result<String, AiError> {
            let (c, h) = (self.conns(), self.host());
            let files = SignInFiles { connections: &c, host: &h, secrets: &self.secrets };
            save_sign_in(&files, "chatgpt", &plan(), reauth, record, identity)
        }
        fn accounts(&self) -> Vec<KnownAccount> {
            serde_json::from_str::<HostFile>(&std::fs::read_to_string(self.host()).unwrap()).unwrap().accounts
        }
        fn live(&self) -> Vec<String> {
            connections::load_connections(&self.conns()).unwrap().into_iter().map(|c| c.id).collect()
        }
    }

    /// Sign out with the plan's endpoints on a mock.
    async fn sign_out_with(p: &PlanSignIn, conns: PathBuf, host: PathBuf, secrets: Arc<dyn SecretStore>, id: String) -> Result<Option<bool>, AiError> {
        sign_out_inner(&super::super::fetch::client(), Some(p), conns, host, secrets, id).await
    }

    fn writer() -> Identity {
        Identity { sub: "user-sub".into(), email: Some("writer@example.com".into()) }
    }

    fn reuse(f: &Files) -> Option<Reauth> {
        reuse_for(&f.conns(), &f.host()).unwrap()
    }

    #[test]
    fn a_granted_sign_in_saves_the_connection_and_remembers_the_issued_client() {
        let f = Files::new();
        let id = f.save(None, record(NOW + 3600), &writer()).unwrap();
        assert_eq!(f.live(), std::slice::from_ref(&id));
        let accounts = f.accounts();
        assert_eq!(accounts.len(), 1);
        assert_eq!((accounts[0].client_id.as_str(), accounts[0].connection_id.as_deref()), ("oaiapp_1", Some(id.as_str())));
        // The host file holds no token.
        let text = std::fs::read_to_string(f.host()).unwrap();
        for t in ["ACCESS-OLD", "REFRESH-OLD", "id.tok.en"] {
            assert!(!text.contains(t), "{t}");
        }
        // The account has a connection: a new sign-in registers (another account) rather than reuse.
        assert!(reuse(&f).is_none());
    }

    #[test]
    fn a_declined_plan_keeps_the_client_and_the_retry_reuses_it_asking_for_consent() {
        let f = Files::new();
        let mut declined = record(NOW + 3600);
        declined.scopes = vec!["openid".into(), "email".into()];
        let e = f.save(None, declined, &writer()).unwrap_err();
        assert!(e.message.contains("did not allow Novel to use your ChatGPT plan"), "{}", e.message);
        assert!(f.live().is_empty(), "no connection without the plan");
        assert!(f.accounts()[0].plan_declined);
        let r = reuse(&f).unwrap();
        assert_eq!((r.client_id.as_str(), r.login_hint.as_deref(), r.prompt_consent), ("oaiapp_1", Some("writer@example.com"), true));
        assert!(r.connection_id.is_none() && r.id_token_hint.is_none());
        let q = query(&authorize_url(&plan(), 1, "c", "s", "n", "urn:uuid:h", Some(&r)));
        assert!(q.contains(&("client_id".to_owned(), "oaiapp_1".to_owned())), "not dynamic_agent_client");
        assert!(!q.iter().any(|(k, _)| k == "agent_name_hint"));
        // The retry, granted, adds the connection under the same client.
        let id = f.save(Some(&r), record(NOW + 3600), &writer()).unwrap();
        assert_eq!(f.accounts()[0].connection_id.as_deref(), Some(id.as_str()));
        assert!(!f.accounts()[0].plan_declined);
    }

    #[tokio::test]
    async fn remove_signs_out_under_the_lock_and_keeps_the_client_for_the_next_sign_in() {
        let f = Files::new();
        let id = f.save(None, record(NOW + 3600), &writer()).unwrap();
        let (base, seen) = routed(vec![("/oauth/revoke", "200 OK", String::new())]).await;
        // The descriptor's revoke URL is fixed, so sign out through the plan on the mock.
        let store: Arc<dyn SecretStore> = Arc::new(MemoryStore(Mutex::new(f.secrets.0.lock().unwrap().clone())));
        let revoked = sign_out_with(&plan_at(&base), f.conns(), f.host(), store.clone(), id.clone()).await.unwrap();
        assert_eq!(revoked, Some(true));
        assert_eq!(seen.lock().unwrap().len(), 1);
        assert!(f.live().is_empty());
        assert!(store.get(&id).unwrap().is_none(), "the tokens are gone");
        // The account and its client stay; the next Continue with ChatGPT reuses them.
        let acc = &f.accounts()[0];
        assert_eq!((acc.client_id.as_str(), acc.connection_id.as_deref()), ("oaiapp_1", None));
        let r = reuse(&f).unwrap();
        assert_eq!((r.client_id.as_str(), r.prompt_consent), ("oaiapp_1", false));
    }

    #[tokio::test]
    async fn remove_with_unreadable_tokens_reports_an_unconfirmed_sign_out() {
        let f = Files::new();
        let id = f.save(None, record(NOW + 3600), &writer()).unwrap();
        // The stored value is no token record (damaged): the sign-out cannot be confirmed (M4).
        let c = connections::load_connections(&f.conns()).unwrap().remove(0);
        let damaged = MemoryStore::default();
        damaged.set(&id, &serde_json::json!({ "v": 1, "b": "chatgpt|oauth|https://api.openai.com", "s": "not a record" }).to_string()).unwrap();
        assert_eq!(c.provider, "chatgpt");
        let (base, seen) = routed(vec![]).await;
        let revoked = sign_out_with(&plan_at(&base), f.conns(), f.host(), Arc::new(damaged), id).await.unwrap();
        assert_eq!(revoked, Some(false));
        assert!(seen.lock().unwrap().is_empty());
        assert!(f.live().is_empty());
        // Not a plan connection: nothing to sign out.
        connections::save_connections(&f.conns(), &f.secrets, vec![Connection {
            id: "k".into(),
            provider: "openai".into(),
            label: "OpenAI".into(),
            auth: connections::ConnectionAuth::ApiKey,
            base_url: None,
            default_model: None,
            tool_support: None,
            insecure_http_accepted: None,
            extra: Default::default(),
        }])
        .unwrap();
        let none = sign_out_with(&plan_at(&base), f.conns(), f.host(), Arc::new(MemoryStore::default()), "k".into()).await.unwrap();
        assert_eq!(none, None);
    }

    #[test]
    fn reusing_a_known_client_that_comes_back_with_another_account_saves_nothing_and_registers_next_time() {
        let f = Files::new();
        let mut declined = record(NOW + 3600);
        declined.scopes = vec!["openid".into()];
        let _ = f.save(None, declined, &writer());
        let r = reuse(&f).unwrap();
        let other = Identity { sub: "someone-else".into(), email: None };
        let e = f.save(Some(&r), record(NOW + 3600), &other).unwrap_err();
        assert!(e.message.contains("different ChatGPT account"), "{}", e.message);
        assert!(f.live().is_empty());
        assert!(reuse(&f).is_none(), "the next new sign-in registers");
    }

    #[test]
    fn two_known_accounts_without_connections_are_not_guessed() {
        let f = Files::new();
        for (sub, client) in [("a", "oaiapp_a"), ("b", "oaiapp_b")] {
            remember_account(&f.host(), KnownAccount { sub: sub.into(), email: None, client_id: client.into(), connection_id: None, plan_declined: false, skip: false }).unwrap();
        }
        assert!(reuse(&f).is_none());
        forget_connection(&f.host(), "nothing").unwrap();
        // The host id is kept across account writes.
        let id = host_id(&f.host()).unwrap();
        remember_account(&f.host(), KnownAccount { sub: "a".into(), email: None, client_id: "oaiapp_a2".into(), connection_id: None, plan_declined: false, skip: false }).unwrap();
        assert_eq!(host_id(&f.host()).unwrap(), id);
        assert_eq!(f.accounts().iter().find(|a| a.sub == "a").unwrap().client_id, "oaiapp_a2");
    }

    #[tokio::test]
    async fn a_refreshed_record_the_keychain_refuses_is_used_and_kept_until_it_is_stored() {
        let client = super::super::fetch::client();
        let (base, seen) = routed(vec![(
            "/oauth/token",
            "200 OK",
            r#"{"access_token":"ACCESS-NEW","refresh_token":"REFRESH-NEW","expires_in":3600}"#.to_owned(),
        )])
        .await;
        let p = plan_at(&base);
        let conn_id = "pending-test-connection";
        let r = OneConnection::new(record(now_secs() + 10).to_secret());
        *r.fail_store.lock().unwrap() = true;
        let out = with_access_token(&client, r.clone(), conn_id, r.resolve(conn_id).unwrap(), &p).await.unwrap();
        assert_eq!(out.secret.unwrap().expose(), "ACCESS-NEW", "the request still gets the new token");
        assert_eq!(*r.stores.lock().unwrap(), 0);
        // The keychain still holds the spent record; the next request uses the kept one, no second refresh.
        let out = with_access_token(&client, r.clone(), conn_id, r.resolve(conn_id).unwrap(), &p).await.unwrap();
        assert_eq!(out.secret.unwrap().expose(), "ACCESS-NEW");
        assert_eq!(seen.lock().unwrap().len(), 1, "one refresh POST");
        // Once the keychain works again, the kept record is stored and forgotten.
        *r.fail_store.lock().unwrap() = false;
        with_access_token(&client, r.clone(), conn_id, r.resolve(conn_id).unwrap(), &p).await.unwrap();
        assert_eq!(TokenRecord::parse(&r.secret.lock().unwrap()).unwrap().refresh_token, "REFRESH-NEW");
        assert!(pending_live(conn_id).is_none());
    }

    #[tokio::test]
    async fn a_refresh_that_finishes_after_the_connection_was_re_pointed_stores_nothing() {
        let dir = tempfile::tempdir().unwrap();
        let conns = dir.path().join(connections::CONNECTIONS_FILE);
        let host = dir.path().join(HOST_FILE);
        let secrets = Arc::new(MemoryStore::default());
        let files = SignInFiles { connections: &conns, host: &host, secrets: secrets.as_ref() };
        let id = save_sign_in(&files, "chatgpt", &plan(), None, record(now_secs() + 10), &writer()).unwrap();
        // The token endpoint: while the refresh is in flight, the webview re-points the connection to an
        // origin of its choosing; then the endpoint answers with a new record.
        let l = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).await.unwrap();
        let base = format!("http://127.0.0.1:{}", l.local_addr().unwrap().port());
        let (c2, s2, id2) = (conns.clone(), secrets.clone(), id.clone());
        tokio::spawn(async move {
            let (mut s, _) = l.accept().await.unwrap();
            let mut buf = vec![0u8; 16 * 1024];
            let mut got = Vec::new();
            while !String::from_utf8_lossy(&got).contains("refresh_token=REFRESH-OLD") {
                let n = s.read(&mut buf).await.unwrap();
                assert!(n > 0, "the refresh request arrives");
                got.extend_from_slice(&buf[..n]);
            }
            let mut evil = connections::load_connections(&c2).unwrap().into_iter().find(|c| c.id == id2).unwrap();
            evil.provider = "custom".into();
            evil.base_url = Some("https://evil.example/v1".into());
            connections::upsert_connection(&c2, s2.as_ref(), evil).unwrap();
            let body = r#"{"access_token":"ACCESS-NEW","refresh_token":"REFRESH-NEW","expires_in":3600}"#;
            let reply = format!("HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len());
            s.write_all(reply.as_bytes()).await.unwrap();
        });
        let resolver: Arc<dyn ConnectionResolver> = Arc::new(connections::FileResolver::new(conns.clone(), secrets.clone()));
        let conn = resolver.resolve(&id).unwrap();
        let e = with_access_token(&super::super::fetch::client(), resolver.clone(), &id, conn, &plan_at(&base)).await.unwrap_err();
        assert_eq!(e, connections::changed_meanwhile());
        // Nothing in the keychain for the re-pointed connection, nothing kept in memory to store later.
        assert!(secrets.get(&id).unwrap().is_none());
        assert!(resolver.resolve(&id).unwrap().secret.is_none());
        assert!(pending_live(&id).is_none());
    }

    fn reuse_with_dead_client() -> (Files, Reauth) {
        let f = Files::new();
        let id = f.save(None, record(NOW + 3600), &writer()).unwrap();
        // Removed (here: the connection is gone from the file), so the account is free for reuse.
        connections::remove_connection(&f.conns(), &f.secrets, &id).unwrap();
        let r = reuse(&f).expect("one known account without a connection");
        (f, r)
    }

    #[test]
    fn every_failure_of_a_reuse_but_a_cancel_or_a_no_moves_off_that_client() {
        let kinds = [
            ("cancelled", "kept"),
            ("superseded", "kept"),
            (DENIED, "kept"),
            (INVALID_CLIENT, "forgotten"),
            (OPENAI_REFUSED, "skipped"), // an OpenAI error on this sign-in's callback, another client id, an OAuth error body
            ("auth", "kept"),            // a timeout, a stray request, a body that is not OpenAI's
            ("network", "kept"),         // a transport error
            ("provider", "kept"),        // an unreadable answer
        ];
        for (kind, want) in kinds {
            let (f, r) = reuse_with_dead_client();
            after_reuse_failure(&f.host(), &r, &AiError::new(kind, "x")).unwrap();
            let accounts = f.accounts();
            let got = match accounts.as_slice() {
                [] => "forgotten",
                [a] if a.skip => "skipped",
                [_] => "kept",
                _ => unreachable!(),
            };
            assert_eq!(got, want, "{kind}");
            // Only a kept entry is reused next time; otherwise Continue with ChatGPT registers anew.
            assert_eq!(reuse(&f).is_some(), want == "kept", "{kind}");
        }
        // A renewal of a saved connection is never touched.
        let f = Files::new();
        let id = f.save(None, record(NOW + 3600), &writer()).unwrap();
        let renewal = reauth_for_test(&id);
        after_reuse_failure(&f.host(), &renewal, &AiError::new(INVALID_CLIENT, "x")).unwrap();
        assert_eq!(f.accounts().len(), 1);
    }

    fn reauth_for_test(connection_id: &str) -> Reauth {
        Reauth {
            connection_id: Some(connection_id.into()),
            client_id: "oaiapp_1".into(),
            sub: "user-sub".into(),
            id_token_hint: None,
            login_hint: None,
            prompt_consent: false,
        }
    }

    #[test]
    fn the_failure_kinds_come_from_the_callback() {
        let p = plan();
        let kind = |head: &str| parse_callback(head, &p, "S", Some("oaiapp_1")).unwrap_err().kind;
        assert_eq!(kind("GET /auth/callback?error=access_denied&state=S HTTP/1.1\r\n\r\n"), DENIED);
        assert_eq!(kind("GET /auth/callback?error=invalid_client&state=S HTTP/1.1\r\n\r\n"), INVALID_CLIENT);
        assert_eq!(kind("GET /auth/callback?error=unauthorized_client&state=S HTTP/1.1\r\n\r\n"), INVALID_CLIENT);
        assert_eq!(kind("GET /auth/callback?error=server_error&state=S HTTP/1.1\r\n\r\n"), OPENAI_REFUSED);
        let other = parse_callback("GET /auth/callback?code=C&state=S&client_id=oaiapp_2 HTTP/1.1\r\n\r\n", &p, "S", Some("oaiapp_1")).unwrap_err();
        assert_eq!(other.kind, OPENAI_REFUSED);
        assert!(!other.message.contains("kept this connection"), "no connection exists in a reuse: {}", other.message);
    }

    #[tokio::test]
    async fn an_exchange_refused_for_the_client_is_an_invalid_client() {
        for code in ["invalid_client", "unauthorized_client"] {
            let body: &'static str = if code == "invalid_client" { r#"{"error":"invalid_client"}"# } else { r#"{"error":"unauthorized_client"}"# };
            let (base, _) = mock("401 Unauthorized", body).await;
            let e = exchange_code(&super::super::fetch::client(), &plan_at(&base), "oaiapp_1", "C", "V", "x").await.unwrap_err();
            assert_eq!(e.kind, INVALID_CLIENT, "{code}");
        }
    }

    #[test]
    fn the_reusable_account_is_offered_by_email_and_a_second_account_can_be_added() {
        let (f, _) = reuse_with_dead_client();
        assert_eq!(reusable_email(&f.conns(), &f.host()).unwrap().as_deref(), Some("writer@example.com"));
        // "Use Another Account": a fresh registration for another account, saved beside the known one.
        let other = Identity { sub: "second-sub".into(), email: Some("second@example.com".into()) };
        let mut rec = record(NOW + 3600);
        rec.client_id = "oaiapp_2".into();
        rec.sub = "second-sub".into();
        let id = f.save(None, rec, &other).unwrap();
        assert_eq!(f.live(), [id]);
        let mut subs: Vec<String> = f.accounts().into_iter().map(|a| a.sub).collect();
        subs.sort();
        assert_eq!(subs, ["second-sub", "user-sub"]);
        // The first account is still the one a plain Continue with ChatGPT would reuse.
        assert_eq!(reusable_email(&f.conns(), &f.host()).unwrap().as_deref(), Some("writer@example.com"));
    }

    #[tokio::test]
    async fn the_failure_kinds_of_the_exchange() {
        let client = super::super::fetch::client();
        for (status, body, want) in [
            ("400 Bad Request", r#"{"error":"invalid_grant"}"#, OPENAI_REFUSED),
            ("400 Bad Request", r#"{"error":"server_error"}"#, OPENAI_REFUSED),
            ("502 Bad Gateway", "<html>proxy</html>", "auth"),
        ] {
            let (base, _) = mock(status, body).await;
            let e = exchange_code(&client, &plan_at(&base), "oaiapp_1", "C", "V", "x").await.unwrap_err();
            assert_eq!(e.kind, want, "{status} {body}");
        }
        // Nobody listening: a transport error.
        let l = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).await.unwrap();
        let base = format!("http://127.0.0.1:{}", l.local_addr().unwrap().port());
        drop(l);
        assert_eq!(exchange_code(&client, &plan_at(&base), "oaiapp_1", "C", "V", "x").await.unwrap_err().kind, "network");
    }

    #[test]
    fn a_timeout_or_a_transport_error_leaves_the_known_account_as_it_was() {
        let (f, r) = reuse_with_dead_client();
        let before = f.accounts();
        for e in [
            oauth::refused("The sign-in timed out. Try again."),
            AiError::new("network", "Novel could not reach ChatGPT. Check your connection and try again."),
            AiError::cancelled(),
        ] {
            after_reuse_failure(&f.host(), &r, &e).unwrap();
            assert_eq!(f.accounts(), before, "{}", e.message);
        }
        assert!(reuse(&f).is_some());
        // invalid_client forgets; another OpenAI error skips.
        after_reuse_failure(&f.host(), &r, &AiError::new(OPENAI_REFUSED, "x")).unwrap();
        assert!(f.accounts()[0].skip);
        let (f, r) = reuse_with_dead_client();
        after_reuse_failure(&f.host(), &r, &AiError::new(INVALID_CLIENT, "x")).unwrap();
        assert!(f.accounts().is_empty());
    }

    async fn send(port: u16, request: &str) -> String {
        let mut s = tokio::net::TcpStream::connect((Ipv4Addr::LOCALHOST, port)).await.unwrap();
        s.write_all(request.as_bytes()).await.unwrap();
        let mut out = String::new();
        let _ = s.read_to_string(&mut out).await;
        out
    }

    #[tokio::test]
    async fn stray_loopback_requests_are_ignored_and_the_real_callback_still_succeeds() {
        let l = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).await.unwrap();
        let port = l.local_addr().unwrap().port();
        let (_tx, rx) = tokio::sync::watch::channel(oauth::Stop::Running);
        let wait = tokio::spawn(async move {
            let p = plan();
            oauth::wait_for_reply(l, Duration::from_secs(5), rx, |h| classify_callback(h, &p, "S", Some("oaiapp_1"))).await
        });
        for (stray, status) in [
            ("GET /auth/callback?code=C&state=WRONG HTTP/1.1\r\n\r\n", "400"),
            ("GET /auth/callback?error=invalid_client HTTP/1.1\r\n\r\n", "400"), // an error without this state
            ("GET /auth/callback?error=invalid_client&state=WRONG HTTP/1.1\r\n\r\n", "400"),
            ("POST /auth/callback?code=C&state=S HTTP/1.1\r\nContent-Length: 0\r\n\r\n", "405"),
            ("GET /callback?code=C&state=S HTTP/1.1\r\n\r\n", "404"),
        ] {
            let page = send(port, stray).await;
            assert!(page.starts_with(&format!("HTTP/1.1 {status}")), "{stray}: {page}");
            assert!(!wait.is_finished(), "{stray}: still waiting");
        }
        let page = send(port, "GET /auth/callback?code=REAL&state=S HTTP/1.1\r\n\r\n").await;
        assert!(page.starts_with("HTTP/1.1 200"), "{page}");
        let cb = wait.await.unwrap().unwrap();
        assert_eq!((cb.code.as_str(), cb.client_id.as_str()), ("REAL", "oaiapp_1"));
    }

    #[tokio::test]
    async fn an_openai_error_with_this_state_ends_the_wait() {
        let l = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).await.unwrap();
        let port = l.local_addr().unwrap().port();
        let (_tx, rx) = tokio::sync::watch::channel(oauth::Stop::Running);
        let wait = tokio::spawn(async move {
            let p = plan();
            oauth::wait_for_reply(l, Duration::from_secs(5), rx, |h| classify_callback(h, &p, "S", Some("oaiapp_1"))).await
        });
        send(port, "GET /auth/callback?error=invalid_client&state=S HTTP/1.1\r\n\r\n").await;
        assert_eq!(wait.await.unwrap().unwrap_err().kind, INVALID_CLIENT);
    }

}
