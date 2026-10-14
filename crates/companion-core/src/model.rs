use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::time::Duration;

pub const PROTOCOL_VERSION: u32 = 1;
pub const MAX_SESSIONS: usize = 24;
pub const MAX_AGENTS_PER_SESSION: usize = 64;
pub const MAX_BODY_BYTES: usize = 512 * 1024;
pub const STALE_AFTER: Duration = Duration::from_secs(35);
pub const MAX_SAFE_INTEGER: u64 = 9_007_199_254_740_991;

#[derive(Clone, Copy, Debug, Default, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum BridgeStatus {
    Starting,
    Listening,
    #[default]
    Stopped,
    Error,
}

#[derive(Clone, Copy, Debug, Default, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum AgentState {
    #[default]
    Idle,
    Thinking,
    Working,
    Waiting,
    Completed,
    Error,
    Stale,
    Offline,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AgentSnapshot {
    /// JSON-encoded [sessionId, agentId], not a delimiter-concatenated identity.
    pub key: String,
    pub session_id: String,
    pub agent_id: String,
    pub name: String,
    pub session_name: String,
    pub role: String,
    pub task: String,
    pub state: AgentState,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tool: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    pub version: u32,
    pub stream_id: String,
    pub revision: u64,
    pub bridge_status: BridgeStatus,
    pub agents: Vec<AgentSnapshot>,
    pub omitted_agent_count: u64,
}

/// Missing fields preserve protocol-v1 partial-update behavior. Metadata not used
/// by the live projection (logs, usage, cwd, project, timestamps) is ignored.
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IngestPayload {
    #[serde(default)]
    pub version: Option<u32>,
    #[serde(default)]
    pub source: Option<SourceOrder>,
    #[serde(default)]
    pub stream_id: Option<String>,
    pub session: SessionUpdate,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
pub struct SourceOrder {
    pub generation: u64,
    pub sequence: u64,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionUpdate {
    pub id: String,
    #[serde(default)]
    pub name: Option<String>,
    #[serde(default)]
    pub model: Patch<String>,
    #[serde(default)]
    pub connected: Option<bool>,
    #[serde(default, deserialize_with = "nonnull_agents")]
    pub agents: Option<Vec<AgentUpdate>>,
    #[serde(default)]
    pub agents_complete: bool,
    #[serde(default)]
    pub omitted_agent_count: Option<u64>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentUpdate {
    pub id: String,
    #[serde(default)]
    pub name: Option<String>,
    #[serde(default)]
    pub role: Option<String>,
    #[serde(default)]
    pub task: Option<String>,
    #[serde(default)]
    pub state: Option<AgentState>,
    #[serde(default)]
    pub tool: Patch<String>,
    #[serde(default)]
    pub model: Patch<String>,
    #[serde(default)]
    pub lifecycle: Patch<Lifecycle>,
}

/// Distinguishes omitted fields from explicit null, which clears metadata.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub enum Patch<T> {
    #[default]
    Missing,
    Clear,
    Set(T),
}
impl<'de, T: Deserialize<'de>> Deserialize<'de> for Patch<T> {
    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        Ok(match Option::<T>::deserialize(deserializer)? {
            Some(value) => Self::Set(value),
            None => Self::Clear,
        })
    }
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Lifecycle {
    pub version: u32,
    pub event_id: String,
    pub kind: LifecycleKind,
    pub source: String,
    /// Retained only for validation. Sender time never establishes freshness or
    /// ordering; the bridge uses monotonic receipt time and optional source order.
    pub at: Value,
}

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum LifecycleKind {
    Start,
    Stop,
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct IngestReceipt {
    pub ok: bool,
    pub revision: u64,
    pub session_id: String,
}

#[derive(Clone, Debug, thiserror::Error, PartialEq, Eq)]
pub enum IngestError {
    #[error("Unsupported observer protocol")]
    Version,
    #[error("Identity must be nonblank, control-free, and at most 240 characters")]
    Identity,
    #[error("Session agent limit exceeded")]
    AgentLimit,
    #[error("Session limit exceeded; disconnect an existing session first")]
    SessionLimit,
    #[error("Duplicate agent identity in one update")]
    DuplicateAgent,
    #[error("Complete agent rosters require an ordered source and an agents array")]
    IncompleteRoster,
    #[error("Invalid source ordering metadata")]
    SourceOrder,
    #[error("Outdated or duplicate source update")]
    OutOfOrder,
    #[error("Source must register with /api/hello before ordered ingest")]
    UnknownSource,
    #[error("Source registration limit reached")]
    SourceLimit,
    #[error("Invalid lifecycle metadata")]
    Lifecycle,
}

pub(crate) fn valid_identity(value: &str) -> bool {
    !value.trim().is_empty() && value.chars().count() <= 240 && !value.chars().any(char::is_control)
}

pub(crate) fn safe_text(value: &str, limit: usize) -> String {
    value
        .chars()
        .filter(|c| !c.is_control() && !matches!(c, '\u{200B}'..='\u{200F}' | '\u{202A}'..='\u{202E}' | '\u{2066}'..='\u{2069}' | '\u{FEFF}'))
        .take(limit)
        .collect()
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
pub struct SourceLease {
    pub generation: u64,
}

fn nonnull_agents<'de, D: serde::Deserializer<'de>>(
    deserializer: D,
) -> Result<Option<Vec<AgentUpdate>>, D::Error> {
    Vec::<AgentUpdate>::deserialize(deserializer).map(Some)
}
