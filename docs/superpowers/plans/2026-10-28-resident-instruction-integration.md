> Root execution status2026-10-28: promoted after independent design review and same-reviewer closure of I1/I2. Reviewed candidate SHA256 CE7D8CF5F3E86C2D92D97BA9119B607937ED4396FB1BC7BC544BB7BB52A3EA17; exact reviewed text follows, including historical candidate-status paragraphs. R1+R2 are released together under a separate root brief because late admitted source/generation cleanup cannot be qualified independently of its original retained owner. Include only the existing assembly dependency barriers required to retain that debt; no unrelated cleanup rewrite. R3 factory consumer wiring, remaining R4 qualification and R5 whole-slice integration are not yet released. Product remains0.1.13-rc.1/Session13. No Core/B1/CodeMode implementation, fresh birth/G2, all/N/V3, reviewer, provider/profile, default rollout, push or release change is authorized. Root assigns one isolated caller writer and normal fresh-root/direct-runner verification; do not infer authorization from the old candidate paragraphs.
# Resident instruction slice — implementation contract and review plan

> Design packet for root and fresh review only. No implementation, runtime, test, probe, dependency, network or Git mutation is authorized or performed here. The readiness report remains unchanged. Later execution requires a root source reservation and review of this packet; it must use the normal approved execution workflow without recursive delegation.

Fix1 addresses only review I1/I2 and their controls. The exact pre-fix1 candidate is preserved as `resident-instruction-slice-design-20261028-pre-fix1.md`, SHA256 `8DD3A780A32B3E79A85511B855B9B9B15F80D2C489E14B5DC6FE04E28A188767`. The original readiness and design review remain unchanged; §10 maps the corrections for the same reviewer.

**Goal:** attach the accepted child instruction lease to an actual cold-reconstructed durable resident, preserving original queued-inbox execution, publication authority and retryable cleanup.

**Architecture:** one pending activation ticket belongs to the original assembly/service construction owner. Existing serialized inbox drives wait on it before execution effects. The original resident/delegated-generation owners retain their exact handles and cleanup acknowledgments; the accepted factory remains the only instruction manager/router implementation.

**Tech stack:** existing TypeScript/Node promises and exact owned Session/FactOwner/Agent/CodeModeMount contracts; no dependency or format change.

**Binding:** all product reads are immutable MAIN `e7e7d53fb69e237c5015c147ed55879585aa5cd4`. The previous packet's immutable C composition check at `eb5894c071089322288177dcd7aaf35813586609` found executor/subagent source unchanged. No moving worktree or runtime evidence was read. Package paths below start at `packages/`.

**Normative existing scope:** `docs/superpowers/{specs,plans}/2026-10-27-child-instruction-factory.md`, Stage B resident/assembly ownership and A2/A3/A4/A6/A7/A9; integrated Task4; accepted Stage A factory and private birth A. This packet refines those original lifetimes, not birth/G2 or a new execution capability.

## 1. Source facts and the compatibility correction

The earlier recommendation needs this concrete refinement before global wiring:

* `assembly.ts:1463` awaits `subagent.ready`. `registerSubagent` restores exact document views, then `sweepPendingInbox` schedules `driveFollowups` without awaiting the turn. The sweep itself can therefore finish while the drive runs.
* During the same assembly construction, `mountAgentTeams` awaits roster reconciliation and `mailbox.recoverRoot` (`agent-team/src/scheduler.ts:308–313`). Its real delivery commits/acknowledges the original target inbox and schedules `driveFollowups`, but does **not** await that chain (`scheduler/task-delivery.ts:85–89`). Its ACK remains independent of whether the child executes.
* Service `executionCallerAvailable` is false until its exact assembly appears in mounting/live ownership (`session-executor/src/service.ts:686`). `createSessionAssembly` must first return before `mountingAssemblies.set` at line 788. Thus allowing a new lease to bypass that gate during construction would introduce early authorization; simply enforcing the gate inside rebuild would fail an already-open original inbox generation.
* `driveFollowups` currently does status/result-source work and opens generation **before** rebuild (`subagent/src/followup/drive.ts:32–58`). Gating only `ensureResidentAgent` is too late.
* `entry.followupChain = next.catch(() => {})` is a scheduling barrier, not generation-cleanup acknowledgment. `openFollowupGeneration` currently owns generation/lifecycle/action only in local closures; its `finally` may release later dependencies despite an earlier close failure (`followup/generation.ts`). New cleanup must retain these original handles instead of treating the swallowed chain as success.

The minimal correction is an original activation handoff at the start of the existing drive, plus private retention of its existing generation cleanup. Do not run another restore, sweep, recoverRoot, launch, or original initial input. Existing scheduled drives wake from the same ticket, then independently revalidate their existing inbox/entry/generation proof.

## 2. Exact activation handoff

Add a narrow in-process type in `subagent/src/followup/activation.ts` and re-export its **type** through the normal subagent entry:

```ts
interface ResidentInboxActivation {
  current(): boolean;
  wait(signal?: AbortSignal, pendingStop?: AbortSignal): Promise<boolean>;
}
```

Only executor `lifecycle/resident-activation.ts` constructs the corresponding private host controller `{ticket, activate(): void, retire(): void}` with the original owner's synchronous `available: () => boolean` predicate. States are `pending → active` or `pending/active → retired`; no reverse transition, reset, replacement, timer or poll. `ticket.current()` is true only for active state and that same original available predicate. `activate` rechecks original availability, retires if it is false, otherwise resolves original pending waiters once; repeated activation never schedules another turn. `retire` synchronously fences subsequent waits and resolves pending waiters false. A waiter registers its settled-result/abort cleanup before listening; settlement removes both listeners and the pending record. No unbounded settled waiter history.

`wait` in active state returns false for an aborted external signal or false current(), otherwise true. The `pendingStop` signal is consulted **only while pending**: it belongs to the captured existing entry controller before execution. It cannot permanently prevent a later genuine turn after activation just because an older turn controller was aborted. In pending state either signal ends that waiter false; retirement ends every waiter false. At activation settlement recheck external signal and current() for each waiter; source availability never comes from the ticket's state alone. No result-source, fact action, generation, model, Agent, instruction reconcile, target observation or acknowledgment occurs in a ticket method. An active ticket schedules a recheck; it is not caller permission.

Exact forwarding:

| Seam | One value and owner |
|---|---|
| Service construction | Add `residentActivation` and optional original `assembly` fields to existing CreatingAssembly row. Create its controller before async construction with available() requiring that captured original assembly object, exact live-map equality, !closed/no closing/no failedClose and nonretired surface. Assign row.assembly only to the returned original; pass that same controller through both actual createSessionAssembly calls. Add no service registry/map. The row is construction retention only: ongoing availability never requires creating.get(id) to contain it. |
| Assembly | Capture supplied controller once. A direct standalone assembly creates and owns one local controller if none was supplied. Retain it in the existing assembly closure and dispose callback. |
| registerSubagent | Add optional `residentActivation?: ResidentInboxActivation` to RegisterSubagentOptions and named SubagentToolDeps; copy the exact read-only ticket, alongside exact `createInstructionContext`. Add `followupActivation?: ResidentInboxActivation` to RegisterSubagentResult for the existing Team forwarding seam. No ticket field in SpawnOptions/child birth DTOs, table snapshots or tools. |
| Normal followup tools/restore | Add optional `activation?: ResidentInboxActivation` and a pure `captureGeneration(entry,input)` port to FollowupDeps; the latter returns the original owner's retained scalar intent described in §5. `followupDepsWithRebuild(deps)` returns the exact ticket, capture function and original open function. Every existing normal drive already uses this helper. |
| Existing Team resident delivery | Add type-only `followupActivation?: FollowupDeps['activation']` and `captureFollowupGeneration?: FollowupDeps['captureGeneration']` to TeamSubagentDeps/RegisterSubagentResult. Assembly forwards those exact subagent values; task-delivery's existing wakeDeps assigns them to `activation`/`captureGeneration`. Team provisioning/fresh spawn receives no new instruction capability here. |

Inside the original serialized `prev.then`, select the original pending inbox metadata as today. For each original inbox, capture its owner's scalar intent **before** awaiting activation, but before result settlement, status/job mutation, `results.forSource`, new execution controller or opening a generation:

```ts
if (signal?.aborted || entry.closing || deps.table.get(entry.path) !== entry) return;
const intent = deps.captureGeneration?.(entry, ev); // original tuple/start/limits only
const pendingStop = entry.controller.signal;       // current pre-execution owner
const view = entry.session, owner = entry.factOwner;
const current = () => deps.table.get(entry.path) === entry && !entry.closing
  && entry.session === view && entry.factOwner === owner;
const replacement = new AbortController();
const off = deps.table.subscribe(() => { if (!current()) replacement.abort(); });
try {
  if (!current()) return;
  const gateSignal = signal
    ? AbortSignal.any([signal, replacement.signal]) : replacement.signal;
  if (deps.activation && !await deps.activation.wait(gateSignal, pendingStop)) return;
} finally { off(); }
if (signal?.aborted || entry.closing || deps.table.get(entry.path) !== entry) return;
// Revalidate same view/owner/inbox seq+messageId and unconsumed cursor.
// Continue only under the per-effect checks in §2a; waking is not admission.
```

Capture the entry controller's signal at waiter entry, not after an await. The private original intent record is retained if the wait ends without consuming that inbox; another scheduling attempt for the same exact inbox reuses its same scalar intent instead of resetting its clock. A later different legitimate inbox has its own original intent. Actual assembly drives always receive the ticket and capture port. Optional absence retains the existing standalone subagent/drive embedding contract; it is not an alternative path inside assembly. Do not add an absent-ticket fallback to another manager or caller permission.

The local table subscription uses the existing AgentTable.subscribe and is installed before a second exact-currentness check to close the check/subscribe gap. It aborts on original entry replacement/removal, original view/FactOwner replacement or closing. Its signal is part of gateSignal, so those events remain stronger even for an already active ticket; the old turn controller is kept separate in pendingStop and is ignored by an active ticket. Both the local listener and ticket abort listeners are removed on every exit. After the wait, require ticket.current() as well as the original entry/view/owner/inbox checks before effects. This is bounded waiter ownership, not a new event pump or Session registry.

**Service activation boundary:** after `assemblies.set`, lane installation, execution subscriptions and original assembly hooks (service lines 832–880), immediately before existing recovery scheduling, recheck `!closed`, no closing/failed-close entry, `assemblies.get(sessionId) === originalAssembly`, the same original construction row/controller and nonretired assembly surface. Without an await between that check and transition, call the original controller.activate. A hook that closes/revokes the assembly prevents activation. Do not activate merely at mounting-map insertion or before extension mount succeeds. Repeated callers of the shared original creation promise do not activate/sweep again.

Successful creation removes the CreatingAssembly row normally (`service.ts:894`). The captured assembly object/controller survives in the original assembly closure; ticket.current() thereafter uses its exact live assembly ownership and original caller gates, not continued presence of a construction row. A legitimate second inbox after creation fully resolves and the row disappears is a required positive.

`revokeSession`, close of a creating row, construction catch, extension/mount failure, assembly.revokeNewWork and assembly.dispose retire the original controller **before** awaits. Before the assembly retains dispose, the row itself retains the ticket; afterward the same existing cleanup callback remains authoritative. After successful ownership transfer, assembly's closure retains it. A rejected creation keeps its original row/cleanup debt and a retired ticket; retry close cannot reactivate it. Creating a later legitimate assembly is a different existing construction operation, not a replay of this ticket.

**Standalone boundary:** a locally owned controller's available() requires a local construction-complete flag plus the original `executionCallerAvailable` when supplied, disposal and surface-retirement checks. Set the flag and activate only after this same createSessionAssembly has completed main Agent, subagent data readiness, Team mount and all construction work, immediately before returning its actual assembled handle. If unavailable, retire rather than authorizing an early drive. A supplied service controller is never activated by assembly. The absence of a service controller selects the existing direct-constructor ownership boundary, not a parent-permission fallback.

**No construction self-wait:** restore readiness and Team delivery continue to await their original data/ACK obligations only, never a ticket waiter or child turn. The existing drive remains fire-and-forget and its original chain is retained. Team partial cleanup sets entry.closing and aborts its captured controller before joining the chain, so pendingStop resolves the held drive false without waiting for assembly publication. Assembly failure retires the global ticket before child joins. No activation-time call to sweep/recoverRoot is added.

## 2a. I1 — one captured predicate before each new effect

Each original per-inbox execution record captures one `executionCurrent(): boolean`, not a second authority. It closes over the original ticket reference, entry/path, view, FactOwner, immutable inbox event/seq/messageId, retained scalar intent and original external signal. It requires ticket.current(), same table entry/view/owner and owner.view, !closing, the same original inbox still present, and an unconsumed cursor until this execution owns dispatch. Before admitting a new turn controller it ignores the older entry controller's aborted signal. Once this execution has installed its own captured controller, it also requires exact entry.controller equality and that controller not aborted. Once an Agent is selected, require the same original Agent registry binding before dispatch. The predicate is for this original execution admission; never bind the installed Session instruction lease permanently to a turn controller.

Latch original operation records and immediate fulfillment/rejection observation **before** invoking each original method, including synchronous observer callbacks. A currentness refusal before admission creates no operation. If currentness becomes false while an admitted operation is suspended, deny subsequent new work without canceling that operation's ownership: await/join its original result, retain every late returned handle before checking currentness, and settle it through its original cleanup. Never call the source/generation method again to replace a late result. Cleanup and already-issued settlements do not require executionCurrent() to become true again.

| Ordered stage | Required same-predicate check and admitted-original rule |
|---|---|
| Prior result settlement | Capture the exact previous resultCapture handle, register its original settle operation, and await it. Retiring during that await does not skip or replay its settlement. Immediately after the await, recheck executionCurrent before any new controller/status/job/source effect. Preserve a raw falsey settlement rejection and any original cleanup obligation. |
| Running/controller publication | Check immediately before installing this execution's captured controller and running status. Retain that local controller/abort listener before callbacks. After table.update returns, recheck because table listeners can synchronously revoke/replace. Check before job-running publication, then again afterward for its callbacks. A false update or retirement prevents all later admissions. Never reset a stronger closing/retired state. |
| Result-source acquisition | Check immediately before one original `resultStore.forSource(undefined, executionCurrent)` call. Register the original promise before calling it. On fulfillment retain that exact TaskResultStore in the execution record **before** rechecking. On false currentness do not open generation/rebuild/dispatch or call forSource again. TaskResultStore exposes no close method; join the admitted acquisition and retain its returned descriptor for original capture/cleanup obligations rather than inventing disposal. |
| Generation/action opening | Check before the openGeneration call. Forward the same executionCurrent predicate and retained intent into the existing helper. Inside that owner, check after awaited childFactOwner acquisition and before each **new** beginAction, lifecycle-factory and lifecycle.open call; latch returned action/lifecycle before each next check. After awaited open returns, retain the original generation handle before rechecking. A late generation is closed on the original record without rebuild/model dispatch, a second open or a renewed clock. An open rejection retains partial handles for §5's body-exit cleanup. |
| Resident rebuild | Check immediately before rebuild, and pass the same predicate for its pre-admission checks after model resolution/CodeMode.ready and before factory/setup/Agent publication. Those checks are in addition to existing lifetime checks, not another owner. Retain handles returned by an admitted factory/mount before refusing later work. After the awaited rebuild, recheck before selecting/registering any further binding or status transition. |
| Final status and model admission | Check before any needed running-status publication, recheck after callbacks, then immediately before the original cursor claim and Agent.followup call. The original cursor assignment and call are one synchronous dispatch-admission block. Latch an own-dispatch flag before assigning lastInboxSeq; thereafter currentness recognizes this execution's own consumed cursor instead of falsely treating its claim as another owner. No await/callback may intervene between final currentness and claim/call. |

The existing usable source port is `TaskResultStore.forSource(context?, current?)` (`subagent/src/task/result.ts:19`). `createTaskResultRetention` captures that callback in the bound store and combines it with its own native result-scope rules (`session-executor/src/lifecycle/task-result-retention.ts:14–17,28`). Pass `undefined` for context because this is the genuine inbox driver, not a fabricated ToolExec. The adapter may await sourceFor(parentSessionId); it does **not** itself revalidate after that await, so the caller's post-return check remains mandatory. No adapter, Core/B1 or source-authority rewrite is needed.

After actual Agent dispatch, its already-admitted result, physical handoff, resultCapture, publication and generation-close obligations remain owned even if ticket/currentness later retires. Run their original settlement/cleanup rules; do not use this new-work predicate to drop debt, synthesize success, reissue a source/capture or overwrite a replacement entry. Native source-currentness rules may truthfully refuse a **new** artifact admission after retirement; they do not authorize replacing an original capture. Original outcomes/falsey failures and unresolved settlement handles remain recorded separately.

Before dispatch, a currentness refusal—or a late source/open/setup rejection after retirement—takes a retained no-further-admission exit. Preserve its original raw outcome and cleanup records; do not fall through the old generic catch into a new captureChildResult/artifact acquisition or new status/job publication. An already-admitted previous result settlement still completes on its own original handle. Already-published running metadata or other earlier effects remain truthful history; no rollback, cursor claim or fabricated executed result is added. After dispatch the existing original-outcome settlement path remains responsible as stated above.

## 3. Exact instruction capability and availability

Create one existing `createChildInstructionHost` after main manager creation. Its captured host predicate is `!disposing && !executionSurfaceRetired && opts.executionCallerAvailable?.() !== false`. Preserve original environment, cwd, authority, root view/FactOwner/manager. Replace only assembly's parent-only fs callback with lazy host.observe; before host construction return unavailable/mapping-unavailable. No root fallback, instruction text copy, hook or manager replacement.

Forward `host.create` unchanged at assembly → RegisterSubagentOptions → the named SubagentToolDeps. Capture that function once at the actual resident invocation. An executor-connected invocation cannot silently lose it or substitute a no-op. Do not forward it into unchanged fresh spawn/Team provisioning/reviewer paths in this slice.

Pure eligibility without executionController and an already registered warm Agent retain their existing early returns and allocate no instruction resources. At actual rebuild, after exact childFactOwner and original childCtx acquisition, acquire the lease synchronously before model/setup work can expose an Agent; store the handle immediately. Its input captures the actual view, original FactOwner and a record-owned dynamic availability function. Never derive authority from IDs.

The record's predicate is:

* owner not retired; record phase preparing or installed; not permanently retired; the same supplied activation ticket.current() remains true;
* same original table entry at original path; `entry.session === capturedView`; `entry.factOwner === capturedOwner`; capturedOwner.view is that view; entry not closing;
* preparing: this original setup owns the record; no Agent-registry check yet;
* installed: same exact Agent in agents.get(capturedSessionId), same installed child registry and own dispose closure, with the same entry/view/FactOwner.

The accepted host independently checks the original assembly caller predicate. Do not transiently set that predicate true for construction. Check the original executionController signal before acquisition/publication to refuse an interrupted setup; do not include its signal/controller identity in installed Session lifetime. Later legitimate inbox turns replace the turn controller while retaining this lease.

Pass exactly `lease.requestContext` to createAgent. No instructions in inheritedSystemContext or role prompt. The rebuild receives the driver's same captured executionCurrent predicate (§2a), checks it before each new setup effect and after model resolution/CodeMode.ready, and checks again before createAgent/local registration/publication. Retain late returned original handles before refusing later effects. The installed lease uses the Session-lifetime predicate above, never the per-turn executionCurrent closure. Do not call requestContext.current(undefined) or fabricate evidence during setup: actual Agent reconciliation owns that evidence later. Register and table-patch synchronously with no await between final check and installed phase. Record the actual Agent before registering so synchronous observer reentry has an original handle. Refusal/failure never overwrites a replacement Agent/entry. No forced eviction of a warm fresh-spawn Agent.

Exact publication/reentry rule: preserve the early installed own-dispose closure, register only the captured Agent, set the private installed phase before invoking the table's synchronous patch, and omit the existing `closing:false` patch (never reopen an entry). The patch installs original registry/model/result-lifetime fields, then existing table observers may run. Recheck same entry/view/owner/Agent, own installed phase, !closing and ticket.current() after that callback boundary before returning true. A synchronous close/replacement wins; never overwrite retired phase afterward. If publication refuses, remove only this exact Agent if still owned, retain the original record/cleanup, and return/throw through original driver ownership. Repeat this retire check after other callback/acquisition boundaries and retain any late returned handle before refusing it.

## 4. Minimum private cleanup owner, not a second runtime registry

An installed entry.dispose closure alone is insufficient: setup can fail before it is installed; table removal/replacement can lose it; a swallowed followupChain loses close failure; a late resource acquisition may arrive after a dispose snapshot. Add one cohesive private `followup/resident-lifetime.ts` owner, associated with the **existing exact named SubagentToolDeps object** via a module-private WeakMap. The owner retains only a finite Set of actually admitted setup/producer records and current close flights. It never selects Sessions by IDs, grants execution, stores text, creates an Agent or persists anything. No new table field, snapshot, general service or result store.

`residentOwnerFor(deps)` is the single association used by actual rebuild, original generation helper and registerSubagent disposal. No parallel optional owner path. registerSubagent.dispose creates/retrieves and retires that same owner synchronously before its first await, so a late restore cannot create a fresh live owner. Its close snapshots admitted records after retirement, joins late acquisitions already registered, and attempts independent records with allSettled. Keep records until every obtained dependent resource acknowledges; a removed entry cannot remove its cleanup record. Successful record removal is cleanup bookkeeping, not a new capability.

Each setup record is admitted **before** fallible scope/mount/factory work. Capture original entry/view/FactOwner and original callbacks once. Fields are phase preparing/installed/retired/closed, setup-exit barrier, obtained ctx/registry/CodeMode/lease/Agent handles, immutable own dispose/cancel/unmount closures, phase acknowledgments, one observed attempt/result and explicit failure occurrence/delivery values. Handles become permanently absent only after setup exits. Preserve raw undefined/null/false/0/empty-string failures via `{occurred:true,value}`, never truthiness/equality.

If accepted host.create throws without returning a lease, the caller does not fabricate a lease or call create again to recover it. Its failed slot/obtained runtime/manager cleanup remains with the original host and is joined by host.close. Accepted construction performs no source action/render/reconcile and receives no childCtx; `createRuntimeContextSource` acquires its FactOwner action only on a later render, and runtime.close with no publications performs no document action. Consequently the caller can settle its **separately obtained** generation/CodeMode/context after failed setup without inventing a per-slot cleanup API; it must still retain the original environment/host and fail overall assembly disposal until host.close acknowledges every failed slot. A returned lease instead remains caller-owned and must acknowledge before its dependent document/context is released.

Install the record's dispose closure on the same entry before its first suspended setup operation, so ordinary close reaches the in-progress original. This is not Agent publication; do not install a running Agent/registry/model until setup succeeds. On an unexpected existing disposable owner, join/refuse its original cleanup rather than overwrite it. On failed preparation leave the record retained even if its table entry is gone. When all preparation-only resources acknowledge, clear an own temporary dispose field only if the same entry/field is still current; never clear another owner.

Before invoking fallible original setup/cleanup methods, install their operation/flight and result observers. Use the accepted factory's original-invocation/self-join pattern (a private AsyncLocalStorage guard is sufficient): reentrant close from its own setup/close first retires and returns an immediately observed local rejection, not a wait on itself. External concurrent close joins the same attempt. A rejected attempt clears only its attempt marker after result observation; it retains original handles and successful phase flags for one later same-owner retry.

## 5. Retain actual original generation acknowledgment

Refine `followup/generation.ts`'s existing owner; do not add generation-open authority. Add the pure `captureFollowupGenerationIntent(deps,entry,input)` used by the capture port, and accept its exact retained intent as the fourth argument of FollowupDeps.openGeneration (forwarded as an extra final argument to the internal openFollowupGeneration helper). The private owner admits a record keyed by exact original entry/view/FactOwner and inbox seq+messageId before waiting. That record captures `start:{wall:Date.now(),monotonic:performance.now()}`, optional modelActionTimeoutMs and optional modelActionMaxAttempts once; preserve absence and do not synthesize another default. Capture uses only the already-restored in-memory tuple/scalars; it performs no document open, action, generation, result/body/source read or model resolution. Repeated capture of the same unconsumed original inbox returns the same record/intent. No prompt copy or ID-based Session lookup.

Exact internal type edges (no RPC/schema fields):

```ts
interface FollowupGenerationIntent {
  readonly start: { readonly wall: number; readonly monotonic: number };
  readonly timeoutMs?: number;
  readonly maxAttempts?: number;
}
// FollowupDeps additions/refinement:
captureGeneration?: (
  entry: ChildAgentEntry,
  input: Extract<SessionEventView, { type: 'subagent/inbox' }>,
) => FollowupGenerationIntent;
openGeneration?: (
  entry: ChildAgentEntry,
  input: Extract<SessionEventView, { type: 'subagent/inbox' }>,
  controller: AbortController,
  originalIntent?: FollowupGenerationIntent,
  executionCurrent?: () => boolean,
) => Promise<FollowupGeneration>;
rebuild?: (
  entry: ChildAgentEntry,
  controller: AbortController,
  executionCurrent?: () => boolean,
) => Promise<boolean>;
```

Freeze the intent and nested start object; its private owner association provides original identity. Capture in the instruction-integrated population requires the restored entry's already-verified exact FactOwner. It never calls childFactOwner to manufacture that prerequisite during a wait. The existing direct helper's no-prior-capture embedding branch can obtain its original owner normally, but cannot be selected by an actual assembly drive to bypass this capture/wait sequence.

Actual subagent and Team closures forward the exact executionCurrent function to both openGeneration and rebuild. RegisterSubagentResult.ensureResident/TeamSubagentDeps.ensureResident accept the optional third predicate, and ensureResidentAgent receives it as the optional fourth argument; actual integrated calls always provide it. This is the same original new-work validation, not another permission. Standalone embedding signatures remain optional-compatible.

The intent is an in-process original-owner handle, not caller-provided scalar authority. Opening verifies that exact record against the same original tuple/view/FactOwner before issue, stores the actual execution controller and then obtains original action/lifecycle/generation handles immediately as they return. Scalar-identical copies cannot replace the owner record. For a standalone direct helper call without an earlier capture, its existing genuine invocation captures once immediately; actual assembly/Team flows always pass the retained record. The same record supplies returned FollowupGeneration.close; registerSubagent's private owner can join/retry that same cleanup even if open/setup throws before a public handle is returned.

Pass the record's original start/timeout/maxAttempts to the existing generation lifecycle.open unchanged after activation. Waiting cannot replace Date.now/performance start, extend expiry, restore attempts or create a new origin/action after an existing one closed. The existing lifecycle's persisted same-origin start/expiry/attempt constraints remain authoritative and may tighten the effective bounds. If activation arrives after the original time budget, the original generation fails truthfully with zero physical model issue; no fresh budget is allocated. Remove a clean producer/intent record only after its original inbox is consumed or permanently fenced and all obtained resources acknowledge; do not discard an unconsumed pending intent merely because a waiter ended.

### I2 — body exit, generation cleanup and raw drive are distinct

Name three separate observations on the original retained record: **bodyExit** (this inbox's execution body and original catch/result-settlement work have exited), **generationCleanup** (generation/lifecycle/action phases acknowledge), and **rawNext** (the full original drive including all finally work). `entry.followupChain` remains a caught serialization wrapper around rawNext; neither it nor bodyExit is a cleanup acknowledgment.

Before any ticket/settlement/source/setup callback can run for an inbox, internal `beginFollowupExecution(originalIntent)` admits its private execution-attempt record and installs an observed bodyExit deferred latch, independent cleanup-flight slot and explicit outcome fields. Associate it with that original intent/entry/view/FactOwner/inbox; do not publish a new task or open a generation. The same raw drive flight is registered/observed before scheduling the prev.then callback. The producer owner and helper access this exact private execution record; no ID lookup or copied scalar object selects it.

The driver wraps **all** per-inbox paths—including activation false/throw, prior-settlement rejection, source/generation/rebuild refusal and existing result-publication catch—with an outer finally that synchronously resolves bodyExit once **before** invoking/awaiting generation cleanup. Preserve raw falsey body outcome with an occurrence flag. Its normal structure is:

```ts
const execution = beginFollowupExecution(originalIntent); // latch before callbacks
let generation: FollowupGeneration | undefined;
try {
  // §2/§2a checks and existing body/catch/result-settlement work;
  // every admitted late handle is retained on execution before a recheck.
} finally {
  execution.exitBody();             // monotone, synchronous; never waits
  detachOriginalAbortListeners();  // existing owned listener cleanup
  await (generation ? generation.close() : execution.closeGeneration());
}
```

`exitBody`, `closeGeneration` and their handle are package-private owner operations, not new FollowupDeps/tool/RPC capabilities. Returned FollowupGeneration.close delegates to that exact execution.closeGeneration. The fallback above handles partial open/setup failure when the helper never returned a generation wrapper: obtained action/lifecycle/late-generation handles were already retained on execution. It is not another open or replacement cleanup owner.

**Acyclic normal close:** execution.closeGeneration installs/observes one flight before callbacks; that flight may wait for bodyExit and the original opening operation to exit, then performs generation.close → lifecycle.drain → action.finish. It must **never** await rawNext, entry.followupChain, the resident full-dispose promise, or a callback that awaits this cleanup. Since the driver's finally resolves bodyExit first, a successful ordinary inbox completes its cleanup and rawNext without external disposal. Concurrent external disposal joins this same flight rather than reinvoking an original phase.

**External disposal:** retire/cancel original producers first; await bodyExit (and original setup-exit/opening records), then join that same generationCleanup flight. Capture its fulfilled/rejected result without skipping later independent joins. Observe/join the record's **captured original** rawNext only **after** generationCleanup has terminated, even when cleanup rejected; never chase the mutable entry.followupChain. Treat the raw/caught serialization outcome as history, not acknowledgment or a reason to rerun cleanup. Then join independent CodeMode/result obligations, aggregate current failures and release dependent instruction/document/context only after their required acknowledgments. A still-pending original source/open/body cannot be replaced by timeout or guessed completion; disposal retains and waits for that original.

**Setup/open failure:** a resident setup failure records its original outcome and admits an immediately observed deferred cleanup; it returns/throws to the driver without awaiting its own bodyExit/rawNext. The driver's existing body/catch work can unwind and signal bodyExit. The same closeGeneration then drains partial obtained handles; no generation.open retry. An original open rejected before a generation handle existed still retains lifecycle/action and closes them in phase order after bodyExit/opening-exit. A callback reentering full dispose from its own active setup/open/cleanup is handled by the existing local self-join rejection guard; that guard does not replace the ordinary acyclic order.

Record success only after each original resource acknowledges. A failed generation close retains lifecycle/action; failed drain retains action; successful phases never replay. Concurrent close joins the installed flight. A rejected attempt is retained and observed; a later explicit same-owner dispose attempt may retry remaining phases once, with bodyExit already settled, without joining rawNext from inside finally. No new start, origin, action, generation or execution reentry. Keep primary body/open outcomes and cleanup occurrences separately, including undefined/null/false/0/empty string; an already-delivered historical primary does not become new debt or duplicate result publication, and a recovered cleanup acknowledgment permits success without replaying successful phases.

A new metadata-only body attempt for a still-unconsumed original inbox can reuse the retained scalar intent only when the owner proves that the earlier attempt admitted no operational source/action/generation and has no cleanup debt. Once an original source/open was admitted, retain/join its original record; do not create a replacement attempt to escape its rejection or renew its clock. Normal completed producer records leave the finite Set only under the consumed/permanently-fenced rule above; the installed Session lease remains live for later distinct genuine inbox turns.

## 6. Retirement and phase cleanup

Ordinary interrupt/cancel aborts the current turn and uses existing CodeMode cancel; it does **not** retire instructions, close the Session or reset generation floors. Permanent entry dispose, entry replacement, assembly retirement or original owner shutdown synchronously retires the instruction lease and denies new setup/capture/reconcile/observe before awaits. Already-issued retain/succeeded/pin release remain the accepted lease's responsibility.

| Phase | Preparation failure | Permanent dispose | Retention / dependency rule |
|---|---|---|---|
| Fence | Retire this failed lease/record; do not revoke borrowed document or invent permanent Session close | Set own permanent retirement and closing; revoke the original managed document; abort original/current entry controller | Never mutate replacement entry/document. |
| Original operations | Let setup exit and observe original result; return to driver so its outer finally signals bodyExit | Join admitted setup/open/body-exit records; full rawNext is a later observation | A setup failure admits observed deferred cleanup without awaiting its own bodyExit, full drive or dispose flight. |
| Producers | Cancel/dispose obtained CodeMode; retain failures. After bodyExit join the exact generationCleanup | Cancel original producers; await bodyExit, join same generationCleanup; then observe rawNext and original result/CodeMode obligations | Attempt independent siblings despite failure. Returned generation.close never waits rawNext/followupChain. No dependent release before acknowledgments. |
| Instructions | Close exact lease after producer obligations; no new render | Same | Runtime→manager ordering remains inside accepted lease. Pending/failed close keeps lease and dependencies. |
| Document | Keep coordinator-owned restored document open for existing owner | Close original managed document only after producer+instruction acknowledgment | No ID-based reopen/replacement to clear debt. |
| Context | Unmount exact original childCtx only after preceding owned dependencies acknowledge | Same, after document acknowledgment | Own unmount wrapper retires and admits observed close; never expose raw scope unmount as a bypass. |
| Final | Remove clean preparation record / own temporary closure | Remove clean record; existing caller may remove table/Agent only after disposal success | Repeated dispose joins in-flight or retries remaining originals once; historical reported errors never poison recovered success. |

On failed preparation, defer cleanup and return to the body; do not await bodyExit, current entry.followupChain or full rawNext inside ensure. On permanent external dispose use the exact §5 order; returned generation.close itself never waits the full drive that is awaiting it. A raw falsey primary failure and independent cleanup failure remain distinct in aggregate/cause evidence. Do not synthesize successful cleanup from bodyExit, fulfilled catch wrappers or reported history.

Actual CodeModeMount.dispose is a complete original producer barrier: `code-mode/src/register.ts:147` itself cancels runtime, disposes broker, closes facts and disposes runtime before acknowledging. Attempt it even after a separate cancel failure. Its genuine acknowledgment makes that mount clean; an earlier cancel occurrence is delivered once and is not permanent remaining resource debt or a reason to invoke the successfully disposed mount again. A failed dispose retains the exact mount for retry. No CodeMode implementation change is required or permitted here.

`registerSubagent.dispose` keeps its existing entry/source/task persistence obligations. It retires the private owner before awaits and invokes owner.close even when ready, an entry resultCapture or another disposer rejects. All siblings receive an attempt. Record successful persistence/close phases; failed originals stay retained. Fresh/nonparticipating entry behavior is a regression obligation, not fresh instruction support. The new owner's final join is independent of membership captured from the mutable table.

## 7. Assembly root barrier and service cleanup

Assembly's stable original dispose function and a private observed dispose flight survive every retry; keep successful phase acknowledgments outside individual attempts. `retainConstructionCleanup(dispose)` remains registered before fallible environment/mount work. Add no replacement cleanup callback/assembly after failure.

1. Synchronously retire original activation ticket and instruction host alongside retireExecutionSurface/new-work revocation; set disposing before awaits. This fences late factory create and held drives while preserving already-issued settlements.
2. Cancel/join existing background jobs, root CodeMode, participating children/private resident owner, Team handles and existing process producers. Attempt independent siblings, mounts, source/task flushes even if another fails. Retain each original handle and acknowledgment. A successful CodeMode cancel/dispose or child/Team cleanup is not reinvoked because a later phase failed.
3. Only after required producer acknowledgments call original instructionHost.close; it joins finite root mappings, admitted cleanup flights and remaining child contexts. Calling it while a failed producer still needs that child runtime would release dependencies early. Host retirement already fences new work during a failed barrier.
4. After host barrier succeeds, close original root runtime, then original main instruction manager. Close original root document only after producer and context/publication dependencies acknowledge. This preserves root runtime→manager and does not release storage through unknown publication.
5. Close an assembly-owned environment only after host/root contexts and dependent document cleanup acknowledge. A supplied shared environment is always borrowed: assembly never closes it. Release result-store lease only after the original producer/router/runtime/manager/document barriers acknowledge. A barrier failure leaves dependencies retained for the original dispose retry.

The private acknowledgment state covers exact original root/host/runtime/document/environment/store and process cleanup phases touched by this change; do not build a general disposal service. On retry, attempt only remaining originals and aggregate current failures, including falsey values. Service's creating row or owned assembly remains retained until this same dispose succeeds. Gateway/service shared environment shutdown retains its existing order: original router/fork-controller/service joins precede environment/coordinator release. No C31 source, result permission, binding observation, source-capture or target-preparation change.

## 8. File plan and reviewable steps

The original narrow source list is insufficient for compatibility. Root must reserve this coherent expansion if it releases implementation:

| File | Exact responsibility |
|---|---|
| executor `src/lifecycle/resident-activation.ts` (new), `src/service.ts` | One pending ticket on existing CreatingAssembly row; exact live publication activation; early close/failure retirement. |
| executor `src/assembly.ts` | Capture ticket; true standalone completion; existing host construction/router/factory forwarding; original retire/dispose dependency barrier. |
| subagent `src/followup/activation.ts` (new), `src/followup/drive.ts` | Read-only ticket type and pre-effect wait; no new execution lane or generation semantics. |
| subagent `src/index.ts`, `src/tools/types.ts` | Exact factory/ticket value forwarding; restore remains data-ready without waiting turns; same private owner disposal; type export/result ticket forwarding. |
| subagent `src/followup/resident.ts`, `src/followup/resident-lifetime.ts` (new) | Preparing/installed lease availability, requestContext installation, finite original cleanup owner and record phases. |
| subagent `src/followup/generation.ts` | Retain original generation/lifecycle/action acknowledgments through open/close failure; no new open/retry authority. |
| agent-team `src/scheduler.ts`, `src/scheduler/task-delivery.ts` | Type/value forwarding of the same ticket, retained-intent capture and executionCurrent argument into existing wakeDeps/rebuild only. Preserve target append/required ACK, partial membership and original recoverRoot once. |

No core, B1, CodeMode implementation, fresh child, reviewer, birth codec, L1/V3 or public fork source edits. No table snapshot or persistent state change. Direct B1/CodeMode writer collision remains absent; service/assembly/index/Team seam requires one reserved caller owner and immutable combined-source review.

- [ ] **R1 — activation compatibility controls and ticket integration:** add failing actual service restore/Team construction and I1 post-wake revocation controls; implement only the ticket, same-predicate forwarding and pre-effect checks; prove no pre-effect drive before live publication, no effects after a later retired gap and no construction self-wait. Review this source boundary before claiming it solves readiness.
- [ ] **R2 — original producer/setup cleanup retention:** add private lifetime/generation failure and I2 successful-normal-finally/concurrent-dispose controls with exact original handle counts/falsey values; implement explicit bodyExit, shared generationCleanup, phase ownership and repeated close. Preserve source/generation semantics; no rerun of initial or closed delegated origin.
- [ ] **R3 — accepted factory production consumer:** install host/router and exact resident requestContext; prove real cold resident targets, actual broker and physical handoff with R1/R2 in place. Scope remains reconstructed residents and subsequent legitimate turns.
- [ ] **R4 — root/child disposal integration:** qualify held original publication/mapping/producer, service creating-row and shared-environment retry paths; successful phase counts remain once and siblings attempt cleanup.
- [ ] **R5 — scoped verification and fresh review:** use approved runtime/six fresh IH roots/named files and affected typechecks from the existing plan; preserve exact source/commands/exits/RED/setup/cleanup evidence. No commands have run in this design task. Review complete fixed range and source composition before integration.

## 9. Frozen actual test populations

Create executor `test/resident-instruction-activation.test.ts`, `test/child-instruction-consumers.test.ts`, and subagent `test/resident-instruction-lifetime.test.ts`; extend actual `resume.test.ts`, `followup-settlement.test.ts`, service close controls and Team lifecycle/ACK controls only where causal. Reuse source-owned fixture patterns, not historical runtime roots.

| Case | Actual fixture and decisive oracle |
|---|---|
| Pending inbox at cold service restore | Genuine JSONL child document and saved waiting state, original inbox seq/messageId/lastInboxSeq. Suspend construction after restore/Team ready. Actual service must finish original data readiness with zero resultStore.forSource, status-running mutation, generation/source/Agent/model/instruction action before publication. Release exact publication; same queued drive executes once under same inbox tuple. No second restore/sweep/callback. |
| Close/partial failure before publication | Hold extension/mount/restore acquisition in separate controls. Revoke same service row/assembly or Team partial child before joining. Ticket/entry abort resolves held drives false; no result/source/generation/model action or inbox cursor advance. Same row and handles retained through cleanup failure; successful retry never activates failed ticket. Team original target ACK remains once. |
| Publication identity and clock | Hook closes/replaces/revokes original during publication; repeated awaiters of same creating promise; extension throws literal falsey value. Only exact original live assembly/controller opens once; no early mounting permission, replacement borrow or lost primary error. Hold publication past captured timeout, mutate configured timeout/attempt values while held, and reschedule the same unconsumed tuple: its identical original scalar intent/start survives; no physical issue or renewed expiry/attempt floor. Direct standalone positive activates at actual completed constructor only; false caller predicate stays fenced. |
| I1 prior-result gap and callbacks | Through actual service/assembly drive, hold the genuine previous resultCapture.settle after activation, revoke that same assembly while its entry is still present/open, then release the original settlement. It is joined once; zero subsequent running/job-running transitions, forSource/action/generation/rebuild/Agent/model work and cursor advance. Separate synchronous table/job observer retirement controls prove no next-stage effect follows those callback gaps. |
| I1 late source/open | Hold actual forSource/sourceFor after its one admitted call; verify it receives undefined ToolExec and the exact executionCurrent callback, retire, then return the original bound store. Retain/join it with no invented close and zero second acquisition/new generation/model/cursor claim. Separately hold lifecycle.open after original acquisition, retire and release original open: same returned generation/action/lifecycle are latched and closed/drained/finished once, including partial-open rejection; no replacement open, rebuild, model dispatch, generic not-dispatched artifact capture or renewed scalar intent. |
| Real resident consumer | Cold restore, then actual pending or newly queued inbox through registered tools/service. Capture factory inputs by observing actual function, not injecting an alternate consumer. Exact document.view/FactOwner, one lease, requestContext before first real Agent request. Zero new initial admitted input/initial invocation/run. Saved running/error/killed automatic sweep and pure probe create no lease. Warm fresh-spawn Agent still bypasses rebuild and earns no instruction credit. |
| Actual fs and broker | Real assembly inherited read/list objects, two disjoint reconstructed residents plus parent; direct tool and actual child code_exec broker. Only exact prepared child view activates its own targets. Parent/sibling state unchanged. Invalid page/failed read, clone/same-ID/foreign view/text never selects a manager; role without read/broker grant remains denied. No extra tool/model floor. |
| Physical acceptance | Use the existing Stage A real `createOpenAICompatibleClient` + fixture-owned loopback HTTP/SSE receipt pattern from `child-instruction-lifecycle.test.ts`, now through actual service/assembly/resident path. Controlled responses first perform real read/list, then inspect next request's current child rules. Only actual accepted physical handoff consumes that resident's pending target. Failed exchange/render/summary/READY does not. Local controlledModel is sufficient for no-launch/activation counts, not physical receipt acceptance. |
| Interrupt and permanent retire | On the newly rebuilt resident, interrupt real turn then send a different genuine inbox message; same lease stays live, distinct original per-turn generation/clock/limits. Active-ticket wait ignores the earlier turn's aborted pendingStop signal, so the new legitimate inbox runs; an actual pending-construction waiter is canceled by its own captured preactivation controller. Ticket retirement/entry replacement remains stronger, wakes/joins original pending waits and prevents model issue. Permanent close/replacement immediately fences new reads/reconcile while issued physical handoff/pin releases settle on original handles. |
| Setup and generation debt | Suspend/fail ctx mount, factory return/throw, CodeMode.ready, createAgent/registration, generation.open/close, lifecycle.drain, action.finish and unmount separately. Test undefined/null/false/0/empty string primary plus independent cleanup failure. No partial Agent/lease publication; caught followupChain is not accepted as acknowledgment. Closed generation is never opened again; failed source drain keeps same action. |
| I2 normal finally and concurrent close | A real successful inbox turn completes bodyExit, generationCleanup and rawNext without external disposal. Hold its exact generation.close: bodyExit is already fulfilled while rawNext stays pending. Concurrent external dispose joins that one close flight; close/drain/finish counts stay one until acknowledgment. Full rawNext/followupChain is absent from the returned-close wait graph. A second genuine inbox after CreatingAssembly row removal still runs on the same live ticket/Session lease. |
| I2 partial-open/setup failure | Reject open before returning its wrapper, or fail resident setup with the original generation retained; include raw falsey primary values and a held/rejected close/drain. Body exits before deferred cleanup joins it, partial handles are available even with generation undefined, and dependent lease/document/context stay held. Normal finally/external dispose share the same failed flight; a later explicit retry runs remaining original phases only, never waits full rawNext from inside its finally and never reopens a generation. |
| Finite joins and retry | Remove/replace an entry while exact original cleanup is pending; host slot cleanup removes its own slot during snapshot; sibling throws; concurrent/reentrant dispose. Root/private owner still joins original records, successful phases count once, dependent document/context/environment/store stay held; same-owner acknowledgment later permits success without historical error poisoning. |
| Original scope regressions | Relevant main-instruction policy/freshness/targets/read-scope/publication/lifetime/service-close, accepted Stage A factory/router/lifecycle, Team partial/required ACK/Stop and O1 execution-surface retirement. Actual inherited-results/fresh/Team provisioning/reviewer/isolated support remains uncredited. |

All runtime/server/test roots and commands require later root assignment. This packet freezes design and tests; it supplies no new G2 launch, source/model permission, all/N/V3/default capability, release claim or implementation authorization.

## 10. Fix1 response for the same reviewer

| Review item | Candidate correction | Decisive controls / remaining disposition |
|---|---|---|
| I1 — post-wake new effects | §2a defines one captured per-execution predicate, checks after prior settlement and each awaited acquisition/rebuild, before and after synchronous status callbacks, and immediately before cursor/model admission. Existing forSource(undefined, current) carries the same callback; generation/rebuild forward it without inventing authority. Late admitted handles are retained before checking; predispatch retirement avoids new generic artifact/status work while original settlement debt remains owned. | §9 “I1 prior-result gap and callbacks” and “I1 late source/open”; future actual service controls must count original calls/handles and prove no late new effect or cursor claim. This is a design response, not a runtime PASS. |
| I2 — raw-drive/close cycle | §5 names bodyExit, generationCleanup and rawNext separately; driver latches body exit before normal finally invokes close. Returned close waits only body/opening exit and original resource phases, never the raw drive/followupChain/full dispose that awaits it. External and partial-failure cleanup order is explicit and shares the same observed flight/remaining-phase flags. §6 table uses those same barriers. | §9 “I2 normal finally and concurrent close” and “I2 partial-open/setup failure”; future successful ordinary turns must finish without external disposal, with exact close-flight counts, retained partial handles and falsey errors. Same-reviewer disposition remains required. |
| Creation-row lifetime clarification | §2 explicitly permits normal creating-row removal; ongoing ticket availability is the exact captured original live assembly/controller and caller gates. | A legitimate second inbox after row deletion is an explicit I2/activation positive; no permanent construction-row requirement. |

Only this candidate and its exact pre-fix1 preservation copy were written for the correction. Readiness report and original independent review are unchanged. No product code or runtime evidence was changed, and no implementation is released by this response.
