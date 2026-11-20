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

/// The proxy's HTTP client: rustls (ring) with the OS certificate store, no redirects (a redirect
/// could leave the connection's host), no system proxy, no cookies.
pub(super) fn client() -> Client {
    // Fails only if a provider is already installed, which is fine.
    let _ = rustls::crypto::ring::default_provider().install_default();
    Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .connect_timeout(CONNECT_TIMEOUT)
        .read_timeout(READ_TIMEOUT)
        .build()
        .expect("the AI HTTP client builds with static settings")
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
            text = error_excerpt(&mut response) => text,
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
    let url = Url::parse(&format!("{}{}", base.trim_end_matches('/'), path)).map_err(|_| blocked())?;
    let same_origin = url.scheme() == base_url.scheme()
        && url.host_str() == base_url.host_str()
        && url.port_or_known_default() == base_url.port_or_known_default();
    if !same_origin || !url.path().starts_with(base_url.path().trim_end_matches('/')) {
        return Err(AiError::new("blocked_host", "The request would leave the connected provider."));
    }
    Ok(url)
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

/// The start of a provider's error body, for the message (best effort; bounded read).
async fn error_excerpt(response: &mut reqwest::Response) -> String {
    let mut bytes = Vec::new();
    while bytes.len() < 4096 {
        match tokio::time::timeout(Duration::from_secs(5), response.chunk()).await {
            Ok(Ok(Some(chunk))) => bytes.extend_from_slice(&chunk),
            _ => break,
        }
    }
    let text = String::from_utf8_lossy(&bytes);
    let text = text.split_whitespace().collect::<Vec<_>>().join(" ");
    text.chars().take(ERROR_EXCERPT_CHARS).collect()
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

/// Remove the connection's secret from an error message (defence in depth: nothing above puts it
/// there, but a provider's error body can echo it).
fn redact(mut e: AiError, conn: &ResolvedConnection) -> AiError {
    if let Some(secret) = &conn.secret {
        let s = secret.expose();
        if !s.is_empty() && e.message.contains(s) {
            e.message = e.message.replace(s, "[redacted]");
        }
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
}
