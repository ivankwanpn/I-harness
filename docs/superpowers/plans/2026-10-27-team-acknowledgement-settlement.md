# Team acknowledgement settlement implementation plan

> Root approved after independent scoped I1-I4 re-review on 2026-10-27. Execute only the root-assigned task slice.
> Existing user authorization permits isolated implementation and local commits; no recursive agents or external publication.

**Goal:** Settle a previously admitted Team message's actual consumed acknowledgement under its original source across shutdown.
**Architecture:** Logical reservation precedes effect awaits; actual required singleton capture follows known consumption.
Keep generic transactions optional, preserve the serial capacity/fold lane, and retain exact partial cleanup owners through failure.
**Tech stack:** Existing TypeScript/ESM, Vitest3, Node >=22.18, JSONL managed coordinator; no dependencies or authority ports added.
**Spec:** `docs/superpowers/specs/2026-10-27-team-acknowledgement-settlement.md` in this repository.

## Global constraints and execution gates

- Work only in the later root-approved owner slice/checkout. These documents used stable MAIN; do not apply against a moving checkout.
- D1/O1/F1 and passive semantics remain intact. No model acceptance inferred from mailbox consumption; no callback replay on close.
- No Code Mode change, three-turn fixture, provider/profile/network access, protocol/schema/authority extension, or new completion registry.
- Preserve exact raw failures including thrown undefined/null with Failure.occurred and errorDelivered flags.
- Preserve synchronous service revocation and existing caller clock; no sleeps/deadline increase/repeat-until-green.
- Use actual coordinator/document/source/capture/receipt. Fault controls may hide real receipt as unknown, never fabricate successful receipts.
- Stop on unrelated setup/functional failure. Keep its evidence; no unapproved test rerun, widened instrumentation or workaround.
- Every task starts red, changes only its owner slice, and ends with the named focused check; do not broaden repeatedly after passing.
- Local commits at reviewed task checkpoints are authorized; publication remains outside these bounded tasks. Root reviews each task slice.

## Frozen files and interfaces

Modify agent-team/src/{facts,transact,mailbox}.ts and scheduler/{task-delivery,completion,recovery}.ts, scheduler.ts.
Modify session-executor/src/{assembly,service}.ts for original partial cleanup retention/error propagation only.
Create agent-team/test/acknowledgement-settlement.test.ts and session-executor/test/team-construction-cleanup.test.ts.
Extend existing agent-team/test/{mailbox,lifecycle,managed-transact,completion-delivery}.test.ts.
No core/persistence behavior edit. Keep implementation helpers in their owning files; a private type-only helper is optional, not a new subsystem.

```ts
type Failure = {occurred:false}|{occurred:true,error:unknown}
type DeliveryOutcome = {kind:'consumed',via:'target'|'parent-stop',sendFailure:Failure}
 | {kind:'queued',via:'no-target-call'|'bridge-false'|'target-owned',sendFailure:Failure}
type QueueGuard = (clone:TeamFoldState)=>void
type DeliveryRequest = {queued:Queued,mode:'enqueue'|'existing',guard:QueueGuard,deliver:()=>Promise<DeliveryOutcome>}
type InstallAck = (write:()=>Promise<void>,markInstalled:()=>void)=>Promise<void>
// Queued/Ack are exact Extract<TeamEvent,...>; MailboxResult={messageId:string,status:'accepted'|'queued'}.
// TeamTransaction.deliverMessage(request:DeliveryRequest):Promise<MailboxResult>
// lead.reserveMessage(queued,mode,installAck):MessageObligation; lead.retire():void
// obligation: queueEvents, queue(), queueInstalled(), start(deliver), settle() as defined in spec.
// TeamDeps.retainMount?:(handle:TeamMountHandle)=>void
// AssemblyOptions.retainConstructionCleanup?:(close:()=>Promise<void>)=>void
```

### Task 1 — Original message records and serial capacity-safe composition (I2/I4)

**Files:** agent-team/src/{facts,transact,mailbox}.ts; test/{acknowledgement-settlement,mailbox,managed-transact}.test.ts.
**Consumes:** actual FactOwner/required delivery capture, existing TeamLead generic commit and clone lane.
**Produces:** the frozen interfaces above; optional reserveMessage for generic-only leads, explicit unsupported refusal on deliverMessage.

- [ ] Add real-owned fixtures using existing owned-fixture.ts. Bind actual facts/tx/mailbox, not a fabricated FactOwner.
- [ ] Red cases: consumed promise held -> source.close pending and ack absent; true released -> exactly one ack; false -> queued/no ack.
- [ ] Add concurrent max1 test through REAL new composition: two sends start before either commits; first false-delivery remains queued,
  second rejects MAILBOX_FULL; assert one queue capture/target callback and no second reservation/action.
- [ ] Preserve exact full-tuple duplicate joining before admission; mismatch rejects before delivered-set dedup. Callback replacement ignored.
- [ ] Implement facts' original record variant and serial algorithm:
```ts
// inside serial entry, before reserve/capture:
const clone=cloneState(shared); request.guard(clone)
// enqueue: applyTeamEvent(clone, request.queued); reserve fixed queue/ack tuples;
// await original queue receipt; install queue once; release lane with record only.
// outside lane: record.start(request.deliver), never hold lane across delivery.
```
- [ ] mailbox supplies its unchanged pure capacity check against clone, closed over actual maxPending(default64); existing-mode validates tuple only.
- [ ] Root ruling for review Minor: include only the mechanical boolean-to-outcome scheduler boundary in Task 1 so C1/C2 typecheck. It classifies true/false only and preserves rejection; Task 2 owns scoped boundary normalization and removes this temporary adapter from the shipping path. No final mixed fallback.
- [ ] Store a logical reservation before queue admit/delivery awaits. Reserve original optional queue action/capture; keep admission action until
  immediate pre-target assertOpen, finish on dispatch/refusal. No new beginAction for ack and no pre-captured required ack.
- [ ] Authoritative queue not-issued: finish action, clear original lane/record, reject actual send outcome, target calls0. Other generic tx unchanged.
- [ ] Unknown/conflict/absence/install debt retains original capture; queue target calls0 until actual receipt AND local installation.
- [ ] A failed original send whose queue later reconciles committed is installed by original lane settlement, then left queued/no-ack;
  cleanup does not dispatch its unreached target callback. A later OPEN explicit mailbox retry is separate optional work.
- [ ] Capture singleton delivery only after known consumed; run receipt/install in existing serial lane. Mark ackInstalled before observer callback.
- [ ] settle joins RESOLVING driver completion sentinel, then state; no-ack terminal succeeds, unsettled true reconciles only original ack.
  The original caller promise can stay rejected after cleanup succeeds. Retain occurred=true/error:undefined or null exactly.
- [ ] Run C1/C2 below; verify old generic managed-transact behavior still passes without reserveMessage. Stop for unrelated failures.

### Task 2 — Scoped real bridge normalization and explicit retry boundaries (I1)

**Files:** agent-team/src/scheduler/task-delivery.ts, scheduler.ts, mailbox.ts; test/acknowledgement-settlement.test.ts.
**Consumes:** DeliveryOutcome and real createTeamDeliveryFacts/default service parent adapter.
**Produces:** actual bridge returns normalized private outcome at the precise operation boundary; boolean overrides adapted only at scheduler seam.

- [ ] Red no-effect case: actual child entry requires ensureResident; wrap its actual dependency to reject before message audit; assert original
  send rejects with SAME thrown object/undefined/null, queue remains, no ack exists, Team source cleanup succeeds.
```ts
const rejection=await send.then(()=>({occurred:false}),error=>({occurred:true,error}))
expect(rejection).toEqual({occurred:true,error:undefined}) // repeat a separate case for null
await handle.unmount() // no created Team ack; target call count remains zero
```
- [ ] Red target-unknown case: lose actual target audit receipt; bridge false leaves queue, Team reservation ends with no ack while actual
  target source/document close rejects until original target capture reconciles. Team does not call/duplicate that recovery owner.
- [ ] Normalize missing/killed/rebuild-false to queued/no-target-call; catch ONLY scoped ensureResident boundary for its rejected no-message attempt.
- [ ] Existing recordDelivery catches remain false behavior and target-owned; parent admission catch retains its actual received-input owner.
  Actual trusted Stop from parentNotify catch yields consumed/parent-stop; no generic code/aggregate inference.
- [ ] Unexpected synchronous post-barrier scheduling/observer failure retains proven consumed flag plus original escaping failure; before-barrier
  failure creates no ack, leaves queue and original error. Never infer physical absence from an unreturned boolean or thrown error.
- [ ] After no-ack terminal removal, explicit OPEN recoverRoot may create a new optional attempt. Close never does. Test existing target
  messageId check/same capture reuse, stable parent inputId and child lastInboxSeq; no second executed turn or duplicate audit/admission.
- [ ] Do not change caught-false public sends into new rejections; preserve original escaping send errors. Run C1/C2.

### Task 3 — Retained partial Team shell and retryable teardown (I3/I4)

**Files:** agent-team/src/{facts,scheduler}.ts; scheduler/{completion,recovery}.ts; test/lifecycle.test.ts.
**Consumes:** MessageObligation.settle, original source.close, existing completionJobs and actual child/tool handles.
**Produces:** retainMount callback; createTeamFacts retainFactsCleanup callback; ToolMount.mount/close; sealCompletions/joinCompletions; phased unmount.

- [ ] Red early construction controls: failure before admitTeam leaves no reservation; after reservation before source retains shell;
  after actual source registration but before factory return retains exact close; partial tool replacement retains original tools.
- [ ] Create/register shell immediately after admitTeam and before activity/source/role/tool mutation or first recovery await. If caller callback
  throws, local catch cleans same shell and returns nominal TeamMountFailure with actual handle if cleanup still fails.
- [ ] createTeamFacts registers its staged exact action/source cleanup after beginAction and BEFORE source registration. A registration failure
  leaves genuine action.finish cleanup reachable; no fabricated source slot. Native source assigned immediately on successful registration;
  close retries unfinished action/source phases. Pre-tx producer drain checks actual empty state, not an uninitialized tx.
- [ ] Before any tool mutation, retain ToolMount; mark exact successful unregister/register operations so close retries remaining restoration.
- [ ] Completion records stay in existing registry with resolving done sentinel, raw Failure and errorDelivered flag until cleanup processes them.
  Seal before joining; new updates cannot start completions. A processed historical error is not continuing source debt.
- [ ] Red held-driver unmount releases waiters immediately, fences new work, joins finite accepted drivers, then source close. Add failed child/tool
  close, retained exact entry/registration, same-owner retry, no releaseTeam until source AND child/tool/role teardown acknowledge.
- [ ] Implement states constructing/open/retiring/recovery/closed + coalesced in-flight promise; no success from isUnmounted. Clear only in-flight
  promise on failure; preserve stage bits/resources/obligations. Continue independent cleanup; aggregate original errors including undefined/null.
- [ ] Throw undelivered historical completion errors once after processing; if resources actually closed, report that separately so next explicit
  close succeeds. Never poison resolved ack by awaiting its old rejected send again or replay observers.
- [ ] Run C1/C3. No global failed-mount registry or new completion registry.

### Task 4 — Actual assembly/service retains failed construction cleanup (I3/I4)

**Files:** session-executor/src/{assembly,service}.ts; test/team-construction-cleanup.test.ts; agent-team/test/lifecycle.test.ts.
**Consumes:** retained original TeamMountHandle; original assembly dispose closure; existing creating/mountingAssemblies maps.
**Produces:** retainConstructionCleanup callback into EXISTING creating row, failed-construction fencing, explicit retry of original dispose.

- [ ] Red mount-recovery control: real pre-existing queue to actual quiet child target; actual audit acknowledgement followed by parent Team ack
  unknown, unresolved original reconciliation. No Code Mode/model drive needed. Recovery mount rejects; Team shell/reservation stay reachable.
- [ ] Assembly passes retainMount before await mountAgentTeams; remove successful-return-only push/double registration. Constructor catch disposes
  registered partial handle and preserves original construction cause plus actual cleanup errors.
- [ ] Service creates its row before build starts and supplies synchronous retainConstructionCleanup into that exact row; register dispose before
  first Team construction. Use `{work:Promise<SessionAssembly>,cleanup?:()=>Promise<void>,failed:boolean}` in existing creating map.
- [ ] Update creating reads at service.ts:608,818-819,1140,1190,1228: await row.work, retain failed cleanup row instead of unconditional finally-delete.
  Update closeAll early return to account for creating rows. No fake partial SessionAssembly or replacement failed-mount map.
- [ ] assemblyFor rejects while row.failed/cleanup remains; no constructor retry. close/closeSession join work then invoke original callback;
  success deletes row, failure keeps row/fence. Publication transfers ownership to real mountingAssemblies and clears construction-only row.
- [ ] Assembly dispose collects Team unmount errors at :1804-1810 while continuing other mounts. Source/child/tool failures keep exact handles.
- [ ] Red/green explicit retry: release actual backend reconciliation, call service.close once more, prove same source/capture/key and zero rebuilds;
  failed child/tool phase remains until its own real acknowledgement. Direct constructor failure also carries original cleanup closure if no seam.
- [ ] Run C4/C5. Do not reopen a failed retained root or infer successful cleanup from a released scalar team reservation.

### Task 5 — Text-only real service order pair and full bounded debt controls

**Files:** agent-team/test/completion-delivery.test.ts, acknowledgement-settlement.test.ts; session-executor/test/team-construction-cleanup.test.ts.
**Consumes:** actual fixture at completion-delivery.test.ts:13-28 with default parentNotify and controlled text-only model clients.
**Produces:** focused regression evidence for this owner only; no promotion of old contaminated/Code Mode fixtures.

- [ ] Install real assembly.inbox.admit wrapper BEFORE spawn. Delegate once; match fresh actual member+queued message ID; hold RETURN after
  successful real commit. Assert actual queue, target audit, admitted input and no ack before close. Use deferred promises, not sleeps.
- [ ] Race: start actual service.close (synchronous revoke), test no new optional mailbox/task/roster/driver starts, release return independently,
  await close. Require actual Stop cancellation, single original-source ack, zero new ack actions and remaining source debt; parent marker turns0.
- [ ] Inverse runs ONLY after race functional assertions/cleanup pass: release return, await exact ack and actual parent lane settle, then close.
- [ ] Ack receipt lost AFTER actual append: retain original key; gate native reconciliation unknown. Close rejects with original debt; allow actual
  reconciliation and explicit same-owner close; append1/target1/install1, public original rejection unchanged, final cleanup succeeds.
- [ ] Negative matrix: actual ack absent/conflict/install failure retains debt; observer throws after install cannot reapply; queue terminal
  not-issued all reasons finishes/no-target; queue unknown never dispatches; false/no-effect send error source closes; target unknown stays target-owned.
- [ ] Concurrent max1 and full-tuple duplicate/mismatch controls; held source/driver unmount; partial recovery/construction/child/tool failure retry.
  Undefined/null each tested with explicit errorOccurred flag; truthiness must not convert them to missing failure.
- [ ] On every cleanup check verify source + child + tool phases, reservation release and no callback replay, not merely event counts/quiet queue.
- [ ] Run C6 then C7. Preserve original failure/evidence and stop if unrelated setup fails; do not run the inverse anyway or rerun the race.

## Exact future validation commands — not executed by this packet

Use later root-approved checkout as `$teamAckCheckout`. Start each invocation in the named package CWD.
Before EACH runtime invocation create a fresh task-owned config/evidence tree; do not reuse original failed roots:
```powershell
$teamAckRun=Join-Path $env:TEMP ('ih-team-ack-'+[guid]::NewGuid().ToString('N'))
$env:IH_CONFIG_DIR=Join-Path $teamAckRun 'c'
$env:IH_MIXED_RETENTION_EVIDENCE_ROOT=Join-Path $teamAckRun 'm'
$env:IH_RESULT_INTEGRITY_EVIDENCE_ROOT=Join-Path $teamAckRun 'r'
$env:IH_LEGACY_FORK_EVIDENCE_ROOT=Join-Path $teamAckRun 'l'
$env:IH_STRUCTURE_EVIDENCE_ROOT=Join-Path $teamAckRun 's'
$env:IH_NATIVE_DEPENDENCY_EVIDENCE_ROOT=Join-Path $teamAckRun 'n'
# Record exact command/CWD/exit/log and all six fresh paths. Use existing local dependencies; no installation.
```
Use `C:/Program Files/nodejs/node.exe`; invocation paths below assume package CWD. Commands are separate, not a retry loop.
All Vitest commands include `--maxWorkers 2 --minWorkers 1 --no-file-parallelism` as shown; retain configured case deadlines.

| ID | Package CWD below checkout | Exact command after `& 'C:/Program Files/nodejs/node.exe'` |
| --- | --- | --- |
| C1 | packages/agent-team | `'../../node_modules/typescript/bin/tsc' --noEmit` |
| C2 | packages/agent-team | `'../../node_modules/vitest/vitest.mjs' run test/acknowledgement-settlement.test.ts test/mailbox.test.ts test/managed-transact.test.ts --maxWorkers 2 --minWorkers 1 --no-file-parallelism` |
| C3 | packages/agent-team | `'../../node_modules/vitest/vitest.mjs' run test/lifecycle.test.ts --maxWorkers 2 --minWorkers 1 --no-file-parallelism` |
| C4 | packages/session-executor | `'../../node_modules/typescript/bin/tsc' --noEmit` |
| C5 | packages/session-executor | `'../../node_modules/vitest/vitest.mjs' run test/team-construction-cleanup.test.ts --maxWorkers 2 --minWorkers 1 --no-file-parallelism` |
| C6 | packages/agent-team | `'../../node_modules/vitest/vitest.mjs' run test/completion-delivery.test.ts --testNamePattern team-ack-owner-order --maxWorkers 2 --minWorkers 1 --no-file-parallelism` |
| C7 | packages/agent-team | `'../../node_modules/vitest/vitest.mjs' run test/acknowledgement-settlement.test.ts test/mailbox.test.ts test/managed-transact.test.ts test/lifecycle.test.ts test/completion-delivery.test.ts --maxWorkers 2 --minWorkers 1 --no-file-parallelism` |

C6 is ONE ordered test that calls race then inverse, so inverse cannot run after failed race. Use assertion/gate cleanup that preserves original
errors; no finally success fabrication. C7 runs only after focused C6 and required debt controls pass; do not widen to whole monorepo/Code Mode.

## Design review and handoff gate

- I1 mapped to Task2 and no-effect/target-unknown controls; no permanent uncreated-ack debt or cleanup delivery callbacks.
- I2 mapped to Task1 with actual serial-clone guard before reserve, including concurrent max1.
- I3 mapped to Tasks3/4 with shell before resource acquisition/recovery and original construction callback retained by existing service row.
- I4 mapped to Tasks1/3/5: all native terminal not-issued queue outcomes; resolving driver sentinel; exact failure flags; remaining-phase retry.
- I1-I4 received scoped design PASS; root approved bounded implementation with the Task 1 typing ruling above. No implementation or test result is implied; Code Mode/Stage6 remain open.
