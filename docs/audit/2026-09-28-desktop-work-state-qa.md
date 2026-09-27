# Desktop Todo and Goal work-state QA

## Delivery

- The Desktop gateway projects `{ todos, goal }` from the selected session's complete durable event stream using the existing `deriveTodoList` and `foldGoal` functions. Cold sessions do not need a model assembly. The Desktop request remains workspace/session scoped and is advertised only when wired.
- The **任務** pane shows actual Todo snapshot state, completed count, the in-progress or first unfinished page by default, and bounded page controls for longer lists. An absent snapshot, an explicitly empty snapshot, and a failed read have different text. Each row's accessible name contains its status.
- A compact goal banner appears only when a `goal/change` snapshot exists. Work-state read failures are visible in the default conversation view and the Tasks pane; an old goal is removed after a failed refresh. A selection generation keeps earlier snapshots from reappearing when switching A→B→A.

## Verified evidence

- Full serial workspace test run: `pnpm -r --no-bail --workspace-concurrency=1 test` exited 0 across 70 projects. The saved output is `D:\frontend-research\desktop-work-state-full-tests.log`; at that point Desktop reported 287 passed and gateway 94 passed.
- After the independent review fixes: `pnpm --filter @i-harness/desktop test` reported 66 files and 289 tests passed. `pnpm typecheck`, `pnpm e2e` (12 passed), and `pnpm verify:reachability` exited 0. Reachability reported 435 rows and no new rows.
- `pnpm --filter @i-harness/desktop dist` built the unsigned portable application and ZIP. ZIP SHA-256: `758FF2E7D755B20C11836670A785DF7707643EA5F6FDA295CFFD727FECFF88B3`.
- Packaged Electron read the existing real `D:\agent-complete\playground` session `sess-mujrqjmf-l1cobe`. Its three persisted Todo items displayed as 3/3 completed, and each row had an accessible item-and-status name. No model prompt was sent and `sample.txt` modification time stayed unchanged. Screenshot: `D:\frontend-research\desktop-work-state-2026-09-28.png`.
- A read-only reviewer found hidden read errors/stale goal display and missing accessible Todo status. Both findings were reproduced in tests and fixed. The final Desktop suite and packaged Electron check ran after those fixes.

## Limits

- `todo_write` is mounted in the Agent. The Goal domain can fold and persist `goal/change`, but there is currently no normal Goal mutation tool or Desktop route in the session executor; no Goal creation/edit control is offered. A live Goal banner could not be verified from an ordinary playground conversation because the existing sessions have no Goal event. The banner's phase behavior is covered by renderer tests and the cold fold by gateway tests.
- The UI method itself does not append Todo or Goal events. On exceptional corrupt/torn JSONL input, `coordinator.load()` may invoke the existing persistence repair path, so this is not a promise that the storage layer can never write during a read.
- Provider account usage/reset/OAuth remains deferred. The user's `packages/desktop/electron.vite.config.ts` change was not staged or committed. Nothing was pushed to GitHub.
