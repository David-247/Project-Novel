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

use std::net::Ipv4Addr;
use std::path::{Path, PathBuf};
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

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct HostFile {
    version: u32,
    host_id: String,
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

/// This installation's host id: the saved one, else a new one, saved before it is first used.
pub fn host_id(path: &Path) -> Result<String, AiError> {
    let _lock = HOST.lock().unwrap_or_else(|e| e.into_inner());
    if let Ok(text) = std::fs::read_to_string(path) {
        if let Ok(f) = serde_json::from_str::<HostFile>(&text) {
            if f.version == 1 && host_id_ok(&f.host_id) {
                return Ok(f.host_id);
            }
        }
    }
    let id = new_host_id()?;
    let text = serde_json::to_string_pretty(&HostFile { version: 1, host_id: id.clone() })
        .map_err(|_| AiError::bad_request("The sign-in could not start."))?;
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(|_| AiError::bad_request("The app data folder could not be created."))?;
    }
    crate::storage::write_atomic(path, text.as_bytes()).map_err(|_| AiError::bad_request("The sign-in could not start: the host id could not be saved."))?;
    Ok(id)
}

// ---- The authorization request -----------------------------------------------------------------------

/// What a renewed sign-in of a saved connection sends and checks.
#[derive(Clone)]
pub struct Reauth {
    pub connection_id: String,
    pub client_id: String,
    /// The account the connection belongs to: the new tokens must be for it.
    pub sub: String,
    pub id_token_hint: Option<String>,
    pub login_hint: Option<String>,
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
            refused("You did not allow Novel to use your ChatGPT account. Try again if you meant to sign in.")
        } else {
            refused("ChatGPT did not finish the sign-in. Try again.")
        });
    }
    let code = match codes.as_slice() {
        [c] if !c.is_empty() && c.chars().count() <= MAX_CODE_CHARS && !c.chars().any(char::is_control) => c.clone(),
        _ => return Err(refused(NOT_EXPECTED)),
    };
    let client_id = match (clients.as_slice(), saved_client) {
        ([], Some(saved)) => saved.to_owned(),
        ([c], Some(saved)) if c == saved => c.clone(),
        ([_], Some(_)) => return Err(refused("ChatGPT answered for another registration, so Novel kept this connection as it was. Try again.")),
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
            Some("invalid_grant") => AiError::new("auth", "The sign-in code expired before Novel could use it. Try again."),
            _ => AiError::new("auth", format!("ChatGPT refused the sign-in (HTTP {status}). Try again.")),
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
        Value::Array(list) => list.iter().any(|a| a == client_id),
        _ => false,
    };
    if !aud_ok {
        return Err(bad());
    }
    let exp = claims["exp"].as_i64().ok_or_else(bad)?;
    if exp + CLOCK_SKEW_SECS < now || claims["iat"].as_i64().is_none() {
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

/// One refresh at a time: the refresh token rotates, so two refreshes of one session must not race.
static REFRESH: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

fn read_record(conn: &ResolvedConnection) -> Result<TokenRecord, AiError> {
    conn.secret.as_ref().and_then(TokenRecord::parse).ok_or_else(|| AiError::new("auth", SIGNED_OUT))
}

/// `conn` with its token record replaced by the access token `ai_fetch` sends (refreshed and saved
/// first when it is due). Refused when the plan scope was not granted.
pub async fn with_access_token(
    client: &reqwest::Client,
    resolver: Arc<dyn ConnectionResolver>,
    connection_id: &str,
    conn: ResolvedConnection,
    plan: &PlanSignIn,
) -> Result<ResolvedConnection, AiError> {
    let mut record = read_record(&conn)?;
    if !record.plan_enabled(plan) {
        return Err(AiError::new(
            "auth",
            "Novel was not allowed to use your ChatGPT plan. Choose Sign In Again for this connection and allow it, or use an API key.",
        ));
    }
    if record.needs_refresh(now_secs()) {
        let _one = REFRESH.lock().await;
        // Another request may have refreshed while this one waited: read the record again.
        let (r, id) = (resolver.clone(), connection_id.to_owned());
        let latest = tokio::task::spawn_blocking(move || r.resolve(&id))
            .await
            .map_err(|_| AiError::new("not_connected", "The AI connection could not be read."))??;
        record = read_record(&latest)?;
        if record.needs_refresh(now_secs()) {
            let next = refresh(client, plan, &record, now_secs()).await?;
            let (r, id, secret) = (resolver, connection_id.to_owned(), next.to_secret());
            tokio::task::spawn_blocking(move || r.store_secret(&id, &secret))
                .await
                .map_err(|_| AiError::new("auth", "The renewed sign-in could not be saved."))??;
            record = next;
        }
    }
    Ok(ResolvedConnection { secret: Some(Secret::new(record.access_token)), ..conn })
}

// ---- Sign out ------------------------------------------------------------------------------------------------

/// The plan sign-in and token record of a saved connection, if it is one and the record can be read.
pub fn saved_sign_in(path: &Path, secrets: &dyn SecretStore, connection_id: &str) -> Result<Option<(PlanSignIn, TokenRecord)>, AiError> {
    let Some((c, secret)) = connections::connection_secret(path, secrets, connection_id)? else { return Ok(None) };
    let Some(plan) = providers::descriptor(&c.provider).and_then(|d| d.plan_sign_in) else { return Ok(None) };
    Ok(TokenRecord::parse(&secret).map(|r| (plan, r)))
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
    Ok(connection_id.to_owned())
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
    Ok(Reauth { connection_id: connection_id.to_owned(), client_id: r.client_id, sub: r.sub, id_token_hint: r.id_token, login_hint: r.email })
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
) -> Result<(), AiError> {
    let path = super::connections_file(&app)?;
    let host_path = app_file(&app, HOST_FILE)?;
    let (p, prov) = (path.clone(), provider.clone());
    let reauth = match connection_id {
        Some(id) => Some(super::blocking(move || reauth_for(&p, &prov, &id)).await?),
        None => None,
    };
    let host = super::blocking(move || host_id(&host_path)).await?;
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
            let callback = oauth::wait_for_reply(listener, CALLBACK_TIMEOUT, stop, |head| parse_callback(head, &plan, &state, saved_client.as_deref())).await?;
            let redirect = redirect_uri(&plan, port);
            let tokens = exchange_code(&client, &plan, &callback.client_id, &callback.code, &pkce.verifier, &redirect).await?;
            let jwks = fetch_jwks(&client, plan.jwks_url).await?;
            let id_token = tokens.id_token.clone().unwrap_or_default();
            let identity = verify_id_token(&id_token, &jwks, &plan, &callback.client_id, &nonce, now_secs())?;
            if let Some(r) = &reauth {
                if !oauth::same(&r.sub, &identity.sub) {
                    return Err(AiError::new(
                        "auth",
                        "You signed in with a different ChatGPT account, so this connection was kept as it was. To add that account, use Continue with ChatGPT.",
                    ));
                }
            }
            let record = record_from(tokens, callback.client_id, identity.clone(), now_secs())?;
            if !record.plan_enabled(&plan) {
                return Err(AiError::new(
                    "auth",
                    "You signed in, but did not allow Novel to use your ChatGPT plan, so nothing was saved. Try again and allow it, or use an API key.",
                ));
            }
            // Cancelled (or replaced) meanwhile: the tokens are dropped, nothing is saved.
            oauth::still_wanted(&wanted)?;
            match reauth {
                Some(r) => super::blocking(move || save_renewed(&path, &KeyringStore, &provider, &r.connection_id, &record)).await,
                None => {
                    let name = connection_name(&plan, &identity);
                    super::blocking(move || oauth::save_signed_in(&path, &KeyringStore, &provider, &name, &record.to_secret())).await
                }
            }
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
        let r = Reauth {
            connection_id: "c".into(),
            client_id: "oaiapp_123".into(),
            sub: "s".into(),
            id_token_hint: Some("old.id.token".into()),
            login_hint: Some("a@example.com".into()),
        };
        let q = query(&authorize_url(&plan(), 5, "c", "s", "n", "urn:uuid:h", Some(&r)));
        let get = |k: &str| q.iter().find(|(n, _)| n == k).map(|(_, v)| v.as_str());
        assert_eq!(get("client_id"), Some("oaiapp_123"));
        assert_eq!(get("agent_name_hint"), None, "only on a first registration");
        assert_eq!(get("id_token_hint"), Some("old.id.token"));
        assert_eq!(get("login_hint"), Some("a@example.com"));
        assert_eq!(get("ext_agent_host_id"), Some("urn:uuid:h"));
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

    // ---- ID tokens: a test RSA key (generated for these tests only; not used anywhere else) ----

    /// Sign `claims` with the test key as an RS256 JWT with `kid`.
    fn jwt(claims: &Value, kid: &str) -> String {
        let key = ring::signature::RsaKeyPair::from_pkcs8(&test_key_pkcs8()).unwrap();
        let h = URL_SAFE_NO_PAD.encode(serde_json::json!({ "alg": "RS256", "kid": kid, "typ": "JWT" }).to_string());
        let p = URL_SAFE_NO_PAD.encode(claims.to_string());
        let input = format!("{h}.{p}");
        let mut sig = vec![0u8; key.public().modulus_len()];
        key.sign(&ring::signature::RSA_PKCS1_SHA256, &ring::rand::SystemRandom::new(), input.as_bytes(), &mut sig).unwrap();
        format!("{input}.{}", URL_SAFE_NO_PAD.encode(sig))
    }

    fn test_jwks() -> Value {
        use ring::signature::KeyPair as _;
        let key = ring::signature::RsaKeyPair::from_pkcs8(&test_key_pkcs8()).unwrap();
        let comps: ring::signature::RsaPublicKeyComponents<Vec<u8>> = key.public_key().into();
        serde_json::json!({ "keys": [
            { "kty": "RSA", "kid": "other", "use": "sig", "alg": "RS256", "n": "AQAB", "e": "AQAB" },
            { "kty": "RSA", "kid": "k1", "use": "sig", "alg": "RS256", "n": URL_SAFE_NO_PAD.encode(&comps.n), "e": URL_SAFE_NO_PAD.encode(&comps.e) },
        ]})
    }

    fn test_key_pkcs8() -> Vec<u8> {
        use base64::engine::general_purpose::STANDARD;
        STANDARD.decode(TEST_KEY_PKCS8.split_whitespace().collect::<String>()).unwrap()
    }

    const NOW: i64 = 1_800_000_000;

    fn claims() -> Value {
        serde_json::json!({
            "iss": "https://auth.openai.com", "sub": "user-sub", "aud": ["oaiapp_1"], "nonce": "N0NCE",
            "iat": NOW - 10, "exp": NOW + 3600, "email": "writer@example.com",
        })
    }

    #[test]
    fn a_good_id_token_verifies() {
        let id = verify_id_token(&jwt(&claims(), "k1"), &test_jwks(), &plan(), "oaiapp_1", "N0NCE", NOW).unwrap();
        assert_eq!(id, Identity { sub: "user-sub".into(), email: Some("writer@example.com".into()) });
        // A string audience works too.
        let mut c = claims();
        c["aud"] = "oaiapp_1".into();
        assert!(verify_id_token(&jwt(&c, "k1"), &test_jwks(), &plan(), "oaiapp_1", "N0NCE", NOW).is_ok());
    }

    #[test]
    fn a_bad_id_token_is_refused() {
        let check = |token: &str, client: &str, nonce: &str, now: i64| verify_id_token(token, &test_jwks(), &plan(), client, nonce, now);
        let good = jwt(&claims(), "k1");
        assert!(check(&good, "oaiapp_2", "N0NCE", NOW).is_err(), "audience");
        assert!(check(&good, "oaiapp_1", "OTHER", NOW).is_err(), "nonce");
        assert!(check(&good, "oaiapp_1", "N0NCE", NOW + 3600 + CLOCK_SKEW_SECS + 1).is_err(), "expired");
        assert!(check(&jwt(&claims(), "unknown-kid"), "oaiapp_1", "N0NCE", NOW).is_err(), "unknown key");
        assert!(check(&jwt(&claims(), "other"), "oaiapp_1", "N0NCE", NOW).is_err(), "signed by another key");
        for (field, value) in [("iss", Value::from("https://evil.example")), ("sub", Value::from("")), ("iat", Value::Null), ("nonce", Value::Null)] {
            let mut c = claims();
            c[field] = value;
            assert!(check(&jwt(&c, "k1"), "oaiapp_1", "N0NCE", NOW).is_err(), "{field}");
        }
        // A tampered payload, an alg of none, garbage.
        let parts: Vec<&str> = good.split('.').collect();
        let mut evil = claims();
        evil["sub"] = "attacker".into();
        let tampered = format!("{}.{}.{}", parts[0], URL_SAFE_NO_PAD.encode(evil.to_string()), parts[2]);
        assert!(check(&tampered, "oaiapp_1", "N0NCE", NOW).is_err(), "tampered");
        let none = format!("{}.{}.", URL_SAFE_NO_PAD.encode(r#"{"alg":"none","kid":"k1"}"#), parts[1]);
        assert!(check(&none, "oaiapp_1", "N0NCE", NOW).is_err(), "alg none");
        assert!(check("not-a-jwt", "oaiapp_1", "N0NCE", NOW).is_err());
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
    }

    impl ConnectionResolver for OneConnection {
        fn resolve(&self, _id: &str) -> Result<ResolvedConnection, AiError> {
            Ok(ResolvedConnection {
                provider: providers::descriptor("chatgpt").unwrap(),
                base_url: None,
                secret: Some(self.secret.lock().unwrap().clone()),
                insecure_http_accepted: false,
            })
        }
        fn store_secret(&self, _id: &str, secret: &Secret) -> Result<(), AiError> {
            *self.secret.lock().unwrap() = secret.clone();
            *self.stores.lock().unwrap() += 1;
            Ok(())
        }
    }

    #[tokio::test]
    async fn ai_fetch_sends_the_access_token_and_refreshes_when_due() {
        let client = super::super::fetch::client();
        // Fresh: no refresh, the access token replaces the record.
        let fresh = Arc::new(OneConnection { secret: Mutex::new(record(now_secs() + 3600).to_secret()), stores: Mutex::new(0) });
        let conn = fresh.resolve("c").unwrap();
        let out = with_access_token(&client, fresh.clone(), "c", conn, &plan()).await.unwrap();
        assert_eq!(out.secret.unwrap().expose(), "ACCESS-OLD");
        assert_eq!(*fresh.stores.lock().unwrap(), 0);
        // Due: refreshed, saved, and the new token is sent.
        let (base, _) = mock("200 OK", r#"{"access_token":"ACCESS-NEW","refresh_token":"REFRESH-NEW","expires_in":3600}"#).await;
        let due = Arc::new(OneConnection { secret: Mutex::new(record(now_secs() + 10).to_secret()), stores: Mutex::new(0) });
        let conn = due.resolve("c").unwrap();
        let out = with_access_token(&client, due.clone(), "c", conn, &plan_at(&base)).await.unwrap();
        assert_eq!(out.secret.unwrap().expose(), "ACCESS-NEW");
        assert_eq!(*due.stores.lock().unwrap(), 1);
        let saved = TokenRecord::parse(&due.secret.lock().unwrap()).unwrap();
        assert_eq!(saved.refresh_token, "REFRESH-NEW");
        // Without the plan scope nothing is sent.
        let mut no_plan = record(now_secs() + 3600);
        no_plan.scopes = vec!["openid".into()];
        let r = Arc::new(OneConnection { secret: Mutex::new(no_plan.to_secret()), stores: Mutex::new(0) });
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

    /// A throwaway 2048-bit RSA key, base64 PKCS#8 DER, made for these tests only (`openssl genpkey
    /// -algorithm RSA -pkeyopt rsa_keygen_bits:2048 | openssl pkcs8 -topk8 -nocrypt -outform DER`). It
    /// signs nothing outside them.
    const TEST_KEY_PKCS8: &str = include_str!("testdata/chatgpt-test-rsa.pk8.b64");
}
