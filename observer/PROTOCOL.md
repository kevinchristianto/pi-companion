# Local observer protocol v1

## Authentication and routes

Read the app-owned connection file via the explicit absolute `PI_COMPANION_CONNECTION_FILE` path:

```json
{"version":1,"url":"http://127.0.0.1:4318","token":"<app-generated private base64url token>"}
```

The placeholder is documentation, not a usable credential. Do not create a token by copying it. The adapter accepts a 32–512 character base64url token only. Every request below sends `Authorization: Bearer …` and JSON. Nothing leaves numeric IPv4 loopback; redirects are errors. Connection credentials are never included in snapshots, logs, fixtures, or UI IPC.

1. POST `/api/hello` with `{"version":1,"sessionId":"…","instanceId":"…"}`.
2. Read `source.generation`, a positive safe integer, and `streamId`, the bridge-process identity.
3. POST `/api/ingest` with a full v1 snapshot, the exact hello `streamId`, and `source:{generation,sequence}`. `sequence` is a strictly increasing safe integer for this activation. It can skip values after failed attempts.

An `instanceId` is a fresh UUID per adapter activation. Retrying hello with the same active instance is idempotent. An old superseded instance must not acquire a replacement lease; a hello 409 permanently pauses that activation until Pi is explicitly reactivated. Other failures discard cached connection/lease data and retry boundedly. A restarted bridge can accept the same instance again under its new lease table. Its new stream ID rejects delayed packets from the previous bridge process, even if generation integers are reused. Failed/out-of-order input must never refresh liveness. A new hello alone does not replace the roster: the first valid ingest does.

The adapter requires the ordered handshake. The bridge may separately accept legacy source-omitted v1 snapshots, but this adapter never falls back to unordered writes.

## Snapshot

```json
{
  "version": 1,
  "source": { "generation": 7, "sequence": 1 },
  "streamId": "bridge-process-id",
  "session": {
    "id": "session-id",
    "name": "My project",
    "cwd": "/local/project",
    "model": "model-id",
    "connected": true,
    "agentsComplete": true,
    "omittedAgentCount": 0,
    "agents": [
      { "id": "main", "name": "Pi", "role": "orchestrator", "state": "idle", "tool": null, "model": "model-id" }
    ]
  },
  "capabilities": { "pi": true, "subagents": false, "fleet": false, "metadataOnly": true, "omittedAgents": 0 }
}
```

- `session.agentsComplete:true` explicitly requests full roster replacement, including retirement of previously reported IDs absent from this snapshot. Legacy clients omitting the flag can retain merge semantics. This adapter always sends the flag.
- Agent IDs are scoped by session. Multiple sessions may each have `id: "main"`.
- States: `idle`, `thinking`, `working`, `waiting`, `completed`, `error`, `stale`, `offline`.
- Identity strings must not be truncated to manufacture identity. Session IDs have a 240-character bound; child IDs use SHA-256 of a validated opaque plugin key. Display names/tool/model identifiers are bounded to 160 characters; cwd is at most 4096.
- At most 64 agents per session are transmitted, including root. `omittedAgentCount` reports overflow/unknown invalid projection rows; the companion should expose this count. Upstream fleet omission is included. Candidates are examined only within a bounded 1024-entry window.
- Optional `lifecycle` is `{version:1,eventId,kind:"start"|"stop",source,at}`. `at` is an ISO-8601 UTC timestamp. A marker's ID stays stable across heartbeat resends; a new lifecycle gets a new ID. These are display-observation markers, not claims to control Pi processes.
- Connected idle is live. Final shutdown sets `connected:false`, every retained agent `state:"offline"`, and stop markers. Optional child terminal states carry stop markers. A complete replacement omits rows no longer in the authoritative fleet.
- No `task`, prompt, transcript, output, logs, credentials, token usage or cost field is emitted. The bridge may support extra v1 fields from other clients; this adapter projects an explicit metadata allowlist.
- Capabilities describe observation, not Pi permissions. Unknown fields must not grant authority.

See [fixtures](./fixtures/) for consistent hello/connected/ordered/disconnected messages containing only synthetic IDs and example metadata. The disconnected ordered fixture follows the ordered fixture's generation with the next sequence. The source-omitted connected fixture tests legacy ingestion independently.
