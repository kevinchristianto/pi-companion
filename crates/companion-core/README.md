# Companion core protocol

`companion-core` is a Rust-owned, in-memory observer. It receives metadata and
projects live agents. It has no command execution, session-control, static-file,
SSE, outbound-agent, persistence, or token-generation endpoint. The Tauri window
uses Rust IPC and never receives the bearer token.

## Embedding

Create an `Observer`, create a `SecretToken` from the shell's already-authorized
local configuration, then call `bridge::start(observer.clone(),
BridgeConfig::new(token)).await`. Port 4318 is the default; tests use port 0.
`BridgeHandle::local_addr()` reports the actual IPv4 loopback address.
`BridgeHandle::shutdown().await` stops serving and expiry; dropping the handle
also stops both tasks and hides the projection.

`Observer::snapshot()` returns a serializable typed snapshot synchronously.
`Observer::subscribe()` returns a Tokio watch receiver with the latest snapshot,
not an unbounded event backlog. `Observer::ingest()` and `register_source()` are
synchronous. Snapshot revisions change when the visible projection or bridge
status changes; a metadata-identical heartbeat need not increment the revision.

```json
{
  "version": 1,
  "streamId": "public-random-id-for-this-core-instance",
  "revision": 12,
  "bridgeStatus": "listening",
  "omittedAgentCount": 0,
  "agents": [{
    "key": "[\"session-a\",\"main\"]",
    "sessionId": "session-a",
    "agentId": "main",
    "name": "Documentation project",
    "sessionName": "Documentation project",
    "cwd": "/local/workspace",
    "role": "orchestrator",
    "task": "",
    "state": "idle"
  }]
}
```

`tool`, `model`, and `cwd` are optional strings. `cwd` is the exact workspace identity
reported by the session's observer and is copied to each projected agent. The
bridge does not resolve filesystem paths, normalize separators or case, or merge
agents from different sessions. The renderer can group equal cwd identities while
preserving every session-local agent. The bridge states are `starting`,
`listening`, `error`, and `stopped`. Agent states are `idle`, `thinking`, `working`,
`waiting`, `completed`, `error`, `stale`, and `offline`; stale/offline agents are
never included. A completed/error task alone is not proof that its agent process
stopped; the adapter supplies lifecycle stop or disconnect evidence.

Agent keys are JSON-encoded identity tuples, preventing separator collisions.
Root display names come from the session title only when role is `orchestrator`
and identity is `main` or the legacy `<sessionId>:main`. Explicit child names are
preserved, including children whose public role is also `orchestrator`. Duplicate display names receive deterministic suffixes,
reserving existing original names so generated suffixes cannot collide with them.

## HTTP surface

Every request must carry an exact `Host: 127.0.0.1:<port>` or
`Host: localhost:<port>`. If Origin is present it must exactly match that Host's
HTTP origin. Fetch site must be absent, `none`, or `same-origin`. Duplicate
security headers, remote peers, cross-site origins, absolute request targets, and
query strings are rejected. No CORS permissions are emitted.

- `GET /api/health`: public minimal service/version/read-only status only.
- `POST /api/hello`: bearer-authenticated version negotiation and optional source
  registration. Requires `application/json`.
- `POST /api/ingest`: bearer-authenticated metadata ingestion. Requires
  `application/json`. Success is 202.
- `GET /api/snapshot`: bearer-authenticated typed live projection.

All other routes are absent. Credentials in URL query strings are never accepted.
No endpoint echoes the configured secret, and `SecretToken` redacts Debug output.
Security headers and no-store caching apply to error responses as well.

## Ordered source activation

1. Choose a new UUID `instanceId` for each adapter/session activation, including
   an extension reload. Reuse it for reconnect attempts in that activation.
2. POST hello: `{"version":1,"sessionId":"s","instanceId":"activation-id"}`.
3. Save the returned top-level `streamId` and `source.generation`.
4. POST ingest with that top-level `streamId`, `source:{generation,sequence}`,
   and the session. Increment sequence strictly within this activation.
5. For complete rosters, set `session.agentsComplete:true`; the `agents` array
   atomically replaces membership, while omitted metadata on retained agents
   keeps its prior value. Send `omittedAgentCount` if the adapter truncated data.

A hello does not replace the live source until its first accepted ingest. Leases
are session-bound; generation is bridge-issued, never derived from the client
clock. A generation change clears the old activation's agents before applying
its first snapshot. A newer accepted generation retires all older generations.
Duplicate or out-of-order packets and retired instances return 409 without
refreshing freshness. A previously retired instance cannot obtain a new lease by
repeating hello. A changed bridge stream requires a new hello; packets from an
old bridge stream are rejected even if generation numbers happen to repeat.

Sequence/generation values must be nonnegative JSON safe integers, and generation
must be positive. A session retains at most 128 source activation leases. Further
new activations return 429 until the retired session is evicted or the bridge
restarts. This intentional bound prevents unbounded replay tombstones.

## Protocol-v1 compatibility

Legacy hello `{ "version": 1 }` is supported. Legacy ingest may omit version and
source ordering. Its session requires an `id`; `name`, `cwd`, `model`, `connected`, and
`agents` may be omitted. Omission keeps metadata and agent membership. Connected
is true on an accepted heartbeat unless explicitly false. Explicit null clears
`tool`, `model`, or `cwd`. Blank cwd also means unknown. Cwd must be control-free
and at most 4,096 UTF-16 code units, matching the observer/renderer bound; invalid
values reject the entire update rather than being truncated. A new ordered source
activation clears the previous workspace until the new source supplies it.
Session, agent, and workspace identities are not normalized or truncated.

`agentsComplete:true` requires an ordered source and an explicit array. Once a
session uses source ordering, a source-less packet cannot supersede it. New
adapters should always send complete ordered snapshots so absent children do not
survive a parent heartbeat. Legacy partial sources cannot provide that stronger
membership guarantee.

Lifecycle markers contain `version:1`, eventId, `kind:start|stop`, source, and
`at` (RFC3339 or nonnegative epoch milliseconds). Recognized sources are
`pi:session_start`, `pi:session_shutdown`, `pi-subagents:child-status`, and the new
`pi-subagents:fleet` extension. Stop stays hidden until a distinct later explicit
start (ordered sources use accepted packet order; legacy sources use marker time); clearing lifecycle metadata does not revive it. Source timestamps never
establish freshness. Logs, project, usage, and other unused metadata are
accepted as unknown fields but are neither projected nor retained.

The new parser rejects malformed record/array types, invalid identities, invalid
states, malformed lifecycle markers, duplicate agent IDs, and oversized rosters
atomically. It does not silently drop invalid records or truncate identities.

## Liveness and resource limits

A session is live only while connected and its last accepted monotonic source
receipt age is **at most 35 seconds**. Exactly 35 seconds remains live; any greater
age expires. Idle is a live state and remains visible when fresh. Explicit
session disconnect, lifecycle stop, stale/offline state, and non-listening bridge
status hide agents. Remote `updatedAt` timestamps cannot keep them alive.

A Rust-owned 250 ms ticker refreshes the watch projection even when the WebView is
suspended or no window is polling IPC. Every snapshot request also checks expiry,
so the logical age test is exact even between ticker notifications.

Bounds are 24 sessions, 64 retained agents per session, and 512 KiB JSON bodies.
At capacity, a disconnected or expired oldest session may be reclaimed, revoking
its ordering leases; live fresh sessions are never silently evicted. If none can
be reclaimed the new session is rejected with 429. Complete snapshots support
unlimited child churn without accumulating retired IDs. Limits apply before
mutating accepted state. Safe display text removes controls/bidirectional display
controls and uses bounded character lengths (240 names/tool/model, 2,000 task).

HTTP defaults: 32 concurrent handlers, 64 accepted TCP sockets, 5 s body deadline,
6 s request deadline, 30 s absolute socket lifetime, and 1 s graceful shutdown.
The socket bound and lifetime also cover incomplete headers. Configuration is
validated; listening is always IPv4 127.0.0.1 regardless of caller input.

## Verification

Run `cargo test -p companion-core` and
`cargo clippy -p companion-core --all-targets -- -D warnings`.
Node 24 must be on PATH for the actual adapter-to-Rust integration test. Node is
a development-test dependency, not an application sidecar. Tests use synthetic
public fixture tokens only. They cover exact staleness,
connected idle, disconnect/stop/reconnect, complete-roster churn, state bounds,
identity/name collisions, bridge failure, generation and stream replay, strict
HTTP guards/auth/body limits/deadlines, bounded sockets, cancellation, shutdown,
and expiry independent of any UI calls.
