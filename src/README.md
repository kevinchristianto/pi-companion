# Frontend

This is a React / TypeScript / semantic HTML / CSS / Canvas2D implementation. It contains no Three.js, Electron, historical live roster, status-file reader, remote artwork loader, or frontend HTTP/filesystem/shell capability.

## Entry points

- `main.ts`: native platform by default; imports synthetic review data only for explicit development serving.
- `platform.ts`: the complete Tauri surface. `get_state`, the `companion-state` event, and named window commands only.
- `model.ts`: bounded, typed, defensive validation and monotonic shell-envelope ordering. Invalid or non-listening bridge data hides the live roster; stale/offline records are excluded. The Rust bridge owns connection/lifecycle authority and expiry. No browser timer infers liveness.
- `app.tsx`: keyed accessible roster, workspace/idle filters, Office/Taskbar modes, details/focus behavior, connection instructions, window controls and recovery warnings. Explicit Demo mode selects a separate fictional roster while live snapshots continue to update independently.
- `sprites.ts`: exact build-time fifteen-file PNG allowlist, complete required-layer loading, natural-dimension checks, collision-free six-design allocation (balanced repeats above six) and five-layer compositor. Only the illustrated visible roster reserves designs; the assigned design also determines the Taskbar baseline offset.
- `preferences.ts`: default-on idle/ready visibility saved in local storage, with a session-only fallback when storage is unavailable.
- `demo.ts`: pure display-only fictional agent generation with injectable randomness, no platform or live-data dependency. The UI updates it every four seconds only while Demo mode is enabled, visible and not paused/reduced-motion.
- `scheduler.ts`: one 125 ms timer for all visible canvas artwork. Idle/thinking/attention advance at 4 fps; typing at 8 fps. Hidden and offscreen art stops; reduced motion uses the state's first frame. No animated status polling.
- `review.ts`: clearly labeled, synthetic six-character fixture. It is never a missing-bridge fallback.
- `assets/pixel-office/ASSET-SOURCES.json`: public-safe source and runtime hashes plus derivative provenance.

Only the first 64 visible agents get illustrated canvases. All agents matching the current workspace and idle filters remain in semantic HTML, including additional text rows. Hidden idle agents remain in connection totals and workspace choices. A reported backend overflow is disclosed separately as an incomplete live roster, not confused with the artwork cap or simulation.

## Commands

Node 24 or later:

- `npm ci`
- `npm run dev`: native-connected frontend development server on 127.0.0.1:1420. A normal standalone browser has no live connection.
- `npm run dev:review`: cross-platform, explicit six-agent browser review fixture, on the same port. This does not start a native app or connect to Pi.
- `npm run typecheck`: frontend and observer type checks.
- `npm run test:frontend`: frontend model, DOM, scheduler, platform and artwork checks.
- `npm run check`: both type checks, frontend and observer tests, then the production build and emitted-art/fixture guard.

The build guard verifies exactly fifteen unchanged PNGs and absence of development-review identities. A build never enables the development-review exception, even with VITE_COMPANION_REVIEW=1 and NODE_ENV=development. The user-selectable, clearly labeled Demo mode is a separate production feature and is never an automatic missing-bridge fallback.

## Rendering and acceptance

Each source frame is 64 × 64. Canvas backing-store and CSS dimensions are exactly 64 × 64 or 128 × 128, image smoothing is disabled, and CSS requests nearest-neighbor rendering. No artwork is fractionally fitted to a tile. The layers are chair → character → desk → laptop → matching foreground hands.

CSS-pixel integer scaling is not proof of physical-device-pixel fidelity. Fractional operating-system DPI and WebView zoom still require native Windows acceptance at 100%, 125%, 150% and 200%, including moving the window between monitors. Browser screenshots, native window interaction, timing, screen-reader behavior and full-cast visual acceptance have not been claimed by the unit/DOM tests.

The interface uses normal HTML buttons, text and focus order; canvas is decorative. Snapshot updates preserve existing buttons and focus. Removing a selected resident closes its details and returns focus to a useful control. Reduced-motion and forced-colors styles are included. Pin/pass-through/hide report authoritative native results. Hide and pass-through require a confirmed native recovery route; the renderer cannot grant itself one.
