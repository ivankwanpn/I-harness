> Root contract promotion2026-10-28: same-reviewer task-3-contract-rereview.md closes I1/I2 at design level. Exact reviewed addendum SHA256AE8ED15A7DD3F84124BBE14E1FE65424EA3FFBFEBB152343055F71AE26B24D59. The complete proposed body follows; integration units still require root source reservation and exact task briefs before implementation. Pure Unit1 is being corrected/reviewed, Unit2 is next. No production host support/default/release or original-body protocol proof is implied. Existing V1 route semantics and product0.1.13-rc.1/Session13 remain unchanged.

# Task 3 integration contract addendum — Important 1 and Important 2

2026-10-28. Read-only research proposal for root and the same reviewer's freeze. This document supplements, and does not edit, `task-3-contract-preflight.md` or its approved pure DTO/domain/stage/manifest/facts contracts. Units 1–2 may proceed under root's separate release; the integration interfaces below require review before units 3–5. No product/runtime/test/probe/network/dependency/Git mutation, moving-checkout inspection or protected-name enumeration was performed in this addendum turn. Only this document was authored.

Evidence: exact `git show 61320f2878e34a89f4a9a5b68a43c4c5cbebcca1:<path>` for persistence `fork-inline-host.ts`, `coordinator/{bootstrap-types,bootstrap,managed-document,binding-observation,fact-types}.ts`; Gateway `src/fork-session.ts`; executor `src/lifecycle/result-observation.ts`; core `conversation/selected-results-types.ts`. The review is ROOT `task-3-contract-review.md`.

## A. Important 1: original selected source and inherited owner

### A1. Evidence that forbids merely retaining today's callback objects

The existing Gateway host opens a source witness, then enters `withExistingSessionBindingObservation`, `projects.withBindingObservation` where applicable, and `nativeContext.withResultObservation`. `ResultObservationScope.run` installs an ALS object whose `active` becomes false in finally. `legacyObservationFor` delegates its currentness to that exact result observation. The Gateway handoff also flips its own active flag and closes transfer state on exit. The binding observation owner releases locks/pins at callback completion. Thus a reader obtained in this scope is not usable after it returns, even if document/view references still match. Existing V1 warm mode reacquires scopes; copying that implementation and retaining reader A would violate the selected contract.

**Decision:** use a new internal operation-held selected source owner, separate from callback-scoped V1 observations. Do not extend the lifetime of existing callback objects by removing their revocation, save escaped ALS state, park a callback on an unresolved Promise, or reopen reader B during warm retry. The new owner must be implemented by the original binding/result/protocol owners, sharing their acquisition, identity and revocation machinery. Until that owner and the genuine inherited metadata adapter are available, selected host admission returns unsupported before reservation. This is a required later integration unit, not an assertion that frozen HOST already has this API.

### A2. Exact host-facing types

Names from the preflight retain their exact definitions. These capability interfaces are internal objects, not serialized DTOs; no caller can deserialize or mint the handles. Own enumerable data/method descriptors are captured once with original receivers, Node proxies/accessors/unknown properties rejected. A private issuing-owner registry binds handle identity to controller/coordinator/operation/source; it is not a persistent registry, source inventory or authorization based on a digest.

```ts
interface HeldSelectedForkSource {
  readonly sourceSessionId: string;
  readonly document: ManagedDocument;
  readonly view: SessionView;
  readonly events: SessionView['events'];
  readonly eventCount: number;
  readonly inherited: HeldInheritedResultMetadata;
  assertCurrent(): void;
}
// All members above are fixed for the handle's life, including inherited identity.
// Authenticated by the selected host factory; public object literals are rejected.

type SelectedForkHandoffMode =
  {kind:'first'} |
  {kind:'warm';source:HeldSelectedForkSource} |
  {kind:'passive'};
type SelectedForkHandoff =
  {kind:'source';source:HeldSelectedForkSource;guards:SelectedResultsGuards} |
  {kind:'passive';guards:SelectedResultsGuards};

interface SelectedResultsForkHost {
  assertAvailable(): void;
  resolvePreparation(request:ForkPrepareRequestV2,signal?:AbortSignal):
    Promise<{metadata:BootstrapCallerMetadata;project:BootstrapProjectIntent}>;
  withHandoff<T>(operation:ForkOperationV2,mode:SelectedForkHandoffMode,
    control:ForkExecutionControl,
    use:(handoff:SelectedForkHandoff)=>Promise<T>):Promise<T>;
  releaseSource(operation:ForkOperationV2,source:HeldSelectedForkSource):Promise<void>;
  withReadyTarget<T>(operation:ForkOperationV2,document:ManagedDocument,
    use:()=>Promise<T>):Promise<T>;
}
```

First and warm modes must return `kind:'source'`; passive must return `kind:'passive'`, with no source field. A warm call must return the **same handle object**, same document/view/events/count and same inherited reader object passed in mode.source. SourceSessionId equals operation.core.sourceSessionId, checked against the original managed document and observed metadata, not the supplied reader. Operation equality includes normalized prepared core/intent and complete invocation. Cross-controller/coordinator/operation handle reuse refuses before callback. `releaseSource` validates that same binding, is idempotent, and never frees a different operation's owner.

The controller's selected holder adds `source?:HeldSelectedForkSource`, `sourceRelease:'none'|'held'|'releasing'|'released'`, and the existing cleanup-handle set. It records the source handle **immediately when first use is entered, before calling B2**, even if reservation later fails or never begins. This prevents leaking the original observation if the original capture callback is never entered. B2 still alone retains the immutable captured request; neither the host nor holder recreates it.

The holder also retains the original once-only capture closure until it is entered or permanently retired. That closure reads the currently active selected handoff guard from an internal per-use slot; it does not retain an expired first-use wrapper. The slot must name the same authenticated source handle and is populated only during first/warm use, then cleared in finally. Callback identity remains fixed; the once-entered bit is set before any await and never reset. After capture the closure is discarded, while B2 retains its captured DTO. An expired or absent slot refuses; it cannot initiate acquisition. Per-use AbortSignal belongs to that use only; operation retire/close and original owner revocation fence the retained lifetime independently of an expired use wrapper.

The host guarantees: acquisition failure before use cleans all acquired resources or returns an original-owner cleanup-debt error; successful use entry transfers responsibility to controller releaseSource, including when use throws. Host per-handoff finally disposes only ephemeral target/protocol wrappers and their debt; it does not release the operation-held source. First mode is never called again once a handle has been handed off for this operation. If absence is proved and capture has not been attempted, the same current handle can support a later first reservation attempt through warm mode, but the B2 callback gate remains strictly committed-new/never-entered. A warm callback must still be the original stored capture closure, not a replacement closure that reprojects a source. Once callback entered or reservation is spent/unknown, warm may only continue the captured DTO or reconcile.

### A3. Underlying owner implementation contract

Implement a private selected source lifetime owner alongside executor result-observation, with a retainable observation primitive in persistence binding-observation. Its external host contract is the handle above; the following describes exact obligations rather than a second public API.

1. First acquisition flushes/opens the actual source managed document once, captures the exact ready witness, obtains real source binding observation and project read scope, validates the actual lineage/source identity, and obtains the original protocol metadata reader for that observation. A fork source's retained result metadata is read from that source; do not reopen its ancestor. The existing `discoverResultLineage` stops at fork origin; preserve that boundary. No body scan or grant acquisition is needed for metadata discovery.
2. Underlying identity consists of actual managed document/view/event-array/count, original observed metadata and binding versions, original project authority/read scope, actual result source identity, and the original inherited metadata owner's observation. Keep those owner objects, not only hashes/IDs. `HeldInheritedResultMetadata` remains the accepted core interface; do not add public sessionId/release flags to core or trust an arbitrary reader's asserted source ID. The original protocol factory validates source identity before attaching its reader to the host-issued handle.
3. The private lifetime states are `acquiring → held → retiring → released`, with `held → revoked → retiring` on source/binding/host invalidation. `assertCurrent` succeeds only in held, with every original owner's assertion and immutable witness equality passing. Revocation is terminal; no reactivation or substituted observation. Each async acquisition and reader advance checks before/after await. The wrapper passed to B1 delegates to these assertions; it never substitutes a constant predicate.
4. Retain the original source pins/binding leases and original metadata-reader resources after a first handoff returns blocked. This is an explicit lifetime extension owned by the new selected primitive, not an escaped `withExistingSessionBindingObservation` callback. It must reuse the existing lease root, pinOwnership and binding-key lease owners. Do not retain a `withSessionOperation` queue turn while idle. No alternate locks/root or source reacquisition is allowed.
5. Retainable scopes participate in the same `scopes`, mutation intersections and close/revocation machinery as current binding observations. Unlike the current callback-only scope, an idle selected scope must respond to revocation by retiring and releasing itself immediately; a source mutation must not wait forever for an unrelated future retry. With an active handoff/reader use, revoke first, prevent further new work, join the active use and its IO, then release. This is an explicit implementation requirement for the extracted lifetime helper; merely holding today's callback scope open is invalid.
6. A warm handoff creates fresh **ephemeral** target/protocol wrappers and a per-use cancellation guard, but enters the original selected owner's use scope and keeps source handle/reader identity unchanged. No new source profile/lineage acquisition, read observation, metadata reader or origin plan is permitted. Warm asserts all retained owners before entering and after leaving use. Any original owner expired/revoked means source-changed for already-issued work; do not replace it to make the operation succeed.
7. Source-owner retirement first revokes future reader/currentness calls, then waits for active metadata iterators/handoff uses, closes original protocol metadata reader resources, releases original binding locks in reverse order and pins in reverse order. Genuine owner close methods keep their original receivers. An error retains the actual unfinished resource ledger; retries continue that ledger, never reacquire it. The core reader itself need not expose close: its original host/protocol owner owns disposal.

The new lifetime primitive must offer explicit per-use context entry to install original observed bindings/result scope, rather than exposing its ALS objects. V1 callback APIs continue their original finally-revoked behavior and do not receive selected retention flags. This is a focused owner extraction plus selected handle; no second lease manager or generic persistent observation service.

### A4. Currentness, missing reader and passive behavior

For first capture and every later **new write**, selected guards.assertCurrent executes: host available → operation not retired → current handoff active → per-use signal not aborted → sourceHandle.assertCurrent (including original inherited owner) → current target preparation assertion when applicable. B1's `held-public-fork` owner uses the exact source.document/view/sourceSessionId and an assertion delegating to this guard; inherited.assertCurrent delegates to the same original lifetime plus the protocol's own currentness. All selected projection checks and final DTO publication use it. A successful export does not discharge the requirement to retain original inherited currentness through later new writes.

Missing inherited factory/retention support is `ForkAdmissionError('unsupported')`; a supported factory unable to supply the genuine original reader is `ForkAdmissionError('source-unavailable')` (policy denial remains policy). This occurs before use/B2 reservation. Outer result is V2 not-issued with that reason and uncaptured only with proved absent/no-debt evidence. Acquisition cleanup failure supersedes a simple not-issued presentation with operation-bound cleanup-incomplete. Empty inherited metadata is valid only if the genuine owner verifies an empty enumeration; never synthesize an empty reader as fallback.

Passive mode must not call source flush/open/profile/lineage discovery, project source getter, withResultObservation, inherited factory or handle.assertCurrent. It may retain a previously stored source handle without using it and may release it. It enters target-only proof/reconciliation scopes. Its guards.assertCurrent always throws a stale-source/cancelled admission error; this permanently disallows new seed/completion writes in passive mode. `targetPreparation.reconcile`, `dependencies.reconcile`, `assertTargetCurrent` and exact issued-frame ACK use target/protocol reconciliation currentness, without calling the forbidden new-write guard. Cold adoption therefore requires actual target retained proof, not live source substitution.

### A5. Release/debt table for the reviewer's trigger

| Outcome | Source and cleanup ownership |
| --- | --- |
| First acquisition fails before use | Host closes original partial acquisition; original handle debt is registered if close fails. No reservation. |
| Source acquired; reservation definitely not issued | Controller may release source before returning terminal not-issued. If keeping a retryable operation, retain same handle; never remint first acquisition. Cancellation/retire releases. |
| Capture succeeds; partial header blocks; first handoff exits | Retain original handle A and reader A. Dispose ephemeral handoff wrappers only. B2 retains DTO. Warm returns A; it never acquires B. |
| Reservation spent but callback fails/refuses | No callback replay. Release source after B2/ephemeral IO settles; original operation/reservation/debt remain. Passive inspection remains possible. |
| Retry blocked with a usable captured DTO | Retain A while operation remains active/current. Revocation/retirement releases A and leaves passive recovery only. |
| Ready/adopted | Perform target qualification with checked B2 receipt, then release A and settle per-handoff debt before returning success. Release failure yields cleanup-incomplete retaining lastOutcome captured; retry is passive reconciliation/cleanup, never capture. |
| Retire/close | Fence new work and revoke A immediately; join active controller/B2 flights, settle target capture IO and ephemeral protocol debt, release original source resources, then clear holder reference. Retrying cleanup uses original handles only. |
| Source/binding revokes while idle | Retire/release source resources without waiting for next controller call. Keep a revoked handle/tombstone in holder until cleanup acknowledged; later warm fails and cannot reacquire. |

Associate selected host cleanup errors with the same coordinator-owned `ObservationCleanupHandle {retry():Promise<void>}` mechanism used by `associateForkHostCleanupOwner`/`observationCleanupFor`, using a separately typed selected-host association. Debt blocks new work. Target capture lease is B2-owned and never released by releaseSource; source pins are never confused with target lease. No callback may close its own active lifetime: reuse controller/binding reentrancy guards and schedule retirement outside the callback.

## B. Important 2: selected B2 types, dispatch and fact admission

### B1. Decision on shared interfaces

Keep existing `BootstrapOutcome`, `BootstrapReceipt`, `BootstrapReadState`, `BootstrapDocumentControl` public signatures, existing V1 route backend and owned fact methods intact. Add **separate selected interfaces** below on an optional internal `selectedResultsBootstrap` backend capability. Shared namespace lookup and managed registry use explicitly discriminated internal unions; no unchecked cast from selected to legacy. The old bootstrap route parsers/readers remain old-format readers. A new internal any-route dispatcher validates each arm and calls its corresponding parser. Existing old public/private writers still reject V3.

```ts
type SelectedB2Receipt = ForkReceiptSummaryV2 & {
  seed:FactReceipt; completion:FactReceipt;
}; // seed is REQUIRED: even zero rows/groups has its manifest record
type SelectedB2Outcome =
  {kind:'ready'|'already-ready';receipt:SelectedB2Receipt;document:ManagedDocument} |
  {kind:'not-issued';reason:'cancelled'|'stale-source'|'unsupported'} |
  {kind:'blocked';reason:'unknown'|'payload-required'|'dependency-unavailable'|'source-changed';
    token:ResumeTokenV2} |
  {kind:'refused';reason:'conflict'|'nonempty'|'cached-unprepared'|'wrong-view'|
    'incompatible'|'manifest-invalid'|'target-policy'};
type SelectedCaptureInspection =
  {kind:'absent'} |
  {kind:'reserved';reservation:SelectedResultsReservationV1} |
  {kind:'materialized';route:SelectedResultsRoute;stage:SelectedResultsHeaderStageV2} |
  {kind:'conflict'|'unavailable'};
type SelectedB2Inspection =
  {kind:'absent';invocation:BootstrapInvocation;needsConfirmation:false} |
  {kind:'reserved';invocation:BootstrapInvocation;token:ResumeTokenV2;needsConfirmation:true} |
  {kind:'ready';invocation:BootstrapInvocation;
    token:Extract<ResumeTokenV2,{manifestDigest:Digest}>;needsConfirmation:true} |
  {kind:'conflict'|'unavailable';invocation:BootstrapInvocation;needsConfirmation:false};

interface SelectedResultsCoordinator {
  inspectSelectedResultsCapture(request:SelectedResultsCaptureRequestV1):Promise<SelectedCaptureInspection>;
  inspectSelectedResultsTarget(request:SelectedResultsCaptureRequestV1):Promise<SelectedB2Inspection>;
  bootstrapSelectedResultsTargetWithCapture(request:SelectedResultsCaptureRequestV1,
    guards:SelectedResultsGuards,capture:()=>Promise<SelectedResultsBootstrapRequest>):Promise<SelectedB2Outcome>;
  resumeSelectedResultsTarget(request:SelectedResultsCaptureRequestV1,
    guards:SelectedResultsGuards):Promise<SelectedB2Outcome>;
}
```

Resume accepts the complete request, never invocation alone or caller-supplied originalPayload. It uses only B2's retained authentic DTO or checked committed journal records. An absent cold retry is blocked payload-required with unknown-header token; only capture entry may issue new reservation. Known token digest is computed from the checked selected stage/birth; unknown token is only phase header, manifest unknown. V1 tokens are never converted by version relabeling. `inspect…ready` means structurally complete birth needing protocol/target/frame confirmation, not a public ready result.

B2 receipt fields seedDigest/sourceObservation/results/seedLength/manifestDigest come from the same stage plus recompiled checked records/facts; dependencyClosureDigest comes from actual V2 confirmation and must equal completion. FactReceipt fields are checked by the original held owner/incarnation/key/count/lastSeq/prefix machinery; seed and complete batch IDs remain existing `bootstrap:${operationId}:seed|complete`. No initial receipt exists. Closed readers reject missing/extra fields and validate both receipt scopes. Outer mapping copies only `ForkReceiptSummaryV2` fields from this checked receipt, maps already-ready to adopted, and binds original V2 operation/title/target. Do not derive missing commitments from a new source capture or a caller-provided receipt.

### B2. Closed storage read and resolved birth shapes

The selected backend returns data snapshots with the following exact arms. Uint8Array fields are owned copies; capability objects such as document/held owner are not JSON-cloned. All parsed DTOs use the preflight closed validators. Malformed/torn artifacts are observations, never parsed stages.

```ts
type SelectedArtifacts = {
  stage: {kind:'absent'} | {kind:'reservation';bytes:Uint8Array;value:SelectedResultsReservationV1} |
    {kind:'full';bytes:Uint8Array;value:SelectedResultsHeaderStageV2} |
    {kind:'unreadable';bytes?:Uint8Array};
  promotion: {kind:'absent'} | {kind:'present';bytes:Uint8Array};
  publication: {kind:'absent'};
};
type SelectedTargetRead =
  {kind:'absent'} |
  {kind:'incomplete';bytes:Uint8Array} |
  {kind:'journal';rawHeader:string;meta:SessionMeta;
    events:readonly SessionEvent[];prefix:JournalPrefix;
    frames:readonly BootstrapFrame[];torn:boolean};
type SelectedBootstrapReadState =
  {kind:'absent'} |
  {kind:'present';route:SelectedResultsRoute;artifacts:SelectedArtifacts;target:SelectedTargetRead} |
  {kind:'unavailable';reason:'foreign'|'collision'|'malformed'|'io';present:boolean};
type SelectedResolvedBirth = {
  protocol:'public-results-v1';route:SelectedResultsRoute;
  stage:SelectedResultsHeaderStageV2;facts:SelectedResultsPreparationFacts;
};
type ResolvedAnyBirth =
  {protocol:'legacy';birth:ResolvedBootstrapBirth} | SelectedResolvedBirth;
type AnyRouteRequest =
  {kind:'legacy';route:BootstrapRoute} | {kind:'selected';route:SelectedResultsRoute};
type AnyRouteRead =
  {kind:'legacy';state:BootstrapReadState} | {kind:'selected';state:SelectedBootstrapReadState};
```

`present` is returned only after exact namespace/route/key validation; unreadable own stage/partial target can be represented for warm retained-byte continuation, not authorization. `absent` means target and whole namespace absent, checked under lease/tombstone fences. Forbidden selected publication, foreign key/mixed route and collision never produce present. Size exceeded/unreadable IO must not allocate unbounded bytes; missing unreadable.bytes means bytes not safely obtained. `journal.meta` is validated to the selected header profile before exposing journal data (SessionMeta is the existing typed wrapper, not a new permissive selected header parser). Prefix read here is read-only and does not repair.

`resolveBirth` returns SelectedResolvedBirth only for complete checked selected birth, including original stage, record reconstruction and all immutable equality/hash/layout/frame checks. It throws/refuses if a selected header lacks its original stage; undefined means no semantic birth only. A separate internal `resolveAnyBirth` dispatches to legacy/selected after recognizing header format and unique namespace; recognizing V3 chooses a validator, not a synthesized public route. Headerless resume already carries complete selected request and never uses resolveBirth to invent it.

### B3. Explicit selected backend and owned lane

```ts
type SelectedHeaderOperation = {
  route:SelectedResultsRoute;target:{kind:'new'};
  stageBytes:Uint8Array;headerBytes:Uint8Array;
};
type SelectedLaneScope = {
  route:SelectedResultsRoute;stage:SelectedResultsHeaderStageV2;
}; // issuer-authenticated internal snapshot, never a JSON-issued capability
interface SelectedResultsBootstrapBackend {
  readState(route:SelectedResultsRoute):Promise<SelectedBootstrapReadState>;
  readCapture(id:string,owner:HeldFactOwner,route:SelectedResultsRoute):Promise<SelectedCaptureInspection>;
  reserveCapture(id:string,owner:IssuingFactOwner,route:SelectedResultsRoute,
    bytes:Uint8Array):Promise<BootstrapCaptureReserveOutcome>;
  prepareHeader(id:string,owner:IssuingFactOwner,operation:SelectedHeaderOperation):Promise<HeaderOutcome>;
  reconcileHeader(id:string,owner:HeldFactOwner,operation:SelectedHeaderOperation):Promise<HeaderOutcome>;
  resolveBirth(id:string):Promise<SelectedResolvedBirth|undefined>;
  readJournalPrefix(id:string,owner:HeldFactOwner,scope:SelectedLaneScope):Promise<JournalPrefix>;
  appendOwnedBatch(id:string,owner:IssuingFactOwner,scope:SelectedLaneScope,
    prefix:JournalPrefix,batch:EncodedFactBatch):Promise<BackendFactOutcome>;
  reconcileOwnedBatch(id:string,owner:HeldFactOwner,scope:SelectedLaneScope,
    prefix:JournalPrefix,batch:EncodedFactBatch):Promise<BackendFactOutcome>;
  confirmFrames(id:string,owner:HeldFactOwner,scope:SelectedLaneScope,
    expected:readonly BootstrapFrame[]):Promise<
      {kind:'committed';receipts:FactReceipt[]}|{kind:'unknown'|'conflict'}>;
}
```

Reuse unchanged `BootstrapCaptureReserveOutcome` and `HeaderOutcome` exact shapes shown in frozen bootstrap-types; they have no versioned payload. IO settlement remains the same original `settleBootstrapCaptureIO(id,held)` ledger; selected methods register their handles/flights with that owner, not another lifecycle. Backend support detection requires every selected method plus the existing real lease/root/settlement capabilities. Unsupported fails before capture.

The selected scope is explicitly passed to prefix/append/reconcile/ACK, not inferred from arbitrary V3 bytes. The coordinator creates it only after a valid original stage bound to authentic capture or checked birth; backend still revalidates actual disk namespace/header/stage against it under the held target owner on **every** operation. A handle alone or matching digest does not authorize IO. Wrong route, operation, target, stage or owner fails before mutation/fsync/ACK. No current-build legacy denial is removed to implement this lane.

Cold managed opening first calls resolveAnyBirth read-only; selected result supplies the validated stage/facts and thus selected scope. Only then may selected readJournalPrefix repair a torn suffix. Legacy opening preserves old flow/guard behavior. Selected prefix repair requires complete original birth; initial header/seed staging uses the selected bootstrap owner's explicit phase path and cannot go through ordinary cold repair. Selected append/reconcile validates exact staged header and incoming bootstrap phase against retained stage; later ordinary suffix frames require complete birth and retain its bytes. Completing seed data is not evidence that protocol preparation succeeded: coordinator admission below supplies that gate.

### B4. Route-neutral fact admission, without casting guards

Frozen managed-document's bootstrap control only reads guards.signal and guards.assertCurrent; it does not consume dependency/preparation ports. Extract that precise private subset:

```ts
interface BootstrapAdmissionGuard {signal?:AbortSignal;assertCurrent():void}
interface SelectedBootstrapDocumentControl {
  readonly held:HeldFactOwner;
  admit(phase:'seed'|'completion',events:readonly SessionEvent[],
    guard:BootstrapAdmissionGuard):Promise<FactOutcome>;
  ready():void;
}
type ManagedBootstrapBinding =
  {kind:'legacy';operationId:string;bind(control:BootstrapDocumentControl):void} |
  {kind:'selected';operationId:string;scope:SelectedLaneScope;
    bind(control:SelectedBootstrapDocumentControl):void};
```

A shared private enqueue implementation consumes only BootstrapAdmissionGuard. Keep the existing V1 control wrapper accepting BootstrapGuards and forwarding its signal/currentness to it; the selected wrapper accepts the subset directly. Thus no V2 dependency port ever enters a V1 port field. Use descriptor-captured closures invoking the original receiver; do not pass detached methods. Bootstrap binding kind chooses the backend lane for all staged/admitted/reconciled frames; ordinary operations on a selected-born document retain that selected scope after ready. Legacy document creation keeps legacy methods.

Selected B2 sequence:

1. Binding-observation adds dedicated `withSelectedBootstrapCapture` / `withSelectedBootstrapResume` wrappers. They validate complete selected request/guards/callback once, then use existing bootstrapMutation(invocation) target mutation admission and reentrancy fencing. They do not call old captureBootstrapRequest or spread selected ports into BootstrapGuards. Reads use selected capture inspection under the actual pinned target lease.
2. Original captured DTO validates selected stage and source binding; selected coordinator constructs mandatory V2 preparation/dependency inputs from that DTO or reconstructed exact records. Invoke appropriate confirm for new work, reconcile for already-issued recovery. Both confirmations must succeed; no empty-artifact shortcut.
3. Immediately before admission form `{signal, assertCurrent(){ checkSelectedNewWork(); checkSelectedTargetCurrent(); }}`. `checkSelectedNewWork` incorporates retained source owner, inherited observation and operation revocation; target failure maps to original FACT_PRECONDITION_STALE behavior. Do not expose dependency objects to the document queue.
4. Managed-document uses its existing capacity ticket, authorization and pump. Captured admission guard is checked at admission and again by issuer.beforeIssue; queue waiting cannot bypass revocation. The selected scope directs append/reconcile to selected backend. Batch encoding, keys, owner/incarnation, pending/outcome logic and receipt validation remain original fact mechanisms.
5. For adoption, reconcile protocol/target proofs, check original birth and confirmFrames with explicit selected scope. Validate actual receipts before control.ready; no admission/new-write guard is invoked on passive-only confirmation. A passive attempt reaching admit must fail currentness before issue. Source loss may still allow exact prior-frame confirmation, never a new completion frame.

No new public managed-document writer method is introduced. Backend lane wrappers and selected control remain private to bootstrap/managed owners; generic create/importSeed/supplied-batch APIs cannot request a selected scope. `ready()` is an internal owner transition after checked proof/receipts, not a caller-controlled boolean.

## C. Required narrow controls and closure map

| Review trigger | Contract and future control |
| --- | --- |
| Reader A captured, partial header, handoff exit, warm retry | Same registered handle/reader A survives under original retainable owner; warm ephemeral wrappers differ, source identities do not. Test zero reader reacquisition, zero second projection/callback, same receiver/currentness failures. |
| Missing genuine inherited reader | Factory unsupported/unavailable before reservation, no empty fallback; test zero reservation/capture and correct debt if partial acquisition cleanup fails. |
| Source mutation while blocked | Idle owner revokes/releases promptly; no held session-operation queue turn or mutation deadlock; warm refuses source-changed; passive can only reconcile retained target proof. |
| First use throws before callback | Holder already owns source handle; cleanup release/debt is operation-bound. |
| Passive cold retry | Poison all source/profile/lineage/reader acquisition methods; no access; target proof/ACK only; forced admission hits failing new-write guard. |
| First seed/completion admission with V2 ports | Dedicated control receives only signal/currentness; selected backend lane sees exact scope; old ports are poisoned and untouched. |
| Cold selected reservation/stage | Closed selected read union preserves discriminants; no old parser or public fallback; target absent/full-stage path returns payload-required without supplied payload. |
| V2 success fields | Checked B2 receipt carries exact original seed/source/results commitments and both fact receipts; outer maps selected fields explicitly, no V1 token conversion or re-projection. |
| Owned prefix/append/reconcile/ACK | Wrong/missing scope rejects before byte mutation/ACK; valid scope still requires actual unique retained birth; torn-tail negative leaves bytes unchanged. |
| Scope/callback cleanup | Retire/close revoke before join; active self-close denied; release failure retried on original ledger; no fresh capture after debt. |

These additions close the interface choices requested by I1/I2 without changing pure preimages or DTOs. They add a real lifetime requirement: the frozen callback-scoped Gateway/executor host cannot be reused unchanged. Unit boundaries should be (a) selected retainable binding/result owner plus host adapter and lifetime tests, (b) selected B2 closed interfaces/dispatcher, (c) explicit selected fact lane and small admission subset, then integration. Keep shared owner extraction focused and preserve V1 callback semantics with compatibility tests. Task 5 still supplies the genuine protocol metadata implementation and actual managed/L1 transfer/recipient proof; until those owners are available, production selected host support remains absent. Task 4 old ACTIVE evidence, Task 6 exposure/native positives and later child/default/release gates remain unchanged.
