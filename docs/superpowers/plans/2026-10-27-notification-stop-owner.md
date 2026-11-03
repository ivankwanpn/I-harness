# Notification Stop owner and Team candidate admission — implementation spec + plan

> Same-reviewer design PASS; root approved bounded Tasks1+2 implementation on 2026-10-27. Original design/review packets remain unchanged. Task3 actual-service qualification is released separately after code review.

**Goal:** Coalesce the actual original service Stop and prevent uncaptured Team candidates after native revoke, including accepted runs delayed by a lane or child acquisition.
**Architecture:** Retained service Stop records use exact assembly identity; actual disposal acknowledgement is separate in-process lifecycle bookkeeping. Team uses genuine outer run actions plus genuine candidate actions acquired at the serialized new-candidate boundary; existing capture reconciliation keeps its original owners.
**Tech stack:** Existing TypeScript, AsyncLocalStorage, ManagedAction/AsyncInbox, controlled Vitest/real JSONL fixtures; no new dependency, Core or persistence interface.
**Baseline/spec:** MAIN `da8eb81b4814a23bfe7ac92b91d5e75551a5b05c`; this revision supersedes the first packet for implementation review. CURRENT qualification WIP remains frozen.

## Evidence, scope and review closures

- Read original packet, `notification-stop-owner-design-review-20261027.md`, Task5 corrected-race report and exact named copied trace; no failed root was reopened.
- Confirmed cancellation cause remains two original inbox.cancel promises for one input, with reasons `parent stopped` then `parent stopped during admission`; second rejects FACT_INVALID_GROUP before first commits. The strict received-input fingerprint comparison is correct and remains unchanged.
- Native cancellation batch `30a96662-36e4-4363-9fd4-4e3591850562`, seq 5, owner incarnation `5742e31f-4108-4c37-9f30-4325a977c734`; exact input/message/Team tuple remains the original packet's corrected trace tuple.
- Review's Important is accepted: `chain.then(work)` delays even the first transaction callback; outer admission does not authorize a later independent optional action after revoke. Roster also awaits child acquisition before active/failed callbacks.
- Review's Minor is accepted: map absence cannot prove actual assembly disposal. Retain acknowledgement for that exact object across live-map removal and Stop retry.
- Historical close's nested cause is still unrecorded; source-proven candidate entry races do not establish the frozen aggregate's nested error. Duplicate public close calls are not callback-replay evidence.
- Scope stays service Stop + Team admission boundaries; no CodeMode/B2, launch protocol, Core/persistence authority, generic debt relaxation, or release expansion.
- No tests/runtime, product source, Git, network, CURRENT WIP, protected-evidence traversal, recursive agent, or failed-root mutation in this design task. Only this revised packet is written.

## Service Stop ownership and acknowledged disposal

**Product file:** `packages/session-executor/src/service.ts`; all names below private.

```ts
type NotificationStop = {
  readonly inputId: string; readonly reason: 'parent stopped';
  inFlight?: Promise<boolean>; succeeded?: Promise<boolean>;
};
type NotificationStopOwner = {
  readonly sessionId: string; readonly assembly: SessionAssembly;
  readonly stops: Map<string, NotificationStop>;
};
const notificationStops: Map<SessionAssembly, NotificationStopOwner>;
const assemblyDisposals: WeakMap<SessionAssembly, {
  acknowledged: boolean; inFlight?: Promise<void>; succeeded?: Promise<void>;
}>;
function stopNotification(id: string, assembly: SessionAssembly, inputId: string): Promise<boolean>;
function joinNotificationStops(sessionId?: string): Promise<void>;
function disposeOwnedAssembly(assembly: SessionAssembly): Promise<void>;
```

`stopNotification` is non-async; synchronously retain exact assembly/input record before calling original `assembly.inbox.cancel(inputId,'parent stopped')`.
Store/return its actual original promise. Concurrent and later callers return `inFlight ?? succeeded`; observers preserve original value/error and never return/throw cleanup work into an unhandled derived promise.
On rejection clear only that attempt's inFlight; retain retryable record, fixed reason and original source capture. Success retains the original fulfilled promise. Never retain a rejected promise as a permanent result.
Normalize a truly synchronous throw into a handled rejecting attempt preserving the exact thrown value; do not synthesize success or Stop consumption.
Both `stopNotifications` and late default `parentNotifyFor.admit` call this helper. Late admit uses its captured assembly and throws ParentNotificationStoppedError only after fulfilled cancellation; unknown/error remains original queued/target-owned disposition.
Keep synchronous parent/controller fences and original eligible pending-input filter. Failed records remain enumerable independently of pending projection/live-map presence.
Close joins admissions before snapshotting Stop records, so a late admission's new record cannot escape. Join selected exact records once per explicit attempt, aggregate original Stop rejections and continue actual cleanup; no retry loop or broad admission-error-to-cleanup conversion.
`closeAll` fast return includes notificationStops emptiness. Per-session ID only filters retained records; cancellation always targets each record's actual assembly, never a replacement lookup.
`disposeOwnedAssembly` uses its exact-object WeakMap row: return succeeded/inFlight when present; otherwise invoke actual assembly.dispose once, store that original promise, clear inFlight on rejection, and set acknowledged=true/succeeded only on actual fulfillment.
Route service-owned assembly disposal calls through this private helper, including closeAll/closeSession and staged assembly cleanup; preserve their existing independent cleanup phases. It does not acknowledge native-only fallback closes as disposal of an assembly.
Release a Stop record iff cancellation succeeded **and** assemblyDisposals.get(exactAssembly)?.acknowledged===true; perform release checks on either acknowledgement, then remove an empty owner row.
Successful disposal followed by live-map removal preserves its WeakMap acknowledgement while old Stop debt retains the object. A later successful Stop retry releases it without invoking its disposed callbacks again.
Retrying old Stop records alone must not fall through to coordinator.closeManagedDocument(sessionId) or dispose an equal-ID replacement; separately present current owner work follows its own normal cleanup path.
If Stop join failed but disposal succeeded, report the original join failure once for that close attempt, remove acknowledged live resources using existing rules, retain the failed Stop owner, and let explicit later close retry it.
Equal DTO retry reaches the same received-input fact.admit; it does not itself reconcile unknown. Existing original source close/native reconciliation resolves that capture/key. Later cancellation false can acknowledge no pending input; original failed caller is never retroactively Stop-consumed/ACKed.
If original reconciliation remains unresolved, preserve actual source/assembly/Stop debt. No reason rewrite, replacement capture, scalar receipt authority, native guard/fingerprint relaxation, or callback replay.

## Team hooks: exact actions, candidate boundary and ALS lifetime

**Product files:** `packages/agent-team/src/facts.ts`, `src/transact.ts`, `src/scheduler.ts`, `src/scheduler/completion.ts`.
Existing public TeamTransaction/run/tool signatures stay. Extend internal structural TeamLead with this optional narrow owner hook; actual createTeamFacts always supplies it (non-owner test leads can omit it).

```ts
interface NewTeamCandidate {
  capture(events: readonly TeamEvent[]): void; // synchronous, adopts actual action
  abandon(): void; // finish only if capture never adopted it
}
// TeamLead addition:
beginCandidate?(): NewTeamCandidate;
// createTeamFacts private-facade addition:
withoutRun<T>(work: () => T): T;
// Transaction record gains attempted:boolean (initially false).
// Run context/record retains { action: ManagedAction<ProducerFactOutcome>, active: boolean, done: Promise<void> }.
```

Outer `run`: local assertOpen; actual owner.beginAction(explicitSignal); action.assertOpen (also needed nondurably); retain active Run before body. Execute once in ALS holding that exact Run and its native action.signal; finish that action once and set active=false/remove only that Run/resolve its sentinel when actual work settles, including synchronous throw.
Preserve actual caller result/error. `exec.abortSignal` inside tool bodies remains the explicit execution signal; ALS native signal does not claim that every bridge/body wait aborts on revoke.
`beginCandidate`: local assertOpen; if ALS contains a Run, require active and invoke that exact run.action.assertOpen. Do not silently discard stale/finished Run context or borrow its signal as new authority.
Then acquire **the actual new transaction action** with the active Run signal, or undefined for a direct/no-run caller, and assert it open before returning the candidate handle. This action is retained for the actual candidate, not a begin/finish authorization probe.
Handle.capture(events) synchronously captures on that same action and registers `{kind:'transaction',action,fact,attempted:false}` for the exact events array; ownership transfers only on successful registration. On capture refusal finish the unadopted action, preserving error; no tx.pending assignment.
Handle.abandon finishes an unadopted action exactly once for no-event result, pure callback throw or validation failure; adopted captures remain independent of outer Run completion.
In `transact`, serial callback first `await settle()` of original pending. Only afterward call beginCandidate, then clone/pure fn/validation, capture the validated events, assign tx.pending, and synchronously enter settle/commit. **No await separates native new-candidate guard from pure fn/capture/pending assignment.** Finally abandon only the unadopted handle.
For createTeamFacts, no new generic pending exists without its registered capture. No-event/read callback still uses its genuine candidate action through that callback, then finishes without a write.
`facts.commit`: an existing prepared record with attempted=false uses fact.admit, marks attempted before await; later retries use fact.reconcile. Existing captured records never consult current Run/local new-work guard or acquire replacement actions.
The original direct commit fallback retains its real capture path for compatibility; use the same current-run assertion before any new action there. Production generic tx reaches prepared records.
Keep existing terminal cancellation handling only for its exact captured outcome; never clear an unknown/issued capture because an outer Run ended/aborted. Source drains reconcile original pending before any new-candidate guard and invoke no pure callback.
`reserveMessage` still joins an existing exact record before new admission; for a genuinely new record assert current Run if present, then acquire/retain its actual message action. Required ACK capture/settle and exact-record joins bypass new-candidate guards.
Native source drain must not join Runs; only external unmount joins resolving Run sentinels. Existing required ACK can settle after revoke without replaying delivery.

## Source path / context map (all actual Team source call sites)

| Path | Native action and context decision |
| --- | --- |
| scheduler.ts tool wrapper → roster/task-board generic tx | Genuine outer Run; candidate hook checks same still-active Run at lane execution, then creates real candidate action. |
| roster.ts provisioning → awaited spawnChild/prompt → active or best-effort failed tx | Same outer Run spans awaits; each later new candidate repeats exact native guard. Existing provisioning capture is settled first. Child cleanup remains external-owner cleanup. |
| scheduler.ts mount → roster.reconcileProvisioning | Explicit withoutRun around recovery entry; each direct generic callback gets its own real candidate action and native close fence. No completed construction/run action is borrowed. |
| scheduler.ts mount mailbox.recoverRoot / handle.drainLeadMessages | Explicit withoutRun around each sweep; new message obligations acquire their own real native action, exact existing records join first. |
| completion.ts teamJobs.updateJob → retention await → mailbox.sendMessage | Independent completion can inherit spawn/followup ALS after its originating tool ended. Inject withoutRun and start the original completion job inside it; do not infer independence from active=false. Its retained completion record and actual message action own the work. |
| facts.ts registered source drain → tx.drain / settleMessages / ACK installer | Invoke drain callback through withoutRun; reconcile original captures/ACKs without a new-action guard or Run join. Clearing scheduling context grants no authority. |
| teammate-lifecycle.ts followupChain callbacks; task-delivery.ts followup callback | Only activity.notify in those callbacks; job completion writes pass through the explicit completion entry above. Child tool calls already enter a fresh explicit run. No generic callback exemption. |
| Direct createTeamFacts + createTeamTransact callers | No ALS Run is required; beginCandidate owns actual new native action before pure fn. Captured pending recovery stays independent. |

`withoutRun` uses this facts facade's ALS.exit(work); it creates no action/capability and is exposed only on the internal facts facade.
Add optional final `withoutRun: <T>(work:()=>T)=>T` argument to createCompletionJobs (identity default for direct callers); scheduler passes work=>lead!.withoutRun(work). Its construction precedes lead allocation, but jobs execute only after bindings exist; retain current staged cleanup if construction refuses.
Clear context only at the listed independently owned entry points, never inside roster's post-acquisition continuation or arbitrary generic tx. Raw inherited detached work receives the stale-context refusal; it cannot silently become independent.
Use withoutRun for both initial recovery calls and public drainLeadMessages; no new outer run/action is held across source cleanup. Other mailbox/ACK authority rules stay unchanged.

## Controlled implementation plan (runtime only within the root-assigned slice)

### Task 1 — service owner and disposal acknowledgement

**Files:** service.ts above; new `packages/session-executor/test/notification-stop-owner.test.ts`; existing received-cancellation-close.test.ts regression.

- [ ] RED/GREEN fresh real default service admission: hold actual numeric admit RETURN after native commit; actual Stop; release RETURN before original cancel native completion. Baseline two reasons/second FACT_INVALID_GROUP; green one original cancel promise/capture/fixed reason, nominal Stop only after fulfillment. No fabricated outcome or cancellation gate.
- [ ] Preserve inverse and OPEN recovery controls for separate authorization; same-input/owner coalesces, equal-ID different incarnation does not. Direct different-reason received-input DTO still fails strict equality before first commit; promotion-wins retirement unchanged.
- [ ] Unknown real append/receipt control: actual commit reports unknown; original caller keeps recovery error/no fabricated ACK; same capture/key/bytes reconciles via existing native source. Continued unknown retains exact debt and rejects close; later explicit retry succeeds without reissue/callback replay/cached-rejection poisoning.
- [ ] Both closeAll and closeSession: Stop join fails; actual disposal/reconciliation succeeds; exact assembly removed; Stop later returns false. Assert retained acknowledged flag releases old owner, no second actual disposal callback, no coordinator fallback due solely to old debt, and close terminates.
- [ ] Per-session equal-ID replacement where allowed: retain old-owner retry beside separately live replacement; promises/actions/captures/disposal acknowledgements never join by strings. Cleanup of either exact owner cannot erase the other's debt.
- [ ] Join admission before Stop snapshot; catch late-created records; aggregate original Stop failure while proceeding with actual cleanup. Successful cancellation with failed disposal retains needed acknowledgement state.

### Task 2 — real Run, real candidate hook and explicit independent entries

**Files:** facts.ts/transact.ts/scheduler.ts/scheduler/completion.ts above; extend `packages/agent-team/test/lifecycle.test.ts`, `test/transact.test.ts`, `test/acknowledgement-settlement.test.ts` as owner controls require.

- [ ] RED/GREEN four valid real retained tools invoked after document revoke/before Team.retire: baseline body/candidate entry; green FACT_CLOSED before body, zero new candidates/captures/drivers/actions/writes; fresh native Team source closes. Serialize nested fresh errors; historical cause remains unclaimed.
- [ ] RED/GREEN **accepted Run, revoke before first serial callback**: invoke real tool without yielding its queued tx, synchronously revoke actual native document, then release/advance lane. Assert pure callback count zero, no candidate/capture/pending, Run finishes once, native Team source closes.
- [ ] RED/GREEN **accepted spawn, revoke during actual child acquisition/prompt hold**, separately success and failure continuations: provisioning remains its exact prior capture; active/failed pure callbacks do not run/install/capture afterward; child cleanup completes once under existing owner; Team source closes without uncaptured debt.
- [ ] Existing generic capture unknown ahead of either order: guard is reached only after original settle succeeds; same original key/capture reconciles even if Run finished or revoke occurred, pure callback runs once, unknown never dropped. Refusing the next candidate cannot erase earlier debt.
- [ ] Direct/mount generic controls without any Run: revoke during real durability probe; subsequent recovery callback is refused before fn/pending; open-owner recovery still commits using its actual candidate action. No throwaway native probe.
- [ ] Genuine candidate transfer: one action acquired before fn, same action captures/admits, success/unknown uses original handle, noevents/validation/throw finish once. Original caller errors/results preserved; acquired outer actions finish on refusal/throw/rejection/success/already-aborted signal.
- [ ] ALS positive/negative pair: finish an actual spawn/followup tool while its child remains running; later real teamJobs.updateJob completion still queues/delivers once through explicit independent entry. Raw detached generic callback retaining expired Run refuses; current live Run continuation cannot bypass native revoke via withoutRun.
- [ ] Completion while origin Run still active uses its own message action; mount/public recovery sweeps work without Run borrowing; source close under stale inherited context reconciles originals. Observe action identities, not just counts.
- [ ] Accepted original message ACK after revoke still settles once through same required source/capture/full key; both child-first and ACK-first cleanup orders; no source-to-run deadlock or callback replay. Existing generic terminal cancellation and ACK negative controls stay intact.

### Task 3 — root-reviewed qualification and checks

- [ ] Review closures in this packet before source/runtime approval. Preserve original 121-line packet, review and frozen CURRENT candidate/evidence; work from fresh authorized candidate/roots only.
- [ ] Once authorized, actual C6 first race precedes separately authorized inverse/OPEN/C7. Record original receiver/args/promises, action/source identities, full native bytes/keys/receipts, zero trace overflow and bounded nested AggregateError.errors/cause serialization; public close counts alone do not qualify cleanup.
- [ ] Direct installed Node/Vitest, package CWD, fresh six evidence roots per invocation, existing worker bounds `--maxWorkers 2 --minWorkers 1 --no-file-parallelism`: focused service test + received-cancellation-close; Team lifecycle/transact/managed-transact/acknowledgement-settlement/completion-delivery. No package manager/install/build/network.
- [ ] Affected session-executor and agent-team `../../node_modules/typescript/bin/tsc --noEmit`; record exact command/CWD/roots/exit. Broader C7 only under its separate ruling.

## Design review outcome and remaining acceptance

Rereview Important closure: real candidate hook at the serialized boundary, same-action capture before pending, original reconciliation ahead of guards, and explicit ALS independence controls. Rereview Minor closure: actual exact-object disposal acknowledgement survives live-map removal and retries without repeated acknowledged callbacks.
Same-reviewer design PASS closed both findings. No Core change is required: the private TeamLead candidate hook plus internal withoutRun callback express the boundary. Root releases Tasks1+2 only; report concrete wider-authority or debt-dropping requirements before widening. Runtime, source acceptance and final service qualification remain to be completed.
