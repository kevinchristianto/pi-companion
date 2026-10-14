# Validation status

This is an unreleased clean rewrite. Automated and native validation are tracked separately.

## Local checks

- The Rust toolchain and dependencies are available. Pure core and shell-policy tests are runnable without a WebView.
- The frontend uses TypeScript and DOM/Canvas-focused tests. The observer has mocked Pi and transport tests.
- Reused artwork is checked against retained SHA-256 hashes and exact atlas dimensions.
- Linux native compilation is blocked in the development environment by missing GLib/GTK/WebKit development libraries. Attempting the supported package installation failed before the package manager launched. No workaround or bypass is used.

Verified locally for the 0.1.1 connection-parity update:

- 57 frontend tests and 51 observer tests; both strict TypeScript checks pass.
- 43 core Rust tests and 19 shell tests pass, including both real Node observer-to-Rust HTTP roundtrips (normal discovery and lifecycle/ordering).
- Strict Clippy passes for the core/shell crates; shell policy and Windows ACL test code also compile with strict Clippy for the Windows GNU target.
- The production build preserves all 15 PNG bytes and excludes synthetic review data and source maps. A forced review environment cannot enable the fixture in a production build.
- npm reports no known vulnerabilities in production dependencies at this checkpoint. This is not a whole-system security certification.
- Rust formatting, public-source privacy scan and dependency-notice generation pass.

Version 0.1.0 at 4ed9b0f passed the complete Windows CI run, including 149 tests and unsigned NSIS packaging. Version 0.1.1 restores one-time Pi settings registration with automatic relative connection discovery and secure native observer export; its final validation is recorded with its successful build. Native GUI acceptance remains pending.

The observer now clears cached child rows when its optional plugin becomes unavailable or emits malformed status, while keeping the connected root visible. The real adapter-to-Rust roundtrip verifies that root heartbeats cannot revive those cached children and that a valid reconnect restores idle children.

## Connection setup regression coverage

- The settings guide emits valid, selectable JSON preserving spaces, Unicode and quoted path characters; no required environment variable or special Pi command is shown.
- Real HTTP discovery tests exercise the ordinary observer entry with no injected loader or environment override, relocated folders, missing app/config followed by automatic retry, and bridge/token restart.
- The real Node-to-Rust roundtrip imports the relocated observer bundle and uses its default relative connection lookup.
- Native export tests cover stable paths, private files, idempotence/upgrades and rejection of unsafe pre-existing destinations. Existing Pi settings and credentials are not modified by export.

## Required Windows acceptance

- Install and uninstall the unsigned x64 preview; confirm WebView2 bootstrap behavior on a clean machine.
- Launch twice, restore from tray and shortcut, handle a shortcut collision.
- Pin/unpin, hide/show, click-through on/off, restore input if the webview reloads or stalls.
- Resize presets and manual resize, move between 100/125/150/200% DPI monitors, remove a monitor.
- Verify all four animations and foreground hands, nearest-neighbor pixels, keyboard contact and no attention clipping.
- Exercise keyboard-only and screen-reader navigation, reduced motion, hidden/offscreen pause.
- Connect a live idle session, send work/thinking/attention, stop a child, disconnect a session, wait beyond35seconds, reconnect, sleep/resume and restart the bridge.
- Confirm root titles and duplicate subagent names, zero/one/many agents, and full accessible roster beyond64illustrated agents.
- Measure idle/64-agent CPU and memory; no performance numbers are claimed before measurement.

No browser or native screenshot has been claimed for this implementation.

## Compact 8bitcn revision (0.1.2)

Version 0.1.2 replaces the vanilla controls with React plus pinned actual 8bitcn/Radix sources, groups sessions by exact workspace cwd and shrinks the default window. Verified: 83 frontend + 51 observer + 49 core Rust + 22 shell tests (205 total), both TypeScript checks, production asset/font/component/license checks, formatting, strict core/shell Clippy and the isolated Windows GNU shell-policy check pass. The explicitly labeled offline layout preview is reviewed separately. Windows compilation, workspace tests and unsigned installer packaging are additionally run by the artifact-only Windows preview workflow. Inspect the run for the exact commit before treating those stages as passed.

Browser rendering is unavailable in this task: the supported cloud browser cannot reach the workspace's loopback review server, and its URL policy explicitly rejects data URLs. No alternate browser or injection route is used. The offline composition uses final local styles, font and approved sprite layers, but is not a browser or native-app screenshot. It cannot verify Radix geometry/collision positioning, WebView font metrics, native drag/resize or mixed-DPI rendering.

Native Windows acceptance must additionally check the compact menu at 320×280 and 480×380, scrolling long project lists, full paths with Unicode, project disappearance/reconnect, custom pixel tooltips/dialogs, and restoring the window after hide/pass-through. The user confirmed connection succeeds with published 0.1.1; the new UI itself has not been run on their Windows machine.

## Menu and agent-details correction (0.1.3)

The scrolling dropdown and Connection guide no longer contain absolute decorative border layers. Their pixel frames use real outer borders, preventing the reported thick line from scrolling across Artwork scale labels. The menu, project list and guide scroll vertically without horizontal scrollbars. The intended thin section separators remain.

Agent details use a 55% preferred height instead of the former 45% cap, with flex shrink and a viewport clamp reserving space for window controls. The Close header stays visible while long details scroll. Long titles use at most two visual lines while retaining their full accessible text, so the sticky header cannot consume the panel.

Local checks pass: 93 frontend, 51 observer, 49 Rust core and 22 shell tests (215 total), strict TypeScript, production asset/font/component/license verification, Rust formatting and strict core/shell Clippy. Ten additional checks cover the border structure, scrolling style contract and long agent details. These DOM/style checks do not verify browser painting. Corrected Windows scrolling appearance, clipping and DPI behavior remain acceptance checks; the artifact-only workflow separately compiles and packages the exact published commit.
