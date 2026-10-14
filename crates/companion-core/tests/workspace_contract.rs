use companion_core::*;
use serde_json::{json, Value};
use std::time::{Duration, Instant};

fn payload(value: Value) -> IngestPayload {
    serde_json::from_value(value).unwrap()
}

fn active() -> (StateStore, Instant) {
    let mut store = StateStore::new();
    let now = Instant::now();
    store.set_bridge_status_at(BridgeStatus::Listening, now);
    (store, now)
}

fn session(id: &str, cwd: Value) -> IngestPayload {
    payload(
        json!({"session":{"id":id,"name":format!("Task {id}"),"cwd":cwd,
        "agents":[{"id":"main","name":"Pi","role":"orchestrator"},{"id":"child","name":format!("Helper {id}")}]}}),
    )
}

#[test]
fn workspace_identity_is_forwarded_to_every_agent_without_collapsing_sessions() {
    let (mut store, now) = active();
    for id in ["first", "second"] {
        store
            .ingest_at(session(id, json!("C:\\work\\companion")), now)
            .unwrap();
    }
    let snapshot = store.snapshot_at(now);
    assert_eq!(snapshot.agents.len(), 4);
    assert!(snapshot
        .agents
        .iter()
        .all(|agent| agent.cwd.as_deref() == Some("C:\\work\\companion")));
    let keys: std::collections::BTreeSet<_> =
        snapshot.agents.iter().map(|agent| &agent.key).collect();
    assert_eq!(keys.len(), 4);
    assert!(snapshot
        .agents
        .iter()
        .any(|agent| agent.name == "Task first"));
    assert!(snapshot
        .agents
        .iter()
        .any(|agent| agent.name == "Task second"));
    assert!(snapshot
        .agents
        .iter()
        .any(|agent| agent.name == "Helper first"));
    assert!(snapshot
        .agents
        .iter()
        .any(|agent| agent.name == "Helper second"));
    let encoded = serde_json::to_value(&snapshot.agents[0]).unwrap();
    assert_eq!(encoded["cwd"], "C:\\work\\companion");
}

#[test]
fn partial_updates_preserve_cwd_and_null_or_blank_explicitly_clear_it() {
    let (mut store, now) = active();
    for clear in [Value::Null, json!(""), json!("   ")] {
        store
            .ingest_at(session("s", json!(" /significant spaces/ ")), now)
            .unwrap();
        store
            .ingest_at(payload(json!({"session":{"id":"s","name":"Renamed"}})), now)
            .unwrap();
        let preserved = store.snapshot_at(now);
        assert_eq!(preserved.agents.len(), 2);
        assert!(preserved
            .agents
            .iter()
            .all(|agent| agent.cwd.as_deref() == Some(" /significant spaces/ ")));
        store
            .ingest_at(payload(json!({"session":{"id":"s","cwd":clear}})), now)
            .unwrap();
        let cleared = store.snapshot_at(now);
        assert!(cleared.agents.iter().all(|agent| agent.cwd.is_none()));
        assert!(cleared.revision > preserved.revision);
        assert!(serde_json::to_value(&cleared.agents[0])
            .unwrap()
            .get("cwd")
            .is_none());
    }
}

#[test]
fn exact_case_unicode_separators_and_dot_segments_are_not_normalized() {
    let (mut store, now) = active();
    let paths = [
        "/repo",
        "/Repo",
        "/repo/",
        "/repo/.",
        "/repo/../repo",
        "C:\\work\\repo",
        "C:/work/repo",
        "/caf\u{e9}",
        "/cafe\u{301}",
    ];
    for (index, path) in paths.iter().enumerate() {
        store
            .ingest_at(session(&index.to_string(), json!(path)), now)
            .unwrap();
    }
    let snapshot = store.snapshot_at(now);
    for (index, path) in paths.iter().enumerate() {
        assert!(snapshot
            .agents
            .iter()
            .filter(|agent| agent.session_id == index.to_string())
            .all(|agent| agent.cwd.as_deref() == Some(*path)));
    }
    let identities: std::collections::BTreeSet<_> =
        snapshot.agents.iter().map(|agent| &agent.cwd).collect();
    assert_eq!(identities.len(), paths.len());
}

#[test]
fn malformed_workspace_identity_rejects_atomically_without_lossy_cleanup() {
    let (mut store, now) = active();
    store.ingest_at(session("s", json!("/old")), now).unwrap();
    let original = store.snapshot_at(now);
    for cwd in [
        "x".repeat(4097),
        "🚀".repeat(2049),
        "/repo\nname".into(),
        "/repo\0name".into(),
        "/repo\u{7f}name".into(),
    ] {
        assert_eq!(
            store.ingest_at(session("s", json!(cwd)), now),
            Err(IngestError::Workspace)
        );
        assert_eq!(store.snapshot_at(now), original);
    }
    for cwd in [json!(12), json!([]), json!({})] {
        assert!(
            serde_json::from_value::<IngestPayload>(json!({"session":{"id":"s","cwd":cwd}}))
                .is_err()
        );
    }
    for cwd in ["x".repeat(4096), "🚀".repeat(2048)] {
        store.ingest_at(session("s", json!(cwd)), now).unwrap();
        assert_eq!(
            store.snapshot_at(now).agents[0].cwd.as_deref(),
            Some(cwd.as_str())
        );
    }
}

#[test]
fn fresh_activation_does_not_inherit_a_departed_sources_workspace() {
    let (mut store, now) = active();
    let old = store.register_source_at("s", "old", now).unwrap();
    let mut first = session("s", json!("/old"));
    first.stream_id = Some(store.stream_id().into());
    first.source = Some(SourceOrder {
        generation: old.generation,
        sequence: 0,
    });
    store.ingest_at(first, now).unwrap();
    let new = store.register_source_at("s", "new", now).unwrap();
    // Registration alone does not change the current workspace.
    assert_eq!(
        store.snapshot_at(now).agents[0].cwd.as_deref(),
        Some("/old")
    );
    let mut replacement =
        payload(json!({"session":{"id":"s","agents":[{"id":"main","role":"orchestrator"}]}}));
    replacement.stream_id = Some(store.stream_id().into());
    replacement.source = Some(SourceOrder {
        generation: new.generation,
        sequence: 0,
    });
    store.ingest_at(replacement, now).unwrap();
    let snapshot = store.snapshot_at(now);
    assert_eq!(snapshot.agents.len(), 1);
    assert_eq!(snapshot.agents[0].cwd, None);
}

#[test]
fn workspace_projection_expires_and_reconnects_only_with_authoritative_live_agents() {
    let (mut store, now) = active();
    store
        .ingest_at(session("first", json!("/same")), now)
        .unwrap();
    store
        .ingest_at(
            session("second", json!("/same")),
            now + Duration::from_secs(20),
        )
        .unwrap();
    let later = now + Duration::from_secs(36);
    let snapshot = store.snapshot_at(later);
    assert_eq!(snapshot.agents.len(), 2);
    assert!(snapshot
        .agents
        .iter()
        .all(|agent| agent.session_id == "second" && agent.cwd.as_deref() == Some("/same")));
    store
        .ingest_at(
            payload(json!({"session":{"id":"second","connected":false}})),
            later,
        )
        .unwrap();
    assert!(store.snapshot_at(later).agents.is_empty());
    store
        .ingest_at(session("third", json!("/same")), later)
        .unwrap();
    let snapshot = store.snapshot_at(later);
    assert_eq!(snapshot.agents.len(), 2);
    assert!(snapshot
        .agents
        .iter()
        .all(|agent| agent.session_id == "third" && agent.cwd.as_deref() == Some("/same")));
    assert!(store
        .set_bridge_status_at(BridgeStatus::Error, later)
        .agents
        .is_empty());
}
