use crate::model::*;
use std::{
    collections::{BTreeMap, BTreeSet},
    sync::{Arc, Mutex, MutexGuard},
    time::Instant,
};
use tokio::sync::watch;

const MAX_LEASES_PER_SESSION: usize = 128;

#[derive(Clone, Debug)]
struct Agent {
    id: String,
    name: String,
    role: String,
    task: String,
    state: AgentState,
    tool: Option<String>,
    model: Option<String>,
    stopped: bool,
    lifecycle_event: Option<String>,
    lifecycle_at: Option<i64>,
}

#[derive(Debug)]
struct Session {
    id: String,
    name: String,
    cwd: Option<String>,
    model: Option<String>,
    agents: BTreeMap<String, Agent>,
    connected: bool,
    last_receipt: Option<Instant>,
    order: Option<SourceOrder>,
    leases: BTreeMap<String, u64>,
    omitted_agent_count: u64,
}

impl Session {
    fn new(id: String) -> Self {
        Self {
            id,
            name: "Pi session".into(),
            cwd: None,
            model: None,
            agents: BTreeMap::new(),
            connected: false,
            last_receipt: None,
            order: None,
            leases: BTreeMap::new(),
            omitted_agent_count: 0,
        }
    }

    fn is_live(&self, now: Instant) -> bool {
        self.connected
            && self
                .last_receipt
                .is_some_and(|receipt| now.saturating_duration_since(receipt) <= STALE_AFTER)
    }
}

/// Deterministic state machine with an injectable monotonic receipt clock for
/// boundary tests. Production callers normally use the thread-safe `Observer`.
#[derive(Debug)]
pub struct StateStore {
    sessions: BTreeMap<String, Session>,
    next_generation: u64,
    snapshot: Snapshot,
}

impl Default for StateStore {
    fn default() -> Self {
        Self::new()
    }
}

impl StateStore {
    pub fn new() -> Self {
        Self {
            sessions: BTreeMap::new(),
            next_generation: 1,
            snapshot: Snapshot {
                version: PROTOCOL_VERSION,
                stream_id: uuid::Uuid::new_v4().to_string(),
                revision: 0,
                bridge_status: BridgeStatus::Stopped,
                agents: Vec::new(),
                omitted_agent_count: 0,
            },
        }
    }

    pub fn stream_id(&self) -> &str {
        &self.snapshot.stream_id
    }

    /// Acquire an idempotent, session-bound ordering lease. A replaced instance
    /// cannot renew its old lease to reclaim the session. A genuinely new session
    /// activation must use a fresh instance id.
    pub fn register_source_at(
        &mut self,
        session_id: &str,
        instance_id: &str,
        now: Instant,
    ) -> Result<SourceLease, IngestError> {
        if !valid_identity(session_id) || !valid_identity(instance_id) {
            return Err(IngestError::Identity);
        }
        if let Some(session) = self.sessions.get(session_id) {
            if let Some(&generation) = session.leases.get(instance_id) {
                if session
                    .order
                    .is_some_and(|order| generation < order.generation)
                {
                    return Err(IngestError::OutOfOrder);
                }
                return Ok(SourceLease { generation });
            }
            if session.leases.len() >= MAX_LEASES_PER_SESSION {
                return Err(IngestError::SourceLimit);
            }
        }
        if self.next_generation > MAX_SAFE_INTEGER {
            return Err(IngestError::SourceLimit);
        }
        self.make_room(session_id, now)?;
        let generation = self.next_generation;
        self.next_generation += 1;
        self.sessions
            .entry(session_id.to_owned())
            .or_insert_with(|| Session::new(session_id.to_owned()))
            .leases
            .insert(instance_id.to_owned(), generation);
        self.refresh(now);
        Ok(SourceLease { generation })
    }

    fn make_room(&mut self, session_id: &str, now: Instant) -> Result<(), IngestError> {
        if self.sessions.contains_key(session_id) || self.sessions.len() < MAX_SESSIONS {
            return Ok(());
        }
        // Never eject a connected fresh session. Forgetting a retired session also
        // revokes all its source leases: delayed ingest cannot resurrect it.
        let retired = self
            .sessions
            .values()
            .filter(|session| !session.is_live(now))
            .min_by_key(|session| (session.last_receipt, &session.id))
            .map(|session| session.id.clone());
        if let Some(retired) = retired {
            self.sessions.remove(&retired);
            Ok(())
        } else {
            Err(IngestError::SessionLimit)
        }
    }

    pub fn ingest_at(
        &mut self,
        payload: IngestPayload,
        now: Instant,
    ) -> Result<IngestReceipt, IngestError> {
        validate(&payload)?;
        let id = &payload.session.id;
        let previous = self.sessions.get(id);
        if let Some(source) = payload.source {
            if payload.stream_id.as_deref() != Some(self.snapshot.stream_id.as_str()) {
                return Err(IngestError::UnknownSource);
            }
            let registered = previous.is_some_and(|session| {
                session
                    .leases
                    .values()
                    .any(|generation| *generation == source.generation)
            });
            if !registered {
                return Err(IngestError::UnknownSource);
            }
        }
        if let Some(order) = previous.and_then(|session| session.order) {
            match payload.source {
                Some(next)
                    if next.generation > order.generation
                        || (next.generation == order.generation
                            && next.sequence > order.sequence) => {}
                _ => return Err(IngestError::OutOfOrder),
            }
        }
        let fresh_generation = payload.source.is_some_and(|source| {
            previous
                .and_then(|session| session.order)
                .map(|s| s.generation)
                != Some(source.generation)
        });
        let mut combined: BTreeSet<&str> = if fresh_generation || payload.session.agents_complete {
            BTreeSet::new()
        } else {
            previous
                .map(|session| session.agents.keys().map(String::as_str).collect())
                .unwrap_or_default()
        };
        if let Some(agents) = &payload.session.agents {
            combined.extend(agents.iter().map(|agent| agent.id.as_str()));
        }
        if combined.len() > MAX_AGENTS_PER_SESSION {
            return Err(IngestError::AgentLimit);
        }
        self.make_room(id, now)?;
        let session = self
            .sessions
            .entry(id.clone())
            .or_insert_with(|| Session::new(id.clone()));
        if fresh_generation {
            // This is a new source activation, not a partial update to a departed
            // process. Old children must not leak into its first heartbeat.
            session.agents.clear();
            session.cwd = None;
            session.model = None;
            session.name = "Pi session".into();
            session.omitted_agent_count = 0;
        }
        if payload.session.agents_complete {
            let included: BTreeSet<_> = payload
                .session
                .agents
                .as_ref()
                .expect("validated roster")
                .iter()
                .map(|agent| agent.id.as_str())
                .collect();
            session
                .agents
                .retain(|id, _| included.contains(id.as_str()));
        }
        if let Some(count) = payload.session.omitted_agent_count {
            session.omitted_agent_count = count;
        }
        if let Some(name) = payload.session.name {
            let name = safe_text(&name, 240);
            session.name = if name.trim().is_empty() {
                "Pi session".into()
            } else {
                name
            };
        }
        apply_text_patch(&mut session.model, payload.session.model, 240);
        // Workspace paths are identity, not lossy display text. Validation runs
        // before mutation; blank and null mean unknown, omission preserves it.
        match payload.session.cwd {
            Patch::Missing => {}
            Patch::Clear => session.cwd = None,
            Patch::Set(value) => {
                session.cwd = if value.trim().is_empty() {
                    None
                } else {
                    Some(value)
                };
            }
        }
        session.connected = payload.session.connected.unwrap_or(true);
        session.last_receipt = Some(now);
        session.order = payload.source.or(session.order);
        for update in payload.session.agents.unwrap_or_default() {
            let agent = session
                .agents
                .entry(update.id.clone())
                .or_insert_with(|| Agent {
                    id: update.id.clone(),
                    name: "Agent".into(),
                    role: "subagent".into(),
                    task: String::new(),
                    state: AgentState::Idle,
                    tool: None,
                    model: None,
                    stopped: false,
                    lifecycle_event: None,
                    lifecycle_at: None,
                });
            if let Some(name) = update.name {
                let name = safe_text(&name, 240);
                agent.name = if name.trim().is_empty() {
                    "Agent".into()
                } else {
                    name
                };
            }
            if let Some(role) = update.role {
                agent.role = safe_text(&role, 80);
            }
            if let Some(task) = update.task {
                agent.task = safe_text(&task, 2000);
            }
            if let Some(state) = update.state {
                agent.state = state;
            }
            apply_text_patch(&mut agent.tool, update.tool, 240);
            apply_text_patch(&mut agent.model, update.model, 240);
            match update.lifecycle {
                Patch::Set(lifecycle)
                    if agent.lifecycle_event.as_ref() != Some(&lifecycle.event_id)
                        && (payload.source.is_some()
                            || agent.lifecycle_at.is_none_or(|previous| {
                                lifecycle_time(&lifecycle) > previous
                                    || (lifecycle_time(&lifecycle) == previous
                                        && lifecycle.kind == LifecycleKind::Stop)
                            })) =>
                {
                    agent.lifecycle_at = Some(lifecycle_time(&lifecycle));
                    agent.stopped = lifecycle.kind == LifecycleKind::Stop;
                    agent.lifecycle_event = Some(lifecycle.event_id);
                }
                // Clearing metadata is not evidence of a new start. A stopped
                // agent remains hidden until an explicit new start event.
                Patch::Missing | Patch::Clear | Patch::Set(_) => {}
            }
        }
        self.refresh(now);
        Ok(IngestReceipt {
            ok: true,
            revision: self.snapshot.revision,
            session_id: id.clone(),
        })
    }

    pub fn snapshot_at(&mut self, now: Instant) -> Snapshot {
        self.refresh(now);
        self.snapshot.clone()
    }

    pub fn set_bridge_status_at(&mut self, status: BridgeStatus, now: Instant) -> Snapshot {
        if self.snapshot.bridge_status != status {
            self.snapshot.bridge_status = status;
            self.snapshot.revision += 1;
        }
        self.refresh(now);
        self.snapshot.clone()
    }

    fn refresh(&mut self, now: Instant) {
        let mut agents = Vec::new();
        let mut omitted_agent_count = 0;
        if self.snapshot.bridge_status == BridgeStatus::Listening {
            for session in self
                .sessions
                .values()
                .filter(|session| session.is_live(now))
            {
                omitted_agent_count += session.omitted_agent_count;
                for agent in session.agents.values() {
                    if agent.stopped
                        || matches!(agent.state, AgentState::Stale | AgentState::Offline)
                    {
                        continue;
                    }
                    agents.push(AgentSnapshot {
                        key: serde_json::to_string(&[&session.id, &agent.id])
                            .expect("strings serialize"),
                        session_id: session.id.clone(),
                        agent_id: agent.id.clone(),
                        name: if agent.role == "orchestrator"
                            && (agent.id == "main"
                                || agent.id.strip_suffix(":main") == Some(session.id.as_str()))
                        {
                            session.name.clone()
                        } else {
                            agent.name.clone()
                        },
                        session_name: session.name.clone(),
                        cwd: session.cwd.clone(),
                        role: agent.role.clone(),
                        task: agent.task.clone(),
                        state: agent.state,
                        tool: agent.tool.clone(),
                        model: agent.model.clone().or_else(|| session.model.clone()),
                    });
                }
            }
        }
        // BTree iteration makes suffix assignment deterministic independent of
        // packet arrival order. Never use lossy display text as identity.
        let mut totals: BTreeMap<String, usize> = BTreeMap::new();
        for agent in &agents {
            *totals.entry(agent.name.clone()).or_default() += 1;
        }
        let reserved: BTreeSet<String> = totals.keys().cloned().collect();
        let mut assigned = BTreeSet::new();
        let mut seen: BTreeMap<String, usize> = BTreeMap::new();
        for agent in &mut agents {
            if totals[&agent.name] > 1 {
                let ordinal = seen.entry(agent.name.clone()).or_default();
                loop {
                    *ordinal += 1;
                    let candidate = format!("{} · {}", agent.name, ordinal);
                    if !reserved.contains(&candidate) && assigned.insert(candidate.clone()) {
                        agent.name = candidate;
                        break;
                    }
                }
            }
        }
        if agents != self.snapshot.agents
            || omitted_agent_count != self.snapshot.omitted_agent_count
        {
            self.snapshot.agents = agents;
            self.snapshot.omitted_agent_count = omitted_agent_count;
            self.snapshot.revision += 1;
        }
    }
}

fn lifecycle_time(marker: &Lifecycle) -> i64 {
    marker
        .at
        .as_u64()
        .map(|value| value as i64)
        .unwrap_or_else(|| {
            chrono::DateTime::parse_from_rfc3339(marker.at.as_str().expect("validated timestamp"))
                .expect("validated timestamp")
                .timestamp_millis()
        })
}

fn apply_text_patch(target: &mut Option<String>, patch: Patch<String>, limit: usize) {
    match patch {
        Patch::Missing => {}
        Patch::Clear => *target = None,
        Patch::Set(value) => *target = Some(safe_text(&value, limit)),
    }
}

fn validate(payload: &IngestPayload) -> Result<(), IngestError> {
    if payload
        .version
        .is_some_and(|version| version != PROTOCOL_VERSION)
    {
        return Err(IngestError::Version);
    }
    if !valid_identity(&payload.session.id) {
        return Err(IngestError::Identity);
    }
    if let Patch::Set(cwd) = &payload.session.cwd {
        if cwd.encode_utf16().count() > 4096 || cwd.chars().any(char::is_control) {
            return Err(IngestError::Workspace);
        }
    }
    if payload.source.is_some_and(|order| {
        order.generation == 0
            || order.generation > MAX_SAFE_INTEGER
            || order.sequence > MAX_SAFE_INTEGER
    }) {
        return Err(IngestError::SourceOrder);
    }
    if payload.session.agents_complete
        && (payload.source.is_none() || payload.session.agents.is_none())
    {
        return Err(IngestError::IncompleteRoster);
    }
    if payload
        .session
        .omitted_agent_count
        .is_some_and(|count| count > MAX_SAFE_INTEGER / MAX_SESSIONS as u64)
    {
        return Err(IngestError::AgentLimit);
    }
    let mut identities = BTreeSet::new();
    if let Some(agents) = &payload.session.agents {
        if agents.len() > MAX_AGENTS_PER_SESSION {
            return Err(IngestError::AgentLimit);
        }
        for agent in agents {
            if !valid_identity(&agent.id) {
                return Err(IngestError::Identity);
            }
            if !identities.insert(&agent.id) {
                return Err(IngestError::DuplicateAgent);
            }
            if let Patch::Set(marker) = &agent.lifecycle {
                let source_valid = match marker.source.as_str() {
                    "pi:session_start" => marker.kind == LifecycleKind::Start,
                    "pi:session_shutdown" => marker.kind == LifecycleKind::Stop,
                    "pi-subagents:child-status" | "pi-subagents:fleet" => true,
                    _ => false,
                };
                let at_valid = marker.at.as_str().is_some_and(|at| {
                    at.len() <= 64 && chrono::DateTime::parse_from_rfc3339(at).is_ok()
                }) || marker.at.as_u64().is_some_and(|at| at <= MAX_SAFE_INTEGER);
                if marker.version != 1
                    || marker.event_id.is_empty()
                    || marker.event_id.len() > 160
                    || !marker
                        .event_id
                        .bytes()
                        .all(|byte| byte.is_ascii_alphanumeric() || b":_-".contains(&byte))
                    || !source_valid
                    || !at_valid
                {
                    return Err(IngestError::Lifecycle);
                }
            }
        }
    }
    Ok(())
}

#[derive(Clone)]
pub struct Observer {
    store: Arc<Mutex<StateStore>>,
    tx: watch::Sender<Snapshot>,
}

impl Default for Observer {
    fn default() -> Self {
        Self::new()
    }
}

impl Observer {
    pub fn new() -> Self {
        let store = StateStore::new();
        let (tx, _) = watch::channel(store.snapshot.clone());
        Self {
            store: Arc::new(Mutex::new(store)),
            tx,
        }
    }

    fn lock(&self) -> MutexGuard<'_, StateStore> {
        self.store
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    fn publish(&self, snapshot: Snapshot) {
        self.tx.send_if_modified(|current| {
            if *current == snapshot {
                false
            } else {
                *current = snapshot;
                true
            }
        });
    }

    pub fn snapshot(&self) -> Snapshot {
        let mut store = self.lock();
        let snapshot = store.snapshot_at(tokio::time::Instant::now().into_std());
        self.publish(snapshot.clone());
        snapshot
    }

    pub fn subscribe(&self) -> watch::Receiver<Snapshot> {
        self.tx.subscribe()
    }

    pub fn ingest(&self, payload: IngestPayload) -> Result<IngestReceipt, IngestError> {
        let mut store = self.lock();
        let result = store.ingest_at(payload, tokio::time::Instant::now().into_std())?;
        self.publish(store.snapshot.clone());
        Ok(result)
    }

    pub fn register_source(
        &self,
        session_id: &str,
        instance_id: &str,
    ) -> Result<SourceLease, IngestError> {
        let mut store = self.lock();
        let lease = store.register_source_at(
            session_id,
            instance_id,
            tokio::time::Instant::now().into_std(),
        )?;
        self.publish(store.snapshot.clone());
        Ok(lease)
    }

    pub fn set_bridge_status(&self, status: BridgeStatus) {
        let mut store = self.lock();
        let snapshot = store.set_bridge_status_at(status, tokio::time::Instant::now().into_std());
        self.publish(snapshot);
    }
}
