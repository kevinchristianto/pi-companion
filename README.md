# Pi Companion

A standalone, read-only Pi agent companion for Windows. A small Tauri 2 / Rust app shows connected agents as animated pixel-art coworkers, with an accessible semantic roster.

This is a clean rewrite. It does not bundle Electron, Node.js, the old 3D web application, or a Node bridge process. Windows uses Microsoft WebView2 for the local React/TypeScript/Canvas UI. Pi runs the optional observer extension in its own existing runtime.

## Windows release

Versioned Windows x64 NSIS installers are published through [GitHub Releases](https://github.com/kevinchristianto/pi-companion/releases), alongside SHA-256 checksums and an optional observer source archive. Normal setup uses the stable observer entry prepared by the installed app.

The installer includes the Rust bridge, six character designs, all four animation states, shared furniture and observer files. If WebView2 is missing, its bootstrapper downloads the required runtime, so first installation can need internet. No signing certificate is configured; Windows can show an unknown-publisher warning. Verify the source commit and artifact origin before deciding whether to install.

The release workflow requires successful automated Windows verification and NSIS packaging before publishing. Real Windows GUI acceptance remains outstanding, especially tray recovery, transparency, mixed-DPI rendering, taskbar auto-hide/fullscreen handling, sleep/resume and accessibility. A successful build is not evidence of those native visual checks. See the [0.2.0 notes](docs/releases/v0.2.0.md).

## Connect Pi

1. Start Pi Companion and open **Menu → Connect Pi** (or **Connection guide**). It prepares its observer in a stable private per-user folder and shows a copyable Pi settings example.
2. Add the shown observer path once to the `extensions` array in your existing Pi user settings (normally `~/.pi/agent/settings.json`). Preserve other settings and extension entries. If you are replacing Pi Office, remove its old observer entry rather than loading both.
3. Run `/reload` once in each already-open Pi session **when its response, compaction and subagent work are idle**, or start Pi normally. Future ordinary Pi launches load the observer and connect automatically.

No environment variable or special Pi launch command is required. The observer finds `../connection.json` beside its stable exported directory, using the app-provided location rather than guessing platform paths. App startup and restarts are retried automatically. The companion never edits your Pi settings. To disable observation, remove its extension entry and reload when idle. See [observer/README.md](observer/README.md) for details and the optional development override.

The observer sends metadata only: session and agent names, lifecycle, state, tool name, model and workspace path (cwd). It does not send prompts, message contents, tool arguments or results. There are no commands that control agents. Closing the companion does not stop Pi.

The bridge binds only to `127.0.0.1:4318`, independently of the old Pi Office port. A conflict leaves the other process untouched. It requires its local credential and validates host, origin, request sizes and ordering. Nothing listens on the LAN.

## Behavior

- Connected idle agents stay visible. Sources missing a heartbeat for more than 35 seconds, explicit disconnects and stopped agents disappear.
- Root labels use session titles; subagent names are preserved and duplicates disambiguated.
- Six 64×64 designs share fixed chair, desk and laptop layers. Each has idle, typing, thinking and attention motion. Animation is code-authored from retained PixelLab artwork.
- Up to 64 agents are illustrated; the semantic roster includes all accepted agents, bounded to 24 sessions × 64 agents. Per-session overflow is reported rather than presented as complete data.
- 1×/2× integer pixel sizes, reduced-motion behavior and hidden/offscreen pause are supported.
- Tray and `Ctrl+Shift+P` restore the window and input. If neither independent recovery route is available, hide and click-through are disabled.

## Compact pixel interface

The local redesign uses actual MIT-licensed [8bitcn](https://www.8bitcn.com/) components, pinned and documented in `src/components/ui/8bit/SOURCES.json`. React owns controls and roster membership; one imperative Canvas2D clock paints the unchanged sprites without a React update per animation frame.

- **Menu** contains the project/workspace picker, artwork scale, window size, Office/Taskbar mode, pin, pass-through, motion, hide and connection guide. The interface stays office-based; there is no separate list view.
- Workspaces group by the exact cwd shared by Pi, never by a session ID or a folder basename. All live sessions in the same path stay together. Duplicate folder names show paths; missing cwd is labeled unknown and kept separate per session.
- Office defaults to 360×300 logical pixels with 1× artwork; its minimum is 280×240. An independent 2× artwork preference, window presets and monitor work-area clamping remain available.
- The undecorated native window has a custom pixel frame/titlebar, square menus/dialogs/tooltips/scrollbars, pixel icons and a bundled OFL Press Start 2P font at compact sizes. There are no remote font requests.
- Optional Taskbar mode is a transparent, borderless strip 104 logical pixels high above the selected monitor’s taskbar. It uses fixed 1× sprites, an always-visible retro status bubble above each desk, with a downward pixel tail. There is no permanent name or status row below the sprite. Names remain available on hover or keyboard focus, in accessible labels and in Office details. Additional agents scroll horizontally. The Office button returns to the full controls; agent details also open in Office. The strip does not embed into Explorer.
- Mode changes preserve the workspace filter and live-only roster. Returning to Office restores its saved size, position and pin preference. Explicit tray/shortcut recovery restores input. Same-monitor fullscreen apps hide the strip without stealing focus; a user-hidden window stays hidden. Native Windows acceptance for these behaviors is pending.
- Long rosters and option menus scroll within the compact window. Keyboard navigation, Escape/outside dismissal, focus recovery, reduced motion and native recovery guards remain supported.

Version 0.2.0 adds the compact Office and optional transparent taskbar strip, the reviewed above-agent retro speech bubbles, and shorter attention arm poses. It retains the 8bitcn controls, local Press Start 2P font, corrected scrolling-menu borders and taller agent-details panel. Native GUI acceptance remains a disclosed follow-up; see the [release checklist](docs/TASKBAR-RELEASE-CHECKLIST.md).

## Development

Install Node.js 24, the pinned Rust toolchain and [Tauri prerequisites](https://v2.tauri.app/start/prerequisites/). Node/npm are development tools only.

```sh
npm ci
npm run check
cargo test -p companion-core -p companion-shell --locked
cargo clippy -p companion-core -p companion-shell --all-targets --locked -- -D warnings
npm run tauri -- dev
```

Run `npm run dev:review` for an explicitly synthetic six-agent browser fixture. It is development-only and excluded from production builds. The ordinary browser page does not pretend to connect to a native bridge.

On Windows, `npm run tauri -- build --bundles nsis` creates the unsigned installer. `cargo test --workspace --locked` also checks the native shell on a machine with Tauri's platform dependencies.

See [architecture](docs/ARCHITECTURE.md), [validation](docs/VALIDATION.md), [observer protocol](observer/PROTOCOL.md) and [art provenance](src/assets/pixel-office/SOURCE-README.md).

## Licensing

A project-wide source/artwork license has not been selected. Public visibility is not an additional license grant. Third-party dependencies retain their own terms; see `THIRD-PARTY-NOTICES.txt` and the locked package manifests. PixelLab's [published terms](https://www.pixellab.ai/termsofservice) permit commercial and non-commercial use of generated creations. This does not claim that every AI-generated pixel is independently copyrightable.
