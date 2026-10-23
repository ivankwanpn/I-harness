# Agent invocation ownership and dependency receivers — implementation report

Status: bounded implementation committed and source writing stopped for independent full-range review. This is **not** an all-Agent/all-release acceptance claim. Remaining failures and unsuccessful fixture/oracle attempts are retained below and in raw evidence.

## Exact source and ownership

- Checkout: `C:/Users/inkik/.codex/worktrees/context-native-transfer/I-harness-main`.
- Branch: `codex/agent-invocation-ownership-20261024`.
- BASE: `a41230d96a84ba2ca14fa2cc36fc30ab3adc85f9`.
- HEAD: `9cafcca6e36a3d0170af5825389886e5158ca106`.
- Full review range: `a41230d96a84ba2ca14fa2cc36fc30ab3adc85f9..9cafcca6e36a3d0170af5825389886e5158ca106`.
- Commit: `fix(agent): own invocation lifetime and preserve live dependency receivers`.
- Exactly eight owned files changed: `packages/core-agent/src/agent/create.ts`, new `src/agent/dependencies.ts`, `src/agent/types.ts`, `README.md`, new `test/agent-invocation.test.ts`, `test/agent.test.ts`, `test/context-recovery.test.ts` (dependency/retry controls only), `test/fixtures/agent.ts`.
- No MAIN product edits, recursive agents, pushes, tags, releases, schema/version/lockfile changes, installs, or live-account access. Product remains `0.1.13-rc.1`; Session format remains 12. Context/recovery/response/admission/history/compaction production files remain unchanged.
- Working tree was clean after commit and at evidence capture. `git diff --check` passed. Dependencies resolve to this checkout (Node v24.15.0); see `evidence/task-1/workspace-resolution.log`. Lockfile unchanged, so no reinstall or Chokidar patch replacement was needed.

`evidence/task-1/source-copy-manifest.json` binds 38 actual physical source/config copies to SHA-256, byte length, normalized working-tree Git blob and HEAD Git blob. Every recorded normalized blob equals HEAD. It includes all eight changed files, relevant unchanged settlement/context/recovery/Session owners and the downstream test/config inputs. `capture-evidence.mjs` is the reproducible capture script. `commands-index.json` gives exact package CWD, invocation, exit, result and raw log for all 19 test/typecheck commands. Artifacts are local SDD evidence, not product commits.

## Implemented behavior

`run`, `runAdmitted`, `followup` and `compact` synchronously acquire the same exclusive invocation lease. A competing Promise rejects with `code: 'AGENT_BUSY'` before `beginAction`, factory creation, input claim, hook, source registration or provider entry. The lease is released only after the original operation and preparation close, generation drain, action finish and source close complete or fail. `updateContext` retains its existing busy guard; `contextBudget` stays read-only.

Setup/settlement now retains local references to every resource actually created. An input preparation factory or source registration throw no longer skips an already-created generation drain/action finish. Preparation close, generation drain and finish failures each still allow the next owned cleanup to run; earlier errors remain causes/aggregate members. The source drain still joins the operation and all delegated drains. Existing recovery codes and source recovery handling remain in their original owners; an ended busy lease does not bypass an unresolved managed owner.

The small explicit dependency facade holds private fact/generation fields and captures Session, fact owner, session ID and initialization limits. Host model/preferences/callback properties remain live and are read from their original receiver. Top-level callbacks bind to the original host; nested model and step-input objects pass through intact with their own receivers. The original host can be frozen, has no fact/generation fields assigned, and cannot move an Agent to another Session by replacing its `session` property. Separate Agents over the same host dependency source retain their separately captured owners and ports.

The controlled summary fixture now forwards host values and receivers instead of copying descriptors, and still supplies the concrete summary factory only when absent. It does not mutate caller inputs. Dedicated receiver/frozen/data-swap controls invoke actual exported `createAgent` directly.

README/API comments replace obsolete overlapping direct mutation/shared-count promises. **Compatibility cost:** direct callers must await settlement or use their existing queue. This packet adds no scheduler and changes no service/SDK steering or queue implementation. Sequential followups retain cumulative step telemetry, including truncated/refused/error results and held stop/flush boundaries.

## Causal controls and qualification

All Vitest runs used package CWD, `--maxWorkers=2 --minWorkers=1`, and were sequential within this checkout. Typechecks were sequential too. No root-CWD Vitest scan occurred.

| Evidence | Result and meaning |
|---|---|
| `task1-red.log` | Exit 1, seven actual behavioral failures on original create.ts: competitors entered/replaced work or source; setup failures skipped owned cleanup. |
| `task1-green.log` | Exit 1, same RED repeated because a Python command failed without editing source. This filename is not a GREEN claim. |
| `task1-green-2.log` | Exit 0, all seven initial invocation/setup controls pass after implementation. |
| `task2-red.log` | Exit 1, 9 failed/69 passed. Direct original-receiver/live-data/frozen-host controls and original mutable effort/output/client controls fail under descriptor copying. Other failures already belonged to reserved packets. |
| `task2-green.log` | Exit 1, 101 passed/10 remaining known failures. All new direct receiver/host mutation controls and owned-budget mutation controls pass. |
| `baseline-source-corruption.log` | Exit 1 with BASE create.ts temporarily restored, followed by byte-exact final-source restoration in `finally`. Held acceptance first operation ends in `FACT_CANCELLED` plus two `FACT_CLOSED` errors after competitors replace its effective ports. All caller promises had eager handlers and were joined; no unhandled-rejection artifact is used as product evidence. |
| `managed-controls-4.log` | Exit 0, 11 controls pass, including actual JSONL coordinator/document, managed generation lifecycle, held acceptance, sequential persistence and retained owner-recovery refusal. |
| `focused-final-3.log` | Exit 0, 36 selected controls pass, 82 unselected. Subsequent full suite verifies the final soft-assertion-only diagnostic edit too. |
| `core-agent-full.log` / `.json` | Exit 1, **426 passed /26 failed**, 452 tests, 52 files (45 pass/7 fail). Final committed product/test bytes. |
| `core-agent-typecheck.log` | Exit 0, final `pnpm typecheck`. |
| `session-executor-controls.log` / `.json` | Exit 1, **43 passed /16 failed**, 59 tests across `admitted-input`, `event-driven-steering`, `service`. |
| `session-executor-baseline.log` / `.json` | Exit 1, same scope with BASE create.ts restored; **43 passed /16 identical failed names**. Final create.ts bytes restored in `finally`. |
| `session-executor-typecheck.log` | Exit 0, final downstream `pnpm typecheck`. |

The 12 new invocation/dependency tests cover original/frozen receiver behavior, model replacement and fixed Session, held provider/acceptance/final stop/failed source drain/manual compact source close, all four competitor APIs, exact original source/action/event preservation, source/finish counts, sequential continuation, setup factory/source-registration failures, separate Agents over one host source, joined close/drain/finish failures, and actual managed source persistence/recovery fencing. Existing full-suite `executor.test.ts` passes, including real step-seam steering admitted during a tool body and serial queued turns. Existing service tests also pass their serial first/second submit, queued successor, admitted input, and live model rebind controls.

Held-retry controls now record preparation identity, actual validated-send client and cap. Prompt/effort changes fence the consumed retry. Same-value reads keep the existing prepared retry. Output cap 1024→512 or same-binding model object replacement invalidates the old candidate, performs exactly one additional preparation after the hold, and sends only that fresh preparation using the changed cap/current client. Exactly one `retry-started` event remains; no new allowance is issued. Existing admission/recovery logic supplies this behavior and is unmodified.

Two unsuccessful held-retry oracle iterations are preserved in `focused-final.log` and `focused-final-2.log`. The first incorrectly required every change to throw; root confirmed A02 permits existing fresh rebuild under the original consumed authorization. The second incorrectly counted all preparations as physical attempts and omitted real compaction probes; final assertions bind exact hold-relative preparation identity to actual send receipts. These are **test-oracle corrections, not product RED claims**.

Managed control setup attempts are also retained: `managed-controls.log` timed out because an unowned custom prepared client failed before the hold; `managed-controls-2.log` exposes `GENERATION_UNSUPPORTED`; the fixture was corrected to the repository's actual local-test model/generation seam. `managed-controls-3.log` used sticky `requireRecovery` and could not close; the intended recoverable retained-drain fixture now uses `holdRecovery`. `typecheck-initial.log` records two test-only union-Promise TS2345 errors corrected by explicit `settled<unknown>`. No production behavior was changed to make these fixture errors green.

## Exact remaining obligations

`agent-failure-comparison.json` compares final names with R5 `final-agent-tests.json`: **35→26, zero newly failed names**. Nine old failed entries disappear: original getter-order/receiver case (replaced by the approved receiver contract), three obsolete concurrent provider-count cases and held overlapping flush case (replaced by busy refusal plus sequential assertions), held retry surface mutation, and three live mutable effort/output/client controls. This comparison is not a baseline waiver; all remaining failures still require the assigned follow-up owners.

Remaining Agent failures, individually:

1. `agent abort rejects immediately when the signal is already aborted` — expected aborted text, actual `FACT_CANCELLED`.
2. `agent compaction seam auto-compacts at a step boundary when under pressure`.
3. `agent compaction seam explicit agent.compact() appends the compaction events`.
4. `contradictory dispatch invalidates the actual candidate guard for a closed exchange (explicit=false)`.
5. Same contradictory-dispatch control, `explicit=true`.
6. `a stop during the resolution checkpoint keeps the owned rejection unresolved`.
7. `a second confirmed overflow blocks durably across calibration loss and reload`.
8. `an explicit different model tuple gets a fresh owned window even with partial identity`.
9. `known-to-unknown provider metadata cannot renew actual main admission (consumed=true)`.
10. `unknown-to-known provider metadata cannot renew actual main admission (consumed=true)`.
11. `ambiguous identity preserves consumed A while known B keeps its own actual retry`.
12. `known-b identity preserves consumed A while known B keeps its own actual retry`.
13. `retains accepted measured usage when Stop arrives during the acceptance flush`.
14. `a failed post-response observation preserves accepted usage and blocks the next unsupported request`.
15. `runs and finishes actual neutral depth-2000 args (deep schema=false)`.
16. Same depth-2000 control, `deep schema=true`.
17. `runs and finishes actual neutral depth-6000 args (deep schema=false)`.
18. Same depth-6000 control, `deep schema=true`.
19. `prepares, measures, derives a cap and physically sends depth-6000 JSON on a controlled actual HTTP route`.
20. `createAgent per-model compaction policies applies the resolved provider/model threshold and retention when the agent runs`.
21. `createAgent per-model compaction policies compacts the same fixture with the equivalent global threshold and retention`.
22. `createAgent per-model compaction policies refreshes the policy key on a direct metadata rebind`.
23. `createAgent per-model compaction policies refreshes the inherited policy descriptor before the next logical step`.
24. `live provider reasoning publishes the first delta immediately and batches more while the same block is still running`.
25. `live provider reasoning settles the visible prefix on cancellation and clears pending batch timers before retry`.
26. `live provider reasoning stops publishing pending progress as soon as cancellation arrives while the provider is waiting`.

These remain the diagnosed recovery/Stop aggregation, compaction source/output eligibility, invalid continuation/coordinate/unknown-effect fixtures and cancellation text families from the root triage. Their final raw errors are in `core-agent-full.json`; no production repair was attempted in their reserved owners.

`session-failure-comparison.json` lists all 16 downstream failures, baseline and current identical, with zero additions/removals. Fourteen are the entire real event-driven-steering file: five child wait variants (foreground/target/all/tasks/subagent-job), code_exec, code_wait, child close, already-dispatched direct sibling, Stop/close nested-owner variants, and exec-job/workflow-job/workflow-run process variants. They fail existing direct `output` assertions (`undefined`, missing cell_id/timed_out), so this run cannot establish their later producer-retention assertions. The two service failures are `M61: a failing fs tool is a model-visible result and the turn CONTINUES` (missing direct output.error) and `closeSession() with a submit in flight settles the binding promise, clears queue rows, and never crashes` (native aborted wording). They are unchanged baseline obligations, not proof that all real steering paths are qualified.

## Review handoff

Root may independently review the full exact range above. Setup and cleanup ordering, original source identity, receiver binding, nonmutating host semantics, pure status reads and protected unresolved owner recovery were self-reviewed. No observer-failure aggregation, R5 failed-attempt facts, sameRequestCandidate, history, current/unknown-effect protections, or compaction selection semantics were edited.

No further source writing or runtime work is in progress. The source lease is available for the independent reviewer. Root's sequential recovery/response/Stop and IC-B work must consume this interface, and the modified dependency-only context-recovery fixture instrumentation should be retained when those test files are rebased.
