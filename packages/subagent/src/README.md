# Subagent creation and followup ownership

`index.ts` remains the package's only public entry. `tools.ts` retains
`createSubagentTools`, its original ordered tool array and its existing helper
exports. `child.ts` retains `spawnChild` and every existing internal export.
All new modules are private source modules; the package export map is unchanged.

| Owner | Responsibility |
| --- | --- |
| `tools/spawn.ts` | Spawn schema/catalogue cache, admission, fork parsing, durable task submission, settlement callback and optional foreground observation. Role metadata is allocated once per tool factory and refreshed by role revision. |
| `tools/followup.ts` | Send, followup and explicit resume tools. Inbox append precedes mailbox push and the optional serialized drive. Resume retains its distinct error vocabulary. |
| `tools/wait.ts` | Exact-child/all-child observation and authorized durable task output. User steering releases observation while the original producer continues. |
| `tools/cancel.ts` | Interrupt, close, job cancellation and task subtree cancellation. The task registry terminalizes the tree before live interruption and quiescence observation. |
| `tools/status.ts` | Live child rows, elapsed time, job output and job index. Job routing retains the subagent/exec/workflow identities and existing fallback/error rules. |
| `tools/types.ts` | The original host dependency contract; no additional mutable state owner. |
| `child.ts` | Spawn orchestration: gate, scope mount, hook registration, seed/depth allocation, conditional model resolution, durable session creation/mirror, inherited ownership event, seed observation, assembly and publication. |
| `child/model-binding.ts` | Settings selection before role selection before inheritance; exact toggle refusal and model labels. The resolved provider/protocol/reasoning/window/cap values still come from the host resolver. |
| `child/prompt.ts` | The original role/identity/delegation/reporting contract and prompt/schema overhead calculation. |
| `child/role-tools.ts` | Resolve and promote exactly the declared child capabilities; report unmounted names. Code Mode wrappers are mounted for the child, rather than copied from the parent. |
| `child/assembly.ts` | Child registry, child Code Mode mount, prompt and overhead callbacks, controller and agent construction. Receives already-resolved locals and the original options reference. |
| `child/lifecycle.ts` | Seed-window warning and initial publication/settlement/disposal. Agent registration precedes job registration, initial run, entry publication and settlement-handler registration. |
| `child/diagnostics.ts` | The one module-scoped run diagnostic handle shared by the moved original child warning sites. |
| `child/types.ts` | Original spawn options and lifecycle callback contract. |
| `followup/resident.ts` | Lazy restoration of the existing durable child's agent, child registry, model binding, Code Mode and disposal functions. It retains the stale-entry check after model resolution. |
| `followup/drive.ts` | One `entry.followupChain` serializes initial work and inbox turns. Each turn advances the original inbox cursor, replaces the controller and reopens the same job before running. |
| `followup/inbox.ts` | Cold-resume sweep over waiting entries, lazy rebuild and the original fire-and-forget failure diagnostic. |

The agent table, agent registry, job registry, roles, fork projection,
task protocol, task notification, persistence and task projections remain their
original independent owners. Team tools and scheduling remain in `agent-team`;
there is no subagent `tools/team.ts` implementation to move or duplicate.

The extracted factories retain the original dependency object by reference.
They do not destructure getters into snapshots. Spawn assembly and publication
are synchronous helper calls at the original statement boundaries, so they add
no await. Inherited host context remains a live callback over the actual child
session; spawn checkpoint callbacks read the original options, while resident
restoration retains the original captured coordinator/session-id pair. Budget
and model locals are passed only after their original resolution. No extra
rollback, cancellation latch or competing driver is introduced.

Close still marks the entry closing, aborts, terminalizes outstanding tasks,
drains/disposes the retained runtime, kills the job, conditionally removes the
same table entry and removes its resident agent. Interrupt retains the child;
subtree Stop preserves the original durable cancellation and followup-chain
observation. Completion callbacks, late results and task delivery remain the
existing task protocol's responsibility.

The original scope-unmount ownership defect and failure cleanup limitations
remain for I4/E2. In particular, spawn mounts its scope before awaiting model
resolution, and a failed resident resolution retains its original return/throw
and cleanup behavior. This extraction does not change context ownership,
recursively unmount scopes or add factory rollback. The existing shared-root
depth binding limitation for custom nesting remains documented at spawn.

Actual physical sizes: facades `tools.ts` 29 and `child.ts` 79 lines;
`createSubagentTools` 16 and `spawnChild` 64 lines. Private modules are 9–207
lines. `createSpawnTool` (192 lines) and `ensureResidentAgent` (136 lines)
remain above the 120-line review trigger: the former keeps its catalogue cache,
durable admission and settlement/observation in one tool; the latter retains
the original restore construction/publication boundary and its captured/live
callbacks. They are focused owners, not relocations of the whole tools factory.
Splitting their async admission merely for a line count would obscure timing.

Verification uses the existing full subagent suites (273 tests / 18 files),
session-executor `child-observation`, `code-mode-children` and `assembly` (52 / 3),
and agent-team `child-sequence`, `completion-delivery` and `lifecycle` (28 / 3),
with package typechecks. Two added cases characterize the inherited ownership
barrier and live restored prompt callback; both pass on original and split
sources. Source reconstruction additionally checks complete statement bodies,
getter/receiver/argument evaluation, allocation/callback placement and public
exports. Actual reachability retains all 419 complete ordered findings and its
digest without changing scanner, baseline or allowlist.

Run these commands from the repository root, sequentially in the order shown:

```powershell
pnpm --filter @i-harness/subagent exec vitest run --maxWorkers=2 --minWorkers=1
pnpm --filter @i-harness/subagent typecheck
pnpm --filter @i-harness/session-executor exec vitest run test/child-observation.test.ts test/code-mode-children.test.ts test/assembly.test.ts --maxWorkers=2 --minWorkers=1
pnpm --filter @i-harness/session-executor typecheck
pnpm --filter @i-harness/agent-team exec vitest run test/child-sequence.test.ts test/completion-delivery.test.ts test/lifecycle.test.ts --maxWorkers=2 --minWorkers=1
pnpm --filter @i-harness/agent-team typecheck
```
