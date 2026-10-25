# D1a ordinary child receiver — specification

Status: root-promoted executable packet under the approved integrated program, 2026-10-26. Root ratifies Session13 and the original11/12 birth-preservation contract below; Product stays0.1.13-rc.1. B2 prerequisite is accepted in MAIN9453cf0e/productdd98e983. The source preflight and draft review produced this contract; no unrun behavior is claimed as implemented. Root assigns one writer and an immutable BASE per review task.

## 1. Outcome and boundary

One real ordinary background `spawn_agent` completion, created through SessionService's actual Agent/tool registry, retains its original result and admits one typed recipient input. An idle published parent runs that input through its existing lane; an active parent can claim it at a normal step boundary. Stop, rewind, cancellation and owner retirement cannot grant late admission or a second dispatch. A normal non-Stop human followup or steer leaves the original background child eligible.

This is a single connected vertical packet. Its core/format and connected consumer commits may have separate review checkpoints, but neither an unused receiver export nor a mock ParentInputAdmission counts as completion. Exec/workflow/Code Mode handoff, the new background-event observation cause, public CLI/Gateway Stop acknowledgment, public F1/ID caller cutovers and team producer conversion are subsequent packets. Human steering, current team legacy behavior, native/result ownership and action budgets remain regression requirements.

Product stays `0.1.13-rc.1`. Task1 sets `CURRENT_FORMAT_VERSION=13` under this explicit format ruling. `TaskProtocolDocument.formatVersion` remains `1|2`: no new task/outbox field carries generation, source-binding or receiver-consumption authority. No new result/event store, broker, mail or webhook.

## 2. Why these owners

Current `service.ts:parentNotifyFor` hashes rendered text+description and keeps Stop in the process-local cancelledParents set. `subagent/index.ts:restoreTasksAndSweep` drains before `assembly.ts` awaits subagent.ready and returns; service publishes assemblies then lanes and invokes `assembly.drainParentNotifications`, currently team-only. `tasks.terminalize` can initiate retainResult→notification drain before spawn's later `source.prepareEnd` commits subagent/end. These are source-observed causal gaps, not runtime REDs already executed.

Reuse actual owners:

- `TaskRecords` owns task-N identity and original TaskIdentity; `TaskResultOwner` owns original result revision/capture/settlement; `TaskPersistence` orders strict task snapshots. `qualifyTaskPublication` uses actual retainedResultWitness for cold qualification.
- `createSpawnSource` owns original captured start, published child and terminal source. Its start is committed before spawnChild; terminalRequired settlement remains possible after the launching action stops.
- The recipient ManagedDocument owns journal install, original BatchKey and writer preconditions; its one cached `receivedInputsFor(owner)` owns received/cancellation capture recovery. New recipient captures extend that source.
- `AsyncInbox` and `readInbox` own pending/claim; `ManagedAction.captureInputPromotion` and `promoteInput` retain atomic input-start/steer-claim. `createSessionExecutor` owns serial execution; the service schedules the already admitted id.
- Finite context/action and context/attempt records continue to own model allowance/deadline/billing. The delivery generation below is a separate semantic field within the same journal, not another model allowance.

## 3. Exact new data, all under the managed journal

Add `core-session/src/events/delivery.ts`. Closed own JSON data only: no symbols, undefined fields, accessors, hidden keys, proxies accepted by the Node capture entry, callbacks or source IO. Use existing conversationId (nonempty≤256), conversationSeq (safe nonnegative integer), strict JSON capture and canonicalJsonData. New operational facts are required, never ignorable. Optional `seq` exists only in the normal event envelope; caller drafts omit it.

In signatures below `Event<K>` is the existing local shorthand `Extract<SessionEvent,{type:K}>`; the generic Outcome is the same existing FactOutcome/NondurableFactOutcome parameter, not a new result domain.

```ts
export interface SubagentDeliveryKey {
  recipientSessionId: string;
  sourceNamespace: string; // exact registry persistence stateId, not a label from a tool
  sourceId: string;        // original TaskRecord.id
  resultRevision: string;  // original task.result.revision / subagent/end.resultRevision
  kind: 'subagent';
}
export type DeliveryGenerationEvent =
  | { type:'agent/delivery-generation'; version:1; op:'open';
      recipientSessionId:string; generationId:string; originInputSeq:number; seq?:number }
  | { type:'agent/delivery-generation'; version:1; op:'close';
      recipientSessionId:string; fenceId:string; reason:'user-stop'|'rewind'; seq?:number };
export interface SubagentDeliverySourceEvent {
  type:'agent/delivery-source'; version:1; kind:'subagent';
  recipientSessionId:string; generationId:string;
  sourceNamespace:string; sourceId:string;
  callSeq:number; startSeq:number; seq?:number;
}
export interface DeliveryReceivedEvent {
  type:'agent/delivery-received'; version:1;
  key:SubagentDeliveryKey; sourceSeq:number; terminalSeq:number;
  inputId:string; seq?:number;
}
export interface SubagentDeliveryLaunchDraft {
  recipientSessionId:string; generationId:string;
  sourceNamespace:string; sourceId:string; callSeq:number;
}
export type DeliveryLaunchPreparation =
  | {kind:'bound';binding:SubagentDeliveryLaunchDraft}
  | {kind:'unavailable';reason:'no-own-human-origin'|'recipient-not-bound'|'uncertified-call'};
export interface SubagentDeliveryEvidence { sourceSeq:number; terminalSeq:number }
export interface DeliveryAdmissionReceipt {
  inputId:string;
  disposition:'pending'|'claimed'|'cancelled'|'suppressed';
  durability:'durable'|'nondurable';
}
export interface DeliveryCloseReceipt {
  fenceId:string; closeSeq:number; durability:'durable'|'nondurable';
}
```

The recipient close event intentionally has no generationId. It fences the entire preceding delivery-generation prefix, including a preceding open whose physical outcome was unknown when Stop was requested. It is legal with no prior open. Its existing writer serializes it behind reconciliation of any original issued frame. It never closes finite model generation by inventing an accepted context/action outcome.

Canonical input id is `delivery-` plus SHA256(canonicalJsonData(['ih.delivery.v1',recipientSessionId,sourceNamespace,sourceId,resultRevision,'subagent'])). This hash identifies a typed tuple, not source proof. Changing presentation, wake count, generation or live incarnation cannot remint the key. Source namespace comes from actual registerSubagent persistence stateId, without adding a prefix beyond existing256-character bounds. A nondurable registry receives one private mount namespace and makes no cold guarantee. Duplicate sourceId in one namespace with a different original start is conflict, never identity adoption.

## 4. Structural fold and group rules

Add `conversation/delivery.ts:createDeliveryIndex(scope)` with the same stage→advance→commit transaction pattern as generation/input-preparation indexes, and `readDeliveries(view)` as its readonly replay surface. It retains scalar event references/ids, not result bodies, artifacts, tool args or a second history archive. `createConversationIndex.stage` stages and commits it with all existing indexes; `createManagedSessionState.stage` uses that same validation. Header sessionId supplied by the actual managed writer binds recipient identity. Read-only no-sessionId history profiles validate internal consistent references without conferring writer authority.

```ts
export interface DeliveryState {
  activeGeneration():Readonly<{generationId:string;openedSeq:number;originInputSeq:number}>|undefined;
  lastFenceSeq():number|undefined;
  source(namespace:string,sourceId:string):Readonly<SubagentDeliverySourceEvent>|undefined;
  receipt(key:SubagentDeliveryKey):Readonly<{event:DeliveryReceivedEvent;
    disposition:DeliveryAdmissionReceipt['disposition']}>|undefined;
  isEligible(inputId:string):boolean; // final durable fold only
  pending():readonly Readonly<{inputId:string;receiptSeq:number}>[];
}
export function readDeliveries(view:SessionView):DeliveryState;
```

Private staged DeliveryIndex additionally exposes advance(event), lookupActionOrigin(open) as specified below, and commit. Its source/receipt lookups refer to original scalar events; they do not copy payloads. Keep `readInbox().pending/isPending` as the existing raw admitted/promoted/cancelled audit fold, because original cancellation-retirement proofs depend on that distinction. `AsyncInbox.pending/isPending` combines that raw fold with delivery durable eligibility plus exact-view live revocation for executable input selection; `AsyncInbox.cancel` checks raw pending directly so an explicit cancellation may still settle a suppressed admission. Recipient scheduling and claim use this same executable predicate. No live flag changes historical replay validation or makes a close equivalent to a committed cancellation/promotion.

The fold enforces:

1. Delivery facts require format≥13 and occur outside inherited seed/history (`seq >= seedLength`, and after actual session/bootstrap/initial-input boundary where applicable). Seed-import refuses new operational delivery facts; semantic seed export carries selected conversation/result context but never live delivery-generation/source/receipt authority. A fork target starts with no active delivery generation or inherited source claims, independent of source labels. Forking does not fence the source session.
2. At most one open generation. `open.originInputSeq` references an actual own non-synthetic human user admission (`kind:'human',authority:'request'`), preceding open and after the last delivery close/rewind boundary. It cannot reference inherited initial input, system notification, seed group, title/action scalar or plugin text. A fresh human input is required after a closed generation. While an existing generation is open, ordinary send/followup/steer does not open/close/rebind it.
3. A source binding requires an open matching generation and actual recipient scope. `startSeq === source.seq-1` references the immediately preceding original subagent/start with matching taskId/sourceId and parentSessionId. `callSeq` references own tool/call name spawn_agent with a real preceding tool/dispatch linked to that original call. Source hook verifies exact TaskRecord.callEventSeq before constructing the draft. One namespace/sourceId gets one original binding. No text/messageId can substitute for these addresses.
4. A receipt references an actual source binding and an original later subagent/end for the same taskId, with resultRevision matching key.resultRevision. Require a validated retained ResultEnvelope and outcome completed or error with matching execution truth; cancel/recovery-required, pending/unqualified/unknown terminal publication do not auto-deliver in D1a. Source retention/witness qualification is additionally required by the live source before it calls the adapter; source DTOs do no IO and cannot manufacture that capability.
5. Source generation is still open at receipt commit. Key recipient/namespace/sourceId equal the referenced binding. The next record in the same atomic group is agent/input/admitted with the receipt inputId, `delivery:'steer'`, `intent:'system'`, child-report/observation/turn provenance producer `session.delivery.subagent`, and task display metadata. The receipt does not grant authority to arbitrary supplied text: the original trusted source owns bounded presentation, retained reference and original outcome.
6. No second receipt for the same key or inputId. Existing committed receipt returns its original disposition; a second raw append is invalid. Promoted/cancelled existing input facts update the same receipt's derived disposition. A receipt cannot move back from claimed/cancelled to pending, even if text is summarized/rewound. Old consumed key is never re-admitted.
7. Close fences every preceding generation and pending bound input. Existing rewind/point also fences the previous generation in replay; a live rewind first commits a close before file restoration. Summaries/prunes/replacements preserve these scalar facts and pending-source dependencies; hiding rendered input does not change eligibility or consumption. Unsettled original source facts remain protected by existing reduction rules, not by a copied event store.

Three closed managed groups:

```ts
// Extend FactGroupDraft; group constructors, never arbitrary append.
{ kind:'delivery-generation'; event:DeliveryGenerationEvent }
{ kind:'subagent-delivery-start'; start:Event<'subagent/start'>;
  binding:SubagentDeliveryLaunchDraft } // resolve adds type/version/startSeq
{ kind:'delivery-admission'; receipt:Omit<DeliveryReceivedEvent,'seq'>;
  admitted:Event<'agent/input/admitted'> }
```

`subagent-delivery-start` resolves `[subagent/start,agent/delivery-source]`; `delivery-admission` resolves `[agent/delivery-received,agent/input/admitted]`. Receipt inputId is the typed-key digest. Resolve validates the concrete referenced events and structural fold, not just equal string IDs.

Add pure `validateDeliveryFrame(events,formatVersion):void`: every binding has its matching immediately preceding start in that physical frame; every receipt has its matching immediately following admission in that frame; a new-producer admission without receipt fails. Invoke it for a managed staged/coalesced frame and inside both ordinary/bootstrap journal readers on each decoded frame before installation. New delivery facts in an unframed legacy prefix fail. This prevents a receipt or binding split over two complete frames from acquiring authority. A torn final group frame installs neither member. Physical format stays session/fact-batch version1; no new frame store/version.

The ordinary in-memory group installer follows the same pair validation atomically. Standalone memory receipts explicitly say nondurable; no durable/restart claim follows. Existing generic source views may describe old subagent/start/end without a binding, but they cannot synthesize a new binding from equality.

### Finite action origin is historical ownership, not pending eligibility

Actual order matters. In executor `lifecycle/input-preparation.ts`, prepareInputExecution opens finite main generation from the admitted observation input **before** preparation and lane.runAdmitted; `core-agent/agent/direct-input.ts:openDirectInput` likewise opens main before returning to turn.ts. But `core-agent/agent/turn.ts:executeTurn` commits promoteTurnInput first, sets `generationOrigin={kind:'input',seq:inputSeqs.at(-1)}`, then uses supplied/direct firstGeneration or calls lifecycle.open in its while loop. Thus a legitimate path without a pre-opened action can open after grouped input-start consumed the receipt. Separately `turn.ts` sets deps.generationAction before `step-input.ts:startStep` claims steer inputs; a B delivery claimed there enters the **already existing** main action rather than owning an additional one. These are distinct normal paths; a final-state pending predicate is wrong for origin replay.

Freeze this internal signature instead of isDeliveryOrigin(admissionSeq,inputId):

```ts
type MainActionOpen = Extract<GenerationActionEvent,{op:'open'}>;
interface DeliveryActionOrigin {
  receiptSeq:number; admissionSeq:number; inputId:string;
  actionId:string; openedSeq:number;
  inputStart?:Readonly<{promotionSeq:number;turnStartSeq:number;rawMessageSeq:number}>;
}
interface DeliveryOriginLookup {
  lookupActionOrigin(open:Readonly<MainActionOpen>):Readonly<DeliveryActionOrigin>|undefined;
}
```

It accepts purpose main only and authenticates **that exact original open record** (actionId, open.seq, ownerSessionId and original origin address), not a fresh permission from a consumed receipt. During transactional advance of context/action open, the delivery stage can derive one tentative receipt→original finite-action association; generation validation must also pass before either stage commits. Rules:

- For `origin.kind:'observation-input'`, the exact receipt-backed admitted input may bind the first action while still pending and generation valid at that event. Once committed, the same original open/action remains valid history after promotion, generation closure, compaction or replay. It is never re-evaluated against final pending state. No new action open from that admission is allowed after consumption.
- For `origin.kind:'input'`, allow the first action after consumption **only** when origin.seq names the exact raw user/message of that receipt's grouped input-start `[promoted,turn/start,raw user/message,...]`. Its actual turn must still be current, there must be no intervening delivery close/rewind/cancellation or other main action assigned to that receipt/turn, and this receipt must have no pre-opened finite action already. Bind that one action. Do not substitute a derived preparation message or assume the last emitted preparation event is raw input. Paths with supplied/direct firstGeneration reuse it instead.
- A steer-claim `[promoted,user/message,...]` has no new turn opener and grants **no new finite action origin** for the claimed B delivery. It is consumed under the current action's existing origin. Existing predecessor-based continuation uses its real model/exchange-accepted lineage, never B's consumed input as a fresh origin.
- Enforce one original finite action per delivery receipt across **both** admitted-origin and raw-message-origin spellings. Existing createGenerationIndex actionId and originKey uniqueness remain, but are insufficient alone because those two origin tuples differ. An attempted second action, even with a different actionId/spelling, fails. A repeated same action at a different open.seq also fails existing duplicate-action rules. Same-invocation known-ready reads return the existing original action; they do not append another open.

Extend internal `createGenerationIndex(scope,deliveryOrigins?:DeliveryOriginLookup)` and its validateOrigin to ask this staged lookup for either receipt-backed origin form **before** generic human/unknown input acceptance. `readGenerationActions(events,scope={},formatVersion=CURRENT_FORMAT_VERSION)` replays delivery then generation sequentially, with actual format instead of its current hardcoded11. Its two lifecycle/generation-actions.ts callers pass view.formatVersion. A standalone index without a delivery lookup refuses these new origins; current live Stop does not invalidate historical open records during replay. New issuance still passes the managed beforeIssue live fence plus exact original-action/turn checks, including the first post-promotion action. Already-issued uncertain original opens only reconcile their original batch. Preserve session.notification team, session.schedule, delegated-input and ordinary human/predecessor rules and all finite budgets; no new action kind/allowance is added.

## 5. Exact narrow owner ports

Extend existing ports, rather than expose FactGroupDraft to tools:

```ts
// Existing ManagedAction method, optional second argument for this ordinary source only.
captureSubagentStart(event:Event<'subagent/start'>,
  binding?:SubagentDeliveryLaunchDraft):CapturedActionFact<Outcome>;

// New members on existing ReceivedInputSource<Outcome>.
readonly owner?: Readonly<OwnerToken>; // managed-only original frozen diagnostic identity
captureDeliveryOpen(event:Extract<DeliveryGenerationEvent,{op:'open'}>,
  checkCurrent:()=>boolean):CapturedSettlementFact<Outcome>;
captureDeliveryAdmission(receipt:Omit<DeliveryReceivedEvent,'seq'>,
  admitted:Event<'agent/input/admitted'>,
  checkCurrent:()=>boolean):CapturedSettlementFact<Outcome>;
captureDeliveryClose(event:Extract<DeliveryGenerationEvent,{op:'close'}>
  ):CapturedSettlementFact<Outcome>;
```

`captureDeliveryClose` validates/captures once, synchronously installs a stronger live fence for this exact managed view/owner, then returns the required original capture. The live fence only revokes eligibility; it cannot authorize any input or replace durable fold state. Capture failure quarantines source/new admission as today. Close capture remains admissible after a launching action's Stop, while ownership/required-source lifetime remains held. It is not a generic post-disposal write capability.

Extend internal `createReceivedInputSource` operations with private document-owned live delivery control, and per-capture checkCurrent guards for open/admission. Recheck guards at actual backend beforeIssue in addition to staging, using existing Authorization.assertSource. Required receipt settlement does not mean a new receipt can ignore eligibility. Once a frame was actually issued, reconcile its original outcome without retroactively changing it; Stop's later close fences any still-pending admission and cannot erase an earlier committed claim.

DP02 required-source disposition: a successfully captured generation-open or delivery-admission that becomes stale before any issuance must not keep source close permanently blocked. The original settlement/source owner may retire only its exact native-observed latest `not-issued/FACT_PRECONDITION_STALE` outcome, with no issued BatchKey/receipt or prior unknown/absent/conflict/install history. A retryAbsent followed by a new stale response cannot erase earlier issued-key history. Keep that handle's immutable stale outcome and its original assertHeld/closed-source checks; removing it from the pending drain is a terminal negative disposition, never a committed admission or synthetic seq. Do not retire malformed captures, synthetic fallback outcomes, close/end work or other groups under this rule. Existing exact input-cancellation invalid-group retirement remains unchanged, and independent original backend/resource cleanup still joins normally. Actual pre-issue Stop, confirmed close and later human/new-generation controls must pass, while issued/unknown/absent/conflict/install and fabricated-stale negatives retain their debt.

`createManagedDocument` composes an internal delivery precondition in admit/stage/beforeIssue for new generation-open, bound subagent-start, receipt-admission, input-start/steer-claim involving a bound delivery (including direct facts.inputs calls), and a new finite context/action open linked to this delivery through either its admitted observation-input or its exact grouped raw input-start message. `createActionCaptures.captureInputPromotion` also composes the same guard with its existing checkCurrent. Thus a service filter, cached pending list, unguarded original captureSubagentStart or async prepare cannot bypass live Stop before durable close lands. Required close/end/cancellation and already-issued settlement reconciliation remain permitted under original held lifetime; live revocation never invalidates previously committed historical generation origins during replay. Provide equivalent nondurable behavior. No readonly `Session` property/setter or caller-shaped OwnerToken can install/clear a live fence. Document revoke/close retires this control; old callbacks cannot bind a new same-label view.

`receivedInputsFor(owner,recipientSessionId?)` returns its existing `{inbox,facts}` plus one cohesive internal delivery adapter. Managed source construction attaches its existing original frozen OwnerToken as nonwritable/nonconfigurable diagnostic `owner` (as ManagedAction already does). Use source.owner.sessionId even when optional new actions are blocked; a supplied host id must equal it. For nondurable source, the first supplied host id binds this cached adapter only; a conflicting later id refuses, absence means no parent-delivery capability. `openExecutorDocument` supplies its existing options.sessionId; cold managed rewind can obtain identity from the original source without mounting an assembly. This scalar is not a held-owner grant, and no DTO-provided string constructs or rebinds the source.

```ts
interface RecipientDelivery {
  prepareLaunch(namespace:string, sourceId:string, callSeq:number)
    :Promise<DeliveryLaunchPreparation>;
  admit(evidence:SubagentDeliveryEvidence,
    presentation:{text:string;description:string;display:InputDisplay})
    :Promise<DeliveryAdmissionReceipt>;
  requestClose(reason:'user-stop'|'rewind')
    :{ fenceId:string; settled:Promise<DeliveryCloseReceipt> };
  settle():Promise<void>; // only original pending opens/admissions/closes, no source execution
}
```

prepareLaunch checks actual owner/readiness and original call; it reuses an open generation or captures one open bound to latest eligible human input. Concurrent callers join the same pending open. It waits original close debt before opening. **Absence of a legitimate own human origin is capability unavailability, not a failed tool:** return `{kind:'unavailable',reason:'no-own-human-origin'}` before capturing any new generation, and launch the otherwise accepted source without a D1a binding. Missing host adapter, ordinary foreground delivery:'tool', nested resultConsumer:'code', or a legitimate actual caller without this mount's exact recipient capability similarly uses the existing unbound source path. It does not accept namespace/sourceId from model args: registerSubagent supplies actual stateId/task.id.

An unavailable result is permitted only after validated current source state establishes this scoped capability absence; it cannot catch/erase actual cancellation, pending close debt, structural/source conflict, capture/IO failure, or an issued-unknown open. Once a genuine trusted open attempt starts, its failure is retained and propagated through original source cleanup; launch does not proceed under invented success. A task with no binding still executes, retains its result and supports existing TaskRegistry.readResult/get_task_output retrieval, remains non-auto-deliverable in D1a, and cannot acquire a binding retrospectively merely because a later human turn appears.

### Supported parents with delegated/synthetic input

Normal `service.ts:submitUnfenced` creates own human/request session.prompt admission, so its initial interactive task supplies D1a's root. The actual B2 `coordinator/bootstrap-header.ts:initialAdmission(request)` instead writes inherited/observation subagent.initial input. `subagent/child/generation.ts:openInitialChildGeneration` does the same before opening the child's **own finite** delegated-input action; child/lifecycle.ts passes that original generation/delegatedOrigin to runAdmitted. `followup/generation.ts` and drive.ts open child-local finite actions from delegated subagent/inbox (including team.delivery), not own human input. A restored/cold B2-initial child, ordinary resident child, teammate and a direct managed Agent.run with unknown provenance can therefore have valid executable work and no own non-synthetic human admission. Legacy session.notification and schedule synthetic turns can also lack a new own human input after a closed generation. Opening a child through SessionService and submitting an actual new human prompt is different: that new own admission may supply a later D1a generation; it does not retroactively authorize its older delegated tasks.

Do not manufacture a human provenance or share/inherit the parent's delivery generation for these cases. If the actual recipient already has a legitimately open own delivery generation, synthetic continuation may reuse it; otherwise return unavailable and preserve accepted spawn/result retrieval. Existing approval-review sharedGeneration is an existing finite approval allowance, not a delivery-generation certificate; defaults do not expose spawn, and D1a adds none.

Current child/assembly.ts resolves allowed parent tools into the child registry. Builtin roles exclude spawn_agent, but a custom allowed role/maxDepth can expose it. tools/spawn.ts explicitly records the current shared-mount/root-depth binding limitation. D1a must inspect actual exec.session/sessionId against this mount's deps.parentSession/receiver before preparation; a legitimate child invocation that lacks its own bound recipient gets the unbound source path, not a relabeled root binding or a new tool failure. Existing role/depth/source gates still decide whether spawning itself is accepted. C2/ID remains responsible for independent child instruction/caller/lifetime binding; this packet does not qualify all nested parent auto-wake.

admit derives full key from actual referenced binding/end in owner.view, validates task outcome/readiness and private current owner, returns an existing receipt if present, otherwise captures exactly one original receipt+input group. Retain the captured immutable presentation until outcome known. The adapter's per-key in-flight map is an outcome cache only; fold is authority. Unknown/conflict/install-failed throws existing recovery failure with original outcome retained; observed absent requires explicit same-capture retryAbsent, not a new input. settle reconciles original handles and surfaces unresolved debt. No passive auto-execution or reconstruction of task results.

requestClose synchronously fences and captures one close per live request/fenceId, then starts its required settlement. Concurrent attempts join that attempt's promise; after a rejection, settle starts a new observation/reconciliation attempt on the same retained capture, never a replacement close. A later distinct successful Stop may append another harmless close. No source keeps a rejected Promise as permanent success; original close outcome is observed/reconciled. The final closeSeq is read only from committedFactSeqs.

## 6. Connected ordinary source and service lifecycle

Add optional composition-only members to existing ParentInputAdmission, retaining its old generic admit/wake for team legacy:

```ts
prepareTaskDelivery?(input:{sessionId:string;namespace:string;taskId:string;
  callSeq:number}):Promise<DeliveryLaunchPreparation>;
admitTaskDelivery?(input:{sessionId:string;evidence:SubagentDeliveryEvidence;
  text:string;description:string;display:InputDisplay})
  :Promise<DeliveryAdmissionReceipt>;
```

They are never RPC/model/tool input fields or publicly exposed mint functions. Source code calls them only for actual ordinary parent tasks under this mount. The service reads exact owner/sessionOperation and receiver journal; it does not accept source-provided generation/key/result bytes as authority.

In spawn execute: submit original task → prepareResult/flush existing task persistence → for eligible ordinary background task with exact recipient caller call prepareTaskDelivery using actual registry namespace/task.id/exec.callEventSeq → on bound pass its binding to existing `createSpawnSource.start(event,binding?:SubagentDeliveryLaunchDraft)` and use the grouped action capture; on unavailable use original unbound source.start(event) → existing spawnChild once. A real trusted preparation/start failure prevents launch and retains original debt; unavailable capability does not. A retry of a retained original call adopts only its actual existing task/source outcome, never recaptures current source or opens a new generation for an old start. No trusted binding on a restored old row means no automatic delivery.

In onSettled, preserve terminal CAS/result capture/save, then await source.prepareEnd with original captured subagent/end. Only after its source reports original terminal committed and result retained does it signal the existing ordinary drain. The drain reads `sourceSeq` from actual journal binding and original committed terminalSeq. Existing terminalized hooks can mark it dirty early, but early retained task bytes cannot admit without these facts; terminal publication triggers another pass. A source failure/reconciliation must signal after the original end becomes known, without another terminalize/tool execution.

The concrete source seam is an optional fifth argument `onTerminalCommitted?:()=>void` to existing createSpawnSource(owner,signal?,retained?,background=true,onTerminalCommitted?). Its existing settleTerminal invokes this callback once only after terminalSaved and taskSaved are both true, including the original reconciliation path. registerSubagent injects through SubagentToolDeps `{parentNotify?:ParentInputAdmission;notificationNamespace?:string;onTaskTerminalCommitted?:()=>void}`: namespace is actual persist.stateId (or bound nondurable mount identity); callback dirties the same existing notifDrain. No task record/document field or substitute TaskRegistry terminal event is added. Source shutdown/current-owner checks remain in the drain/recipient lifecycle, so this callback cannot activate a replacement assembly.

### Result durability is not terminal publication after a process cut

Actual `TaskResultOwner` capture handles and createSpawnSource's `terminal`, `terminalEvent`, `prepareEnd` closure, terminalSaved/taskSaved and BatchKey outcome are live retained objects. TaskDoc1|2 persists task/result/outbox observations, not these original capture handles or a certificate permitting a cold end append. `task/publication.ts:unqualifyRestoredTask` changes current rows to recovery-required/unknown; qualifyTaskPublication calls retainedResultWitness with **taskId**, which in result-publication.ts accepts an actual matching non-rewound subagent/end with the same retained revision/ref metadata. A job/status-only witness or child turn/end/text is not that taskId terminal proof. `task/recovery.ts:classifyRestoredTasks` skips publication:'unqualified' rows. D1a must not bypass that rule or reconstruct a missing terminal from an auxiliary completed snapshot.

| Exact cut | Permitted recovery and D1a result |
| --- | --- |
| Original result bytes/ref durable **and original subagent/end already committed**, before recipient receipt | Cold actual managed journal/source qualification can prove that original revision/end and binding. After publication, the same ordinary drain admits/schedules it once if generation remains valid. |
| Original subagent/end complete frame physically landed but original acknowledgment unknown | While original source is live, reconcile its exact retained frame/capture; the successful terminal+task settlement invokes onTerminalCommitted and the same existing drain. After a process cut, only the existing backend's validated actual original complete journal frame/current committed-prefix recovery can supply the terminal proof; do not recreate an original handle or append a replacement end from TaskDoc. If that frame cannot be established, use the next row's no-wake outcome. |
| Bytes/ref durable, but original terminal fact was never issued/committed; or only an unissued in-memory terminal capture existed and was lost | A still-live original held source may finish its retained original capture under existing settlement rules. **Cold D1a cannot auto-complete this cut.** Preserve unqualified/recovery-required outcome and saved diagnostics/result reference; allow existing independently authorized read of retained bytes, or return the original reader's recovery-required/unavailable result when its proof is insufficient. No receipt, model wake, fabricated terminal, new result revision or producer replay. No receiver timer tries to resurrect a lost source capture. |
| End frame torn/absent/conflicted after uncertain issue, with no qualified actual terminal proof | Retain original recovery/cleanup debt where held and preserve truthful result observations. Apply existing journal repair/recovery without synthesizing execution completion. No delivery until original proof actually becomes available under the real owner. |

The broad Task5 failure-delivery/recovery obligation for bytes saved without recoverable terminal publication remains explicit open work; this scoped packet does not introduce the new persisted source certificate/authority needed to close it. Reporting this negative as honest recovery-required is a required D1a test, not a successful completed-result wake or whole-event acceptance.

Expose `drainParentNotifications():Promise<void>` on actual SubagentHandle. Keep one createNotificationDrain instance per registry; all dirty/restore/terminal signals join it. With admitTaskDelivery present, ordinary rows use that path exclusively; never fallback to generic admit. Without a trusted host adapter (including the not-yet-converted default CLI), ordinary rows/results remain pending/readable and do not auto-wake through this new source path. Do not report them delivered/woken. Generic ParentInputAdmission remains used by team at its existing entry, preserving team quiet/wakeup policy until D2.

Split restore into source restoration/qualification/classification and recipient activation: no ordinary notification admission during subagent.ready. At service publication, after exact assemblies.set, lanes.set, execution subscriptions and attach hooks, call assembly.drainParentNotifications, which now joins ordinary subagent handle and existing team handles. Install receiver event subscription before initial reconciliation; completion during any await sets dirty for another pass. Activation joins old source drain rather than creating a second one. Direct assembly consumers need an explicit host activation call after their real lane exists; absence keeps ordinary rows pending. Disposal deactivates synchronously and awaits existing drains; no substitute assembly callback runs after any await.

The service receiver scheduling drain reads only pending eligible `session.delivery.subagent` inputs with committed receipts. It invokes existing submit with admittedInputId, after exact published-owner/sessionOperation checks; single-flight+dirty coalesces signals. Wake is a hint: receiver pending recovery does not depend on source woken/ack. Active claim racing a queued hint becomes a normal already-claimed no-op, not a duplicate request/error or new admission. Source ack is saved only after receiver committed receipt, and remains derived evidence. A failed/claimed model request is never resubmitted by scheduling retry.

### Error retry eligibility and preserved debt

No successful-state interval. One timer per recipient uses100ms,500ms,2000ms, then5000ms cap **only for positively classified retryable original operations**. Freeze this private scheduling disposition (not persisted/wire/result authority):

```ts
type DeliveryDrainDisposition =
  | {kind:'settled'}
  | {kind:'waiting-source'}
  | {kind:'retryable';phase:'original-physical'|'temporary-admission'}
  | {kind:'blocked';reason:'invalid'|'conflict'|'unsupported'|'retired'|'out-of-scope'
      |'explicit-absence-retry'|'unclassified';debt:'retained'|'none'}
  | {kind:'suppressed';reason:'generation-closed'|'cancelled'|'claimed'};
```

| Observed state under the actual owner | Automatic timer | Required disposition |
| --- | --- | --- |
| Exact retained captured batch is unknown; known receipt/install recovery of that original batch can be attempted under same held authority | Yes, original observe/reconcile only | Preserve key/bytes/action/source; never allocate/replay a replacement. |
| Explicitly temporary pre-issue admission failure positively classified by its actual owner, no conflict/invalid/cancel/revoke | Yes, same pending operation only | Recheck same generation/scope before any first issuance. A generic thrown error or FACT_RECOVERY_REQUIRED alone is insufficient classification. |
| Source is running/not terminal, or result retained but original terminal not yet published | No | waiting-source; real original terminal/source changes dirty the drain. A registered real source may retry its own positively known original captured terminal; receiver never drains arbitrary live invocations or recaptures task result. |
| Conflict, FACT_INVALID_GROUP/structural invalid, unsupported capability, retired owner, out-of-scope source | No | blocked; preserve diagnostics and any original physical/cleanup debt. Invalid is a product failure to fix, not successful suppression. No permanent5s exception loop. |
| Absent original physical batch | No automatic write | explicit-absence-retry; original source may explicitly request retryAbsent after proven absence and current authority, never a new capture. |
| Known pre-issue cancellation/closed generation or already-claimed input, with no unresolved issued outcome | No | suppressed scheduler disposition; preserve retained result/audit, never label it successful execution or re-admit. |
| Retired/suppressed logical delivery still owns an issued-unknown frame or cleanup debt | No receiver scheduling timer after retirement | Keep original required debt/close failure under existing lifetime; suppression never discharges it. Same-owner cleanup/reconcile remains required before release/replacement. |
| Unclassified source/finalization/cleanup error, including generic recovery error without exact captured disposition | No | blocked/unclassified with debt retained; surface it. Do not infer retry safety from message text or code alone. |

A successful full drain clears timer/backoff. A real source/receiver state change cancels an outstanding timer and permits one new dirty reconciliation **only if the same actual authority still allows that original operation**. Reclassify its observed result; blocked rows do not keep dirtying themselves. Retirement cancels scheduling timer/subscriptions synchronously while original required owner cleanup remains separate. No catch-all retries, source/model replay, consumed-input resubmit or new authority after conflict. These dispositions do not overwrite TaskDoc/result outcome; a logically suppressed/unsupported notification remains readable, while unresolved operational debt still rejects appropriate settle/close acknowledgment.

## 7. Stop, close, rewind and acknowledgment

Keep `SessionService.cancelRunning(sessionId):{cancelled:boolean}` synchronous. It requests receiver close/fence before aborting model/current work, including when parent is live but currently idle with background work; cancelled still reports whether a current/queued model action was cancelled, not whether persistence completed. Missing/unmounted session is not mounted by Stop and has no new durable acknowledgment.

Add in-process service method:

```ts
awaitDeliveryStop(sessionId:string):Promise<DeliveryCloseReceipt|undefined>;
```

It joins/attempts settlement of the exact latest requested live Stop's original close and returns undefined if this service never requested one. It rejects retained unknown/failed closure until same-owner settle can complete; it never performs another Stop or source capture. Subsequent service submit first awaits/reconciles original delivery close debt before preparing new work; source/document close also joins it. Expose neither a new public wire method nor a fabricated success field now. Gateway/CLI callers may still acknowledge request only; awaited public acknowledgment is a later explicit contract.

Split today's `stopNotifications` into explicit user-stop fencing versus disposal revoke. Service close/closeSession/failed construction synchronously revoke the exact recipient runtime and its scheduling/drain callbacks; they do not append user-stop generation closure merely because a process is closing. Existing native/child cleanup still cancels/settles according to its actual owner. Allowed durable background state can be recovered by a later assembly; a new live owner cannot reuse old closures/callbacks.

`withRewindFacts(owner,restore)` obtains the same receivedInputsFor(owner), requests close('rewind') and awaits its original acknowledgment **before invoking restore**. Existing rewind fact/result retains original file effects and marker recovery; do not replay file restoration to repair a delivery close or rewind marker. A rejected close means zero new restoration effects; a failed restoration after confirmed close leaves generation conservatively fenced. New human input after fence is needed for new launch generation. Actual gateway createDesktopRewind already calls this helper after owned document/fingerprint/busy checks; no extra gateway rewrite is needed.

Issued-before-Stop physical frames may later prove committed. Their historical admission/claim is preserved; a subsequent committed close suppresses only unconsumed work. Immediate live revocation prevents new beforeIssue after Stop; no claim is made that an already issued frame can be unissued. A process cut before any close issuance cannot durably remember an unrecorded click. The guarantee begins at confirmed close acknowledgment; issued-unknown remains explicit debt, with no success receipt or permission to start new background delivery.

## 8. Required compatibility: Session13, TaskDoc unchanged

These are required changes under the root-ratified13 contract; this document itself performs no migration:

The integrated B2 coordinator exposes `inspectBootstrapCapture(request:BootstrapCaptureRequest):Promise<BootstrapCaptureInspection>` and `bootstrapSemanticTargetWithCapture(request:BootstrapCaptureRequest,guards:BootstrapGuards,capture:()=>Promise<BootstrapRequest>):Promise<BootstrapOutcome>`, optionally together under the actual backend capability. Its backend seams are checkBootstrapCaptureRoot/readBootstrapCapture/prepareBootstrapCapture/settleBootstrapCaptureIO; BootstrapHeaderStage carries optional captureReservation. D1a does not call these to authorize delivery or change their types/phase semantics. Its13 work only preserves their literal original11/12 stage/birth behavior while allowing new current13 births. Root's B2 integration is already complete; no public F1 implementation is a prerequisite for this service-local packet.

- `core-session/events/types.ts` current13; register three required event types in persistence format registry; add12→13 identity event migration. Both current shape validation and physical frame validation reject new delivery facts under≤12. A predecessor12 binary rejects header13 before repair; even a malicious header downgrade leaves unknown required event types/nonignorable records and must refuse without rewriting. Freeze literal predecessor fixtures/source runner from baseline before changes, not a current reader configured to pretend old support.
- Current core JSONL and JSONL backend contain explicit framed lists `[6,7,8,9,10,11,12]`; include13 everywhere in the exact serializer/parser/read/repair/updateMeta/upgrade branches. `upgradeSessionFormat` expected-set must accept genuine12→13; `backend/format-upgrade.ts` must treat12 as already-framed, copy only header, and preserve exact journal legacy metadata/body/frame bytes. Never reinterpret existing frame envelopes as legacy JSON lines or recompute the legacy digest over them.
- Preflight genuine old12 in old profile first. After durable header upgrade, old body has no new authority, open delivery generation or launch binding. Add no synthetic historical source facts during migration. First genuinely new authorized spawn can open a generation; completed old12 tasks remain readable through original get_task_output/retained reference and normal task document qualification, but absent binding cannot enter admitTaskDelivery or the receiver scheduler. No new adoption API.
- `conversation/bootstrap-validation.ts` current accepted `[11,12]` must allow13 readiness while preserving exact original seed manifest/initial-input/birth validation. `coordinator/bootstrap-header.ts` currently hardcodes new header12 and validates11|12; new births use current13 after root ruling, literal original11/12 stages are still parsed/bound as originally born. B2 pre-capture variants/full-stage reservation and their exact bytes remain its owner's accepted contract.
- `backend/fact-journal.ts:preserveBootstrapBirth` currently allows only11→12. Permit original birth11 or12 under current13 (and11→12 retained case), with unchanged original stage.headerBytes, manifest/preimage/digests/seed+completion+initial-input phase bytes. The special original bootstrap-phase append lane currently only accepts noncurrent11; extend it to original11/12 **only for exact original seed/completion/initial-input frames**, never arbitrary delivery/new operational append under an old header. Inspect/recover original B2 readiness before ordinary writable upgrade; no new source callback or second initial input.
- Genuine11→13 upgrade must preserve/confirm bootstrap birth before header replacement, as11→12 did; genuine12→13 with semanticSeed must perform the same actual preserve/confirm check, not skip because birth was previously current12. Preserve original claim/resources and B2 cleanup debt. Failed file-close/replacement/unknown is surfaced under original upgrade owner, not called absence or a new bootstrap chance.
- Session13 readers continue literal11/12 source views for observation and semantic source export; recipient operational facts never flow into seed-import. Existing source DTOs do not gain IO/writer authority. Public F1 plans must consume the reviewed current constant and extend their caller compatibility matrix without independently changing format or rewriting original stage records.
- TaskDoc stays1|2 and existing JSON shape/legacy provenance rules remain. Do not add generation/sourceSeq/terminalSeq/receiver claim fields to TaskRecord or TaskNotificationRecord. Use actual managed scalar references during each drain. Existing outbox status/error/timestamps remain derived scheduling records only.

Legacy ordinary inputs already committed by the inspected12 service carry task display metadata. Suppress their automatic receiver eligibility when `producer==='session.notification' && synthetic.display.kind==='task'` and no new receipt; retain audit/result bytes and do not relabel them as consumed. Team metadata `team-message|team-result`, mailbox facts and generic ParentInputAdmission preserve their existing path. The new ordinary source also refuses unbound old task rows before invoking the generic adapter, so default CLI does not fabricate new proof. Historical unlabeled custom host injections are not upgraded into trusted ordinary delivery; this packet does not claim exhaustive classification of every older/custom generic system input. Root must keep that distinction in the compatibility report rather than parse model-like task tags as authority or disable team legacy globally.

## 9. Decisive acceptance and explicit limits

Required real service fixture: actual JSONL coordinator with locks; actual createSessionService; controlledModel only at provider seam; real model-issued spawn_agent with background default and private role binding; real TaskRegistry/result owner/start/end/Inbox/lane. Child completion and backend append/reconcile may be causally held. Record actual launch, tool dispatch, result revision/ref/bytes, admission, grouped promotion and real request bodies independently. No fake consumer, fake terminal record or successful-only counting in decisive tests.

Cover distinct equal text→two inputs; same key/rerender→one; terminal end held after result retention→zero wake; original end reconciled→one; cold original result **and committed end** restore before publication→deliver after exact published lane; cold durable-bytes/missing-end→readable-or-recovery-required with no receipt/wake/replay; receipt physical-landed/response-unknown; source-ack/wake/claim crash cuts; active/idle claim race; Stop before/during each capture/prepare/issue; original claim commit before Stop; explicit Stop while parent idle; next human turn cannot revive old child; ordinary followup/steer does preserve old child; callback after dispose/replacement cannot wake; one cleanup failure retains original resources; summary/rewind/fork seed boundaries; genuine old12 readable/no auto wake and actual predecessor rejection/birth preservation.

Add exact origin-order controls: supplied/pre-opened action before input-start; legitimate no-preopened post-input-start action from its raw message; active B steer claimed under A's already-open action with no extra B action; replay same original consumed action succeeds; new actionId or admitted/raw alias on the consumed B fails; post-Stop new issuance fails while original already-issued reconciliation/history remains truthful. Add actual delegated/B2/unknown/synthetic parent compatibility controls showing accepted spawn and original result read still succeed with unavailable D1a auto-delivery, plus genuine trusted open unknown/error refusing launch. Retry controls separately assert one timer for a known original unknown and zero timers for invalid/conflict/unsupported/retired/out-of-scope/unclassified, with debt preserved and no repeated attempt unless an actual same-authority change permits it.

Known-ready outcome controls preserve the accepted retained-batch same-invocation proof: original action/input/task/revision/error metadata, one producer, original capture.observe/reconcile, no recursive aggregate unwrapping/new retry token. Source terminal cancellation/recovery-required stays truthful/readable and is not a completed notification. Lack of native platform support or unavailable original result reader is an explicit qualification limit, never a fake completion.

This packet does not release an active wait on unrelated A when B completes. It makes B eligible for the next normal step or idle turn; D4 adds the trusted background-event observation cause using this eligibility. Existing human-steer ready/cancel precedence and producer survival are required unchanged regressions.

## 10. Interface and scope self-audit

| Surface | Existing owner | Draft delta | Guard against scope/authority expansion |
| --- | --- | --- | --- |
| Result/terminal | TaskResultOwner/createSpawnSource | Signal drain only after original committed terminal | No copy/revision remint/producer replay; artifact/native qualification preserved. |
| Cold bytes without terminal proof | Existing task publication/witness and journal owner | Honest no-wake recovery-required negative | No lost capture reconstruction from TaskDoc; broader failure-delivery obligation remains open. |
| Generation/binding/receipt | ManagedDocument/core validation | Three required event types and three closed groups | Root-selected13; concrete refs/frame membership/seed boundary; no TaskDoc trust. |
| Received intake | ReceivedInputSource | Three narrow capture methods | Required original outcomes; guarded admission beforeIssue; no public generic append. |
| Claim | AsyncInbox/managed input promotion | Same eligibility in pending/stage/beforeIssue | Cached service read cannot grant claim; consumed key never resurrects. |
| Finite-action origin after claim | Generation/delivery staged indexes | Exact lookupActionOrigin(open), one action across admitted/raw aliases | Historical same action remains valid; steer consumption grants no new action. |
| No own human root | Existing child/B2/direct/synthetic execution | Bound/unavailable preparation before any generation capture | Valid unbound spawn/result read preserved; no inherited/shared delivery generation. |
| Stop | SessionService/required input source | Immediate revoke plus awaitDeliveryStop | Request acknowledgment remains synchronous/honest; no unissued disk durability claim. |
| Rewind | withRewindFacts/original rewind source | Confirm close before restoration | No replay of file effects/marker; fork target imports no operational authority. |
| Wake/lifecycle | Existing service lane/assembly/subagent drain | Post-publication activation+dirty reconciliation | No replacement-owner callbacks/parallel drain/model lane. |
| Error retry | Actual original capture/source owner | Retryable/blocked/waiting/suppressed classification | No catch-all5s loop; notification suppression does not discharge physical debt. |
| Legacy ordinary/team | Actual task display/outbox vs team mailbox | New ordinary fail-closed path; old team unchanged | No text-tag trust; no global suppression of team generic notifications. |
| F1/ID/B2/HOST | Existing assigned writers | Consume reviewed format/ports after integration | B2 exact stages/birth; HOST Store/index untouched; no public caller redesign. |

## 11. Root rulings and reserved execution

1. Session13/event/frame/original11/12 birth contract is ratified. TaskDoc remains1|2. The actual predecessor12 reader and genuine old files must prove migration/refusal; no emulated old constant is sufficient.
2. One writer at a time owns core/persistence/JSONL and then service/assembly/spawn. Root assigns fresh Sol workers for the three review tasks, preserving the same branch/interfaces. Task1 protocol approval is not whole D1a acceptance. Public F1 and C2/ID consumers wait for the relevant reviewed shared interface.
3. Existing external Stop acknowledgment remains request-only; in-process awaitDeliveryStop joins the original required closure. Public awaited acknowledgment remains an explicit follow-on obligation.
4. Ratified100/500/2000/5000ms capped backoff requires the positive retry classifier below. Permanent invalid/conflict/unsupported/retired/out-of-scope/unclassified failures never acquire a timer. Logical suppression cannot discard physical debt.
5. Old ordinary results remain readable where authorized without inventing delivery proof; team stays on its existing consumer. Valid delegated/synthetic/unknown-origin parents retain accepted spawning/result reads when D1a binding is unavailable. Their automatic delivery and cold missing-end failure notification remain named follow-on obligations before whole-version closure.
6. The historical-action lookup is distinct from pending eligibility and supports the exact original pre/post-promotion action orders, with no second action across origin aliases. Managed beforeIssue covers both origin forms. No current live fence invalidates historical replay.

No unexecuted test is recorded as passing. Final packet review must bind exact promoted source and preserve causal failures/setup issues; full Task5, native cross-platform, GUI push, public semantic callers and packaged0.1.13 gates remain root-owned.
