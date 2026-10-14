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
