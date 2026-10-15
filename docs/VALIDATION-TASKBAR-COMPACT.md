# Compact Office and transparent strip: local validation

The reviewed sizing and above-agent speech bubbles are approved for version 0.2.0 publication. The results below are local pre-release evidence; the release workflow separately verifies the exact commit on Windows before packaging and publication.

- 122 frontend, 51 observer, 8 sprite-authoring and 83 Rust core/shell tests passed (264 total).
- TypeScript, Rust clippy with warnings denied, formatting and public-source audit passed.
- Independent source review found no remaining blocker.
- Approved character/hand atlas hashes are unchanged.
- Office: 360×300 logical default, 280×240 minimum, default 1× with optional 2× artwork.
- Transparent strip: 104 logical pixels high, 12px margins, fixed 64×64 sprite canvases. An always-visible retro status bubble sits above each sprite with a downward tail; no bottom row; names remain on hover/focus and in accessibility/details.
- User-hidden state, fullscreen hiding, recovery guards, mode restoration, monitor/work-area bounds, exact workspace filtering and stale/reconnect behavior have automated coverage.

## Remaining acceptance

The native Tauri integration and Windows probe have not been compiled or executed in this environment. Linux compilation stopped at missing GTK/GLib development libraries; a Windows target download did not complete. Pure Rust policy tests do not establish native integration correctness. The release preparation reruns the production frontend build; consult the exact commit’s CI result for Windows integration status.

The layout examples are offline illustrations using actual local assets and font. They cannot establish Radix/WebView text metrics, native transparency, hit testing, dragging, mixed DPI, z-order, taskbar auto-hide timing, fullscreen detection or tray/hotkey recovery. An exact-commit Windows build is required before publication. Real desktop acceptance is still required before claiming native appearance or usability is verified.
