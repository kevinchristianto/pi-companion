# Pi observer adapter

An independent, metadata-only Pi extension for Pi Companion. It runs **inside Pi's existing process**. The packaged Tauri app contains no Node server, Node runtime, Pi runtime, or observer sidecar. This directory has no dependency on the old office application or the renderer.

## Manual activation

1. Start the Pi Companion desktop app. The app creates its private local connection file at runtime and shows the exact file path in its connection/settings view. Do not paste its contents into chat, a terminal command, a screenshot, or a repository.
2. Keep this entire `observer` directory together. Set `PI_COMPANION_CONNECTION_FILE` to the **absolute file path shown by the app**. The adapter deliberately does not guess platform-specific paths.
3. Explicitly launch Pi with this extension. This does not install or enable anything persistently:

   macOS/Linux shell:
   ```sh
   export PI_COMPANION_CONNECTION_FILE='/absolute/path/shown/by/the/app/connection.json'
   pi --extension /absolute/path/to/pi-companion/observer/index.ts
   ```

   PowerShell:
   ```powershell
   $env:PI_COMPANION_CONNECTION_FILE = 'C:\absolute\path\shown\by\the\app\connection.json'
   pi --extension 'C:\absolute\path\to\pi-companion\observer\index.ts'
   ```

4. The session should appear in the companion. An idle but connected session stays visible. Quitting or replacing the Pi session sends a final disconnected snapshot. A crash or forced kill cannot guarantee a final send; the app expires missing heartbeats.
5. To stop using it, quit that Pi invocation and launch Pi without `--extension`. No global/project Pi settings were changed by these instructions.

The new bridge uses `http://127.0.0.1:4318`; the old office application's port 4317 is unrelated. Neither `PI_OFFICE_*`, a token environment variable, a URL override, nor credentials from a conversation are supported. If port 4318 is occupied, resolve the conflict in the desktop app; this adapter never kills processes or switches to another service.

## What it observes

- Session ID, user-assigned name, exact working directory, model identifier, and connected state
- Root idle/thinking/working/waiting state and currently running tool **names**
- Optional public child agent names, roles, model/tool names, states, and display lifecycle markers from a compatible `nicobailon/pi-subagents` v1 fleet API
- A full snapshot every **10 seconds**, including while idle

It never reads prompts, transcript branches, message text, thoughts, tool arguments/results, task descriptions, or credentials from Pi events. No task-text opt-in is included. Display metadata such as session names and working directories can itself contain private information, so it is sent only to the authenticated local bridge. There are no telemetry or external network destinations.

The adapter registers no tools, commands, shortcuts, providers, or model messages. It never changes a prompt, controls a tool, starts/stops/steers subagents, runs a shell, or changes Pi settings. Optional Pi UI warnings contain only a fixed overflow explanation, never agent names or task content.

## Supported Pi contracts

Verified against the official upstream public declarations on 2026-10-14. The former `badlogic/pi-mono` repository currently redirects to `earendil-works/pi`.

- [Pi extension guide](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/extensions.md)
- [Exact extension event/context types](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/src/core/extensions/types.ts)
- [Optional pi-subagents v1 extension API](https://github.com/nicobailon/pi-subagents/blob/main/docs/extension-api.md)
- [Optional pi-subagents observability](https://github.com/nicobailon/pi-subagents/blob/main/docs/observability.md)

The extension uses `session_start`, `session_shutdown`, `session_info_changed`, `agent_start`, `agent_end`, `agent_settled`, `tool_execution_start`, `tool_execution_end`, `model_select`, `ui_prompt_start`, and `ui_prompt_end`. Handler return values never modify Pi behavior. Resources begin at session start, not when the extension factory is loaded, and teardown is idempotent. Current Pi replaces extension runtimes for new/resume/fork/reload flows; the adapter additionally guards against stale-context callbacks and overlapping lifecycle calls.

`agent_settled` is the final idle signal. `agent_end` alone can precede automatic continuation, so it changes the root to idle only when the read-only context confirms idle. Renames are also refreshed on each heartbeat for older versions. Newer optional events can be unavailable on older Pi releases; no compatibility with every historical Pi version is claimed.

### Optional children

Pi itself does not define a universal subagent event API. This adapter supports only the documented `nicobailon/pi-subagents` event-bus v1 capability `fleetStatus: {version: 1}`. It emits only `ping` and untargeted `status`, with empty parameters, and listens for documented readiness/lifecycle hints. It never emits `spawn`, `stop`, `steer`, `interrupt`, `manage`, `resume`, or `consume`.

The public fleet projection is authoritative. Opaque fleet keys are hashed for collision-resistant wire IDs; run IDs and child-status hints are never guessed to be fleet keys. A hint requests a fresh status snapshot. No compatible plugin means root-only observation. Missing optional RPC replies time out and are canceled during shutdown; there is no terminal-output scraping or filesystem artifact reading. Failed or malformed status/handshake replies clear the child roster immediately after the failure is established. Plugin readiness/restart clears it before renegotiation and cancels old requests. Root heartbeats continue independently, and cached children cannot remain live while their status source is unavailable. A later valid status can restore connected idle children with fresh observation markers.

One session is bounded to 64 rows: the root plus up to 63 children. A bounded, deterministic live-first selection is used on overflow. `session.omittedAgentCount` and a one-time fixed Pi UI warning make omissions explicit. The warning resets after overflow resolves. Complete projections remove missing rows; partial projections retain earlier unseen rows as inactive/stale where room permits. All outgoing messages are full replacements, so the bridge must remove previously sent rows omitted by the next accepted snapshot. Child completion/error/explicit stop carries a stop lifecycle marker, while connected root completion becomes idle.

## Connection security and failure behavior

The app-owned file is JSON with `version`, `url`, and `token`. See [PROTOCOL.md](./PROTOCOL.md). The adapter reads at most 4096 bytes, requires a regular non-hardlinked file, rejects symlinks/junctions visible through Node at any path component, opens with `O_NOFOLLOW` where available, and checks identity/size again after reading. On Unix it requires current-user ownership and no group/other permission bits. On Windows the desktop app must create a current-user-only ACL; Node's POSIX mode bits are not an ACL audit. Windows reparse-point/ACL behavior still needs native acceptance testing.

Use the exact canonical local path, without symlink aliases. UNC/network-share paths, relative paths, URL credentials, alternate numeric loopback forms, DNS names, IPv6, query strings, fragments, and redirects are rejected. HTTP uses `node:http` with no proxy configuration and does not follow redirects. Requests have a 750 ms total deadline and a 256 KiB outgoing limit; responses are limited to 8 KiB.

A single-flight latest-only queue prevents overlapping network calls. Failed delivery retries after 5 seconds while the session remains active, re-reading the connection file and redoing the handshake, so app restart/token rotation can recover. The 10-second heartbeat continues without activity. A superseded observer activation receives a conflict from the bridge and stops retrying, rather than stealing the session back. Shutdown cancels timers/RPC listeners and attempts the final disconnected snapshot after any in-flight request. Delivery during network failure is best effort; bridge liveness expiry handles ungraceful exits.

## Validation

Node 24 is used for native TypeScript test loading; Pi loads local TypeScript through its own extension loader.

```sh
node --test observer/tests/*.test.mjs
node node_modules/typescript/bin/tsc -p observer/tsconfig.json
cargo test -p companion-core --test adapter_roundtrip
```

Tests cover actual loopback HTTP, redirect/external URL rejection, bounded files/responses, symlinks, permissions, concurrent lifecycle transitions, parallel tools, idle heartbeats, shutdown flush, offline retry, lease replacement, optional RPC cleanup, privacy via throwing content getters, and deterministic roster overflow. The additional Rust integration test starts the real bridge on a test-only loopback port and runs this actual Node adapter through handshake, ingest, root/child lifecycle, overflow, replay rejection, source replacement, and shutdown. The Pi API itself is mocked; neither a real installed Pi nor the Windows desktop integration was exercised. No persistent Pi installation, real credential creation, publish, or release is part of this adapter work.
