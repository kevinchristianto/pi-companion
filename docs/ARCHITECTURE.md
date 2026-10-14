# Pi Companion

This is a clean, standalone rewrite. The existing Pi Office repository and 3D web application are not dependencies. The only reused implementation inputs are approved sprite pixels, their manifest/provenance, and observer protocol behavior.

- `crates/companion-core`: bounded in-memory observer state, authenticated loopback HTTP, source ordering and 35-second heartbeat expiry. Rust owns liveness, including while the view is hidden or suspended.
- `crates/companion-shell`: testable connection-file, recovery and monitor geometry policy.
- `src-tauri`: native tray, recovery shortcut, window controls, local credential ownership, IPC snapshot delivery. No Node subprocess or sidecar.
- `src`: React/TypeScript, actual pinned 8bitcn/Radix controls, Canvas2D decorative sprites and a semantic HTML roster. A single imperative animation clock remains outside React state updates. Animation has no authority over agent lifecycle.
- `observer`: an independent read-only Pi extension. Pi itself supplies its JavaScript runtime; the companion does not.

## Boundaries

The app listens only on `127.0.0.1:4318`. A port conflict fails closed and never terminates another program. It neither requires nor reuses the old Pi Office web bridge at 4317. A versioned, private `connection.json` links the explicitly registered observer. The native app exports five embedded observer sources into its protected per-user config directory under `observer/`, beside that connection file. A user adds the stable exported `observer/index.ts` path to Pi settings once; the observer resolves its connection relative to itself. No profile-folder guessing or per-session environment variable is needed. Export refreshes only the app-owned observer sources and never edits Pi settings. Credentials never enter renderer IPC, logs, clipboard or repository files. No prompts or tool outputs are recorded.

The bridge owns authenticated hello/ingest/snapshot endpoints, bounded request bodies and valid host/origin checks. A source lease orders restarts and monotonically increasing sequence numbers order updates. UI snapshots contain display-only metadata and a monotonic shell sequence. Stale or disconnected sources and explicitly stopped agents do not appear; connected idle agents do.

The WebView has only narrow named app commands and event-listener permissions. It cannot access filesystem, execute processes, create arbitrary windows, make general HTTP requests, or obtain the bridge credential. All UI content is local; no remote scripts, fonts or art.

Hide and click-through require an independent Rust recovery route. The tray and global shortcut restore input before showing the window. Window sizes are clamped to monitor work areas on restore, resize and scale change. The complete roster is semantic HTML even when only the first 64 agents are illustrated.

## Validation gates

Automated core/adapter/frontend checks do not establish native Windows appearance or usability. Windows build, tray behavior, transparency, click-through recovery, shortcut collisions, mixed DPI, monitor removal, sleep/resume, keyboard/screen-reader use and idle resource costs are separate gates. The preview workflow only uploads an unsigned test artifact; it does not publish a release or deploy a website.

## Workspace identity and pixel UI

Pi already supplies cwd; the core now preserves its exact validated value on every agent snapshot. Session restarts clear old workspace metadata. No filesystem scan, path alias normalization or inferred project identity is performed. The renderer groups only the authoritative live roster, so idle roots remain while stale/disconnected agents disappear as before. An unknown cwd falls back to a visibly unknown, per-session group. Removing the last agent releases that workspace filter and restores keyboard focus.

The single options dropdown uses actual 8bitcn sources on Radix. Project, scale and size choices are inline radio groups, avoiding horizontal submenus that cannot fit the 320px minimum window. The menu itself scrolls, as does the bounded project list. The connection guide uses the adapted 8bitcn dialog and retains one-time settings registration. No IPC, capability, native privilege or Pi-control surface was added by the UI migration.

The full font and component licenses are bundled locally. `SOURCES.json` records the exact upstream commit and hashes before/after documented adaptations. Production checks enforce the font/component hashes, original sprite bytes and absence of remote CSS URLs. CSS styles the existing undecorated window; native dragging, resizing and recovery remain Rust/Tauri responsibilities.
