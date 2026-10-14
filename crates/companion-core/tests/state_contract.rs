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
fn session(id: &str) -> IngestPayload {
    payload(
        json!({"version":1,"session":{"id":id,"name":"Feature work","connected":true,"agents":[{"id":"main","name":"Main","role":"orchestrator","state":"idle"}]}}),
    )
}
fn lifecycle(kind: &str, id: &str, at: &str) -> Value {
    json!({"version":1,"eventId":id,"kind":kind,"source":"pi-subagents:child-status","at":at})
}

#[test]
fn idle_is_live_through_exact_boundary_then_expires() {
    let (mut store, now) = active();
    store.ingest_at(session("s"), now).unwrap();
    let before = store.snapshot_at(now + STALE_AFTER);
    assert_eq!(before.agents.len(), 1);
    assert_eq!(before.agents[0].state, AgentState::Idle);
    let after = store.snapshot_at(now + STALE_AFTER + Duration::from_nanos(1));
    assert!(after.agents.is_empty());
    assert!(after.revision > before.revision);
    assert_eq!(after, store.snapshot_at(now + Duration::from_secs(100)));
}

#[test]
fn source_timestamp_cannot_extend_liveness() {
    let (mut store, now) = active();
    store.ingest_at(payload(json!({"session":{"id":"s","updatedAt":"9999-12-31T23:59:59Z","agents":[{"id":"main","state":"working","updatedAt":"9999-12-31T23:59:59Z"}]}})), now).unwrap();
    assert!(store
        .snapshot_at(now + Duration::from_secs(36))
        .agents
        .is_empty());
}

#[test]
fn partial_heartbeat_refreshes_receipt_and_preserves_idle_name_task() {
    let (mut store, now) = active();
    store.ingest_at(payload(json!({"session":{"id":"s","name":"Patch auth","agents":[{"id":"main","role":"orchestrator","state":"idle","task":"Waiting for input"},{"id":"child","name":"Researcher","task":"Docs","state":"working"}]}})), now).unwrap();
    store
        .ingest_at(
            payload(json!({"session":{"id":"s"}})),
            now + Duration::from_secs(30),
        )
        .unwrap();
    let snapshot = store.snapshot_at(now + Duration::from_secs(50));
    assert_eq!(snapshot.agents.len(), 2);
    assert_eq!(snapshot.agents[0].name, "Researcher");
    assert_eq!(snapshot.agents[0].task, "Docs");
    assert_eq!(snapshot.agents[1].name, "Patch auth");
}

#[test]
fn disconnect_and_bridge_failure_hide_every_agent() {
    let (mut store, now) = active();
    store.ingest_at(session("s"), now).unwrap();
    store
        .ingest_at(
            payload(json!({"session":{"id":"s","connected":false}})),
            now,
        )
        .unwrap();
    assert!(store.snapshot_at(now).agents.is_empty());
    store
        .ingest_at(payload(json!({"session":{"id":"s","connected":true}})), now)
        .unwrap();
    assert_eq!(store.snapshot_at(now).agents.len(), 1);
    assert!(store
        .set_bridge_status_at(BridgeStatus::Error, now)
        .agents
        .is_empty());
    assert!(store
        .set_bridge_status_at(BridgeStatus::Stopped, now)
        .agents
        .is_empty());
    assert!(store
        .set_bridge_status_at(BridgeStatus::Starting, now)
        .agents
        .is_empty());
    assert_eq!(
        store
            .set_bridge_status_at(BridgeStatus::Listening, now)
            .agents
            .len(),
        1
    );
}

#[test]
fn stop_is_sticky_until_newer_explicit_start() {
    let (mut store, now) = active();
    let update = |marker: Value| {
        payload(
            json!({"session":{"id":"s","agents":[{"id":"a","state":"idle","lifecycle":marker}]}}),
        )
    };
    store
        .ingest_at(
            update(lifecycle("stop", "stop-1", "2026-10-14T10:00:01Z")),
            now,
        )
        .unwrap();
    assert!(store.snapshot_at(now).agents.is_empty());
    store.ingest_at(update(Value::Null), now).unwrap();
    store
        .ingest_at(
            update(lifecycle("start", "old", "2026-10-14T10:00:00Z")),
            now,
        )
        .unwrap();
    assert!(store.snapshot_at(now).agents.is_empty());
    store
        .ingest_at(
            update(lifecycle("start", "equal", "2026-10-14T10:00:01Z")),
            now,
        )
        .unwrap();
    assert!(store.snapshot_at(now).agents.is_empty());
    store
        .ingest_at(
            update(lifecycle("start", "new", "2026-10-14T10:00:02Z")),
            now,
        )
        .unwrap();
    assert_eq!(store.snapshot_at(now).agents.len(), 1);
}

#[test]
fn stale_and_offline_states_never_project_even_in_connected_session() {
    let (mut store, now) = active();
    store.ingest_at(payload(json!({"session":{"id":"s","agents":[{"id":"a","state":"stale"},{"id":"b","state":"offline"},{"id":"c","state":"idle"}]}})), now).unwrap();
    let snapshot = store.snapshot_at(now);
    assert_eq!(snapshot.agents.len(), 1);
    assert_eq!(snapshot.agents[0].agent_id, "c");
}

#[test]
fn rejects_invalid_identity_atomically_instead_of_lossy_cleanup() {
    for id in ["", "  ", "\n", "agent\0one", "agent\u{7f}"] {
        let (mut store, now) = active();
        assert_eq!(
            store.ingest_at(session(id), now),
            Err(IngestError::Identity)
        );
        assert!(store.snapshot_at(now).agents.is_empty());
        assert_eq!(store.ingest_at(payload(json!({"session":{"id":"s","name":"Uncommitted","agents":[{"id":"valid"},{"id":id}]}})), now), Err(IngestError::Identity));
        assert!(store.snapshot_at(now).agents.is_empty());
    }
    let (mut store, now) = active();
    assert_eq!(
        store.ingest_at(session(&"a".repeat(241)), now),
        Err(IngestError::Identity)
    );
    store.ingest_at(session(&"界".repeat(240)), now).unwrap();
}

#[test]
fn display_text_is_bounded_without_mutating_identity() {
    let (mut store, now) = active();
    store.ingest_at(payload(json!({"session":{"id":" A ","name":"Title\u{202e}\u{0}","agents":[{"id":"a:b","name":"Visible\n\u{202e}Name","task":"x".repeat(3000),"role":"subagent"}]}})), now).unwrap();
    let agent = &store.snapshot_at(now).agents[0];
    assert_eq!(agent.session_id, " A ");
    assert_eq!(agent.name, "VisibleName");
    assert_eq!(agent.session_name, "Title");
    assert_eq!(agent.task.len(), 2000);
}

#[test]
fn collision_free_keys_and_deterministic_display_disambiguation() {
    let mut output = Vec::new();
    for reversed in [false, true] {
        let (mut store, now) = active();
        let mut ids = vec!["a:b", "a"];
        if reversed {
            ids.reverse();
        }
        for id in ids {
            store.ingest_at(payload(json!({"session":{"id":id,"agents":[{"id":if id == "a" {"b:c"} else {"c"},"name":"Scout"},{"id":"reserved","name":"Scout · 1"}]}})), now).unwrap();
        }
        let agents = store.snapshot_at(now).agents;
        assert_eq!(agents.len(), 4);
        let names: std::collections::BTreeSet<_> = agents.iter().map(|agent| &agent.name).collect();
        let keys: std::collections::BTreeSet<_> = agents.iter().map(|agent| &agent.key).collect();
        assert_eq!(names.len(), 4);
        assert_eq!(keys.len(), 4);
        output.push(agents);
    }
    assert_eq!(output[0], output[1]);
}

#[test]
fn explicit_null_clears_optional_metadata_omission_preserves_it() {
    let (mut store, now) = active();
    store.ingest_at(payload(json!({"session":{"id":"s","model":"session-model","agents":[{"id":"a","tool":"read","model":"child-model"}]}})), now).unwrap();
    store
        .ingest_at(
            payload(json!({"session":{"id":"s","agents":[{"id":"a"}]}})),
            now,
        )
        .unwrap();
    assert_eq!(
        store.snapshot_at(now).agents[0].tool.as_deref(),
        Some("read")
    );
    store.ingest_at(payload(json!({"session":{"id":"s","model":null,"agents":[{"id":"a","tool":null,"model":null}]}})), now).unwrap();
    let agent = &store.snapshot_at(now).agents[0];
    assert_eq!(agent.tool, None);
    assert_eq!(agent.model, None);
    let encoded = serde_json::to_value(agent).unwrap();
    assert!(encoded.get("tool").is_none());
}

#[test]
fn bounded_sessions_reject_live_eviction_but_reclaim_departed_sessions() {
    let (mut store, now) = active();
    for id in 0..MAX_SESSIONS {
        store.ingest_at(session(&id.to_string()), now).unwrap();
    }
    assert_eq!(
        store.ingest_at(session("overflow"), now),
        Err(IngestError::SessionLimit)
    );
    assert_eq!(store.snapshot_at(now).agents.len(), MAX_SESSIONS);
    store
        .ingest_at(
            payload(json!({"session":{"id":"0","connected":false}})),
            now,
        )
        .unwrap();
    store.ingest_at(session("replacement"), now).unwrap();
    assert_eq!(store.snapshot_at(now).agents.len(), MAX_SESSIONS);
}

#[test]
fn bounded_agents_and_duplicates_reject_whole_update() {
    let (mut store, now) = active();
    let agents: Vec<_> = (0..MAX_AGENTS_PER_SESSION)
        .map(|id| json!({"id":id.to_string()}))
        .collect();
    store
        .ingest_at(payload(json!({"session":{"id":"s","agents":agents}})), now)
        .unwrap();
    assert_eq!(
        store.ingest_at(
            payload(json!({"session":{"id":"s","agents":[{"id":"overflow"}]}})),
            now
        ),
        Err(IngestError::AgentLimit)
    );
    assert_eq!(store.snapshot_at(now).agents.len(), MAX_AGENTS_PER_SESSION);
    assert_eq!(
        store.ingest_at(
            payload(json!({"session":{"id":"s2","agents":[{"id":"dup"},{"id":"dup"}]}})),
            now
        ),
        Err(IngestError::DuplicateAgent)
    );
}

#[test]
fn ordering_rejects_replay_without_refreshing_receipt() {
    let (mut store, now) = active();
    let lease = store.register_source_at("s", "activation-a", now).unwrap();
    assert_eq!(
        store.register_source_at("s", "activation-a", now).unwrap(),
        lease
    );
    let mut message = session("s");
    message.stream_id = Some(store.stream_id().to_owned());
    message.source = Some(SourceOrder {
        generation: lease.generation,
        sequence: 4,
    });
    store.ingest_at(message.clone(), now).unwrap();
    assert_eq!(
        store.ingest_at(message.clone(), now + Duration::from_secs(34)),
        Err(IngestError::OutOfOrder)
    );
    message.source.as_mut().unwrap().sequence = 3;
    assert_eq!(
        store.ingest_at(message, now + Duration::from_secs(34)),
        Err(IngestError::OutOfOrder)
    );
    assert_eq!(
        store.ingest_at(session("s"), now + Duration::from_secs(34)),
        Err(IngestError::OutOfOrder)
    );
    assert!(store
        .snapshot_at(now + Duration::from_secs(36))
        .agents
        .is_empty());
}

#[test]
fn bridge_issued_restart_generation_prevents_old_source_reclamation() {
    let (mut store, now) = active();
    let old = store.register_source_at("s", "activation-a", now).unwrap();
    let mut message = session("s");
    message.stream_id = Some(store.stream_id().to_owned());
    message.source = Some(SourceOrder {
        generation: old.generation,
        sequence: 99,
    });
    store.ingest_at(message.clone(), now).unwrap();
    let new = store.register_source_at("s", "activation-b", now).unwrap();
    assert_eq!(
        store.snapshot_at(now).agents.len(),
        1,
        "hello alone does not replace source"
    );
    let mut replacement = payload(
        json!({"session":{"id":"s","name":"Restart","agents":[{"id":"new-root","role":"orchestrator"}]}}),
    );
    replacement.stream_id = Some(store.stream_id().to_owned());
    replacement.source = Some(SourceOrder {
        generation: new.generation,
        sequence: 0,
    });
    store.ingest_at(replacement, now).unwrap();
    assert_eq!(store.snapshot_at(now).agents[0].agent_id, "new-root");
    message.source.as_mut().unwrap().sequence = 100;
    assert_eq!(store.ingest_at(message, now), Err(IngestError::OutOfOrder));
    assert_eq!(
        store.register_source_at("s", "activation-a", now),
        Err(IngestError::OutOfOrder)
    );
}

#[test]
fn source_leases_are_session_bound_and_revoked_on_eviction() {
    let (mut store, now) = active();
    let lease = store.register_source_at("s", "activation", now).unwrap();
    let mut wrong = session("wrong");
    wrong.stream_id = Some(store.stream_id().to_owned());
    wrong.source = Some(SourceOrder {
        generation: lease.generation,
        sequence: 0,
    });
    assert_eq!(store.ingest_at(wrong, now), Err(IngestError::UnknownSource));
    for id in 0..MAX_SESSIONS {
        store.ingest_at(session(&id.to_string()), now).unwrap();
    }
    let mut old = session("s");
    old.stream_id = Some(store.stream_id().to_owned());
    old.source = Some(SourceOrder {
        generation: lease.generation,
        sequence: 0,
    });
    assert_eq!(store.ingest_at(old, now), Err(IngestError::UnknownSource));
}

#[test]
fn invalid_lifecycle_and_protocol_are_rejected() {
    let (mut store, now) = active();
    let mut message = session("s");
    message.version = Some(2);
    assert_eq!(store.ingest_at(message, now), Err(IngestError::Version));
    let mut invalid = lifecycle("start", "event", "not-a-date");
    for field in ["at", "eventId", "source"] {
        invalid[field] = json!("bad value");
        let message =
            payload(json!({"session":{"id":"s","agents":[{"id":"a","lifecycle":invalid}]}}));
        assert_eq!(store.ingest_at(message, now), Err(IngestError::Lifecycle));
    }
}

#[test]
fn missing_or_empty_source_data_never_creates_fake_agents() {
    let (mut store, now) = active();
    assert!(store.snapshot_at(now).agents.is_empty());
    store
        .ingest_at(
            payload(json!({"session":{"id":"s","name":"Connected but no root yet"}})),
            now,
        )
        .unwrap();
    assert!(store.snapshot_at(now).agents.is_empty());
    assert!(
        serde_json::from_value::<IngestPayload>(json!({"session":{"id":"s","agents":null}}))
            .is_err()
    );
    assert!(
        serde_json::from_value::<IngestPayload>(json!({"session":{"id":"s","agents":{}}})).is_err()
    );
}

#[test]
fn snapshots_have_separate_stream_ids_and_monotonic_projection_revision() {
    let (mut store, now) = active();
    let first = store.snapshot_at(now);
    let second = StateStore::new().snapshot_at(now);
    assert_ne!(first.stream_id, second.stream_id);
    store.ingest_at(session("s"), now).unwrap();
    let revision = store.snapshot_at(now).revision;
    store
        .ingest_at(session("s"), now + Duration::from_secs(1))
        .unwrap();
    assert_eq!(
        store.snapshot_at(now + Duration::from_secs(1)).revision,
        revision
    );
}

#[test]
fn ordered_complete_roster_removes_departed_children_and_allows_bounded_churn() {
    let (mut store, now) = active();
    let lease = store.register_source_at("s", "activation", now).unwrap();
    for sequence in 0..200 {
        let message = payload(
            json!({"streamId":store.stream_id(),"source":{"generation":lease.generation,"sequence":sequence},
            "session":{"id":"s","agentsComplete":true,"omittedAgentCount":3,
            "agents":[{"id":"main","role":"orchestrator"},{"id":format!("child-{sequence}")}]}}),
        );
        store.ingest_at(message, now).unwrap();
        assert_eq!(store.snapshot_at(now).agents.len(), 2);
    }
    assert_eq!(store.snapshot_at(now).omitted_agent_count, 3);
    assert_eq!(
        store
            .snapshot_at(now + Duration::from_secs(36))
            .omitted_agent_count,
        0
    );
    let message = payload(json!({"session":{"id":"legacy","agentsComplete":true,"agents":[]}}));
    assert_eq!(
        store.ingest_at(message, now),
        Err(IngestError::IncompleteRoster)
    );
}

#[test]
fn previous_bridge_packets_cannot_replay_after_generation_counter_reset() {
    let (mut first, now) = active();
    let lease = first.register_source_at("s", "old-instance", now).unwrap();
    let mut delayed = session("s");
    delayed.stream_id = Some(first.stream_id().to_owned());
    delayed.source = Some(SourceOrder {
        generation: lease.generation,
        sequence: 999,
    });
    let (mut restarted, now) = active();
    let replacement = restarted
        .register_source_at("s", "new-instance", now)
        .unwrap();
    assert_eq!(lease.generation, replacement.generation);
    assert_eq!(
        restarted.ingest_at(delayed, now),
        Err(IngestError::UnknownSource)
    );
}

#[test]
fn ordered_lifecycle_transitions_use_sequence_not_sender_wall_clock() {
    let (mut store, now) = active();
    let lease = store.register_source_at("s", "activation", now).unwrap();
    for (sequence, kind, at, expected) in [
        (1, "stop", "2026-10-14T10:00:00Z", 0),
        (2, "start", "2026-10-14T10:00:00Z", 1),
        (3, "stop", "2026-10-14T10:00:00Z", 0),
        (4, "start", "2026-10-14T09:00:00Z", 1),
    ] {
        let message = payload(
            json!({"streamId":store.stream_id(),"source":{"generation":lease.generation,"sequence":sequence},"session":{"id":"s","agents":[{"id":"a","lifecycle":lifecycle(kind,&format!("event-{sequence}"),at)}]}}),
        );
        store.ingest_at(message, now).unwrap();
        assert_eq!(store.snapshot_at(now).agents.len(), expected);
    }
}

#[test]
fn only_known_root_identities_take_session_title_and_nested_orchestrators_keep_names() {
    let (mut store, now) = active();
    store
        .ingest_at(
            payload(
                json!({"session":{"id":"new-session","name":"New session title","agents":[
                    {"id":"main","name":"Pi","role":"orchestrator"},
                    {"id":"child:one","name":"Research coordinator","role":"orchestrator"}
                ]}}),
            ),
            now,
        )
        .unwrap();
    store
        .ingest_at(
            payload(
                json!({"session":{"id":"legacy-session","name":"Legacy session title","agents":[
                    {"id":"legacy-session:main","name":"Pi legacy","role":"orchestrator"},
                    {"id":"other-session:main","name":"Nested coordinator","role":"orchestrator"}
                ]}}),
            ),
            now,
        )
        .unwrap();
    store
        .ingest_at(
            payload(
                json!({"session":{"id":"child-only","name":"Unrelated title","agents":[
                    {"id":"main","name":"Named child","role":"subagent"}
                ]}}),
            ),
            now,
        )
        .unwrap();
    let snapshot = store.snapshot_at(now);
    let names: std::collections::BTreeMap<_, _> = snapshot
        .agents
        .iter()
        .map(|agent| {
            (
                (agent.session_id.as_str(), agent.agent_id.as_str()),
                agent.name.as_str(),
            )
        })
        .collect();
    assert_eq!(names[&("new-session", "main")], "New session title");
    assert_eq!(names[&("new-session", "child:one")], "Research coordinator");
    assert_eq!(
        names[&("legacy-session", "legacy-session:main")],
        "Legacy session title"
    );
    assert_eq!(
        names[&("legacy-session", "other-session:main")],
        "Nested coordinator"
    );
    assert_eq!(names[&("child-only", "main")], "Named child");
}
