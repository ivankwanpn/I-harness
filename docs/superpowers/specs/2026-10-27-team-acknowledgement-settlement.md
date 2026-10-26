# Team acknowledgement settlement — approved implementation specification

2026-10-27. Root approved after scoped I1-I4 re-review; implementation and runtime acceptance remain outstanding.
Source: stable MAIN Team flow preserved from f3dc2bac; review identifies unchanged Team source at
d282a6c1. Preserve the original design and review files. No product changes/tests/Git operations here.
The original contaminated race still proves source ordinal3/new-action refusal; the corrected
attempt failed before its gate in a separate Code Mode source hold. Neither is a clean pair.

## Fixed scope and authority

Settle only the exact original Team delivered acknowledgement after actual protocol consumption.
Reuse the mount-owned source and serial fold; generic Team transactions remain optional. No new
core/persistence port, protocol event, schema, completion registry, or model-acceptance authority.
`SettlementFacts.delivery.capture` already accepts delivered (`core-session/src/managed/ports.ts:68`;
`session-persistence/src/coordinator/settlement-source.ts:83-85`; memory parity exists).
Native group is exactly `{kind:'delivery',event:{type:'team/message/delivered',version:1,teamId,messageId,targetId}}`.
Only a known consumed disposition may create this required capture. A logical reservation is not
a capture: native source pre-drain would otherwise issue acknowledgement before actual delivery.

## Frozen internal signatures and records

All paths below are relative to `packages/`. Types stay inside agent-team composition, not tools.
`Queued = Extract<TeamEvent,{type:'team/message/queued'}>`; `Ack = Extract<TeamEvent,{type:'team/message/delivered'}>`.
`Failure = {occurred:false} | {occurred:true,error:unknown}`; never infer occurrence from truthiness.
`DeliveryOutcome = {kind:'consumed',via:'target'|'parent-stop',sendFailure:Failure}`
` | {kind:'queued',via:'no-target-call'|'bridge-false'|'target-owned',sendFailure:Failure}`.
`QueueGuard = (clone:TeamFoldState)=>void` is pure, mailbox-bound, and runs only inside the serial lane.
`DeliveryRequest = {queued:Queued,mode:'enqueue'|'existing',guard:QueueGuard,deliver:()=>Promise<DeliveryOutcome>}`.
`TeamTransaction.deliverMessage(request:DeliveryRequest):Promise<{messageId:string,status:'accepted'|'queued'}>`.
`TeamLead.reserveMessage(queued:Queued,mode:'enqueue'|'existing',installAck:InstallAck):MessageObligation`.
It may be absent on generic-only custom leads; deliverMessage then refuses unsupported ownership, never falls back to generic commit.
`InstallAck = (write:()=>Promise<void>,markInstalled:()=>void)=>Promise<void>`; supplied by actual tx.
`MessageObligation` exposes frozen `queueEvents:readonly[Queued]`, `queue():Promise<void>`,
`queueInstalled():void`, `start(deliver:()=>Promise<DeliveryOutcome>):Promise<MailboxResult>`, `settle():Promise<void>`.
`MailboxResult` is deliverMessage's return DTO. `lead.retire():void` seals admission, not settlement.
`createTeamFacts` also takes `retainFactsCleanup:(close:()=>Promise<void>)=>void`, invoked after actual
beginAction, BEFORE registerSettlementSource, with its exact staged action/source cleanup closure.

Extend facts.ts's existing transactions records with original message obligations; no second job map.
Retain immutable full queue tuple/ack tuple, actual action/capture/source references, queue disposition,
queueInstalled, driverStarted/driverDone, consumedKnown/consumed, optional ack capture and ackInstalled.
Retain `sendFailure:Failure`, `errorDelivered:boolean`, and current settlement failure separately.
Store a resolved driver-completion sentinel separately from the original rejecting caller promise.
Undefined/null remain original thrown values when occurred=true; cause/delivery flags never erase them.
Same live full tuple joins before new admission checks; ignore its replacement callback/guard.
Same key with mismatched full queue data/target rejects. Compare tuple before delivered-set deduplication.

## I1 — Actual bridge outcome ownership, not generic error inference

Normalize at the bound `scheduler/task-delivery.ts` operation boundaries, not by scanning codes,
aggregate causes or a generic catch in tx. The default bridge is the shipping path; boolean test
overrides are adapted to true/false only and retain any original rejection, conferring no receipt.
No created Team ack exists when delivery has not returned a scoped consumed disposition.

| Actual boundary | Normalized result and original owner |
| --- | --- |
| Missing member/entry, no rebuild, rebuild false, killed entry (`:44-61`) | queued/no-target-call; no new message audit/admission |
| ensureResident throws at `:58` | queued/no-target-call with exact sendFailure; this message's audit has not started; preserve any rebuild-owned cleanup separately |
| Parent/child recordDelivery fails (`:23-24,63-64`) | queued/target-owned; existing return-false/send-status preserved; target document's original inbox source owns capture/key |
| ParentNotify admission fails temporarily (`:30-38`) | queued/target-owned; its actual received-input owner decides whether capture/debt exists; no Team ack; preserve existing false behavior |
| Actual ParentNotificationStoppedError from that parentNotify call | consumed/parent-stop only after target audit acknowledgement; existing Stop consumption semantics |
| Parent branch finishes, or child audit acknowledged and followup scheduled/quiet (`:41-42,62-84`) | consumed/target |

The target inbox owner is `createTeamDeliveryFacts`'s actual record/source (`facts.ts:46-80`),
settled by its original source.close/document close or the same record's explicit delivery retry.
Parent admission/cancellation uncertainty belongs to `receivedInputsFor`'s original received-input
source (`session-executor/src/lifecycle/received-inputs.ts:18-31`); its document close settles it.
Default service wake (`service.ts:398-415`) schedules with existing catches; child drive creates its
existing followupChain (`subagent/src/followup/drive.ts:27-99`). Their later failures are execution
owners' debt, not an uncertain Team transport disposition. No model acceptance is inferred.
If a synchronous scheduling/observer exception follows a proven target/admission barrier, normalize
consumed plus exact failure at that site, preserving the original send rejection where it escaped.
If an exception precedes that barrier, no Team ack is created: retire its uncreated reservation,
leave queue intact, and preserve/rethrow its exact original escaping error. This asserts no Team
acknowledgement, not physical absence; captures already created remain at the named target owners.
Previously caught false paths do not newly reject the public send merely to report target errors.
Actual Stop comes only from the trusted parent adapter call (`task-notification.ts:58-60`);
FACT_CLOSED, arbitrary thrown values, or matching text confer no consumption classification.

Known consumed=true alone enters ack settlement. False/scoped no-consumption ends the uncreated
Team ack obligation; close does NOT re-await its rejection as permanent debt or duplicate target
uncertainty. Cleanup never calls deliver/rebuild/retention/admit/wake again. It reports target debt
through the original target owner. Unexpected escaping errors are kept verbatim, not converted to success.

An OPEN explicit mailbox recoverRoot retry is different from cleanup replay: queued/nonconsumed
messages remain eligible for a new optional attempt only after the previous attempt's final outcome.
Existing target guards check subagent/inbox.messageId before append (`task-delivery.ts:22,62`);
same-owner recordDelivery reuses its captured fact (`facts.ts:61-79`). Parent service derives stable
inputId, checks original admission (`service.ts:381-383`), and the child drive uses lastInboxSeq
(`followup/drive.ts:31-37,67-69`). These are bounded dedup facts, not an exactly-once transport claim.
An existing uncertain Team ack joins its original record; it never starts another delivery attempt.
No retry after retire, scalar owner reconstruction, failed-root reopen, or executed-work replay.

## I2 — Admission and atomic capacity remain in the serial clone

Mailbox keeps its size/live fast checks and passes its EXISTING pure capacity rule as request.guard:
`if ((clone.queued.get(targetId)??[]).filter(m=>!clone.delivered.has(m.id)).length >= maxPending) throw new TeamError(TEAM_CODES.MAILBOX_FULL,...)`.
maxPending is closed over from maxPendingMessagesPerMember (default64), not a caller override.
For enqueue, serial order is: join matching record; clone; run guard; apply fixed queue tuple to
clone; only then reserve/capture; await original queue receipt; install queue once; return record.
Recovery existing-mode guard validates exact committed tuple/target and not already delivered; it
does not charge a second capacity slot. Duplicates have already joined or checked exact committed data.
`fold.ts:137-150` retains structural/target/duplicate validation; it is not the capacity guard.
Return only receipt/record work from this lane. Start delivery outside it; ack re-enters the same
lane for clone validation, receipt and installation. No lane-held external delivery/driver join.

## I4 — Queue, driver and original settlement are separate closed lifecycles

Queue states: pending -> committed+installed | never-issued | recovery. Driver states:
not-started -> running -> consumed | queued | failed-no-ack. Ack states:
uncreated -> captured -> committed -> installed; unknown/conflict/absent/install-failed remain recovery.
For this composition only, every authoritative native not-issued queue outcome ends its unexecuted
obligation: finish original action, clear its optional lane slot and reservation, preserve actual
send failure, never call target. Do not reuse generic tx's FACT_CANCELLED-only deletion policy.
Unknown/conflict/absence/installation failure retains the original capture/key; no automatic reissue.
If original queue failure ended the send, cleanup may reconcile/install that exact queue through
the retained lane record. Committed then becomes queued/no-ack; not-issued ends it; remaining debt
still blocks. It NEVER starts the target callback that the failed send did not reach.
Before target invocation, the original admission action.assertOpen and Team-open guard run with
no await before dispatch. Retire/refusal here finishes action, leaves any committed queue truthful,
rejects with the original error and creates no ack. Finish that action when dispatch starts.

After known true, record disposition before entering ack lane; create one required singleton capture
on original Team source, then admit/reconcile it without beginAction. Install live fold once and
set ackInstalled immediately after applyTeamEvent succeeds, BEFORE onCommit/activity observers.
Observer failure after install preserves original error but cannot cause a second application.
Unknown receipt blocks installation/status/release; only actual same capture reconciliation advances.
`settle()` first joins the RESOLVING driver-completion sentinel, then examines retained state:
no-ack terminal -> success; consumed+unsettled ack -> reconcile/install original; installed -> success.
It does not await the rejected public send again or start callbacks. Historic send rejection stays
observable to its original caller even when later cleanup successfully resolves the original ack.

CompletionJobs remains the existing registry, with records retaining raw failures until processed;
add sealCompletions():void and joinCompletions():Promise<void> to createCompletionJobs's returned
facade. Register each accepted record before its work starts; stop accepting when sealed. Retain
original failure with occurred/errorDelivered flags even after its work settles. Original caller
delivery counts once; undelivered fire-and-forget failures are reported once in the cleanup aggregate.
A processed historic failure is not continuing settlement debt. Current failed phase/debt remains
retryable; successful reconciliation cannot remain poisoned by historic promise rejection.

## I3 — Partial construction remains reachable through actual owners

`TeamDeps.retainMount?:(handle:TeamMountHandle)=>void` is a synchronous caller-owned retention seam.
Immediately after admitTeam reserves (scheduler.ts:128), allocate one cleanup shell and register it
with the actual assembly's teamHandles BEFORE creating activity/source/roles/tools or recovery awaits.
Assembly passes `retainMount:h=>teamHandles.push(h)` and no longer pushes again after successful await.
Shell starts with empty acknowledged resource slots; each actual acquired resource is retained
before its next fallible operation. createTeamFacts's retainFactsCleanup closes over the actual
action before registration; registration immediately fills its source slot. If beginAction fails,
no facts slot exists. If register fails, finish exact action; later failures retain staged action/source
cleanup in the shell. Its empty producer drain must not dereference an uninitialized tx.

Before tool replacement, create/retain a partial ToolMount `{mount():void,close():Promise<void>}`;
reuse replaced/installed-tool tracking in recovery.ts, recording each mutation for exact rollback.
Retain generated role ownership, activity, exact child entry references, and source in that shell.
Early failure before admitTeam reserves has nothing to release; after reservation every catch invokes
that shell. On failure, throw original error plus cleanup errors; NEVER unconditional releaseTeam.
Standalone callers without retainMount receive a nominal TeamMountFailure carrying the same handle
if cleanup fails. Actual assembly always retains it before recovery; no failed-mount global registry.

Assembly's construction catch currently calls dispose, but service records mountingAssemblies only
after createSessionAssembly returns (`service.ts:643/686,708`). Thus also retain original construction
dispose through `AssemblyOptions.retainConstructionCleanup?:(close:()=>Promise<void>)=>void`, before
first Team construction. Service overrides it with its own synchronous callback into the EXISTING
creating entry, extended to `{work:Promise<SessionAssembly>,cleanup?:()=>Promise<void>,failed:boolean}`.
On construction rejection with pending cleanup, keep that row/failed-close fence; assemblyFor must
not rebuild or expose an Agent. Explicit close/closeSession joins work then retries that exact cleanup.
Delete only after successful cleanup; successful publication transfers ownership to mountingAssemblies.
No new map, owner lookup by scalar IDs, fake partial SessionAssembly, or automatic constructor retry.
Direct assembly errors also carry the original cleanup closure when no caller retention seam exists.

## Close phases and error propagation

Mount states: constructing -> open -> retiring -> closed, or failure -> recovery -> retiring.
One in-flight unmount promise coalesces; rejection clears only that promise. Retired is scheduling
state, never proof of cleanup success. First seal completion starts/message admission and activity;
then join accepted completion/driver sentinels, drain lane/obligations/lane, close original source.
Continue independent exact child/tool cleanup and report original errors. Never call its own
source.close recursively or hold the lane while joining a driver. Record each acknowledged phase.
Failed child disposal retains its exact entry/closure; remove table/agent identity only after
acknowledgement and only if still the same entry. Tool restoration similarly tracks remaining work.
Only source AND required child/tool/role cleanup acknowledgement permits releaseTeam and closed.
If all resources close but an undelivered historic error must still be thrown once, mark its delivery
and keep that distinction; another explicit close is clean, not permanently poisoned by history.
Failed phases retain same shell/reservation and retry ONLY remaining phases; never return success
from isUnmounted. Assembly aggregates Team unmount failures while continuing other mounts/cleanup.
Construction error remains primary, including undefined/null; use occurrence flags and AggregateError
entries, not `if(error)` or `error??fallback`. Current errors do not invent authority to replay work.

## File map, controls and release limits

- agent-team/src/{facts,transact,mailbox}.ts: original record/outcome/guard/receipt/fold composition.
- agent-team/src/scheduler/{task-delivery,completion,recovery}.ts and scheduler.ts: scoped normalization,
  retained completion records, partial resources, retainMount and retryable phased unmount.
- session-executor/src/{assembly,service}.ts: early exact cleanup retention/creating-row ownership,
  aggregation and explicit retry. Preserve synchronous revocation and the caller's existing clock.
- agent-team/test/{acknowledgement-settlement,mailbox,lifecycle,managed-transact,completion-delivery}.test.ts;
  session-executor/test/team-construction-cleanup.test.ts: focused controls described in candidate plan.
Real barrier uses text-only actual Team/service one final/default parentNotify. Hold real inbox.admit
RETURN after actual commit; assert queue/audit/admission, start actual close, release gate independently
(close joins notificationAdmissions), require real Stop cancellation plus single original ack.
Then clean inverse; no Code Mode/reconstruction/three-turn stores/sleeps/deadline increase or fake success.
Required negative controls: no-effect throw and undefined/null; target-owned unknown; concurrent max1;
queue never-issued/unknown/conflict/install; ack unknown/absence/conflict/fold observer; duplicates;
partial recovery mount failure; early source/tool construction failure; failed child/tool close retry.
No passive projection starts/joins work. D1/O1 distinguish durable result, transport consumption and
actual model acceptance; F1 preserves original source/capture/key. Focused success cannot clear the
distinct Code Mode hold, Stage6 or whole-feature gate. Bounded implementation is approved; acceptance remains open.
