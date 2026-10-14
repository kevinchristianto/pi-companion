use axum::{
    body::{to_bytes, Body},
    http::{Request, StatusCode},
    Router,
};
use companion_core::{
    bridge::{self, BridgeConfig, SecretToken},
    *,
};
use serde_json::{json, Value};
use std::{io, time::Duration};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tower::ServiceExt;

const FIXTURE_TOKEN: &str = "test-only-not-a-credential-1234567890";
fn config() -> BridgeConfig {
    BridgeConfig::new(SecretToken::new(FIXTURE_TOKEN.into()).unwrap())
}
fn app() -> (Observer, Router) {
    let observer = Observer::new();
    observer.set_bridge_status(BridgeStatus::Listening);
    (
        observer.clone(),
        bridge::router(observer, config()).unwrap(),
    )
}
fn request(method: &str, path: &str, body: impl Into<Body>, authenticated: bool) -> Request<Body> {
    let mut builder = Request::builder()
        .method(method)
        .uri(path)
        .header("host", "127.0.0.1:4318")
        .header("content-type", "application/json");
    if authenticated {
        builder = builder.header("authorization", format!("Bearer {FIXTURE_TOKEN}"));
    }
    builder.body(body.into()).unwrap()
}
async fn json_response(response: axum::response::Response) -> Value {
    serde_json::from_slice(
        &to_bytes(response.into_body(), 2 * MAX_BODY_BYTES)
            .await
            .unwrap(),
    )
    .unwrap()
}
fn idle_payload() -> Value {
    json!({"version":1,"session":{"id":"fixture-session","name":"Fix login","agents":[{"id":"main","role":"orchestrator","state":"idle"}]}})
}

#[tokio::test]
async fn health_is_public_minimal_and_hardened() {
    let (_, app) = app();
    let response = app
        .oneshot(request("GET", "/api/health", Body::empty(), false))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(response.headers()["cache-control"], "no-store");
    assert_eq!(response.headers()["x-content-type-options"], "nosniff");
    assert_eq!(
        response.headers()["cross-origin-resource-policy"],
        "same-origin"
    );
    let value = json_response(response).await;
    assert_eq!(
        value,
        json!({"ok":true,"version":1,"service":"pi-companion","readOnly":true})
    );
}

#[tokio::test]
async fn snapshot_ingest_hello_and_unknown_routes_require_bearer_auth() {
    let (_, app) = app();
    for (method, path) in [
        ("GET", "/api/snapshot"),
        ("POST", "/api/hello"),
        ("POST", "/api/ingest"),
        ("GET", "/api/events"),
    ] {
        for authorization in [None, Some("Bearer wrong"), Some("Basic credentials")] {
            let mut req = request(method, path, "{}", false);
            if let Some(value) = authorization {
                req.headers_mut()
                    .insert("authorization", value.parse().unwrap());
            }
            let response = app.clone().oneshot(req).await.unwrap();
            assert_eq!(response.status(), StatusCode::UNAUTHORIZED, "{path}");
            let text = json_response(response).await.to_string();
            assert!(!text.contains(FIXTURE_TOKEN));
        }
    }
    let mut duplicate = request("GET", "/api/snapshot", Body::empty(), true);
    duplicate.headers_mut().append(
        "authorization",
        format!("Bearer {FIXTURE_TOKEN}").parse().unwrap(),
    );
    assert_eq!(
        app.oneshot(duplicate).await.unwrap().status(),
        StatusCode::UNAUTHORIZED
    );
}

#[tokio::test]
async fn rejects_dns_rebinding_cross_origin_and_cross_site_even_for_health() {
    let (_, app) = app();
    for host in [
        "evil.example:4318",
        "127.0.0.1:80",
        "127.0.0.1.evil:4318",
        "localhost",
        "[::1]:4318",
        "LOCALHOST:4318",
    ] {
        let mut req = request("GET", "/api/health", Body::empty(), false);
        req.headers_mut().insert("host", host.parse().unwrap());
        assert_eq!(
            app.clone().oneshot(req).await.unwrap().status(),
            StatusCode::FORBIDDEN
        );
    }
    for (header, value) in [
        ("origin", "https://evil.example"),
        ("origin", "null"),
        ("origin", "http://localhost:4318"),
        ("sec-fetch-site", "cross-site"),
        ("sec-fetch-site", "same-site"),
    ] {
        let mut req = request("GET", "/api/health", Body::empty(), false);
        req.headers_mut().insert(header, value.parse().unwrap());
        assert_eq!(
            app.clone().oneshot(req).await.unwrap().status(),
            StatusCode::FORBIDDEN
        );
    }
    let mut req = request("GET", "/api/health", Body::empty(), false);
    req.headers_mut().remove("host");
    assert_eq!(
        app.clone().oneshot(req).await.unwrap().status(),
        StatusCode::FORBIDDEN
    );
    let mut req = request("GET", "/api/health", Body::empty(), false);
    req.headers_mut()
        .insert("origin", "http://127.0.0.1:4318".parse().unwrap());
    req.headers_mut()
        .insert("sec-fetch-site", "same-origin".parse().unwrap());
    assert_eq!(app.oneshot(req).await.unwrap().status(), StatusCode::OK);
}

#[tokio::test]
async fn duplicate_host_origin_headers_and_remote_peers_are_rejected() {
    let (_, app) = app();
    for header in ["host", "origin", "sec-fetch-site"] {
        let mut req = request("GET", "/api/health", Body::empty(), false);
        if header != "host" {
            req.headers_mut()
                .append(header, "http://127.0.0.1:4318".parse().unwrap());
        }
        req.headers_mut()
            .append(header, "127.0.0.1:4318".parse().unwrap());
        assert_eq!(
            app.clone().oneshot(req).await.unwrap().status(),
            StatusCode::FORBIDDEN
        );
    }
    let mut req = request("GET", "/api/health", Body::empty(), false);
    req.extensions_mut().insert(axum::extract::ConnectInfo(
        "192.0.2.1:4567".parse::<std::net::SocketAddr>().unwrap(),
    ));
    assert_eq!(
        app.oneshot(req).await.unwrap().status(),
        StatusCode::FORBIDDEN
    );
}

#[tokio::test]
async fn query_credentials_absolute_targets_and_control_routes_are_unavailable() {
    let (_, app) = app();
    for path in [
        "/api/snapshot?token=fixture",
        "http://127.0.0.1:4318/api/health",
    ] {
        assert_eq!(
            app.clone()
                .oneshot(request("GET", path, Body::empty(), true))
                .await
                .unwrap()
                .status(),
            StatusCode::BAD_REQUEST
        );
    }
    for path in ["/api/events", "/api/command", "/api/execute", "/"] {
        assert_eq!(
            app.clone()
                .oneshot(request("GET", path, Body::empty(), true))
                .await
                .unwrap()
                .status(),
            StatusCode::NOT_FOUND
        );
    }
}

#[tokio::test]
async fn v1_partial_ingest_projects_session_title_and_never_leaks_token() {
    let (_, app) = app();
    assert_eq!(
        app.clone()
            .oneshot(request(
                "POST",
                "/api/ingest",
                idle_payload().to_string(),
                true
            ))
            .await
            .unwrap()
            .status(),
        StatusCode::ACCEPTED
    );
    let response = app
        .oneshot(request("GET", "/api/snapshot", Body::empty(), true))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let value = json_response(response).await;
    assert_eq!(value["agents"][0]["name"], "Fix login");
    assert_eq!(value["agents"][0]["state"], "idle");
    assert_eq!(value["bridgeStatus"], "listening");
    assert!(!value.to_string().contains(FIXTURE_TOKEN));
    assert!(!format!("{:?}", config()).contains(FIXTURE_TOKEN));
}

#[tokio::test]
async fn hello_negotiates_ordered_lease_and_replay_is_conflict() {
    let (_, app) = app();
    let hello =
        json!({"version":1,"sessionId":"fixture-session","instanceId":"fixture-activation"});
    let response = app
        .clone()
        .oneshot(request("POST", "/api/hello", hello.to_string(), true))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let negotiation = json_response(response).await;
    assert_eq!(negotiation["capabilities"]["sse"], false);
    let mut payload = idle_payload();
    payload["source"] = json!({"generation":negotiation["source"]["generation"],"sequence":0});
    payload["streamId"] = negotiation["streamId"].clone();
    assert_eq!(
        app.clone()
            .oneshot(request("POST", "/api/ingest", payload.to_string(), true))
            .await
            .unwrap()
            .status(),
        StatusCode::ACCEPTED
    );
    assert_eq!(
        app.clone()
            .oneshot(request("POST", "/api/ingest", payload.to_string(), true))
            .await
            .unwrap()
            .status(),
        StatusCode::CONFLICT
    );
    payload["streamId"] = json!("previous-bridge");
    payload["source"]["sequence"] = json!(1);
    assert_eq!(
        app.oneshot(request("POST", "/api/ingest", payload.to_string(), true))
            .await
            .unwrap()
            .status(),
        StatusCode::CONFLICT
    );
}

#[tokio::test]
async fn malformed_payloads_leave_state_untouched() {
    let (observer, app) = app();
    let before = observer.snapshot();
    for body in [
        "not json",
        "null",
        "[]",
        "{}",
        "{\"session\":{\"id\":\"s\",\"agents\":null}}",
        "{\"session\":{\"id\":\"s\",\"agents\":[{\"id\":\"x\",\"state\":\"running\"}]}}",
        "{\"session\":{\"id\":\"s\",\"connected\":\"false\"}}",
        "{\"version\":2,\"session\":{\"id\":\"s\"}}",
        "{\"session\":{\"id\":\"s\",\"agents\":[{\"id\":\"a\"},{\"id\":\"a\"}]}}",
    ] {
        let response = app
            .clone()
            .oneshot(request("POST", "/api/ingest", body, true))
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::BAD_REQUEST, "{body}");
    }
    assert_eq!(observer.snapshot(), before);
}

#[tokio::test]
async fn malformed_hello_and_content_type_fail_without_state_changes() {
    let (_, app) = app();
    for body in [
        "null",
        "[]",
        "{\"version\":9}",
        "{\"version\":1,\"sessionId\":\"s\"}",
    ] {
        assert_eq!(
            app.clone()
                .oneshot(request("POST", "/api/hello", body, true))
                .await
                .unwrap()
                .status(),
            StatusCode::BAD_REQUEST
        );
    }
    for content_type in [None, Some("text/plain"), Some("application/jsonp")] {
        let mut req = request("POST", "/api/hello", "{}", true);
        req.headers_mut().remove("content-type");
        if let Some(value) = content_type {
            req.headers_mut()
                .insert("content-type", value.parse().unwrap());
        }
        assert_eq!(
            app.clone().oneshot(req).await.unwrap().status(),
            StatusCode::UNSUPPORTED_MEDIA_TYPE
        );
    }
    assert_eq!(
        app.oneshot(request("POST", "/api/hello", "{\"version\":1}", true))
            .await
            .unwrap()
            .status(),
        StatusCode::OK
    );
}

#[tokio::test]
async fn oversized_bodies_are_rejected_with_and_without_declared_size() {
    let (_, app) = app();
    let mut declared = request("POST", "/api/ingest", "{}", true);
    declared.headers_mut().insert(
        "content-length",
        (MAX_BODY_BYTES + 1).to_string().parse().unwrap(),
    );
    assert_eq!(
        app.clone().oneshot(declared).await.unwrap().status(),
        StatusCode::PAYLOAD_TOO_LARGE
    );
    let streamed = Body::from_stream(futures_util::stream::iter(vec![
        Ok::<_, io::Error>(vec![b'x'; MAX_BODY_BYTES / 2]),
        Ok(vec![b'y'; MAX_BODY_BYTES / 2 + 1]),
    ]));
    assert_eq!(
        app.oneshot(request("POST", "/api/ingest", streamed, true))
            .await
            .unwrap()
            .status(),
        StatusCode::PAYLOAD_TOO_LARGE
    );
}

#[tokio::test(start_paused = true)]
async fn request_body_has_a_real_deadline() {
    let (_, app) = app();
    let stream = futures_util::stream::once(async {
        tokio::time::sleep(Duration::from_secs(20)).await;
        Ok::<_, io::Error>("{}")
    });
    let response = app
        .oneshot(request(
            "POST",
            "/api/hello",
            Body::from_stream(stream),
            true,
        ))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::REQUEST_TIMEOUT);
}

#[tokio::test]
async fn concurrency_is_bounded_and_cancellation_releases_permit() {
    let observer = Observer::new();
    let mut cfg = config();
    cfg.max_concurrent_requests = 1;
    let app = bridge::router(observer, cfg).unwrap();
    let (entered_tx, entered_rx) = tokio::sync::oneshot::channel();
    let stream = futures_util::stream::once(async move {
        entered_tx.send(()).unwrap();
        std::future::pending::<()>().await;
        Ok::<_, io::Error>("{}")
    });
    let first = tokio::spawn(app.clone().oneshot(request(
        "POST",
        "/api/hello",
        Body::from_stream(stream),
        true,
    )));
    entered_rx.await.unwrap();
    assert_eq!(
        app.clone()
            .oneshot(request("GET", "/api/health", Body::empty(), false))
            .await
            .unwrap()
            .status(),
        StatusCode::SERVICE_UNAVAILABLE
    );
    first.abort();
    let _ = first.await;
    assert_eq!(
        app.oneshot(request("GET", "/api/health", Body::empty(), false))
            .await
            .unwrap()
            .status(),
        StatusCode::OK
    );
}

#[tokio::test]
async fn live_network_binds_only_ipv4_loopback_and_shuts_down() {
    let observer = Observer::new();
    let mut cfg = config();
    cfg.port = 0;
    let handle = bridge::start(observer.clone(), cfg).await.unwrap();
    let address = handle.local_addr();
    assert_eq!(address.ip().to_string(), "127.0.0.1");
    let mut socket = tokio::net::TcpStream::connect(address).await.unwrap();
    socket
        .write_all(
            format!("GET /api/health HTTP/1.1\r\nHost: {address}\r\nConnection: close\r\n\r\n")
                .as_bytes(),
        )
        .await
        .unwrap();
    let mut response = String::new();
    socket.read_to_string(&mut response).await.unwrap();
    assert!(response.starts_with("HTTP/1.1 200 OK"));
    assert!(!response.contains(FIXTURE_TOKEN));
    observer
        .ingest(serde_json::from_value(idle_payload()).unwrap())
        .unwrap();
    handle.shutdown().await.unwrap();
    assert_eq!(observer.snapshot().bridge_status, BridgeStatus::Stopped);
    assert!(observer.snapshot().agents.is_empty());
    assert!(tokio::net::TcpStream::connect(address).await.is_err());
}

#[tokio::test(start_paused = true)]
async fn rust_owned_expiry_runs_without_any_ui_snapshot_calls() {
    let observer = Observer::new();
    let mut cfg = config();
    cfg.port = 0;
    let handle = bridge::start(observer.clone(), cfg).await.unwrap();
    let mut updates = observer.subscribe();
    observer
        .ingest(serde_json::from_value(idle_payload()).unwrap())
        .unwrap();
    assert_eq!(updates.borrow_and_update().agents.len(), 1);
    tokio::task::yield_now().await;
    tokio::time::advance(Duration::from_secs(35)).await;
    tokio::task::yield_now().await;
    assert_eq!(
        updates.borrow().agents.len(),
        1,
        "exact boundary remains live"
    );
    tokio::time::advance(Duration::from_millis(251)).await;
    tokio::task::yield_now().await;
    assert!(
        updates.borrow().agents.is_empty(),
        "Rust ticker expires even with no IPC polling"
    );
    handle.shutdown().await.unwrap();
}

#[tokio::test]
async fn bind_failure_and_drop_report_non_live_status() {
    let occupied = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let observer = Observer::new();
    let mut cfg = config();
    cfg.port = occupied.local_addr().unwrap().port();
    assert!(bridge::start(observer.clone(), cfg).await.is_err());
    assert_eq!(observer.snapshot().bridge_status, BridgeStatus::Error);
    let mut cfg = config();
    cfg.port = 0;
    let handle = bridge::start(observer.clone(), cfg).await.unwrap();
    observer
        .ingest(serde_json::from_value(idle_payload()).unwrap())
        .unwrap();
    drop(handle);
    assert_eq!(observer.snapshot().bridge_status, BridgeStatus::Stopped);
    assert!(observer.snapshot().agents.is_empty());
}

#[tokio::test]
async fn incomplete_headers_cannot_hold_the_only_socket_forever() {
    let observer = Observer::new();
    let mut cfg = config();
    cfg.port = 0;
    cfg.max_concurrent_connections = 1;
    cfg.connection_lifetime = Duration::from_millis(100);
    let handle = bridge::start(observer, cfg).await.unwrap();
    let address = handle.local_addr();
    let mut stalled = tokio::net::TcpStream::connect(address).await.unwrap();
    stalled
        .write_all(b"GET /api/health HTTP/1.1\r\nHost: ")
        .await
        .unwrap();
    tokio::time::sleep(Duration::from_millis(10)).await;
    let mut waiting = tokio::net::TcpStream::connect(address).await.unwrap();
    waiting
        .write_all(
            format!("GET /api/health HTTP/1.1\r\nHost: {address}\r\nConnection: close\r\n\r\n")
                .as_bytes(),
        )
        .await
        .unwrap();
    let mut byte = [0_u8; 1];
    assert!(
        tokio::time::timeout(Duration::from_millis(20), waiting.read(&mut byte))
            .await
            .is_err(),
        "second connection is not accepted while cap is occupied"
    );
    let mut response = String::new();
    tokio::time::timeout(
        Duration::from_secs(1),
        waiting.read_to_string(&mut response),
    )
    .await
    .unwrap()
    .unwrap();
    assert!(response.starts_with("HTTP/1.1 200 OK"));
    handle.shutdown().await.unwrap();
}

#[test]
fn invalid_token_and_dangerous_timer_settings_never_start() {
    for value in [
        "short",
        "secret with spaces secret with spaces",
        "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\n",
    ] {
        assert!(SecretToken::new(value.to_owned()).is_err());
    }
    let mut cfg = config();
    cfg.max_concurrent_requests = 0;
    assert!(bridge::router(Observer::new(), cfg).is_err());
}

#[tokio::test]
async fn real_adapter_fixtures_cross_the_http_contract() {
    let (_, app) = app();
    let hello = include_str!("../../../observer/fixtures/hello-request-v1.json");
    let response = app
        .clone()
        .oneshot(request("POST", "/api/hello", hello, true))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let lease = json_response(response).await;
    for (sequence, fixture) in [
        (
            1,
            include_str!("../../../observer/fixtures/connected-v1.json"),
        ),
        (
            2,
            include_str!("../../../observer/fixtures/disconnected-v1.json"),
        ),
    ] {
        let mut payload: Value = serde_json::from_str(fixture).unwrap();
        payload["streamId"] = lease["streamId"].clone();
        payload["source"] = json!({"generation":lease["source"]["generation"],"sequence":sequence});
        let response = app
            .clone()
            .oneshot(request("POST", "/api/ingest", payload.to_string(), true))
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::ACCEPTED);
        let snapshot = json_response(
            app.clone()
                .oneshot(request("GET", "/api/snapshot", Body::empty(), true))
                .await
                .unwrap(),
        )
        .await;
        if sequence == 1 {
            assert_eq!(snapshot["agents"].as_array().unwrap().len(), 2);
            assert_eq!(snapshot["agents"][0]["name"], "Reviewer");
            assert_eq!(snapshot["agents"][1]["name"], "Documentation project");
        } else {
            assert!(snapshot["agents"].as_array().unwrap().is_empty());
        }
    }
}

#[tokio::test]
async fn array_shaped_structs_cannot_bypass_object_schema() {
    let (_, app) = app();
    for body in [
        json!({"session":["s",null,null,true,[]]}),
        json!({"session":{"id":"s","agents":[["a"]]}}),
        json!({"source":[1,2],"session":{"id":"s"}}),
        json!({"session":{"id":"s","agents":[{"id":"a","lifecycle":[1,"id","start","pi:session_start","2026-10-14T00:00:00Z"]}]}}),
    ] {
        assert_eq!(
            app.clone()
                .oneshot(request("POST", "/api/ingest", body.to_string(), true))
                .await
                .unwrap()
                .status(),
            StatusCode::BAD_REQUEST
        );
    }
}
