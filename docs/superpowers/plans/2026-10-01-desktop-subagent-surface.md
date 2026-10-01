# Desktop parent-scoped subagent surface

## Authorized design

The user asked to reference both ZCode and the latest local DSH `D:/agent-complete/deepseek-harness-dsh-v0.2.0-rc.2`, actually launch DSH to inspect its UI, and move delegated child conversations out of the main chat list into a dedicated parent-scoped location. Screenshots also show a child session sequence-invariant failure.

Main lists use durable origin metadata: hide subagent/reviewer origins, preserve user chats and ordinary forks. A visible header action and dedicated right-pane tab show a parent-owned child catalog, live versus saved state, result/model/role information and a read-only child transcript with lineage/back navigation. Child selection stays local to that pane and never rebinds the main conversation or exposes an editable child Composer. Controls are enabled only with real runtime ownership; cold saved logs remain inspectable, without paid model work on reads. Existing unavailable/corrupt history is reported and preserved.

The backend catalog/history/control validates actual parent lineage and never constructs assemblies on read. Role settings keep their existing endpoint. The child-sequence defect is repaired at its producer, with no relaxation of the sequence invariant or silent rewrite of saved histories. DSH design patterns guide own markup/CSS; no reference repository source is modified.

## Tasks

- [x] Inspect actual DSH launch/UI and latest subagent reference source.
- [x] Fix demonstrated live-child read/repair producer and dense sequence/followup/restart regressions.
- [x] Add parent-scoped catalog/history/control DTOs and native/gateway transport with truthful runtime authority.
- [x] Exclude delegated/reviewer sessions from main dashboard, navigation, archive and search results.
- [x] Add independent subagent pane/header access, read-only child timeline, status/errors/guards and controls.
- [x] Verify packaged native UI and backend authority/persistence boundaries, update gap inventory and report, commit/package locally.

Final gate: 4,039 passed, 10 skipped, 0 failed, 70/70 projects; types, five E2E files and reachability passed. Packaged Electron acceptance passed with real isolated JSONL and zero provider calls. DSH Desktop was directly operated and its self-test/Plan review observed. Reports: `docs/audit/2026-10-01-desktop-subagent-surface-qa.md` and `docs/audit/2026-10-01-dsh-desktop-observation.md`. User excluded DSH Agent preset/mode adoption; reminders remain deferred. Local commit only.

Checkpoint before this phase: `e70707a0` (4,011 passed, 10 skipped, 70/70 projects), with the tools/Todo/UI inventory package preserved. No remote push, main-checkout edit, user Electron configuration edit or reminder work.
