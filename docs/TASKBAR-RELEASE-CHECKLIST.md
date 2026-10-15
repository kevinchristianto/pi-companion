# Desk-strip release gate

The above-taskbar placement and final above-agent retro bubbles were reviewed and approved for publication. Version 0.2.0 is the first formal release. Publication requires successful exact-commit Windows tests and NSIS packaging. Native GUI acceptance is still outstanding and must be disclosed prominently, not implied by CI success.

## Reviewed behavior

- Office remains the default. An optional Taskbar mode floats seated desks above
  the selected monitor's work area; it does not embed into Explorer or replace the
  system taskbar.
- Move the Office window to a monitor before choosing Taskbar to select that
  display. Monitor removal and changes to its scale/work area must keep recovery
  available.
- Taskbar mode uses the same live roster, exact workspace filter, sprite assets
  and observer. Connected idle agents remain; stale/disconnected rows disappear.
- The Office button or tray switches back to the normal controls. Agent details
  open in Office so a tall dialog is never clipped inside the narrow strip.
- Click-through is optional. Tray/shortcut recovery returns to Office and restores
  interaction. Entry must be unavailable without a working recovery route.
- Fullscreen hiding is automatic and reversible without taking focus. A window
  explicitly hidden by its user must not reappear when a fullscreen app closes.
- The redundant session text below each agent is removed. Full session context
  remains in details and accessible labels.

## Required pre-release evidence

1. The user reviewed and approved the accurately labeled offline sprite/layout example.
2. Local TypeScript, DOM, observer, sprite authoring and pure Rust geometry/state
   tests pass. Existing connection/export/privacy tests remain green.
3. A fresh authorized Windows build of the exact release commit passes native
   tests, format/lint and NSIS packaging. No artifact from an earlier commit is
   reused.
4. Disclose these outstanding native Windows acceptance checks and perform them before claiming native usability is verified: 100/125/150/200% DPI, negative-origin second
   monitor, unplug/reconnect a display, work-area changes, taskbar auto-hide,
   fullscreen on the same/other monitor, explicit Hide, click-through, shortcut
   collision, tray recovery, empty roster, long names, keyboard-only navigation,
   project filtering and stale/reconnect behavior.
5. Verify every installer/archive SHA-256 and file identity; inspect release notes
   and bundled licenses. Local previews and DOM tests do not establish native
   Windows placement, z-order, transparency or fullscreen correctness.

## Packaging and formal release

- Keep the existing standalone Tauri/Rust NSIS packaging and bundled observer.
  WebView2 download-bootstrapper mode needs internet if WebView2 is absent.
- The installer is unsigned until a separately authorized signing setup exists.
  A formal GitHub Release does not remove Windows reputation/security warnings.
- Use a normal versioned release title and asset names, without a `preview` suffix.
  Example naming, once the version is chosen: `Pi-Companion-VERSION-Windows-x64.zip`.
  The enclosed setup executable already uses Tauri's versioned installer naming.
- Publish only after the authorized release marker and exact-commit build gate are satisfied. Ordinary pushes must remain artifact-only; a successful workflow alone is not release authorization.
- No signing purchase, certificate generation or signing credential setup is part
  of this task.
