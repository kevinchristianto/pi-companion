# Compact all-idle strip and synchronized tray visibility

## Scope

Version 0.2.3 is prepared from Pi Companion 0.2.2 (`0b16f5d`) and the reviewed fix (`dc955a5`). Publication is authorized and requires the exact release commit to pass the Windows MSVC workflow and verified NSIS packaging. The local GNU test installer is not the final release asset.

- The Taskbar strip no longer reuses Office's large empty-state heading and paragraph. When every selected agent is idle, one desk-sized slot contains three short lines: **Idle hidden**, **N ready**, and **Use tray menu**. Full context remains available to assistive technology and in Office. The other strip empty states are compact too. There is no nested paragraph scrollbar or extra strip button.
- The tray context menu has a checked **Show idle / ready agents** option. It and the Office checkbox consume the same native authoritative setting. Both apply to the selected live/demo display without changing Pi sessions, window mode, pin/input state, or visibility/recovery behavior.
- The setting is persisted with the existing private placement preferences. Older files remain readable; on first load, the renderer's prior local preference initializes the native value only if still unset. A prior native/tray choice cannot be overwritten by late migration. Placement and monitor preferences are preserved. Save failures retain the current session choice and report that persistence was not verified.
- Existing filtering rules remain unchanged: only `idle` (Ready) agents are hidden. Working, thinking, waiting, completed, error and unknown states stay visible. Hidden agents remain connected and reappear on activity.

## Verified

- `npm run check`: frontend and observer TypeScript checks; **206 frontend tests**, **51 observer tests**; production build and emitted asset/provenance guard passed.
- `cargo test -p companion-core -p companion-shell --locked`: **103 tests** passed, including native setting/migration and private preference-file regression tests.
- Core/shell Clippy with all targets and `-D warnings`, workspace Rust formatting, public-source audit, eight pixel-authoring tests and `git diff --check` passed.
- All 15 bundled sprite PNGs remain unchanged. No dependencies or observer protocol changed. The release workflow retains its existing safeguards, with its exact version gate advanced to 0.2.3.
- Independent source review found no actionable correctness defects.
- Full Windows GNU application check, Windows-target workspace Clippy, optimized executable compilation and NSIS packaging passed after installing isolated build dependencies. The test installer passed archive integrity; extracted application/loader hashes and all 23 observer/license resources match their inputs. The test build was reported working, but this is not an exhaustive native acceptance matrix.

New regression coverage includes compact empty-state content at 1, 6 and 1536 hidden agents; fixed one-desk CSS sizing; tray-style state events, strip content counts and Office synchronization; stale local preference migration; late migration/command results after a newer native choice; duplicate pending clicks; native-command and migration errors; saved preference preservation; unavailable browser storage; and filtering/restoring the isolated demo.

## Verification limits

The CSS tests check layout declarations and a nominal 112×104 logical-pixel budget. DOM tests do not establish actual browser painting or native Windows behavior.

- Browser visual QA was attempted using the supported cloud browser and local development server, but it returned `net::ERR_CONNECTION_REFUSED`. It could not access this executor's preview. No visual acceptance or new screenshots are claimed.
- Linux Tauri compilation initially stopped at missing GLib development dependencies. A Windows GNU cross-build subsequently passed, including the full native application; this experimental target is not the final Windows MSVC release route.
- The final release requires Windows CI compilation, workspace tests/lint and NSIS packaging. Native acceptance beyond the reported working test build remains limited. Check that tray and Office checkmarks agree in both directions, that a tray toggle does not show/focus a hidden window, and that restart preserves the choice and strip position. Include Windows scaling, accessibility and a transition from hidden idle to active status.
