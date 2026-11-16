# Compact all-idle strip and synchronized tray visibility

## Scope

Unreleased changes based on Pi Companion 0.2.2 (`0b16f5d`). No version bump, push, CI run or release was performed for this revision.

- The Taskbar strip no longer reuses Office's large empty-state heading and paragraph. When every selected agent is idle, one desk-sized slot contains three short lines: **Idle hidden**, **N ready**, and **Use tray menu**. Full context remains available to assistive technology and in Office. The other strip empty states are compact too. There is no nested paragraph scrollbar or extra strip button.
- The tray context menu has a checked **Show idle / ready agents** option. It and the Office checkbox consume the same native authoritative setting. Both apply to the selected live/demo display without changing Pi sessions, window mode, pin/input state, or visibility/recovery behavior.
- The setting is persisted with the existing private placement preferences. Older files remain readable; on first load, the renderer's prior local preference initializes the native value only if still unset. A prior native/tray choice cannot be overwritten by late migration. Placement and monitor preferences are preserved. Save failures retain the current session choice and report that persistence was not verified.
- Existing filtering rules remain unchanged: only `idle` (Ready) agents are hidden. Working, thinking, waiting, completed, error and unknown states stay visible. Hidden agents remain connected and reappear on activity.

## Verified

- `npm run check`: frontend and observer TypeScript checks; **206 frontend tests**, **51 observer tests**; production build and emitted asset/provenance guard passed.
- `cargo test -p companion-core -p companion-shell --locked`: **103 tests** passed, including native setting/migration and private preference-file regression tests.
- Core/shell Clippy with all targets and `-D warnings`, workspace Rust formatting, public-source audit, eight pixel-authoring tests and `git diff --check` passed.
- All 15 bundled sprite PNGs remain unchanged. No dependencies, observer protocol or workflow files changed.
- Independent source review found no actionable correctness defects.

New regression coverage includes compact empty-state content at 1, 6 and 1536 hidden agents; fixed one-desk CSS sizing; tray-style state events, strip content counts and Office synchronization; stale local preference migration; late migration/command results after a newer native choice; duplicate pending clicks; native-command and migration errors; saved preference preservation; unavailable browser storage; and filtering/restoring the isolated demo.

## Verification limits

The CSS tests check layout declarations and a nominal 112×104 logical-pixel budget. DOM tests do not establish actual browser painting or native Windows behavior.

- Browser visual QA was attempted using the supported cloud browser and local development server, but it returned `net::ERR_CONNECTION_REFUSED`. It could not access this executor's preview. No visual acceptance or new screenshots are claimed.
- Linux Tauri compilation stopped at missing `glib-2.0` development dependencies before application type-checking. A Windows GNU cross-check reached the application build script but stopped because `x86_64-w64-mingw32-windres` was absent. The managed CheckMenuItem API and thread-safety bounds were checked against the installed Tauri source, but full application compilation is not verified by that inspection.
- Windows compilation/installer packaging and real tray clicks still need CI/native acceptance. Check that hiding all six ready agents leaves the complete compact message visible, that tray and Office checkmarks agree in both directions, that a tray toggle does not show/focus a hidden window, and that restart preserves the prior choice and strip position. Include Windows scaling and a transition from hidden idle to active status.
