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

Automated core/adapter/frontend checks do not establish native Windows appearance or usability. Windows build, tray behavior, transparency, click-through recovery, shortcut collisions, mixed DPI, monitor removal, sleep/resume, keyboard/screen-reader use and idle resource costs are separate gates. Ordinary main pushes produce unsigned build artifacts. A specifically authorized release commit marker enables a separate write-scoped job that publishes a versioned GitHub Release only after Windows verification and packaging pass. Native GUI acceptance remains separate and is disclosed in the release notes. No website is deployed.

## Workspace identity and pixel UI

Pi already supplies cwd; the core now preserves its exact validated value on every agent snapshot. Session restarts clear old workspace metadata. No filesystem scan, path alias normalization or inferred project identity is performed. The renderer groups only the authoritative live roster, so idle roots remain while stale/disconnected agents disappear as before. An unknown cwd falls back to a visibly unknown, per-session group. Removing the last agent releases that workspace filter and restores keyboard focus.

The single options dropdown uses actual 8bitcn sources on Radix. Project, scale and size choices are inline radio groups, avoiding horizontal submenus that cannot fit the 280px minimum window. The menu itself scrolls, as does the bounded project list. The connection guide uses the adapted 8bitcn dialog and retains one-time settings registration. No IPC, capability, native privilege or Pi-control surface was added by the UI migration.

The full font and component licenses are bundled locally. `SOURCES.json` records the exact upstream commit and hashes before/after documented adaptations. Production checks enforce the font/component hashes, original sprite bytes and absence of remote CSS URLs. CSS styles the existing undecorated window; native dragging, resizing and recovery remain Rust/Tauri responsibilities.

## Optional transparent taskbar strip

Rust owns Office/Taskbar mode, saved Office placement and input recovery. Taskbar mode reuses the transparent main window above the selected monitor work area, with a 104-logical-pixel viewport, zero bottom margin and a content-sized width clamped to the selected work area. It never embeds into Explorer. Bounded main-thread polling observes work-area/auto-hide/fullscreen changes; user-hidden state is distinct from automatic fullscreen hiding. Recovery returns to Office with input enabled.

The same live-only workspace-filtered roster and single canvas clock serve both modes. The strip fixes artwork at 64×64 logical pixels and uses a retro status bubble above it with a downward tail. Agent names remain available through pixel-styled hover/focus content, accessible labels and Office details. Office preserves its independent 1×/2× artwork preference.


### Local placement revision

A bounded renderer count (0–64 slots) selects the desired width: 88px controls, 12px horizontal workspace padding, 112px per slot and 8px between slots. At least one slot is reserved for an empty roster. Wider content scrolls inside the clamped window. Rust owns alignment and normalized horizontal travel; the renderer cannot request arbitrary screen geometry. Native drag samples physical cursor positions and keeps the vertical baseline fixed. Keyboard positioning uses a finite normalized 0–1 value. Late or cancelled drag updates cannot restart a finished drag.

Placement preferences are validated and saved in a private per-user app configuration file. The first strip entry can restore its saved monitor; after returning to Office, moving Office intentionally selects the monitor for its next strip entry. Automatic monitor removal/reconnect retains the strip preference without moving Office. Mode, click-through and observer credentials are not part of placement preferences.

Frontend scrollbars reserve no bottom space. Canvas-only integer translations remove each design's 2–3 transparent bottom rows without changing an opaque pixel or the source atlases. The 104px strip still contains the existing 18px status bubbles and 64px artwork. Only hover/focus names become 6px with 9px line height; their full accessible names and Office details remain available.
