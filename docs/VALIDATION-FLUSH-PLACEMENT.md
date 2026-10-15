# Flush taskbar placement: version 0.2.1

## Status

Local implementation, preview review and publication authorization are complete. Version 0.2.1 is prepared against the v0.2.0 baseline, commit `07ccd3876a6b709401e4190da5bdf9b6814dfe61`. Exact-commit Windows CI is required before formal publication.

## Changes verified locally

- Taskbar hover/focus agent names alone use 6px Press Start 2P with a 9px line height and smaller padding. Status bubbles and Office names retain their previous size. Long hover names wrap and scroll within the strip.
- The strip remains 104 logical pixels tall, with no native bottom margin or frontend bottom padding/scrollbar reservation. Per-character integer canvas translation consumes only the existing 2–3 transparent bottom rows. All source sprite PNG bytes are unchanged.
- Width is content-sized: 88px controls + 12px workspace padding + 112px per tile + 8px between tiles, clamped to the monitor work area. Three agents use 452px and six use 812px. Empty content reserves one tile. Large rosters remain horizontally scrollable through buttons, keyboard, trackpad and focused-agent reveal.
- Left/Center/Right preferences are available in the Office menu. Changing alignment in Office does not move or resize Office. The strip grip supports bounded horizontal dragging, Left/Right keys, Shift for larger steps, and Home/End alignment. Its vertical position stays at the work-area bottom.
- Placement persists in a bounded, validated private configuration file using existing link-safe I/O. Mode and click-through are not persisted. Missing/removed monitors fall back safely; saved-monitor reconnection and an intentional later Office-monitor move are handled separately.
- Drag samples are serialized, the final release position is flushed, and cancellation prevents late updates from restarting a drag. Recovery, click-through, hiding, blur, timeout, fullscreen, monitor/DPI/work-area and content-size changes cancel active dragging.

## Verification

313 automated tests passed:

- 155 frontend tests across nine files, including IPC validation, alignment, count synchronization/retry, grip lifecycle, keyboard focus, scroll overflow and small hover-name styling
- 51 observer tests, including ordinary one-time configuration discovery, app start order, reconnect and restart behavior
- 99 Rust core/shell tests: 49 core integration tests and 50 shell tests, including liveness, geometry, DPI/work-area, auto-hide, monitor fallback, private persistence and recovery policy
- Eight approved pixel-authoring regression tests

Also passed:

- Frontend and observer TypeScript checks
- Vite production build and offline font/license/provenance checks; review fixtures excluded from production
- Rust formatting and core/shell Clippy for all targets with warnings denied
- Public-source boundary audit
- Independent source review; findings fixed before final checks, including Office restoration ignoring the saved strip-monitor preference
- All 192 layered sprite frames retain every opaque pixel after the per-design bottom-gutter translation, with the final opaque row at the strip baseline
- All 15 bundled PNGs match the published baseline and approved sprite lock

## Preview and remaining acceptance

The supplied layout board is an offline illustration derived from source geometry, local fonts and actual sprite layers, not a browser or native screenshot. Alignment panels use logical 1x artwork; hover comparison cards are exactly 2x magnification. Scroll buttons are shown disabled where all sample desks fit. A separate RGBA strip preserves real transparent pixels.

This environment has not compiled the changed Windows-native source or exercised it in a Windows GUI. WebView font metrics, real CSS/portal layout, pointer capture, physical mixed-DPI positioning, native transparency, taskbar auto-hide, z-order/fullscreen recovery and Windows private-file persistence still require native acceptance. Linux core/shell tests and the illustration do not establish those properties. Browser rendering is unavailable through the permitted current route.

The prior v0.2.0 Windows CI/release evidence remains historical; it does not validate this revision. The user has approved publication; the exact-commit Windows release gate still applies.
