# Character allocation, idle visibility and display-only demo

## Scope

Version 0.2.2 is prepared against Pi Companion 0.2.1, commit `1bd66e0`. Publication is authorized and remains gated on the exact release commit passing the Windows workflow and verified NSIS packaging.

- Roster-aware allocation uses all six designs before duplicates and balances unavoidable repeats. Assignments are stable for unchanged rosters and are retained where possible after joins, removals or filtering. Only the first 64 illustrated agents reserve designs. Canvas drawing and Taskbar baseline offsets use the same assigned design.
- The default-on **Show idle / ready agents** checkbox applies to Office and Taskbar. It filters only `idle`, keeps live connection totals/workspace identities intact, updates on status transitions, and saves its choice locally. Missing or restricted storage falls back safely. An idle-only filtered view explains why it is empty and offers restoration in Office.
- **Demo mode** is explicitly selected, always labeled, and not persisted. Six fictional agents start the display; every four seconds the generator varies membership between two and six and changes predefined activities, states and tool labels. It has no network, filesystem, platform-command or live-state dependency. The UI continues receiving live snapshots separately, and switching back restores current live data and the previous live workspace/artwork preferences.
- Demo transitions pause for Pause motion, reduced motion, page hiding and fullscreen hiding. Exit and disposal clear the timer. Native commands remain limited to existing window controls and display-width synchronization; no Pi-control API was added.

## Automated verification

- `npm run check`: frontend and observer TypeScript checks, 182 frontend tests, 51 observer tests, production build and emitted-asset/provenance guard pass.
- Eight pixel-authoring regression tests pass. All 15 sprite PNGs remain unchanged.
- Public-source audit and `git diff --check` pass.
- Independent source review found no actionable correctness issues.

Coverage includes hash collisions, balanced repeats, roster reorders, joins/removals, filtered subsets, text-only overflow, consistent Taskbar gutter selection, idle persistence and unavailable storage, ready-state transitions and focus recovery, mode switches and strip sizing, isolated demo updates, return to newer live data, disconnected/invalid live data, simulated details, timer pause/disposal and non-persisted demo activation.

## Remaining acceptance

No Rust or native source was changed. Rust checks were not run because this executor has no Cargo toolchain. No Windows build, installer or native GUI acceptance was performed.

Browser regression automation was prepared but could not launch Chromium: the executor returned `socket() failed: Operation not permitted`, including on the permitted escalated attempt. No browser screenshots or visual acceptance are claimed. Actual Office/menu layout, Taskbar transparency/placement, mixed-DPI rendering and native recovery still require browser/Windows validation. DOM and production-build checks do not establish those native behaviors.
