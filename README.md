# Pi Companion

A standalone, read-only Pi agent companion for Windows. A small Tauri 2 / Rust app shows connected agents as animated pixel-art coworkers, with an accessible semantic roster.

This is a clean rewrite. It does not bundle Electron, Node.js, the old 3D web application, or a Node bridge process. Windows uses Microsoft WebView2 for the local React/TypeScript/Canvas UI. Pi runs the optional observer extension in its own existing runtime.

## Windows test build

The **Windows preview artifact** workflow builds an unsigned x64 NSIS installer and uploads it to that workflow run's artifacts. It never creates a GitHub release. Download the installer artifact from the successful commit. The separate observer source artifact is optional; normal setup uses the stable observer entry prepared by the installed app.

The installer includes the Rust bridge, six character designs, all four animation states, shared furniture and observer files. If WebView2 is missing, its bootstrapper downloads the required runtime, so first installation can need internet. No signing certificate is configured; Windows can show an unknown-publisher warning. Verify the source commit and artifact origin before deciding whether to install.

This preview still requires real Windows GUI acceptance, especially tray recovery, transparency, mixed-DPI rendering, sleep/resume and accessibility. Compilation and automated tests are separate from that acceptance.

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

## Compact pixel interface (local revision)

The local redesign uses actual MIT-licensed [8bitcn](https://www.8bitcn.com/) components, pinned and documented in `src/components/ui/8bit/SOURCES.json`. React owns controls and roster membership; one imperative Canvas2D clock paints the unchanged sprites without a React update per animation frame.

- **Menu** contains the project/workspace picker, artwork scale, window size, pin, pass-through, motion, hide and connection guide. Office is the only view.
- Workspaces group by the exact cwd shared by Pi, never by a session ID or a folder basename. All live sessions in the same path stay together. Duplicate folder names show paths; missing cwd is labeled unknown and kept separate per session.
- The default is 480×380 logical pixels; the minimum is 320×280. Window presets and monitor work-area clamping remain available.
- The undecorated native window has a custom pixel frame/titlebar, square menus/dialogs/tooltips/scrollbars, pixel icons and a bundled OFL Press Start 2P font at compact sizes. There are no remote font requests.
- Long rosters and option menus scroll within the compact window. Keyboard navigation, Escape/outside dismissal, focus recovery, reduced motion and native recovery guards remain supported.

Version 0.1.2 contains the reviewed compact 8bitcn redesign and locally bundled Press Start 2P. The Windows preview workflow verifies and builds an unsigned test installer; it does not create a formal release. Native GUI acceptance is still required.

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

On Windows, `npm run tauri -- build --bundles nsis` creates the unsigned test installer. `cargo test --workspace --locked` also checks the native shell on a machine with Tauri's platform dependencies.

See [architecture](docs/ARCHITECTURE.md), [validation](docs/VALIDATION.md), [observer protocol](observer/PROTOCOL.md) and [art provenance](src/assets/pixel-office/SOURCE-README.md).

## Licensing

A project-wide source/artwork license has not been selected. Public visibility is not an additional license grant. Third-party dependencies retain their own terms; see `THIRD-PARTY-NOTICES.txt` and the locked package manifests. PixelLab's [published terms](https://www.pixellab.ai/termsofservice) permit commercial and non-commercial use of generated creations. This does not claim that every AI-generated pixel is independently copyrightable.
