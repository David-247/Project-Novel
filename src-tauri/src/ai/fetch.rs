//! The request itself: validate the path, pick the host, filter headers, add the credential, send,
//! and stream the body back. Every error message is redacted of the connection's secret.

use std::time::Duration;

use base64::Engine as _;
use reqwest::header::{HeaderMap, HeaderName, HeaderValue, AUTHORIZATION};
use reqwest::{Client, StatusCode, Url};
use tokio::sync::watch;

use super::providers::Auth;
use super::{AiError, AiFetchEvent, AiRequest, Method, ResolvedConnection};

/// The only caller header names forwarded (ruling R2). Credentials, cookies, `host`, `user-agent`,
/// `x-stainless-*` and everything else are dropped; Rust sets the credential and the provider's
/// own headers (`anthropic-version`).
pub const FORWARDED_HEADERS: &[&str] = &["content-type", "accept", "anthropic-beta", "openai-beta"];

/// Request body cap (a whole 100k-word manuscript is well under 2 MB of JSON).
const MAX_BODY_BYTES: usize = 16 * 1024 * 1024;
/// How much of a provider's error body is quoted in the error message.
const ERROR_EXCERPT_CHARS: usize = 300;
const CONNECT_TIMEOUT: Duration = Duration::from_secs(20);
/// Longest silence between two body reads (a local model may take minutes to load).
const READ_TIMEOUT: Duration = Duration::from_secs(300);

/// Hosts that never go through a proxy, whatever `NO_PROXY` says: this machine by name, and every IP
/// literal (loopback, LAN and public), in hyper-util's `NO_PROXY` syntax.
const NEVER_PROXIED: &str = "localhost,0.0.0.0/0,::/0";

/// The AI HTTP client (every Rust call in `src/ai`: `ai_fetch`, the OAuth code exchanges, ChatGPT
/// token refresh, JWKS and revoke): rustls (ring) with the OS certificate store, no redirects (a
/// redirect could leave the connection's host), no cookies, and proxies only per ruling R25.
pub(super) fn client() -> Client {
    client_with_env(&|name| std::env::var(name).ok())
}

/// [`client`] with the environment read through `env` (tests pass their own).
///
/// Proxies (ruling R25). reqwest would otherwise follow `HTTP_PROXY`, `HTTPS_PROXY` and `ALL_PROXY`
/// for every target (the OS-registry lookup is not built in, but the variables are always read).
/// Here only https targets with a host name may use a proxy, from `HTTPS_PROXY` or else `ALL_PROXY`,
/// through a CONNECT tunnel, so TLS still runs end to end with the provider. Plain http targets and
/// `localhost` or IP-literal hosts always connect directly: their prompts and keys would otherwise
/// cross the proxy in the clear, or leave the machine. `NO_PROXY` is honoured on top.
pub(super) fn client_with_env(env: &dyn Fn(&str) -> Option<String>) -> Client {
    // Fails only if a provider is already installed, which is fine.
    let _ = rustls::crypto::ring::default_provider().install_default();
    let builder = Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .connect_timeout(CONNECT_TIMEOUT)
        .read_timeout(READ_TIMEOUT)
        // Drop reqwest's environment proxy; the one allowed below is added explicitly.
        .no_proxy();
    let builder = match proxy_settings(env) {
        Some((proxy, no_proxy)) => match reqwest::Proxy::https(proxy.as_str()) {
            Ok(p) => builder.proxy(p.no_proxy(reqwest::NoProxy::from_string(&no_proxy))),
            Err(_) => builder,
        },
        None => builder,
    };
    builder.build().expect("the AI HTTP client builds with static settings")
}

/// The proxy for https targets (`HTTPS_PROXY`, else `ALL_PROXY`, either case) and the hosts that
/// bypass it (`NO_PROXY` plus [`NEVER_PROXIED`]). `None` when no usable http(s) proxy is set: SOCKS
/// is not built in, and an unparsable value means no proxy rather than a broken one.
pub(super) fn proxy_settings(env: &dyn Fn(&str) -> Option<String>) -> Option<(String, String)> {
    let first = |names: &[&str]| names.iter().find_map(|n| env(n).map(|v| v.trim().to_owned()).filter(|v| !v.is_empty()));
    let raw = first(&["HTTPS_PROXY", "https_proxy"]).or_else(|| first(&["ALL_PROXY", "all_proxy"]))?;
    let with_scheme = if raw.contains("://") { raw } else { format!("http://{raw}") };
    let url = Url::parse(&with_scheme).ok()?;
    if !matches!(url.scheme(), "http" | "https") || url.host_str().is_none_or(str::is_empty) {
        return None;
    }
    let no_proxy = match first(&["NO_PROXY", "no_proxy"]) {
        Some(list) => format!("{list},{NEVER_PROXIED}"),
        None => NEVER_PROXIED.to_owned(),
    };
    Some((url.to_string(), no_proxy))
}

/// Run one request and stream it through `emit` (Head, Chunk..., End). `emit` returning false
/// means nobody listens any more: the request stops as cancelled.
pub(super) async fn run(
    client: &Client,
    conn: &ResolvedConnection,
    req: AiRequest,
    cancel: watch::Receiver<bool>,
    emit: &mut (dyn FnMut(AiFetchEvent) -> bool + Send),
) -> Result<(), AiError> {
    stream(client, conn, req, cancel, emit).await.map_err(|e| redact(e, conn))
}

async fn stream(
    client: &Client,
    conn: &ResolvedConnection,
    req: AiRequest,
    mut cancel: watch::Receiver<bool>,
    emit: &mut (dyn FnMut(AiFetchEvent) -> bool + Send),
) -> Result<(), AiError> {
    let url = target_url(conn, &req.path)?;
    let headers = request_headers(conn, &req.headers)?;
    let method = match req.method {
        Method::Get => reqwest::Method::GET,
        Method::Post => reqwest::Method::POST,
    };
    let mut builder = client.request(method, url.clone()).headers(headers);
    if let Some(body) = req.body {
        if body.len() > MAX_BODY_BYTES {
            return Err(AiError::bad_request("The request is too large to send."));
        }
        builder = builder.body(body);
    }
    let host = url.host_str().unwrap_or_default().to_owned();

    let mut response = tokio::select! {
        biased;
        _ = cancelled(&mut cancel) => return Err(AiError::cancelled()),
        r = builder.send() => r.map_err(|e| network_error(&e, &host))?,
    };

    let status = response.status();
    if !status.is_success() {
        let excerpt = tokio::select! {
            biased;
            _ = cancelled(&mut cancel) => return Err(AiError::cancelled()),
            text = error_excerpt(&mut response, conn) => text,
        };
        return Err(status_error(status, &host, &excerpt));
    }

    let head_headers = response
        .headers()
        .iter()
        .filter(|(name, _)| *name != reqwest::header::SET_COOKIE)
        .filter_map(|(name, value)| Some((name.as_str().to_owned(), value.to_str().ok()?.to_owned())))
        .collect();
    if !emit(AiFetchEvent::Head { status: status.as_u16(), headers: head_headers }) {
        return Err(AiError::cancelled());
    }
    loop {
        let next = tokio::select! {
            biased;
            _ = cancelled(&mut cancel) => return Err(AiError::cancelled()),
            c = response.chunk() => c.map_err(|e| network_error(&e, &host))?,
        };
        let Some(bytes) = next else { break };
        let data = base64::engine::general_purpose::STANDARD.encode(&bytes);
        if !emit(AiFetchEvent::Chunk { data }) {
            return Err(AiError::cancelled());
        }
    }
    if !emit(AiFetchEvent::End) {
        return Err(AiError::cancelled());
    }
    Ok(())
}

/// Resolves once the request is cancelled.
async fn cancelled(cancel: &mut watch::Receiver<bool>) {
    // An error means the sender (the in-flight entry) is gone: treat that as cancelled too.
    let _ = cancel.wait_for(|c| *c).await;
}

/// The path must be a plain absolute path (+ query) under the provider's base URL.
pub(super) fn check_path(path: &str) -> Result<(), AiError> {
    let lower = path.to_ascii_lowercase();
    let bad = !path.starts_with('/')
        || path.contains("://")
        || path.contains("..")
        || path.contains('\\')
        || lower.contains("%2e")
        || lower.contains("%5c")
        || path.chars().any(|c| c.is_control() || c == ' ' || c == '#');
    if bad {
        return Err(AiError::bad_request("The request path is not allowed."));
    }
    Ok(())
}

/// Base URL (the provider's fixed one, else the connection's saved one) + path, on that host only.
pub(super) fn target_url(conn: &ResolvedConnection, path: &str) -> Result<Url, AiError> {
    check_path(path)?;
    let base = match conn.provider.base_url {
        Some(fixed) => fixed.to_owned(),
        None => conn.base_url.clone().ok_or_else(AiError::not_connected)?,
    };
    let blocked = || AiError::new("blocked_host", "The AI connection's address is not an http or https URL.");
    let base_url = Url::parse(&base).map_err(|_| blocked())?;
    if !matches!(base_url.scheme(), "http" | "https") || base_url.host_str().is_none() {
        return Err(blocked());
    }
    // Plain http carries the prompt and the key in the clear: only to this machine, unless the user
    // accepted it for this connection (a LAN server). Hosted providers are https, so never affected.
    if base_url.scheme() == "http" && !is_loopback(&base_url) && !conn.insecure_http_accepted {
        return Err(AiError::new(
            "blocked_host",
            "This connection uses plain http to another computer. Accept the risk for the connection in Settings, or use https.",
        ));
    }
    let url = Url::parse(&format!("{}{}", base.trim_end_matches('/'), path)).map_err(|_| blocked())?;
    let same_origin = url.scheme() == base_url.scheme()
        && url.host_str() == base_url.host_str()
        && url.port_or_known_default() == base_url.port_or_known_default();
    // Under the base path, at a `/` boundary (`/v1/...`, never `/v1foo`).
    let base_path = base_url.path().trim_end_matches('/');
    let under_base = base_path.is_empty() || url.path() == base_path || url.path().starts_with(&format!("{base_path}/"));
    if !same_origin || !under_base {
        return Err(AiError::new("blocked_host", "The request would leave the connected provider."));
    }
    Ok(url)
}

/// True for the host `localhost` and loopback IP literals (127.0.0.0/8, ::1). Other names, `*.localhost`
/// included, are not trusted to resolve to this machine.
pub(super) fn is_loopback(url: &Url) -> bool {
    let Some(host) = url.host_str() else { return false };
    let host = host.trim_start_matches('[').trim_end_matches(']').trim_end_matches('.').to_ascii_lowercase();
    match host.parse::<std::net::IpAddr>() {
        Ok(ip) => ip.is_loopback(),
        Err(_) => host == "localhost",
    }
}

/// The caller's allowlisted headers, then the provider's own, then the credential.
pub(super) fn request_headers(conn: &ResolvedConnection, caller: &[(String, String)]) -> Result<HeaderMap, AiError> {
    let invalid = || AiError::bad_request("A request header is not valid.");
    let mut headers = HeaderMap::new();
    for (name, value) in caller {
        let name = name.to_ascii_lowercase();
        if !FORWARDED_HEADERS.contains(&name.as_str()) {
            continue;
        }
        let name = HeaderName::from_bytes(name.as_bytes()).map_err(|_| invalid())?;
        headers.append(name, HeaderValue::from_str(value).map_err(|_| invalid())?);
    }
    for (name, value) in conn.provider.extra_headers {
        headers.insert(HeaderName::from_static(name), HeaderValue::from_static(value));
    }
    if let Some(secret) = &conn.secret {
        let credential = |v: String| {
            let mut v = HeaderValue::from_str(&v)
                .map_err(|_| AiError::new("auth", "The stored credential cannot be sent. Reconnect the provider."))?;
            v.set_sensitive(true);
            Ok::<_, AiError>(v)
        };
        match conn.provider.auth {
            Auth::Bearer => {
                headers.insert(AUTHORIZATION, credential(format!("Bearer {}", secret.expose()))?);
            }
            Auth::Header(name) => {
                headers.insert(HeaderName::from_static(name), credential(secret.expose().to_owned())?);
            }
            Auth::None => {}
        }
    }
    Ok(headers)
}

/// How much of a provider's error body is read (a hard cut).
const ERROR_BODY_BYTES: usize = 4096;
/// A secret counts as echoed when this many of its leading characters appear (fewer for a shorter
/// secret): no prefix of 4 or more characters may reach an error message.
const SECRET_PROBE_CHARS: usize = 4;

/// The start of a provider's error body, for the message (best effort; bounded read). Empty when
/// the body read so far echoes any part of the secret's start, checked on the whole read body
/// (raw and JSON-unescaped) before it is collapsed or cut, so no cut can leave a fragment behind.
async fn error_excerpt(response: &mut reqwest::Response, conn: &ResolvedConnection) -> String {
    let mut bytes = Vec::new();
    while bytes.len() < ERROR_BODY_BYTES {
        match tokio::time::timeout(Duration::from_secs(5), response.chunk()).await {
            Ok(Ok(Some(chunk))) => bytes.extend_from_slice(&chunk),
            _ => break,
        }
    }
    bytes.truncate(ERROR_BODY_BYTES);
    let text = String::from_utf8_lossy(&bytes);
    if echoes_secret(&text, conn) {
        return String::new();
    }
    let text = text.split_whitespace().collect::<Vec<_>>().join(" ");
    let excerpt: String = text.chars().take(ERROR_EXCERPT_CHARS).collect();
    if echoes_secret(&excerpt, conn) {
        return String::new();
    }
    excerpt
}

/// True if `text`, as is or JSON-unescaped (once or twice, for JSON quoted inside JSON), contains
/// the secret's first `SECRET_PROBE_CHARS` characters (the whole secret if it is shorter). Any
/// prefix of 4 or more characters, the whole secret and a secret cut by a read cap or the
/// excerpt cut all contain that probe.
pub(super) fn echoes_secret(text: &str, conn: &ResolvedConnection) -> bool {
    let Some(secret) = &conn.secret else { return false };
    let probe: String = secret.expose().chars().take(SECRET_PROBE_CHARS).collect();
    if probe.is_empty() {
        return false;
    }
    let once = json_unescape(text);
    text.contains(&probe) || once.contains(&probe) || json_unescape(&once).contains(&probe)
}

/// Decode JSON string escapes (`\uXXXX` including surrogate pairs, `\/`, `\\`, `\"`, `\n`, ...)
/// wherever they appear, for secret detection. An unknown escape `\X` reads as `X`; a malformed
/// `\u` is kept as written.
pub(super) fn json_unescape(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut chars = text.chars().peekable();
    let hex4 = |it: &mut std::iter::Peekable<std::str::Chars>| -> Option<u32> {
        let s: String = it.clone().take(4).collect();
        if s.len() == 4 && s.chars().all(|c| c.is_ascii_hexdigit()) {
            for _ in 0..4 {
                it.next();
            }
            u32::from_str_radix(&s, 16).ok()
        } else {
            None
        }
    };
    while let Some(c) = chars.next() {
        if c != '\\' {
            out.push(c);
            continue;
        }
        match chars.peek().copied() {
            Some('u') => {
                let mut after_u = chars.clone();
                after_u.next();
                match hex4(&mut after_u) {
                    Some(hi) if (0xD800..0xDC00).contains(&hi) => {
                        let mut low = after_u.clone();
                        let lo = (low.next() == Some('\\') && low.next() == Some('u')).then(|| hex4(&mut low)).flatten();
                        match lo.filter(|lo| (0xDC00..0xE000).contains(lo)) {
                            Some(lo) => {
                                out.extend(char::from_u32(0x10000 + ((hi - 0xD800) << 10) + (lo - 0xDC00)));
                                chars = low;
                            }
                            None => {
                                out.push('\u{FFFD}');
                                chars = after_u;
                            }
                        }
                    }
                    Some(code) => {
                        out.push(char::from_u32(code).unwrap_or('\u{FFFD}'));
                        chars = after_u;
                    }
                    None => out.push('\\'),
                }
            }
            Some(e @ ('"' | '\\' | '/')) => {
                out.push(e);
                chars.next();
            }
            Some('n') => {
                out.push('\n');
                chars.next();
            }
            Some('t') => {
                out.push('\t');
                chars.next();
            }
            Some('r') => {
                out.push('\r');
                chars.next();
            }
            Some('b') | Some('f') => {
                out.push(' ');
                chars.next();
            }
            // Not valid JSON, but a lenient server may write it (`\-`): read it as the character.
            Some(other) => {
                out.push(other);
                chars.next();
            }
            None => out.push('\\'),
        }
    }
    out
}

fn status_error(status: StatusCode, host: &str, excerpt: &str) -> AiError {
    match status.as_u16() {
        401 | 403 => AiError::new(
            "auth",
            format!("{host} did not accept the credential (HTTP {}). Check or reconnect the provider.", status.as_u16()),
        ),
        429 => AiError::new("rate_limit", format!("{host} is rate limiting requests (HTTP 429). Wait a moment and retry.")),
        code => {
            let detail = if excerpt.is_empty() { String::new() } else { format!(": {excerpt}") };
            AiError::new("provider", format!("{host} returned an error (HTTP {code}){detail}"))
        }
    }
}

fn network_error(e: &reqwest::Error, host: &str) -> AiError {
    let message = if e.is_timeout() {
        format!("{host} did not respond in time.")
    } else if e.is_connect() {
        format!("Could not connect to {host}. Check the network, or that the server is running.")
    } else {
        format!("The connection to {host} failed.")
    };
    AiError::new("network", message)
}

/// Backstop for every error message (`error_excerpt` already drops an echoing excerpt): a message
/// that echoes any part of the secret's start (see `echoes_secret`) is replaced as a whole, so no
/// fragment can survive a partial replace.
fn redact(mut e: AiError, conn: &ResolvedConnection) -> AiError {
    if echoes_secret(&e.message, conn) {
        e.message = "The provider returned an error. Its details were withheld because they echoed the credential.".into();
    }
    e
}

#[cfg(test)]
mod tests {
    use std::sync::{Arc, Mutex};
    use std::time::Duration;

    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::TcpListener;

    use super::super::{providers, AiState, ConnectionResolver, Method, Secret};
    use super::*;

    const SECRET: &str = "sk-test-SECRET";

    /// One scripted server action.
    #[derive(Clone)]
    enum Step {
        Write(Vec<u8>),
        Sleep(u64),
        /// Keep the connection open (until the client goes away).
        Hold,
    }

    /// A one-request-per-connection HTTP/1.1 mock: records each raw request (head + body) and plays
    /// `steps` back.
    struct Mock {
        base_url: String,
        requests: Arc<Mutex<Vec<String>>>,
    }

    async fn mock(steps: Vec<Step>) -> Mock {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let requests = Arc::new(Mutex::new(Vec::new()));
        let log = requests.clone();
        tokio::spawn(async move {
            loop {
                let Ok((mut sock, _)) = listener.accept().await else { return };
                let steps = steps.clone();
                let log = log.clone();
                tokio::spawn(async move {
                    let mut buf = Vec::new();
                    let mut tmp = [0u8; 4096];
                    let head_end = loop {
                        let n = sock.read(&mut tmp).await.unwrap_or(0);
                        if n == 0 {
                            return;
                        }
                        buf.extend_from_slice(&tmp[..n]);
                        if let Some(i) = buf.windows(4).position(|w| w == b"\r\n\r\n") {
                            break i + 4;
                        }
                    };
                    let head = String::from_utf8_lossy(&buf[..head_end]).to_lowercase();
                    let len = head
                        .lines()
                        .find_map(|l| l.strip_prefix("content-length:").map(|v| v.trim().parse::<usize>().unwrap()))
                        .unwrap_or(0);
                    while buf.len() < head_end + len {
                        let n = sock.read(&mut tmp).await.unwrap_or(0);
                        if n == 0 {
                            break;
                        }
                        buf.extend_from_slice(&tmp[..n]);
                    }
                    log.lock().unwrap().push(String::from_utf8_lossy(&buf).into_owned());
                    for step in steps {
                        match step {
                            Step::Write(b) => {
                                if sock.write_all(&b).await.is_err() {
                                    return;
                                }
                                let _ = sock.flush().await;
                            }
                            Step::Sleep(ms) => tokio::time::sleep(Duration::from_millis(ms)).await,
                            Step::Hold => {
                                let _ = sock.read(&mut tmp).await;
                                return;
                            }
                        }
                    }
                });
            }
        });
        Mock { base_url: format!("http://{addr}/v1"), requests }
    }

    fn sse_head() -> Step {
        Step::Write(
            b"HTTP/1.1 200 OK\r\ncontent-type: text/event-stream\r\ntransfer-encoding: chunked\r\nset-cookie: s=1\r\n\r\n"
                .to_vec(),
        )
    }

    fn chunk(text: &str) -> Step {
        Step::Write(format!("{:x}\r\n{text}\r\n", text.len()).into_bytes())
    }

    fn last_chunk() -> Step {
        Step::Write(b"0\r\n\r\n".to_vec())
    }

    fn status(code: u16, reason: &str, body: &str) -> Step {
        Step::Write(
            format!("HTTP/1.1 {code} {reason}\r\ncontent-type: application/json\r\ncontent-length: {}\r\n\r\n{body}", body.len())
                .into_bytes(),
        )
    }

    /// A custom-endpoint connection to `base_url` with the test secret.
    struct TestResolver(String);

    impl ConnectionResolver for TestResolver {
        fn resolve(&self, connection_id: &str) -> Result<ResolvedConnection, AiError> {
            assert_eq!(connection_id, "c1");
            Ok(ResolvedConnection {
                provider: providers::descriptor("custom").unwrap(),
                base_url: Some(self.0.clone()),
                secret: Some(Secret::new(SECRET)),
                insecure_http_accepted: false,
            })
        }
    }

    fn state(base_url: &str) -> Arc<AiState> {
        Arc::new(AiState::new(Arc::new(TestResolver(base_url.to_owned()))))
    }

    fn post(path: &str, headers: &[(&str, &str)]) -> AiRequest {
        AiRequest {
            method: Method::Post,
            path: path.to_owned(),
            headers: headers.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect(),
            body: Some(r#"{"model":"m","stream":true}"#.to_owned()),
        }
    }

    async fn fetch(state: &AiState, id: u32, req: AiRequest) -> (Result<(), AiError>, Vec<AiFetchEvent>) {
        let events = Mutex::new(Vec::new());
        let result = tokio::time::timeout(
            Duration::from_secs(10),
            state.fetch(id, "c1", req, |e| {
                events.lock().unwrap().push(e);
                true
            }),
        )
        .await
        .expect("fetch timed out");
        (result, events.into_inner().unwrap())
    }

    fn body_of(events: &[AiFetchEvent]) -> String {
        let mut out = Vec::new();
        for e in events {
            if let AiFetchEvent::Chunk { data } = e {
                out.extend(base64::engine::general_purpose::STANDARD.decode(data).unwrap());
            }
        }
        String::from_utf8(out).unwrap()
    }

    fn error_strings(result: &Result<(), AiError>, events: &[AiFetchEvent]) -> Vec<String> {
        let mut out: Vec<String> = events
            .iter()
            .filter_map(|e| match e {
                AiFetchEvent::Error { kind, message } => Some(format!("{kind} {message}")),
                _ => None,
            })
            .collect();
        if let Err(e) = result {
            out.push(e.to_string());
            out.push(format!("{e:?}"));
        }
        out
    }

    #[tokio::test]
    async fn streams_chunks_in_order() {
        let m = mock(vec![
            sse_head(),
            chunk("data: one\n\n"),
            Step::Sleep(30),
            chunk("data: two\n\n"),
            Step::Sleep(30),
            chunk("data: three\n\n"),
            last_chunk(),
        ])
        .await;
        let (result, events) = fetch(&state(&m.base_url), 1, post("/chat/completions?x=1", &[])).await;
        result.unwrap();
        match &events[0] {
            AiFetchEvent::Head { status, headers } => {
                assert_eq!(*status, 200);
                assert!(headers.iter().any(|(k, v)| k == "content-type" && v == "text/event-stream"));
                assert!(!headers.iter().any(|(k, _)| k == "set-cookie"), "set-cookie is not passed on");
            }
            other => panic!("first event is {other:?}"),
        }
        assert_eq!(events.last(), Some(&AiFetchEvent::End));
        assert!(events.iter().filter(|e| matches!(e, AiFetchEvent::Chunk { .. })).count() >= 2);
        assert_eq!(body_of(&events), "data: one\n\ndata: two\n\ndata: three\n\n");
        let req = m.requests.lock().unwrap()[0].clone();
        assert!(req.starts_with("POST /v1/chat/completions?x=1 HTTP/1.1\r\n"), "{req}");
        assert!(req.ends_with(r#"{"model":"m","stream":true}"#), "{req}");
    }

    #[tokio::test]
    async fn rejects_absolute_url_in_path() {
        let m = mock(vec![status(200, "OK", "{}")]).await;
        let s = state(&m.base_url);
        for path in ["https://evil.example/v1/chat", "chat/completions", "/x?u=http://evil.example", ""] {
            let (result, events) = fetch(&s, 2, post(path, &[])).await;
            assert_eq!(result.unwrap_err().kind, "bad_request", "{path}");
            assert!(matches!(events.as_slice(), [AiFetchEvent::Error { kind: "bad_request", .. }]), "{path}");
        }
        assert!(m.requests.lock().unwrap().is_empty(), "nothing reached the network");
    }

    #[tokio::test]
    async fn rejects_dotdot() {
        let m = mock(vec![status(200, "OK", "{}")]).await;
        let s = state(&m.base_url);
        for path in ["/../admin", "/v1/..", "/a/%2e%2e/b", "/a/%2E%2e/b", "/a\\b", "/a/%5cb"] {
            let (result, _) = fetch(&s, 3, post(path, &[])).await;
            assert_eq!(result.unwrap_err().kind, "bad_request", "{path}");
        }
        assert!(m.requests.lock().unwrap().is_empty());
    }

    #[tokio::test]
    async fn drops_caller_auth_header() {
        let m = mock(vec![status(200, "OK", "{}")]).await;
        let headers = [
            ("Authorization", "Bearer from-webview"),
            ("x-api-key", "from-webview"),
            ("api-key", "from-webview"),
            ("Cookie", "a=b"),
            ("Host", "evil.example"),
            ("x-stainless-os", "Windows"),
            ("user-agent", "ai-sdk"),
            ("Content-Type", "application/json"),
            ("accept", "text/event-stream"),
            ("anthropic-beta", "tools-2024"),
            ("OpenAI-Beta", "assistants=v2"),
        ];
        let (result, _) = fetch(&state(&m.base_url), 4, post("/chat/completions", &headers)).await;
        result.unwrap();
        let req = m.requests.lock().unwrap()[0].to_lowercase();
        let lines: Vec<&str> = req.split("\r\n\r\n").next().unwrap().lines().collect();
        let auth: Vec<_> = lines.iter().filter(|l| l.starts_with("authorization:")).collect();
        assert_eq!(auth, [&"authorization: bearer sk-test-secret"], "only Rust's credential");
        assert!(!req.contains("from-webview"));
        for dropped in ["x-api-key:", "api-key:", "cookie:", "x-stainless-os:", "user-agent:"] {
            assert!(!lines.iter().any(|l| l.starts_with(dropped)), "{dropped} was forwarded");
        }
        assert!(lines.iter().any(|l| l.starts_with("host: 127.0.0.1:")));
        assert!(!req.contains("evil.example"));
        for kept in [
            "content-type: application/json",
            "accept: text/event-stream",
            "anthropic-beta: tools-2024",
            "openai-beta: assistants=v2",
        ] {
            assert!(lines.contains(&kept), "{kept} missing");
        }
    }

    #[tokio::test]
    async fn maps_401_to_auth_and_429_to_rate_limit() {
        for (code, reason, kind) in [
            (401, "Unauthorized", "auth"),
            (403, "Forbidden", "auth"),
            (429, "Too Many Requests", "rate_limit"),
            (500, "Internal Server Error", "provider"),
            (404, "Not Found", "provider"),
        ] {
            let m = mock(vec![status(code, reason, r#"{"error":{"message":"nope"}}"#)]).await;
            let (result, events) = fetch(&state(&m.base_url), 5, post("/chat/completions", &[])).await;
            assert_eq!(result.unwrap_err().kind, kind, "{code}");
            assert!(matches!(events.as_slice(), [AiFetchEvent::Error { kind: k, .. }] if *k == kind), "{code}: {events:?}");
        }
    }

    #[tokio::test]
    async fn cancel_stops_stream() {
        let m = mock(vec![sse_head(), chunk("data: one\n\n"), Step::Hold]).await;
        let s = state(&m.base_url);
        let s2 = s.clone();
        let (seen_tx, seen_rx) = tokio::sync::oneshot::channel::<()>();
        let mut seen_tx = Some(seen_tx);
        let task = tokio::spawn(async move {
            let mut events = Vec::new();
            let result = s2
                .fetch(6, "c1", post("/chat/completions", &[]), |e| {
                    if matches!(e, AiFetchEvent::Chunk { .. }) {
                        if let Some(tx) = seen_tx.take() {
                            let _ = tx.send(());
                        }
                    }
                    events.push(e);
                    true
                })
                .await;
            (result, events)
        });
        tokio::time::timeout(Duration::from_secs(5), seen_rx).await.unwrap().unwrap();
        assert!(s.cancel(6));
        let (result, events) = tokio::time::timeout(Duration::from_secs(5), task).await.unwrap().unwrap();
        assert_eq!(result.unwrap_err().kind, "cancelled");
        assert!(!events.contains(&AiFetchEvent::End));
        assert!(matches!(events.last(), Some(AiFetchEvent::Error { kind: "cancelled", .. })));
        // The id is free again, and a cancel that overtakes its request stops it before it starts.
        assert!(!s.cancel(7));
        let (result, _) = fetch(&s, 7, post("/chat/completions", &[])).await;
        assert_eq!(result.unwrap_err().kind, "cancelled");
        assert_eq!(m.requests.lock().unwrap().len(), 1);
    }

    #[tokio::test]
    async fn error_message_never_contains_secret() {
        let echo = format!(r#"{{"error":{{"message":"Incorrect API key provided: {SECRET}"}}}}"#);
        let mut checked = 0;
        for steps in [
            vec![status(401, "Unauthorized", &echo)],
            vec![status(429, "Too Many Requests", &echo)],
            vec![status(500, "Internal Server Error", &echo)],
            vec![status(400, "Bad Request", &echo)],
            vec![sse_head(), chunk("data: x\n\n"), Step::Write(b"zz\r\n".to_vec())], // broken chunking
        ] {
            let m = mock(steps).await;
            let (result, events) = fetch(&state(&m.base_url), 8, post("/chat/completions", &[])).await;
            assert!(result.is_err());
            for s in error_strings(&result, &events) {
                assert!(!s.contains(SECRET), "secret leaked: {s}");
                checked += 1;
            }
        }
        // Unreachable host, and a base URL that is not http(s).
        for base in ["http://127.0.0.1:9/v1", "ftp://127.0.0.1/v1"] {
            let (result, events) = fetch(&state(base), 9, post("/chat/completions", &[])).await;
            assert!(result.is_err());
            for s in error_strings(&result, &events) {
                assert!(!s.contains(SECRET), "secret leaked: {s}");
                checked += 1;
            }
        }
        assert!(checked >= 21);
        assert!(!format!("{:?}", Secret::new(SECRET)).contains(SECRET));
    }

    /// True if `s` holds any prefix of the secret of 4+ characters, as is or JSON-unescaped, or the
    /// secret's unescaped tail.
    fn leaks_secret(s: &str) -> bool {
        let unescaped = json_unescape(s);
        (4..=SECRET.len()).any(|n| s.contains(&SECRET[..n]) || unescaped.contains(&SECRET[..n]))
            || s.contains("test-SECRET")
    }

    /// Every error string a `code` response with `body` produces, after asserting it failed.
    async fn error_strings_for(code: u16, body: &str) -> Vec<String> {
        let m = mock(vec![status(code, "Error", body)]).await;
        let (result, events) = fetch(&state(&m.base_url), 13, post("/chat/completions", &[])).await;
        assert!(result.is_err());
        let strings = error_strings(&result, &events);
        assert!(!strings.is_empty());
        strings
    }

    #[tokio::test]
    async fn secret_cut_by_the_300_char_excerpt_never_leaks() {
        // The secret straddles the excerpt cut: "...xxxx sk-test-SE|CRET".
        for pad in [286, 289, 290, 292, 295, 296] {
            let body = format!("{} {SECRET} tail", "x".repeat(pad));
            for s in error_strings_for(500, &body).await {
                assert!(!leaks_secret(&s), "pad {pad}: {s}");
            }
        }
    }

    #[tokio::test]
    async fn secret_cut_by_the_4096_byte_read_cap_never_leaks() {
        // Whitespace collapses, so the bytes near the read cap land inside the 300-char excerpt.
        for keep in [4, 5, 8, 12] {
            let pad = ERROR_BODY_BYTES - keep;
            let body = format!("{}{SECRET}", " ".repeat(pad));
            for s in error_strings_for(400, &body).await {
                assert!(!leaks_secret(&s), "keep {keep}: {s}");
            }
        }
    }

    #[tokio::test]
    async fn json_escaped_secret_never_leaks() {
        let escaped_dash = SECRET.replace('-', "\\u002d");
        let all_escaped: String = SECRET.chars().map(|c| format!("\\u{:04x}", c as u32)).collect();
        let double = format!(r#""{}""#, SECRET.replace('-', "\\\\u002d"));
        for echo in [escaped_dash, all_escaped, double, SECRET.replace('-', "\\-")] {
            let body = format!(r#"{{"error":{{"message":"bad key {echo}"}}}}"#);
            for s in error_strings_for(400, &body).await {
                assert!(!leaks_secret(&s), "{echo}: {s}");
            }
        }
    }

    #[tokio::test]
    async fn provider_error_without_the_secret_keeps_its_detail() {
        let strings = error_strings_for(400, r#"{"error":{"message":"model not found"}}"#).await;
        assert!(strings.iter().all(|s| s.contains("model not found")), "{strings:?}");
    }

    #[test]
    fn json_unescape_decodes_escapes_and_keeps_malformed_text() {
        assert_eq!(json_unescape(r#"sk-x \/ \\ \" \n"#), "sk-x / \\ \" \n");
        assert_eq!(json_unescape(r"😀"), "\u{1F600}");
        assert_eq!(json_unescape(r"\u00 \q end\"), r"\u00 q end\");
    }

    #[tokio::test]
    async fn blocks_base_urls_that_are_not_http() {
        let (result, _) = fetch(&state("ftp://127.0.0.1/v1"), 10, post("/chat/completions", &[])).await;
        assert_eq!(result.unwrap_err().kind, "blocked_host");
        let (result, _) = fetch(&state("not a url"), 11, post("/chat/completions", &[])).await;
        assert_eq!(result.unwrap_err().kind, "blocked_host");
    }

    #[tokio::test]
    async fn unknown_connection_is_not_connected() {
        let s = AiState::new(Arc::new(super::super::NoConnections));
        let (result, events) = fetch(&s, 12, post("/chat/completions", &[])).await;
        assert_eq!(result.unwrap_err().kind, "not_connected");
        assert!(matches!(events.as_slice(), [AiFetchEvent::Error { kind: "not_connected", .. }]));
    }

    // ---- Proxies (ruling R25): only https targets, never http, loopback or IP literals ----

    /// A listener that records the first request line of every connection and answers 403.
    async fn recording_listener() -> (String, Arc<Mutex<Vec<String>>>) {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let seen = Arc::new(Mutex::new(Vec::new()));
        let log = seen.clone();
        tokio::spawn(async move {
            loop {
                let Ok((mut sock, _)) = listener.accept().await else { return };
                let log = log.clone();
                tokio::spawn(async move {
                    let mut buf = Vec::new();
                    let mut tmp = [0u8; 1024];
                    // A TLS ClientHello (0x16) has no HTTP head: record it and hang up.
                    while !buf.windows(4).any(|w| w == b"\r\n\r\n") && buf.first() != Some(&0x16) {
                        match sock.read(&mut tmp).await {
                            Ok(0) | Err(_) => break,
                            Ok(n) => buf.extend_from_slice(&tmp[..n]),
                        }
                    }
                    if buf.first() == Some(&0x16) {
                        log.lock().unwrap().push("<tls>".to_owned());
                        return;
                    }
                    let text = String::from_utf8_lossy(&buf).into_owned();
                    log.lock().unwrap().push(text.lines().next().unwrap_or("<empty>").to_owned());
                    let _ = sock.write_all(b"HTTP/1.1 403 Forbidden\r\ncontent-length: 0\r\n\r\n").await;
                });
            }
        });
        (format!("http://{addr}"), seen)
    }

    fn env_of(vars: &[(&'static str, String)]) -> impl Fn(&str) -> Option<String> {
        let vars: Vec<(&'static str, String)> = vars.to_vec();
        move |k| vars.iter().find(|(n, _)| *n == k).map(|(_, v)| v.clone())
    }

    /// Every proxy variable pointing at `proxy`.
    fn all_proxy_vars(proxy: &str) -> Vec<(&'static str, String)> {
        ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "all_proxy"]
            .into_iter()
            .map(|k| (k, proxy.to_owned()))
            .collect()
    }

    async fn send(client: &Client, url: &str) -> Result<reqwest::Response, reqwest::Error> {
        tokio::time::timeout(Duration::from_secs(25), client.get(url).send()).await.expect("request timed out")
    }

    #[tokio::test]
    async fn plain_http_to_loopback_never_goes_through_a_proxy() {
        let (proxy, via_proxy) = recording_listener().await;
        let m = mock(vec![status(200, "OK", "{}")]).await;
        let client = client_with_env(&env_of(&all_proxy_vars(&proxy)));
        let res = send(&client, &format!("{}/models", m.base_url)).await.unwrap();
        assert_eq!(res.status(), 200);
        // `localhost` may resolve to ::1 first; only "not via the proxy" matters here.
        let _ = send(&client, &format!("{}/models", m.base_url.replace("127.0.0.1", "localhost"))).await;
        assert!(via_proxy.lock().unwrap().is_empty(), "{:?}", via_proxy.lock().unwrap());
        assert!(!m.requests.lock().unwrap().is_empty(), "the request went straight to the server");
    }

    #[tokio::test]
    async fn plain_http_to_a_named_host_is_never_proxied() {
        let (proxy, via_proxy) = recording_listener().await;
        let client = client_with_env(&env_of(&all_proxy_vars(&proxy)));
        // `.invalid` never resolves: the request fails without touching the proxy.
        assert!(send(&client, "http://provider.invalid/v1/models").await.is_err());
        assert!(via_proxy.lock().unwrap().is_empty(), "{:?}", via_proxy.lock().unwrap());
    }

    #[tokio::test]
    async fn https_to_a_named_host_tunnels_through_the_https_proxy() {
        for var in ["HTTPS_PROXY", "https_proxy", "ALL_PROXY", "all_proxy"] {
            let (proxy, via_proxy) = recording_listener().await;
            let client = client_with_env(&env_of(&[(var, proxy)]));
            // The proxy refuses the tunnel, so the request fails; it must have asked for a CONNECT.
            assert!(send(&client, "https://provider.example/v1/models").await.is_err(), "{var}");
            assert_eq!(*via_proxy.lock().unwrap(), vec!["CONNECT provider.example:443 HTTP/1.1".to_owned()], "{var}");
        }
    }

    #[tokio::test]
    async fn http_proxy_alone_does_not_carry_https() {
        let (proxy, via_proxy) = recording_listener().await;
        let client = client_with_env(&env_of(&[("HTTP_PROXY", proxy.clone()), ("http_proxy", proxy)]));
        let _ = send(&client, "https://provider.invalid/v1/models").await;
        assert!(via_proxy.lock().unwrap().is_empty(), "{:?}", via_proxy.lock().unwrap());
    }

    #[tokio::test]
    async fn https_to_loopback_or_an_ip_literal_is_never_proxied() {
        let (proxy, via_proxy) = recording_listener().await;
        let (direct, reached) = recording_listener().await;
        let port = direct.rsplit(':').next().unwrap().to_owned();
        let client = client_with_env(&env_of(&all_proxy_vars(&proxy)));
        // The direct listener is not TLS, so these fail; they must have gone to it, not the proxy.
        assert!(send(&client, &format!("https://127.0.0.1:{port}/v1")).await.is_err());
        // These may hang on connect; a proxied request would have reached the proxy at once.
        for url in [format!("https://localhost:{port}/v1"), "https://[::1]:9/v1".into(), "https://192.0.2.1:9/v1".into()] {
            let _ = tokio::time::timeout(Duration::from_secs(2), client.get(&url).send()).await;
        }
        assert!(via_proxy.lock().unwrap().is_empty(), "{:?}", via_proxy.lock().unwrap());
        assert!(!reached.lock().unwrap().is_empty(), "the request went straight to the server");
    }

    #[tokio::test]
    async fn no_proxy_is_honoured_for_https() {
        let (proxy, via_proxy) = recording_listener().await;
        let mut vars = all_proxy_vars(&proxy);
        vars.push(("NO_PROXY", "example.org, provider.invalid".to_owned()));
        let client = client_with_env(&env_of(&vars));
        assert!(send(&client, "https://api.provider.invalid/v1/models").await.is_err());
        assert!(via_proxy.lock().unwrap().is_empty(), "{:?}", via_proxy.lock().unwrap());
    }

    #[test]
    fn proxy_settings_pick_https_then_all_and_skip_unusable_values() {
        let env = |vars: &[(&'static str, &str)]| {
            let v: Vec<(&'static str, String)> = vars.iter().map(|(k, v)| (*k, v.to_string())).collect();
            proxy_settings(&env_of(&v))
        };
        assert_eq!(env(&[]), None);
        assert_eq!(env(&[("HTTP_PROXY", "http://p:1")]), None, "HTTP_PROXY is for http targets, which are never proxied");
        assert_eq!(env(&[("HTTPS_PROXY", "http://p:1")]).unwrap().0, "http://p:1/");
        assert_eq!(env(&[("https_proxy", "http://q:2"), ("ALL_PROXY", "http://a:3")]).unwrap().0, "http://q:2/");
        assert_eq!(env(&[("ALL_PROXY", "http://a:3")]).unwrap().0, "http://a:3/");
        assert_eq!(env(&[("HTTPS_PROXY", " "), ("ALL_PROXY", "http://a:3")]).unwrap().0, "http://a:3/");
        // A bare host:port is read as http, as curl does.
        assert_eq!(env(&[("HTTPS_PROXY", "p:8080")]).unwrap().0, "http://p:8080/");
        // SOCKS is not built in, and nonsense is ignored: no proxy rather than a broken one.
        assert_eq!(env(&[("HTTPS_PROXY", "socks5://p:1080")]), None);
        assert_eq!(env(&[("HTTPS_PROXY", "http://")]), None);
        let (_, no) = env(&[("HTTPS_PROXY", "http://p:1"), ("no_proxy", "corp.example")]).unwrap();
        assert!(no.starts_with("corp.example,"), "{no}");
        for always in ["localhost", "0.0.0.0/0", "::/0"] {
            assert!(no.split(',').any(|p| p == always), "{always} in {no}");
        }
    }
}
