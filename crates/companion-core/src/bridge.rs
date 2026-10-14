//! Authenticated ingestion-only HTTP bridge. The window consumes Rust IPC, never
//! the bearer token, an SSE connection, or executable content from this server.
use crate::{
    BridgeStatus, IngestError, IngestPayload, Observer, SourceLease, MAX_AGENTS_PER_SESSION,
    MAX_BODY_BYTES, MAX_SESSIONS, PROTOCOL_VERSION,
};
use axum::{
    body::to_bytes,
    extract::{ConnectInfo, Request, State},
    http::{header, HeaderMap, HeaderValue, Method, StatusCode},
    middleware::{self, Next},
    response::{IntoResponse, Response},
    routing::{get, post},
    serve::ListenerExt,
    Json, Router,
};
use serde::Deserialize;
use serde_json::{json, Value};
use std::{
    fmt, io,
    net::{Ipv4Addr, SocketAddr},
    sync::Arc,
    time::Duration,
};
use subtle::ConstantTimeEq;
use tokio::{
    net::TcpListener,
    sync::{watch, Semaphore},
    task::JoinHandle,
};

/// Only configuration code may obtain the token bytes. Neither Debug, errors,
/// health, snapshots, nor IPC serialize the secret. No credential is generated.
#[derive(Clone)]
pub struct SecretToken(String);
impl SecretToken {
    pub fn new(value: String) -> Result<Self, BridgeError> {
        if !(32..=512).contains(&value.len())
            || !value
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || b"_.~+/-".contains(&byte))
        {
            return Err(BridgeError::InvalidToken);
        }
        Ok(Self(value))
    }
}
impl fmt::Debug for SecretToken {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("SecretToken([REDACTED])")
    }
}

#[derive(Clone, Debug)]
pub struct BridgeConfig {
    pub port: u16,
    pub token: SecretToken,
    pub body_timeout: Duration,
    pub request_timeout: Duration,
    pub max_concurrent_requests: usize,
    pub max_concurrent_connections: usize,
    pub connection_lifetime: Duration,
    pub tick_interval: Duration,
    pub shutdown_timeout: Duration,
}
impl BridgeConfig {
    pub fn new(token: SecretToken) -> Self {
        Self {
            port: 4318,
            token,
            body_timeout: Duration::from_secs(5),
            request_timeout: Duration::from_secs(6),
            max_concurrent_requests: 32,
            max_concurrent_connections: 64,
            connection_lifetime: Duration::from_secs(30),
            tick_interval: Duration::from_millis(250),
            shutdown_timeout: Duration::from_secs(1),
        }
    }
    fn validate(&self) -> Result<(), BridgeError> {
        if self.max_concurrent_requests == 0
            || self.max_concurrent_requests > 256
            || self.max_concurrent_connections == 0
            || self.max_concurrent_connections > 512
            || [
                self.connection_lifetime,
                self.body_timeout,
                self.request_timeout,
                self.tick_interval,
                self.shutdown_timeout,
            ]
            .iter()
            .any(|duration| duration.is_zero() || *duration > Duration::from_secs(60))
            || self.request_timeout < self.body_timeout
        {
            return Err(BridgeError::InvalidConfig);
        }
        Ok(())
    }
}

#[derive(Debug, thiserror::Error)]
pub enum BridgeError {
    #[error("Observer token must contain 32–512 URL-safe characters")]
    InvalidToken,
    #[error("Observer timer or concurrency configuration is invalid")]
    InvalidConfig,
    #[error("Could not bind the loopback observer")]
    Bind(#[source] io::Error),
    #[error("Loopback observer stopped unexpectedly")]
    Serve(#[source] io::Error),
    #[error("Observer task failed")]
    Task,
}

#[derive(Clone)]
struct ServerState {
    observer: Observer,
    config: BridgeConfig,
    permits: Arc<Semaphore>,
}

pub struct BridgeHandle {
    local_addr: SocketAddr,
    observer: Observer,
    stop: watch::Sender<bool>,
    server: Option<JoinHandle<io::Result<()>>>,
    ticker: Option<JoinHandle<()>>,
    shutdown_timeout: Duration,
}
impl BridgeHandle {
    pub fn local_addr(&self) -> SocketAddr {
        self.local_addr
    }

    pub async fn shutdown(mut self) -> Result<(), BridgeError> {
        self.stop.send_replace(true);
        self.observer.set_bridge_status(BridgeStatus::Stopped);
        if let Some(ticker) = self.ticker.take() {
            ticker.abort();
            let _ = ticker.await;
        }
        if let Some(mut server) = self.server.take() {
            match tokio::time::timeout(self.shutdown_timeout, &mut server).await {
                Ok(Ok(Ok(()))) => {}
                Ok(Ok(Err(error))) => return Err(BridgeError::Serve(error)),
                Ok(Err(_)) => return Err(BridgeError::Task),
                Err(_) => {
                    // Idle keep-alives or an incomplete client request cannot
                    // hold the desktop process open indefinitely.
                    server.abort();
                    let _ = server.await;
                }
            }
        }
        Ok(())
    }
}
impl Drop for BridgeHandle {
    fn drop(&mut self) {
        self.stop.send_replace(true);
        if let Some(server) = &self.server {
            server.abort();
        }
        if let Some(ticker) = &self.ticker {
            ticker.abort();
        }
        self.observer.set_bridge_status(BridgeStatus::Stopped);
    }
}

pub async fn start(
    observer: Observer,
    mut config: BridgeConfig,
) -> Result<BridgeHandle, BridgeError> {
    config.validate()?;
    observer.set_bridge_status(BridgeStatus::Starting);
    let listener = match TcpListener::bind((Ipv4Addr::LOCALHOST, config.port)).await {
        Ok(listener) => listener,
        Err(error) => {
            observer.set_bridge_status(BridgeStatus::Error);
            return Err(BridgeError::Bind(error));
        }
    };
    let local_addr = listener.local_addr().map_err(BridgeError::Bind)?;
    config.port = local_addr.port();
    let app = router(observer.clone(), config.clone())?;
    let (stop, mut server_stop) = watch::channel(false);
    let mut ticker_stop = stop.subscribe();
    let server_observer = observer.clone();
    let connection_cap = config.max_concurrent_connections;
    let connection_lifetime = config.connection_lifetime;
    let server = tokio::spawn(async move {
        let listener = BoundedListener {
            listener,
            permits: Arc::new(Semaphore::new(connection_cap)),
            lifetime: connection_lifetime,
        }
        .tap_io(|_| {});
        let result = axum::serve(
            listener,
            app.into_make_service_with_connect_info::<SocketAddr>(),
        )
        .with_graceful_shutdown(async move {
            while !*server_stop.borrow_and_update() {
                if server_stop.changed().await.is_err() {
                    break;
                }
            }
        })
        .await;
        server_observer.set_bridge_status(if result.is_ok() {
            BridgeStatus::Stopped
        } else {
            BridgeStatus::Error
        });
        result
    });
    let ticker_observer = observer.clone();
    let interval = config.tick_interval;
    let ticker = tokio::spawn(async move {
        let mut timer = tokio::time::interval(interval);
        timer.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
        loop {
            tokio::select! {
                _ = timer.tick() => { ticker_observer.snapshot(); }
                result = ticker_stop.changed() => {
                    if result.is_err() || *ticker_stop.borrow() { break; }
                }
            }
        }
    });
    observer.set_bridge_status(BridgeStatus::Listening);
    Ok(BridgeHandle {
        local_addr,
        observer,
        stop,
        server: Some(server),
        ticker: Some(ticker),
        shutdown_timeout: config.shutdown_timeout,
    })
}

/// Router constructor exposed for in-process HTTP verification. Production code
/// must call `start`, which always binds 127.0.0.1 and owns the expiry task.
pub fn router(observer: Observer, config: BridgeConfig) -> Result<Router, BridgeError> {
    config.validate()?;
    let state = ServerState {
        observer,
        permits: Arc::new(Semaphore::new(config.max_concurrent_requests)),
        config,
    };
    Ok(Router::new()
        .route("/api/health", get(health))
        .route("/api/hello", post(hello))
        .route("/api/ingest", post(ingest))
        .route("/api/snapshot", get(snapshot))
        .fallback(|| async { error(StatusCode::NOT_FOUND, "Observer endpoint not found") })
        .layer(middleware::from_fn_with_state(state.clone(), guard))
        .with_state(state))
}

fn error(status: StatusCode, message: &'static str) -> Response {
    (status, Json(json!({"error":message}))).into_response()
}
fn hardened(mut response: Response) -> Response {
    let headers = response.headers_mut();
    headers.insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    headers.insert(
        "x-content-type-options",
        HeaderValue::from_static("nosniff"),
    );
    headers.insert(
        "cross-origin-resource-policy",
        HeaderValue::from_static("same-origin"),
    );
    headers.insert("referrer-policy", HeaderValue::from_static("no-referrer"));
    headers.insert("x-frame-options", HeaderValue::from_static("DENY"));
    headers.insert(
        "content-security-policy",
        HeaderValue::from_static("default-src 'none'; frame-ancestors 'none'"),
    );
    response
}
fn single_header<'a>(headers: &'a HeaderMap, name: &str) -> Result<Option<&'a str>, ()> {
    let mut values = headers.get_all(name).iter();
    let value = values.next().map(|value| value.to_str().map_err(|_| ()));
    if values.next().is_some() {
        return Err(());
    }
    value.transpose()
}

async fn guard(State(state): State<ServerState>, request: Request, next: Next) -> Response {
    hardened(guard_inner(state, request, next).await)
}
async fn guard_inner(state: ServerState, request: Request, next: Next) -> Response {
    if let Some(ConnectInfo(peer)) = request.extensions().get::<ConnectInfo<SocketAddr>>() {
        if !peer.ip().is_loopback() {
            return error(StatusCode::FORBIDDEN, "Loopback peer required");
        }
    }
    let headers = request.headers();
    let host = match single_header(headers, "host") {
        Ok(Some(host))
            if host == format!("127.0.0.1:{}", state.config.port)
                || host == format!("localhost:{}", state.config.port) =>
        {
            host
        }
        _ => return error(StatusCode::FORBIDDEN, "Loopback Host required"),
    };
    match single_header(headers, "origin") {
        Ok(None) => {}
        Ok(Some(origin)) if origin == format!("http://{host}") => {}
        _ => return error(StatusCode::FORBIDDEN, "Same-origin requests only"),
    }
    match single_header(headers, "sec-fetch-site") {
        Ok(None | Some("none" | "same-origin")) => {}
        _ => return error(StatusCode::FORBIDDEN, "Cross-site requests denied"),
    }
    if request.uri().authority().is_some()
        || request.uri().scheme().is_some()
        || request.uri().query().is_some()
    {
        return error(StatusCode::BAD_REQUEST, "Invalid request target");
    }
    match single_header(headers, "content-length") {
        Ok(Some(value)) => match value.parse::<usize>() {
            Ok(length) if length <= MAX_BODY_BYTES => {}
            Ok(_) => return error(StatusCode::PAYLOAD_TOO_LARGE, "Payload too large"),
            Err(_) => return error(StatusCode::BAD_REQUEST, "Invalid body length"),
        },
        Ok(None) => {}
        Err(_) => return error(StatusCode::BAD_REQUEST, "Invalid body length"),
    }
    let is_public_health = request.uri().path() == "/api/health" && request.method() == Method::GET;
    if !is_public_health {
        let supplied = match single_header(headers, "authorization") {
            Ok(Some(value)) => value.strip_prefix("Bearer ").unwrap_or(""),
            _ => "",
        };
        if supplied.len() != state.config.token.0.len()
            || !bool::from(supplied.as_bytes().ct_eq(state.config.token.0.as_bytes()))
        {
            return error(StatusCode::UNAUTHORIZED, "Observer authentication required");
        }
    }
    let _permit = match state.permits.try_acquire() {
        Ok(permit) => permit,
        Err(_) => {
            return error(
                StatusCode::SERVICE_UNAVAILABLE,
                "Too many observer requests",
            )
        }
    };
    match tokio::time::timeout(state.config.request_timeout, next.run(request)).await {
        Ok(response) => response,
        Err(_) => error(StatusCode::REQUEST_TIMEOUT, "Observer request timed out"),
    }
}

async fn health() -> Json<Value> {
    Json(json!({"ok":true,"version":PROTOCOL_VERSION,"service":"pi-companion","readOnly":true}))
}
async fn snapshot(State(state): State<ServerState>) -> Json<crate::Snapshot> {
    Json(state.observer.snapshot())
}

async fn read_json(
    request: Request,
    timeout: Duration,
) -> Result<Value, (StatusCode, &'static str)> {
    match single_header(request.headers(), "content-type") {
        Ok(Some(value))
            if value
                .split(';')
                .next()
                .is_some_and(|mime| mime.trim().eq_ignore_ascii_case("application/json")) => {}
        _ => {
            return Err((
                StatusCode::UNSUPPORTED_MEDIA_TYPE,
                "application/json required",
            ))
        }
    }
    let bytes =
        match tokio::time::timeout(timeout, to_bytes(request.into_body(), MAX_BODY_BYTES)).await {
            Err(_) => return Err((StatusCode::REQUEST_TIMEOUT, "Request body timed out")),
            Ok(Err(_)) => {
                return Err((
                    StatusCode::PAYLOAD_TOO_LARGE,
                    "Payload too large or interrupted",
                ))
            }
            Ok(Ok(bytes)) => bytes,
        };
    let value: Value =
        serde_json::from_slice(&bytes).map_err(|_| (StatusCode::BAD_REQUEST, "Invalid JSON"))?;
    if !value.is_object() {
        return Err((StatusCode::BAD_REQUEST, "JSON object required"));
    }
    Ok(value)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Hello {
    #[serde(default)]
    version: Option<u32>,
    #[serde(default)]
    session_id: Option<String>,
    #[serde(default)]
    instance_id: Option<String>,
}
async fn hello(State(state): State<ServerState>, request: Request) -> Response {
    let value = match read_json(request, state.config.body_timeout).await {
        Ok(value) => value,
        Err((status, message)) => return error(status, message),
    };
    let hello: Hello = match serde_json::from_value(value) {
        Ok(hello) => hello,
        Err(_) => return error(StatusCode::BAD_REQUEST, "Invalid hello payload"),
    };
    if hello
        .version
        .is_some_and(|version| version != PROTOCOL_VERSION)
    {
        return error(StatusCode::BAD_REQUEST, "Unsupported observer protocol");
    }
    let source: Option<SourceLease> = match (hello.session_id, hello.instance_id) {
        (None, None) => None,
        (Some(session), Some(instance)) => {
            match state.observer.register_source(&session, &instance) {
                Ok(lease) => Some(lease),
                Err(failure) => return ingest_error(failure),
            }
        }
        _ => {
            return error(
                StatusCode::BAD_REQUEST,
                "Both sessionId and instanceId are required",
            )
        }
    };
    let mut response = json!({
        "version":PROTOCOL_VERSION,
        "streamId":state.observer.snapshot().stream_id,
        "capabilities":{"snapshot":true,"sse":false,"ingest":true,"readOnly":true,"sourceOrdering":true},
        "limits":{"sessions":MAX_SESSIONS,"agents":MAX_AGENTS_PER_SESSION,"payloadBytes":MAX_BODY_BYTES}
    });
    if let Some(source) = source {
        response["source"] = json!(source);
    }
    Json(response).into_response()
}

async fn ingest(State(state): State<ServerState>, request: Request) -> Response {
    let value = match read_json(request, state.config.body_timeout).await {
        Ok(value) => value,
        Err((status, message)) => return error(status, message),
    };
    if !ingest_shape(&value) {
        return error(StatusCode::BAD_REQUEST, "Invalid observer payload");
    }
    let payload: IngestPayload = match serde_json::from_value(value) {
        Ok(payload) => payload,
        Err(_) => return error(StatusCode::BAD_REQUEST, "Invalid observer payload"),
    };
    match state.observer.ingest(payload) {
        Ok(receipt) => (StatusCode::ACCEPTED, Json(receipt)).into_response(),
        Err(failure) => ingest_error(failure),
    }
}
fn ingest_shape(value: &Value) -> bool {
    let Some(session) = value.get("session").and_then(Value::as_object) else {
        return false;
    };
    if value
        .get("source")
        .is_some_and(|source| !source.is_object())
    {
        return false;
    }
    if let Some(agents) = session.get("agents") {
        let Some(agents) = agents.as_array() else {
            return false;
        };
        if agents.iter().any(|agent| {
            !agent.is_object()
                || agent
                    .get("lifecycle")
                    .is_some_and(|marker| !marker.is_null() && !marker.is_object())
        }) {
            return false;
        }
    }
    true
}
fn ingest_error(failure: IngestError) -> Response {
    let status = match failure {
        IngestError::OutOfOrder | IngestError::UnknownSource => StatusCode::CONFLICT,
        IngestError::SessionLimit | IngestError::SourceLimit => StatusCode::TOO_MANY_REQUESTS,
        _ => StatusCode::BAD_REQUEST,
    };
    (status, Json(json!({"error":failure.to_string()}))).into_response()
}

// Bound accepted sockets as well as complete HTTP requests. An absolute socket
// lifetime also closes clients that drip incomplete headers forever; body and
// whole-request deadlines separately bound authenticated handlers.
struct BoundedListener {
    listener: TcpListener,
    permits: Arc<Semaphore>,
    lifetime: Duration,
}
impl axum::serve::Listener for BoundedListener {
    type Io = BoundedSocket;
    type Addr = SocketAddr;
    async fn accept(&mut self) -> (Self::Io, Self::Addr) {
        loop {
            let permit = self
                .permits
                .clone()
                .acquire_owned()
                .await
                .expect("semaphore not closed");
            match self.listener.accept().await {
                Ok((stream, peer)) => {
                    return (
                        BoundedSocket {
                            stream,
                            _permit: permit,
                            deadline: Box::pin(tokio::time::sleep(self.lifetime)),
                        },
                        peer,
                    )
                }
                Err(_) => tokio::time::sleep(Duration::from_millis(100)).await,
            }
        }
    }
    fn local_addr(&self) -> io::Result<SocketAddr> {
        self.listener.local_addr()
    }
}
struct BoundedSocket {
    stream: tokio::net::TcpStream,
    _permit: tokio::sync::OwnedSemaphorePermit,
    deadline: std::pin::Pin<Box<tokio::time::Sleep>>,
}
impl BoundedSocket {
    fn expired(&mut self, context: &mut std::task::Context<'_>) -> bool {
        std::future::Future::poll(self.deadline.as_mut(), context).is_ready()
    }
    fn timeout() -> io::Error {
        io::Error::new(io::ErrorKind::TimedOut, "Observer connection expired")
    }
}
impl tokio::io::AsyncRead for BoundedSocket {
    fn poll_read(
        mut self: std::pin::Pin<&mut Self>,
        context: &mut std::task::Context<'_>,
        buffer: &mut tokio::io::ReadBuf<'_>,
    ) -> std::task::Poll<io::Result<()>> {
        if self.expired(context) {
            return std::task::Poll::Ready(Err(Self::timeout()));
        }
        std::pin::Pin::new(&mut self.stream).poll_read(context, buffer)
    }
}
impl tokio::io::AsyncWrite for BoundedSocket {
    fn poll_write(
        mut self: std::pin::Pin<&mut Self>,
        context: &mut std::task::Context<'_>,
        buffer: &[u8],
    ) -> std::task::Poll<io::Result<usize>> {
        if self.expired(context) {
            return std::task::Poll::Ready(Err(Self::timeout()));
        }
        std::pin::Pin::new(&mut self.stream).poll_write(context, buffer)
    }
    fn poll_flush(
        mut self: std::pin::Pin<&mut Self>,
        context: &mut std::task::Context<'_>,
    ) -> std::task::Poll<io::Result<()>> {
        if self.expired(context) {
            return std::task::Poll::Ready(Err(Self::timeout()));
        }
        std::pin::Pin::new(&mut self.stream).poll_flush(context)
    }
    fn poll_shutdown(
        mut self: std::pin::Pin<&mut Self>,
        context: &mut std::task::Context<'_>,
    ) -> std::task::Poll<io::Result<()>> {
        std::pin::Pin::new(&mut self.stream).poll_shutdown(context)
    }
}
