# Desktop workflow completion and acceptance

Implementation continued from `03a88b0f` in `D:\frontend-test`, branch `codex/desktop-workbench`. The user approved the workflow features and reuse of suitable ZCode/DSH UI. The source work stayed out of `D:\I-harness-main`, and the user's existing `packages/desktop/electron.vite.config.ts` edit remains excluded from the implementation commit. No remote push.

## Completed features

| Feature | Engine / data | Desktop control |
| --- | --- | --- |
| Immediate reasoning | First provider delta immediately, then 50ms batches. Per-block identities distinguish reused provider IDs across steps. Canonical reasoning replaces transient progress; transient events do not enter the log or advance its cursor. Cancellation stops timers. | In-progress reasoning opens immediately, keeps the reader's disclosure choice, and becomes saved reasoning without duplicates. |
| Agent Shell | Separate durable detected executable choice. Generic `shell` uses its actual POSIX/PowerShell/CMD dialect. Prepared calls pin the approved executable; later settings affect later calls. Explicit bash/pwsh remain available. | General → Agent Shell shows choices, executable and unavailable errors. |
| Reviewer reuse | Bounded internal, tool-free contexts keyed by session/intent/model/protocol/effort/configuration/policy/permissions. Fresh decision on every operation; only successful final-text pairs commit. | Independent reviewer model stays configurable. Workflow → review history shows arguments, model, outcome/rationale/status, timing and reuse. |
| Durable jobs | Desktop enables actual job/status events, with full-log and persisted snapshot reads. Output is bounded; cold rows have no invented cancellation authority. | Workflow → Background jobs shows history, output and owned cancellation. |
| Team roster / board | Real per-session team tools. Colliding commands are namespaced so generic subagent messaging stays usable. Forked seed history does not transfer source-team child ownership. | Workflow → Team shows the main conversation, teammates, explicit spawn/message/followup/interrupt and revision-checked task actions. |
| Goal | CAS create/edit/pause/resume/complete/clear, explicit start plus autonomous continuation, goal_read/goal_complete, owned cancellation. No fixed step or round allowance. Refusal/empty/error pauses continuation with a reason; failed recovery persistence cannot escape as an unhandled background rejection. | Goal editor/control, actual run indicator and error, plus conversation goal strip. Saved state restores without silently starting new paid work. |
| Plan Mode | Durable mode/proposal, model-visible proposal and dynamic prompt. Tool registry enforces read-only admission; changes apply at idle boundaries. | Workflow → Goal/Plan mode and proposal controls. |
| Detailed inventory | Producer, transport, UI display/control, persistence and evidence checked for smaller capabilities. | See [fine capability inventory](2026-09-30-desktop-fine-capabilities.md), including Todo, input queue, reminders, tools, context, review/rewind, sessions, resources, models and interaction. |

UI reuses the existing licensed ZCode tabs and adapts its status lamp/label presentation. Actual DSH GoalBar, PlanModeControl and JobListAction were inspected for control/state patterns. ZCode attribution is retained in `packages/desktop/licenses/zcode/README.md`; no DSH source was copied verbatim.

## Verification and repairs found by acceptance

Final **`pnpm verify:all` passed: 3,792 passed, 9 skipped, 0 failed; 70/70 projects; typecheck, five E2E files and reachability passed.** Log: `D:\frontend-research\desktop-workflow-completion-portable-verify-2026-09-30.log`.

Focused tests include streamed reasoning order/replay/usage/cancel, shell execution and approval pinning, Goal stale revisions/restore/refusal/empty/recovery failure, pause-resume while an old provider request settles, independent team forks, read-only Plan admission, review pool boundaries/rollback, durable review history, and scoped UI read/mutation/output races.

Packaged acceptance found a distribution defect that source tests could not expose: package-local dependency links could resolve back to the development checkout. Distinct core-session module instances meant live Goal changes could miss the append hook and subscriber map, although some other state appeared to work. Package payload copying now excludes nested node_modules, and all dependency resolution uses the shipped graph. A regression verifies shared module object identity.

Removing those links also exposed an existing package-root resolver defect: `@modelcontextprotocol/sdk/package.json` could resolve to a nested `{type: commonjs}` manifest. The builder now finds the named actual manifest and copies its required dependencies. Missing required dependencies fail the build; only optional platform dependencies may be skipped. A second regression covers this nested-manifest case. The final gateway ships 193 actual resolved packages.

The gateway payload was copied into a temporary directory outside the repository, NODE_PATH was cleared, and its packaged Electron Node launcher started with **exit 0 and empty stderr**. Probe: `D:\frontend-research\probe-packaged-gateway-2026-09-30.mjs`.

## Actual provider and UI acceptance

QA used isolated copies of the actual settings/credentials/installed skill files, with `D:\agent-complete\playground` as its workspace. It selected model/effort through the actual UI, checked the resolved route, and exercised real providers rather than mock transport.

| Configured route | Protocol | Main effort | Real calls | Live reasoning | Reviewer history |
| --- | --- | --- | --- | --- | --- |
| deepseek | anthropic-messages | Max | list_dir + read | 1 progress event, 1 canonical block | 2 reviews, 1 reused context |
| deepseek-responses | openai-responses | Max | list_dir + read | 10 progress events, 2 canonical blocks | 2 reviews, 1 reused context |

The independently selected reviewer used DeepSeek Flash at Low while the ordinary task-subagent model gate was false. Each operation still made a fresh review request. Reuse is an internal context property; no provider cache billing reduction is claimed.

Additional actual packaged actions passed:

- General setting resolved CMD, and the model invoked `shell` with `echo agent-shell-ok`, receiving the expected output.
- Plan proposal/mode controls applied and switched off; registry-level write refusal is separately verified by the real-filesystem admission test.
- A Goal created through the UI executed and marked itself complete using actual read/tool results on the Responses route.
- UI created a shared task and a named teammate. The teammate read sample.txt on the real model, producing one completed background job.
- After closing and reopening the app, completed Goal, one member/task, one saved job and six review records remained. Cold saved jobs were not reported cancellable.
- Exactly three ordinary conversations existed: two main QA conversations and the explicitly created teammate. No reviewer chat was created.
- At 1000px, scrollWidth equaled innerWidth. Goal/team/job/review screenshots were inspected. Earlier failed QA attempts were diagnostic only; this is the accepted portable run.

Script/log: `D:\frontend-research\desktop-workflow-live-qa-2026-09-30.mjs` and `desktop-workflow-live-qa-2026-09-30-portable.log`. Temporary settings and userData were removed after shutdown; normal installed preferences, plugin files and test conversations were not changed.

## Delivered local package

- ZIP: `D:\frontend-test\packages\desktop\release\I-harness-Desktop-0.1.0.zip`
- SHA-256: `5EB641F95E8BC8C32AF688AB4EFF1128B32EA5487808A8A8EF77E4D797E8E5B2`
- Build log: `D:\frontend-research\desktop-workflow-completion-portable-dist-2026-09-30.log`
- Screenshots: `desktop-live-deepseek-thinking-2026-09-30.png`, `desktop-live-deepseek-responses-thinking-2026-09-30.png`, `desktop-agent-shell-settings-2026-09-30.png`, and `desktop-workflow-{plan,goal,team,jobs,reviews,reviews-narrow}-2026-09-30.png`, all under `D:\frontend-research`.

## Remaining precise limits

- Todo already has agent writes, durable full-log projection, status/count and paging UI; it has no human add/edit/delete/checkbox mutation control.
- Queue display/cancel exists. Explicit human steering and reliable multiple submissions from the same window during its own outstanding prompt remain separate missing controls.
- Reminders are next-step delivery, not idle-session wakeups. Pending human interactions, process/PTY handles and warm reviewer contexts are not restart-surviving workers.
- Other original-provider routes (Claude/GPT/Gemini/Bedrock) still need their own live credentials. The available DeepSeek compatibility routes do not establish acceptance for those providers.
- Historical Anthropic test-dialogue migration was removed from scope, as requested. No old dialogue migration or bulk deletion was performed.
- Previously deferred account usage/OAuth, shortcut/statistics pages, unmounted Agent browser control and signing/public distribution remain deferred. These limits are inventory, not a claim that the requested eight feature integrations are unfinished.
