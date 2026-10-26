# Task 6 O1 — ExecutionPane observation implementation plan

> **Status 2026-10-27:** root-promoted after I1–I5 closure. The matching ledger reserves Task1 source-only and its exact isolated writer. Tasks2–6 retain accepted-F1 gates. Original drafts/review are preserved; this plan does not authorize recursive agents or shared-file overlap.

**Goal:** replace only ExecutionPane's1500ms execution reads with bounded authorized subscriptions while preserving original IH UI, source ownership, Stop/D1 semantics and passive inspection.

**Architecture:** original Code Mode/executor publishers expose pure reliability/post-install/lifecycle state; one Gateway lease adapter supplies stamps and existing read-only execution DTOs through actual SDK/native IPC/preload to one pane controller. No healthy polling, inspection-triggered recovery, new bus/model lane/authority registry or backend rewrite.

**Contract:** `docs/superpowers/specs/2026-10-27-execution-surface-observation.md` is normative, including exact new methods, recovery premise and private assertion callback. Read preserved `execution-surface-candidate-review-20261027.md` for the source anchors and original drafts for history. No unresolved interface choice is handed to the implementer.

## Global gates, direct runner and evidence

- Root supplies an immutable integrated source/evidence manifest with full accepted D1a/Stop IDs and eventual accepted F1 IDs. Do not inspect moving HOST/NATIVE/worktrees. Product remains0.1.13-rc.1/Session13; preserve original formats and other accepted scoped evidence.
- **Source-only exception:** Task 1 alone can begin before F1 acceptance after root reserves its exact files AND passive-code-store writer hands off `code-mode/src/types.ts`. Task 0's shared-source reads and Tasks 2–6 wait accepted F1 plus a sequential shared reservation. No capability/pane/whole-O1 credit at Task 1.
- Passive-code-store writer currently owns Code Mode types raw-wrapper, state.ts/runtime limits and core seed. Preserve its resulting type contract; O1 adds only surface methods after serial handoff. Task 1 never edits state.ts/runtime/limits.ts/core seed. Branch/worktree separation is not a writer slot.
- Preserve D1 format/Inbox/Stop, F1/B2/L1/public fork, ContextOutput/HOST, instruction ownership and original producer recovery/capture/retention. Observation cannot call modelState/prepare/auth/send, writable construction/load, tool execution or receipt recovery.
- Wire/bounds exactly match spec: surface execution; protocol3; capability desktop-surface-events:["1"];32 active leases/64 idempotency entries;128 UTF8-byte opaque IDs; session256 UTF16; safe offset; limit1..20/default10;65536 units/100 output/100 call rows per cell. No scan-cost claim from render bounds.
- **Runner incident rule:** no pnpm run/exec/test/type shortcuts, autorelink, install, dependency repair or package-manager subprocess, including test children. Resolve existing Node/Vitest/TypeScript files read-only, record absolute paths/hashes/CWD/env/exit. Setup/import failure is not intended RED and never authorizes dependency repair.
- Resolve once at authorized dispatch; Node selection MUST choose the first Application on this host. An absent target stops as setup failure; use root-supplied equivalent verified absolute paths if installed directories are not links.

```powershell
$o1Node = (Get-Command node -CommandType Application | Select-Object -First 1).Source
$o1Vitest = Join-Path (Get-Item -LiteralPath 'D:/I-harness-main/node_modules/vitest').ResolveLinkTarget($true).FullName 'vitest.mjs'
$o1Tsc = Join-Path (Get-Item -LiteralPath 'D:/I-harness-main/node_modules/typescript').ResolveLinkTarget($true).FullName 'bin/tsc'
```

- Before EACH single test/type invocation, including reruns, create a NEW fixture-owned short root and SIX new subroots, record them, and set only these IH variables. Never reuse ambient homes/evidence roots or change HOME/USERPROFILE. Run the setup below again before the next individual command.

```powershell
$o1RunRoot = Join-Path 'D:/tmp' ('o1-' + [guid]::NewGuid().ToString('N').Substring(0,8))
$o1IHNames = @('IH_CONFIG_DIR','IH_STRUCTURE_EVIDENCE_ROOT','IH_RESULT_INTEGRITY_EVIDENCE_ROOT','IH_LEGACY_FORK_EVIDENCE_ROOT','IH_MIXED_RETENTION_EVIDENCE_ROOT','IH_NATIVE_DEPENDENCY_EVIDENCE_ROOT')
foreach ($o1IHName in $o1IHNames) {
  $o1IHRoot = Join-Path $o1RunRoot $o1IHName
  New-Item -ItemType Directory -Path $o1IHRoot -Force | Out-Null
  Set-Item -LiteralPath ('Env:' + $o1IHName) -Value $o1IHRoot
}
```

- Run ONE package-CWD command at a time; Vitest always `--maxWorkers=2 --minWorkers=1`. Every typecheck is direct `& $o1Node $o1Tsc --noEmit` in the named affected package, after its own fresh-six-root setup. No concurrent suites or chained commands. Record actual RED/GREEN and preserve raw failures. Broaden/repeat only for changed source, failure or concrete unresolved concern.

## Exact files and sequential reservations

| Stage | Files | Gate/collision |
|---|---|---|
| Task 1 Code Mode | modify `packages/code-mode/src/{types,register,event-facts}.ts`; new `test/surface-publication.test.ts`; extend `test/output-source-recovery.test.ts` | Root exact original-owner reservation; passive raw-wrapper types serial handoff first. No core/persistence recovery API changes. |
| Task 1 executor | modify `packages/session-executor/src/{assembly,service}.ts`; new `test/execution-surface-lifecycle.test.ts` | Same source-only reservation; preserve D1/Stop and retained cleanup debt. |
| Task 2 adapter | new `packages/desktop-gateway/src/observation/{types,index,subscriptions,execution-source}.ts`; modify `src/execution.ts`; new `test/surface-subscriptions.test.ts` | Source seams accepted; F1 accepted immutable handoff; no parallel Gateway registry. |
| Task 3 composition | Gateway `src/{host,router,types,project-scope}.ts`, tests router/execution-surfaces/host-close-retry; `session-management.ts`/`rewind.ts` only for actual lifecycle publishers | Root sequential shared reservation after F1; rebase accepted broker observation/currentness exactly. |
| Task 3 SDK | `packages/sdk/src/client.ts`; new `test/surface-notification-loss.test.ts` | F1 generic request/notification path accepted; no model API/protocol bump. |
| Task 3 Desktop | `packages/desktop/src/{shared/bridge,main/context-requests,main/ipc,main/sdk-runtime,preload/index}.ts`; renderer/app.tsx event/props only | F1 bridge/app-fork handoff accepted; no fork-controller edits. |
| Task 4 pane | new Desktop `src/renderer/observation/{controller,use-observation}.ts`; modify session/ExecutionPane.tsx and necessary stale/limited execution-i18n text | Accepted bridge contract; original IH styling; other hook consumers unchanged. |
| Tasks 3–5 evidence | new Desktop `test/surface-observation-controller.test.ts`, `test/surface-subscriptions-runtime.test.ts`, `test/surface-observation-pane.test.tsx`; extend original IPC/runtime/pane tests | One coherent connected candidate; actual preload/source chain, fake Electron shell permitted. |

## Task 0 — root promotion and staged handoff

- [ ] Root promotes this candidate, records immutable source/evidence IDs, and reserves Task 1 source/test files with original owners. Verify passive writer's types handoff; preserve its raw-wrapper contract. Without that handoff/reservation stop source edits.
- [ ] Explicitly record source-only Task 1 exception if F1 shared slot is still occupied. Do not read/edit shared F1 composition during that stage.
- [ ] For Tasks 2–6 only: accept F1 product handoff and idle shared slot, then read/re-anchor actual HarnessClient request/onNotification, WorkspaceRuntimeManager, dispatchDesktopRequest/registerDesktopIpc, capability/bootstrap, broker visibility/currentness and native runtime ownership on that immutable source.
- [ ] A concrete incompatible accepted signature returns to root before edits. No speculative second seam, model lane or authority registry. Establish resolved direct runner and evidence manifest; no capability before Task 6.

## Task 1 — original Code Mode/executor publication and retirement

**Consumes:** actual registerCodeMode, FactOwner/SettlementFacts, original event-facts recovery and mount liveCells/Stop, assembly revokeNewWork/liveResources, service original publication/close debt.

**Produces exact additions:** mount `onSurfaceChanged?(listener:()=>void):()=>void` and pure `surfaceState?():"available"|"unavailable"|"retired"`; internal `createCodeModeEventFacts(owner,drainProducers,onObservationChange?)` with added pure returned `observationState():"available"|"unavailable"|"retired"`; assembly `onExecutionSurfaceChanged?` and `executionSurfaceState?` with those same signatures/unions; service `onExecutionSurfaceLifecycle?(listener:(event:{sessionId:string;assembly:SessionAssembly;kind:"published"|"retiring"|"removed"})=>void,options?:{includeExisting?:boolean}):()=>void`. Every lifecycle event includes exact assembly identity.

- [ ] RED real managed-coordinator/default register/tool tests separate durable record publication from local install. Cover initial readiness; optional start held through the WHOLE started handler, before first await through broker.startCell/liveCells.add or original admission-failure/interrupted-terminal path; unavailable during each transition. A resolved optional promise is not enough.
- [ ] RED source cases: pending registration before awaits, preparation failure, cancelled store bookkeeping, committed terminal before local removal, nondurable flush boundary, install failure, final pending deletion, original late receipt/reconciliation after rejected tool call. A rejected start's later receipt never runs broker.startCell/adds liveCells/revives continuation.
- [ ] RED recovery/currentness cases use real source holds: pure state/getters never call refresh/clear/settle; unrelated successful record/pending.size0 cannot clear a hold. `SettlementFacts` has NO acknowledgment API; assertHeld is lifetime only. Sticky requireRecovery/uncapturable/installation fault stays unavailable for mount lifetime. A transient hold clears only at that SAME original source's successful close boundary; preserve original close/retry authority. Do not invent ack or change core/persistence.
- [ ] Implement minimal internal pure fact observation state plus future-only isolated callback. Emit validity loss before first relevant await; emit actual changes after pending/cancel/install/delete bookkeeping. Retain original subscribe-driven reconciliation. Compose mount certificate from readiness, whole-handler local transitions, fact state and irreversible disposal/retirement; missing custom feed OR state is unavailable.
- [ ] Publish after actual liveCells.add/remove and final pending removal, including original late installation following rejection. Listener exceptions never fail producer publication. Callback removal detaches that consumer only; original recovery subscription remains through failed close and is removed only after successful original source.close.
- [ ] RED lifecycle tests use real service/assembly: includeExisting registers before enumeration; identity checks handle reentrant publish/revoke/remove; current handles are published, closing/failed debt is retiring, never synthetic live. Listener exceptions cannot fail source publication. Cover cold→live and exact owner replacement.
- [ ] Extend EXISTING assembly.revokeNewWork to retire observation synchronously/irreversibly and publish once before its original revocation; direct dispose shares the latch before awaits. Service revoke/closeSession/closeAll reaches that path before waits. Keep new-work/Stop/D1/cancellation/settlement semantics. Retiring once/identity; removed only after successful cleanup/map removal. Failed cleanup retains retired debt, retry never republishes.
- [ ] Forward actual mount state/feed; detach old consumer forwards on replacement/removal. Publish actual mounted effective-owner changes only; no hot remount or saved==effective assumption.
- [ ] Code Mode CWD, fresh-six setup: `& $o1Node $o1Vitest run test/surface-publication.test.ts test/output-source-recovery.test.ts test/register.test.ts test/managed-store-stop.test.ts --maxWorkers=2 --minWorkers=1`.
- [ ] Executor CWD, new fresh-six setup: `& $o1Node $o1Vitest run test/execution-surface-lifecycle.test.ts test/execution-state.test.ts test/code-mode.test.ts test/code-mode-live-settings.test.ts --maxWorkers=2 --minWorkers=1`.
- [ ] Separate direct typechecks in Code Mode then executor CWD, fresh-six EACH. Review complete changed source seam and preserve raw RED/GREEN evidence. Source-only work STOPS here until Task 0 shared F1 acceptance/reservation; no advertisement or connected claim.

## Task 2 — read-only Gateway leases and assertions through actual reads

**Consumes:** accepted Task 1 source methods; existing execution.read/profile/snapshot; accepted F1 visibility/broker currentness. **Produces:** exact spec wire, guards, adapters and createSurfaceSubscriptions API, including mandatory `ExecutionSourceAttachment.read(page,assertCurrent)`.

- [ ] RED initialized real-router denial before source reads: uninitialized/unknown/internal/foreign-scope/deleted/unowned/malformed/accessor/extra fields. Trap cold load/assemblyFor; missing read-only snapshot refuses. Hold authorization/profile/snapshot and change scope/owner away/back; no stale value or post-revocation source read.
- [ ] Thread PRIVATE assertion into `createDesktopExecution.read(sessionId,options={},assertCurrent?)` and `readDesktopSnapshot(coordinator,sessionId,assertCurrent?)`. Manual compatibility may omit it; lease source read MUST supply it. Assert before/after profile, before source selection/read, around snapshot await and before value return. Callback validates captured guard/owner only; no profile reentry, second authorization or registry.
- [ ] Read once via existing DTO builder; compare stamp/owner/guard after await. Dirty source returns reset without value; revoked scope refuses. Preserve render bounds, raw rewind semantics, history rows and scan limitation. Committed unknown-cell creation invalidates collection even with unchanged queue state.
- [ ] Attach actual record/post-install/reliability/lifecycle publishers synchronously; provisional sink before authorization await and includeExisting. Compare incarnation afterward. Lease-source close detaches adapter only, never original source/assembly recovery ownership.
- [ ] Implement32 active leases/64 idempotency entries/high-watermark; identical key/query joins its original disposition, conflicting/evicted keys refuse. Native ambiguity remains charged. One pending notice with retired>reset>invalidate precedence, one server read/lease; same page joins, conflict resets without queued reads.
- [ ] RED/GREEN real publication→snapshot, terminal history/control split, late original reconciliation,1000 source changes during held read, max concurrency1/bounded maps/eventual final page, close during subscribe/read, one failed independent release, retained producer debt.
- [ ] Gateway CWD, fresh-six setup: `& $o1Node $o1Vitest run test/surface-subscriptions.test.ts test/execution-surfaces.test.ts test/execution-reference-authority.test.ts test/router.test.ts test/host-close-retry.test.ts --maxWorkers=2 --minWorkers=1`.
- [ ] Gateway separate direct typecheck/fresh-six. Review exact adapter/guard range before shared composition; do not advertise.

## Task 3 — sequential actual SDK/native IPC/preload composition

**Consumes:** accepted F1 generic request/notification, writer, ownership/capability/currentness; Task 2. **Produces:** actual bridge surface request/event discriminants, native window-owned key/lease routes, sdk/ready current runtime generation.

- [ ] RED actual HarnessClient stream tests: unrelated throwing listener cannot suppress surface listener; affected surface-listener failure observably retires/closes. Exercise original bounded writer overload/EOF/forwarding failure; isolate other consumers without leaving failed surface current.
- [ ] RED native IPC: catalog workspace mapping, sender WebContents, tracked window tokens, cross-window guesses, malformed inputs before reads; serial canonical r1 key issuance, same-key lost-response retry, bounded owned pending ambiguity. Renderer never supplies native keys/roots/runtime authority. A retired lease's late subscribe reply cannot restore state.
- [ ] Install sink before subscribe; route through actual Gateway writer, runtime notification allowlist, bridge unions, preload onEvent/removeListener and app exhaustive event/ExecutionPane props. Preserve F1 fork paths. Register early notices until exact lease correlation.
- [ ] Emit sdk/ready only after current initialize/project sync/publication; withdrawal fences generation before close. Forward/window/listener failure observably retires/disconnects. Close joins flights/independent releases; old-child/ready/project-sync callbacks cannot reattach old runtime.
- [ ] SDK CWD, fresh-six setup: `& $o1Node $o1Vitest run test/surface-notification-loss.test.ts test/execution-state.test.ts --maxWorkers=2 --minWorkers=1`.
- [ ] Desktop CWD, new fresh-six setup: `& $o1Node $o1Vitest run test/ipc.test.ts test/sdk-runtime.test.ts test/close-lifecycle.test.ts test/surface-subscriptions-runtime.test.ts --maxWorkers=2 --minWorkers=1`.
- [ ] Separate SDK/Desktop direct typechecks/fresh-six EACH. Preserve original F1 affected named evidence on this connected range using the same direct runner; root records any exact added suite before execution.

## Task 4 — single-flight controller and original ExecutionPane

**Produces:** hook state/error/busy/refresh/act/generation plus explicit currentness/limited status. Other execution-surface hook consumers remain unchanged.

- [ ] RED sink-before-subscribe early/retired notices; one lease/read flight+dirty bit; stale page/scope/epoch/runtime tickets; duplicate/old revisions, gap/reset; unknown-epoch authority denied; one immediate reset follow-up, one transient retry/cycle under30s deadline, hidden dirty catch-up, unmount during subscribe and no offline retry loop.
- [ ] Implement no recurring timer. Capability absent does one initial/manual read-only limited inspection, clears live-current controls; manual refresh never starts polling. Coalesce visibility/reconnect/manual requests; sustained changes after one follow-up show updating/stale until real new publication/manual boundary.
- [ ] RED/GREEN original Stop confirmation while read held: Stop exactly once via original mutation/owner check/flush; invalidate old tickets, buffer notices, reconcile once. Scope/page/old response cannot restore authority; accepted hidden mutation completes; cold/limited/disconnected/wrong owner disabled. No mutation retry.
- [ ] Preserve tabs/layout/classes/buttons/clipping/page10/raw records/errors/focus and original IH styling. Add only needed stale/limited text; no fork/controller or unrelated pane changes.
- [ ] Desktop CWD, fresh-six setup: `& $o1Node $o1Vitest run test/surface-observation-controller.test.ts test/surface-observation-pane.test.tsx test/execution-surface-polling.test.tsx test/execution-surfaces-ui.test.tsx test/execution-pane-polish.test.tsx --maxWorkers=2 --minWorkers=1`.
- [ ] Desktop separate direct typecheck/fresh-six. Existing unconverted hook tests retain their timer behavior.

## Task 5 — actual route, idle, loss and authority qualification

- [ ] Build actual original registered code_exec/output/nested-call source→Gateway host/RPC stream→HarnessClient→WorkspaceRuntimeManager→dispatchDesktopRequest/registerDesktopIpc→preload wrapper→rendered ExecutionPane. Controlled provider/source gates and fake Electron shell permitted; direct callback/component fixture alone cannot qualify.
- [ ] Real new cell/source/output/trace with unchanged queue state appears; actual late reconciliation restores availability only where original source certificates permit it. Sticky faults remain unavailable; retirement removes live control and preserves history.
- [ ] Count exact execution/read/surface/snapshot RPCs, source read/status/scan, modelState/dashboard/send/tool launch/assembly construction. After one initial subscribe+snapshot, advance10 healthy fake minutes: additional O1 reads/scans/model/actions0. No synthetic notices hiding scans; separately identify unrelated loops.
- [ ] Burst1000 actual changes during blocked snapshot; max native/renderer/server reads1, bounded notices/maps and final correct page. Ongoing reset stops immediate reads after one follow-up until a real publication/manual boundary.
- [ ] Drop one notice then send later real gap/reset and recover. Silent dropped final notice recovers only on actual later manual/reset/reconnect boundary. Separately overload/EOF/native send/throwing surface listener must observably stale/retire/disconnect, with no polling recovery.
- [ ] Same-label reconnect does one fresh capability/lease/snapshot; old read/ready/runtime denied. Scope/binding/owner/window/epoch ABA, archive/move/delete/withdrawal, source unavailable/replaced and cross-window tokens deny before value release.
- [ ] Cold persisted inspection compares JSONL before/after bytes and traps load/repair/upgrade/writable/model/assembly/recovery: counters0, original bounded view; unsupported snapshot errors, no fallback. Authorization assertions run around actual inner read awaits.
- [ ] Desktop CWD, fresh-six setup: `& $o1Node $o1Vitest run test/surface-subscriptions-runtime.test.ts --maxWorkers=2 --minWorkers=1`. Other affected owner suites/typechecks run sequentially only when connected changes/new failures justify them, always direct Node and fresh-six EACH; root records exact commands.
- [ ] Freeze one coherent candidate/evidence manifest; root assigns independent whole-range review. No reviewer dispatch is authorized by this docs packet. Preserve failed/setup-invalid evidence; no fixture-only or helper-only acceptance.

## Task 6 — advertisement and honest handoff

- [ ] Advertise desktop-surface-events:["1"] only after complete connected source/state/lifecycle/loss/authority/idle proof. Missing mount state/feed/native support cannot advertise false reliability.
- [ ] Confirm ExecutionPane no longer requests polling hook/timer and actual packaged composition reaches source events. Keep initial/manual compatibility read and original Stop route; no interval fallback. Original UI/style evidence passes.
- [ ] Record immutable source, RED/GREEN/type evidence, actual-route counters, loss limit and visual regression evidence. Root integrates reviewed implementation. Source-only Task 1 is never whole-O1/Task6/release/native completion.

## Preserved follow-up boundaries

AgentProcessesPane/ContextSubsystemSettings remain O2/W2; TerminalPane remains O2 with its own cursor/EOF/backpressure/tree ownership; BrowserPane/CodingPlans remain O3, remote quota stale/manual absent push. Host policy/settings/index/MCP/Git/instruction diagnostics remain original W2/IG scopes. S1/N1–N4/native and full Task6 gates retain original owners and evidence; O1 grants no removal or platform credit there.

## Root source-only release

Root confirmed on2026-10-27: passive writer types.ts is unchanged atcbb29546 and needs no later edit; it is released for the two optional mount methods. F1 assembly.ts delta is frozen atf33 and service.ts unchanged; F1 has no further planned writes and now returns any new need before editing. O1 consumes stable MAIN source for Task1, then root composes accepted F1/O1 deltas serially. Source-only evidence does not advertise capability, change the pane timer or qualify Tasks2–6. NATIVE checkout/BASE/writer and protected evidence are recorded in the ledger. Shared F1 SDK/router/bridge/app-fork remains exclusively F1.
