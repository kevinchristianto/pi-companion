# Frontend

This is a clean vanilla TypeScript / semantic HTML / CSS / Canvas2D implementation. It contains no React, Three.js, Electron, historical roster, status-file reader, remote artwork loader, or frontend HTTP/filesystem/shell capability.

## Entry points

- `main.ts`: native platform by default; imports synthetic review data only for explicit development serving.
- `platform.ts`: the complete Tauri surface. `get_state`, the `companion-state` event, and named window commands only.
- `model.ts`: bounded, typed, defensive validation and monotonic shell-envelope ordering. Invalid or non-listening bridge data hides the live roster; stale/offline records are excluded. The Rust bridge owns connection/lifecycle authority and expiry. No browser timer infers liveness.
- `app.ts`: keyed accessible roster, session filter, office/list views, details/focus behavior, connection instructions, window controls and recovery warnings.
- `sprites.ts`: exact build-time fifteen-file PNG allowlist, complete required-layer loading, natural-dimension checks, stable identity assignment and five-layer compositor.
- `scheduler.ts`: one 125 ms timer for all visible canvas artwork. Idle/thinking/attention advance at 4 fps; typing at 8 fps. Hidden and offscreen art stops; reduced motion uses the state's first frame. No animated status polling.
- `review.ts`: clearly labeled, synthetic six-character fixture. It is never a missing-bridge fallback.
- `assets/pixel-office/ASSET-SOURCES.json`: public-safe source and runtime hashes plus derivative provenance.

Only the first 64 agents in office view get illustrated canvases. Every received agent remains in semantic HTML, including additional text rows and the complete list view. A reported backend overflow is disclosed separately as an incomplete roster, not confused with the artwork cap.

## Commands

Node 24 or later:

- `npm ci`
- `npm run dev`: native-connected frontend development server on 127.0.0.1:1420. A normal standalone browser has no live connection.
- `npm run dev:review`: cross-platform, explicit six-agent browser review fixture, on the same port. This does not start a native app or connect to Pi.
- `npm run typecheck`: frontend and observer type checks.
- `npm run test:frontend`: frontend model, DOM, scheduler, platform and artwork checks.
- `npm run check`: both type checks, frontend and observer tests, then the production build and emitted-art/fixture guard.

The build guard verifies exactly fifteen unchanged PNGs and absence of synthetic review identities. A build never enables the review exception, even with VITE_COMPANION_REVIEW=1 and NODE_ENV=development.

## Rendering and acceptance

Each source frame is 64 × 64. Canvas backing-store and CSS dimensions are exactly 64 × 64 or 128 × 128, image smoothing is disabled, and CSS requests nearest-neighbor rendering. No artwork is fractionally fitted to a tile. The layers are chair → character → desk → laptop → matching foreground hands.

CSS-pixel integer scaling is not proof of physical-device-pixel fidelity. Fractional operating-system DPI and WebView zoom still require native Windows acceptance at 100%, 125%, 150% and 200%, including moving the window between monitors. Browser screenshots, native window interaction, timing, screen-reader behavior and full-cast visual acceptance have not been claimed by the unit/DOM tests.

The interface uses normal HTML buttons, text and focus order; canvas is decorative. Snapshot updates preserve existing buttons and focus. Removing a selected resident closes its details and returns focus to a useful control. Reduced-motion and forced-colors styles are included. Pin/pass-through/hide report authoritative native results. Hide and pass-through require a confirmed native recovery route; the renderer cannot grant itself one.
