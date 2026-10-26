# F1-C connected public semantic fork specification

Status: **Root-promoted on2026-10-26 after accepted D1a and FC01–03 contract review.** Product0.1.13-rc.1/Session13; no independent format change. Root assigns a fixed integrated BASE and one isolated owner before implementation. Original drafts, candidate documents, reviews and historical evidence remain unchanged.

## 1. Outcome, ownership and dispatch boundary

One connected public cut reaches actual persistence `forkSession`, SDK→CLI stdio, Gateway router/manager/broker, real Desktop IPC and both renderer callbacks. Managed catalog/member and legacy selected results survive original source clear/close and cold target read/search, including a second nested fork. The original semantic-fork-baseline summary+tail/no-consumed-body oracle becomes GREEN through its real public entry. Helper-only acceptance or refusal replacing a positive retrieval oracle is invalid.

Use accepted B1 selection, B2 durable pre-capture stage/promotion/receipt, F0, existing-session observation, L0/L1 result owners unchanged in authority. No new seed/receipt/completion registry, private stage format, store/index schema, raw-history fallback, arbitrary ref/descriptor cap or native replay permission. Product remains `0.1.13-rc.1`. Session13 is accepted; consume **root-approved CURRENT_FORMAT_VERSION at actual dispatch** without hardcoding a proposed version or allocating another transition. Preserve historical11/12 bootstrap birth/stage compatibility and accepted Windows interruption/restart bounds.

D1a's accepted generation/source/receipt facts are operational authority, not forked conversation. Consume its final root-integrated source and preserve B1's operational-fact exclusion and selected conversation/result inheritance. Real fork tests must prove target has no inherited delivery generation/source/receipt eligibility and source remains unfenced. F1 owns the shared public router/SDK/native bridge/app fork integration slot **before O1**. O1 source/subscription keys, epochs, revisions, controller and first-pane semantics remain reserved. C2/ID independent instruction factory, provider B3 and R6 remain subsequent owners.

## 2. Actual integrated contracts and caller gap

Existing APIs to consume, **not implement again**:

```ts
// persistence normal entry + existing browser leaf /fork-contract
readForkRequestCore(input:unknown):Readonly<ForkRequestCore>;
createBootstrapRequestIntent(core:unknown,project:BootstrapProjectIntent):
  {intent:BootstrapRequestIntent;requestDigest:string};
captureBootstrapCaptureRequest(input:unknown):BootstrapCaptureRequest;
// Actual optional coordinator members
inspectBootstrapCapture?(request:BootstrapCaptureRequest):Promise<BootstrapCaptureInspection>;
bootstrapSemanticTargetWithCapture?(request:BootstrapCaptureRequest,guards:BootstrapGuards,
  capture:()=>Promise<BootstrapRequest>):Promise<BootstrapOutcome>;
withSessionBindingObservation?<T>(request:SessionBindingObservationRequest,
  use:(observation:SessionBindingObservation)=>Promise<T>):Promise<T>;
withExistingSessionBindingObservation?<T>(request:ExistingSessionBindingObservationRequest,
  use:(observation:ExistingSessionBindingObservation)=>Promise<T>):Promise<T>;
// Existing unconditional B2 surfaces
resumeSemanticTarget(invocation:BootstrapInvocation,guards:BootstrapGuards,
  originalPayload?:BootstrapRequest):Promise<BootstrapOutcome>;
inspectBootstrap(invocation:BootstrapInvocation):Promise<BootstrapInspection>;
```

The exact observation request/result types remain those in coordinator/types.ts. New capture capability already gates supported locking/platform, all original B2 backend functions and four actual root/read/reserve/settle backend hooks. It already owns once-only callback, original held/issuer reference, IO cleanup, strict absence and captureReservation preservation. Do not reimplement those gates, create an admission token or reach through backend hooks from F1.

`ForkRequestCore` is actual `{version:1,kind:'session-fork-core',sourceSessionId,selection:{kind:'completed',atSeq?},sourceCapture:'first-authorized-capture',metadata:BootstrapCallerMetadata}`. `BootstrapCaptureRequest` is actual `{invocation,core,requestIntent}`. Current B2 outcome/token/receipt and actual optional observation signatures stay unchanged. B2 preserves callback faults including null/undefined/falsy; F1 must not lose them in catch/truthiness handling.

Source-based gap: persistence fork.ts still profiles→completedTurnPrefix→create→importSeed. SDK client still sends old `session/fork {sessionId}` and casts SessionIdResult; server advertises old session-fork from its simple callback. CLI index.ts flushes then calls old fork. Gateway router's manage fork checks busy before manager; manager profiles/idle/fence/flushes, old fork then host post-READY `projects.inherit/nativeContext.inheritFork`. Desktop bridge/IPC carry action fork; both app.tsx callbacks cast sessionId and await refresh before navigation. Actual strict mode/observed legacy APIs exist but both host constructors/tools omit them. Accepted BC11 is real B2+managed transfer/cold-read evidence, not public caller or legacy/nested completion.

## 3. Closed public data and errors

Extend **existing** persistence `src/fork-contract.ts` browser-safe leaf with these data types/readers. Type-only imports of existing BootstrapInvocation/RequestIntent/CallerMetadata/ResumeToken are permitted; no Node/engine/SDK runtime imports. Add SDK `/fork` browser-safe re-export leaf; no persistence↔SDK cycle. Reuse actual ForkRequestCore and its validator; do not redefine/hash it in SDK/renderer.

```ts
interface ForkPrepareRequest {
  version:1;sourceSessionId:string;
  selection?:{kind:'completed';atSeq?:number};
  metadata?:BootstrapCallerMetadata;
}
interface ForkPrepared {
  version:1;kind:'session-fork-prepared';core:ForkRequestCore;
  requestIntent:BootstrapRequestIntent;requestDigest:string;
}
type ForkPrepareResult = {kind:'prepared';prepared:ForkPrepared}
  | {kind:'unavailable';reason:'unsupported'|'source-unavailable'|'policy'|'unavailable'};
interface ForkOperation {
  version:1;kind:'session-fork-operation';prepared:ForkPrepared;invocation:BootstrapInvocation;
}
interface ForkCommand {operation:ForkOperation;mode:'begin'|'retry'}
type ForkCaptureState='uncaptured'|'captured'|'unknown'; // evidence, never authority
interface ForkReceiptSummary {
  version:1;invocation:BootstrapInvocation;manifestDigest:string;
  seedLength:number;dependencyClosureDigest:string;
}
type ForkSuccess={version:1;kind:'ready'|'adopted';operation:ForkOperation;capture:'captured';
  sessionId:string;seedLength:number;receipt:ForkReceiptSummary;title?:string};
type ForkOutcome=ForkSuccess
  | {version:1;kind:'not-issued';operation:ForkOperation;capture:ForkCaptureState;
      reason:'cancelled'|'stale-source'|'unsupported'|'busy'|'source-unavailable'|'policy'|'unavailable'}
  | {version:1;kind:'blocked';operation:ForkOperation;capture:ForkCaptureState;
      reason:'unknown'|'payload-required'|'dependency-unavailable'|'source-changed';token:BootstrapResumeToken}
  | {version:1;kind:'refused';operation:ForkOperation;capture:ForkCaptureState;
      reason:'conflict'|'nonempty'|'cached-unprepared'|'wrong-view'|'incompatible'|'manifest-invalid'|'target-policy'
        |'invalid-selection'|'source-unsupported'|'ambiguous-boundary'|'no-completed-boundary'
        |'straddling-group'|'unsafe-input-component'|'invalid-seed'|'source-changed'|'legacy-anchor-unsupported'};
interface ForkHostErrorData {
  version:1;kind:'session-fork-error';operation:ForkOperation;capture:ForkCaptureState;
  reason:'host-unavailable'|'cleanup-incomplete'|'internal';lastOutcome?:ForkOutcome;
}
```

Exact readers: `readForkPrepareRequest`, `readForkPrepareResult`, `readForkOperation`, `readForkCommand`, `readForkOutcome(input,expectedOperation)`, `readForkHostErrorData(input,expectedOperation)`, and pure `createForkOperation(prepared,identity:{operationId,targetSessionId,createdAt})`. Capture/freeze own closed fields; reject extra/undefined/accessor/symbol/unsafe values. Browser validates JSON descriptors and existing core limits, not impossible proxy-trap freedom or hash authority. Node hosts reject proxies/strict-data violations and recompute core/intent using actual canonical owner, then use actual capture request validator. Preserve actual model/protocol/title/ID bounds, no new ones.

Node admission follows the existing canonical sequence: read the existing core, recompute `createBootstrapRequestIntent(core,requestIntent.project)`, validate the complete invocation through the existing owner, then call `captureBootstrapCaptureRequest({invocation,core,requestIntent})`. Invocation is exactly `{version,operationId,targetSessionId,createdAt,requestDigest}`; retain the actual printable-ASCII operationId bound1..237, canonical UTC millisecond timestamp, source/target path checks and existing metadata bounds. Do not impose a UUID-only rule or trust prepared hashes as host authority.

Success requires exact original operation/invocation, target sessionId, matching top/summary seedLength, resolved optional title, valid receipt digests/counts. Map B2 ready→ready and already-ready→adopted only from its actual outcome/document; no inspect-derived receipt. Blocked token equals full original invocation, preserving unknown-manifest variant. Every post-mint failure retains the original locally valid operation; malformed unvalidated incoming operation gets INVALID_PARAMS without unsafe echo.

RPC returns prepare/outcome union normally. A post-validation host/cleanup fault returns INTERNAL_ERROR plus exact ForkHostErrorData; no raw exception message/path/stack/guards/ManagedDocument/seed bytes. Prepare failures before an operation exists use a closed safe preparation error/unavailable mapping without fabricated ForkHostErrorData or unsafe echo. New fork handlers do not use the current generic SDK hostMethodFailure's exception-message serialization. `lastOutcome` is known owner result stored before cleanup, not current target permission. An error containing historical ready never navigates by itself. Local errors:

```ts
class ForkOperationError extends Error {
  readonly operation:ForkOperation;
  readonly kind:'outcome'|'transport'|'protocol'|'host'|'cleanup';
  readonly outcome?:ForkOutcome;readonly hostError?:ForkHostErrorData;
  // cause is local only and may be any thrown value, including undefined.
}
class ForkPreparationError extends Error {
  readonly kind:'unavailable'|'transport'|'protocol';
  readonly result?:Extract<ForkPrepareResult,{kind:'unavailable'}>;
}
```

Explicit prepare returns unavailable normally; convenience throws ForkPreparationError before mint. Post-mint convenience non-success/transport/malformed/host/cleanup becomes ForkOperationError with original operation. Use separate failure booleans, not truthiness, when storing/rethrowing cause. No implicit replacement invocation.

Node host admission uses `ForkAdmissionError extends Error` with readonly reason equal to the not-issued reason set above. It is a host composition fault, never parsed from RPC. Controller maps it to not-issued only when its own routing/flight proves first work was refused **before entering B2** with no prior reservation/capture/debt; later/passive/warm faults retain original outcome or become safe host/cleanup error. Do not trust an exception flag as absence proof. Actual B2 not-issued/blocked/refused map directly. B1 refusal inside the owner-invoked callback is retained in a private `ForkSelectionError` carrying actual SeedRefusal/legacy-anchor-unsupported; cleanup fault takes precedence as error with that known lastOutcome, not a fabricated clean refusal.

FC02 adds private Node `ForkTargetPolicyDeniedError extends Error`, issued only by the genuine host's known current target-policy check. It carries no wire authority. Only this typed distinction maps a post-handoff target check to `refused/target-policy` with the original operation and captured evidence. Unknown observation/IO/internal faults use the closed safe host mapping; cleanup failure takes precedence as `cleanup-incomplete` retaining original lastOutcome and exact debt. Do not infer target-policy from arbitrary message/code strings. No source/warm fallback or new identity follows any of these target-check failures.

Conservative capture evidence: uncaptured only for proved pre-callback/unreserved refusal; ready/adopted proves captured; a non-success after callback entry/reservation uncertainty is unknown unless actual accepted owner evidence proves more. Neither callback-attempt flag nor inspection absence is permission to recreate payload. Controller may retain callback-returned/witness flags for routing, but B2 alone decides whether original owned payload exists; warm callback is always a reentry trap.

## 4. Preparation and durable branch selection

Prepare omission resolves selection `{kind:'completed'}`. Resolve explicit metadata overrides plus source title/workspace/model defaults **once** from actual current metadata under existing-session observation; project/unassigned via Gateway broker, unmanaged via CLI. Metadata is original child creation intent; later changes do not re-resolve it. Validate current source visibility/archive and exact provisional lineage from held metadata/bindings. Prepare reads policy/metadata only; no source export, target IDs/reservation/header, grants, input/model/tool/assembly effects. Source atSeq is a numeric selection request, not a click-time snapshot.

Client synchronously mints operationId/targetSessionId/canonical createdAt once after prepared reply, before first mutation, using client crypto/clock and prepared digest. Host-only in-process convenience may mint once. Actual default completed cut is selected only **inside B2's reserved source callback** under genuine source view guards. No source-at-click promise.

Both begin and retry run identical server routing after operation/hash/receiving authority validation. Controller flight/known capture witness is considered before strict inspection; inspection cannot reset it. Before source profile, router busy, manager fence/idle or CLI flush:

1. Exact live operation joins its own flight; changed identity conflicts. Call actual `inspectBootstrapCapture(captureRequest)` (no source). Unavailable/conflict never means absent.
2. Materialized/reserved original routes to actual **passive resume first**. Use ordinary inspect only to distinguish historical ready vs incomplete for routing, never readiness adoption. Ready indication plus failed target confirmation never falls through to source work. Cold reservation/spent/unknown or lost witness remains passive blocked/refused.
3. Strict absent with no retained captured/spent state permits new-source preflight then actual `bootstrapSemanticTargetWithCapture`. Only that owner's callback performs B1 export/compile. B2 rechecks absence/reserves; no client mode convention grants capture.
4. Same-process retained original source witness may continue incomplete original after passive attempt only when it is not an already-ready target-policy/dependency refusal. Enter warm host scope, call actual withCapture with same capture request and a callback that throws a reentry trap if invoked. B2's owned original payload is authoritative; controller holds **no BootstrapRequest/seed cache**. Changed/lost witness or unclear route is passive only. New operation is explicit fresh intent.

Durable recovery is scoped to the **unchanged complete operation and target namespace**. Register/compare complete operation before first await and reject in-process operationId/target collisions. JSONL's durable sibling check is under the original target and complete invocation; in-process operationId checks do not establish cross-target/cross-process global operationId deduplication. Changing a target/other handle field is not retrying the original operation. Do not create a global index/registry; resend the same serialized operation across response loss, new RPC IDs and runtime reconnection.

Controller records `captureAttempted` before its actual B2 callback export, retaining source-only witness even on B1 refusal; never resets on absent/not-issued. Truly pre-reservation/pre-callback failures can remain uncaptured and first-capture later under same prepared intent if actual strict state permits. Reserved-but-zero-export is not that permission. Process loss after reservation but before payload can permanently leave original payload-required. Process-restart/Windows optional-directory limitation is inherited from accepted B2, not redesigned or strengthened.

FC06 actual B2 routing: `resumeSemanticTarget` is not intrinsically source-passive when that coordinator retains its owned request; its original run can issue incomplete publication/seed/completion work. The controller's passive handoff therefore supplies a source-currentness guard that refuses new source-derived issuance, while forwarding the real target preparation/dependency reconciliation and target-currentness capabilities. Genuine original READY adoption/confirmation, including the original owner's permitted header upgrade, remains available without source work. Only a later genuine warm handoff under the original unchanged source witness and actual new-work policy permits new continuation issuance. Do not weaken B2, invent a permission flag or reclassify outstanding debt as absence.

## 5. Public controller and exact host lifetime

```ts
interface ForkExecutionControl {
  signal?:AbortSignal; // genuine host/in-process control; never RPC permission
  withNewWork?<T>(sourceSessionId:string,operationId:string,use:()=>Promise<T>):Promise<T>;
}
interface ForkSourceWitness {
  document:ManagedDocument;view:SessionView;events:SessionView['events'];eventCount:number;
  assertUnchanged():void; // actual original source only, no expired attempt guard
}
type ForkHandoffMode={kind:'first'}|{kind:'warm';source:ForkSourceWitness}|{kind:'passive'};
interface ForkHandoff {source?:ForkSourceWitness;guards:BootstrapGuards}
interface ForkHost {
  resolvePreparation(request:ForkPrepareRequest,signal?:AbortSignal):Promise<
    {metadata:BootstrapCallerMetadata;project:BootstrapProjectIntent}>;
  withHandoff<T>(operation:ForkOperation,mode:ForkHandoffMode,control:ForkExecutionControl,
    use:(handoff:ForkHandoff)=>Promise<T>):Promise<T>;
  withReadyTarget<T>(operation:ForkOperation,document:ManagedDocument,use:()=>Promise<T>):Promise<T>;
  assertAvailable():void;
}
interface ForkSessionController {
  prepare(request:ForkPrepareRequest,signal?:AbortSignal):Promise<ForkPrepareResult>;
  execute(command:ForkCommand,control?:ForkExecutionControl):Promise<ForkOutcome>;
  retire(operation:ForkOperation):Promise<void>;
  close():Promise<void>;
}
createForkSessionController(coordinator:SessionCoordinator,host:ForkHost):ForkSessionController;
```

New Node owner `fork-controller.ts` owns closed operation identity, admitted whole flights, source-only witness, diagnostic lastOutcome and original host cleanup closures. It creates no durable phase or payload cache. B2 owns reservation/payload/receipt and original IO. Compare complete operation on operationId **and** target collisions; register before first await. Controller's witness does not retain F0/broker/attempt signal; each warm callback combines original document/view/events/count with fresh actual metadata/project/host/Stop authority. All B2 calls run inside host callback; no callback returns expired guards for later use.

In first B2 callback: assert actual source/host scope; set holder captureAttempted; call existing exportConversationSeed(view,{kind:'session',sessionId:core.sourceSessionId},core.selection), refuse actual B1 refusal, compile through existing owner; return request `{invocation,target:{kind:'new'},metadata:core.metadata,lineage:{origin:'fork',parentSession:core.sourceSessionId},seed}` with no initial input. No full request reference retained by controller after returning it. Store mapped actual outcome before host cleanup; cleanup failure retains original outcome/operation without rollback.

Before returning **current public success**, finish the original handoff cleanup, then call host.withReadyTarget with B2's actual ready document. This separate read callback uses actual existing-session observation of the now-existing target, current metadata/nonarchive/binding and a freshly acquired actual broker target scope plus READY view checks; never reuse the closed transfer getter. It is **outside B2 target mutation and after outer fork F0 exits**; do not nest overlapping target observation inside that F0 or use a reserved target profile. Validate immutable original seed tuple and current project/session authority, then return the validated success. Actual B2 generic adoption may allow mutable archived metadata; the host throws ForkTargetPolicyDeniedError only for known current target-policy refusal. Unknown target observation/IO/internal failure remains a safe host error. A post-receipt failure cannot fall through to warm/source work, and cleanup errors retain original lastOutcome/debt without navigating.

`retire` revokes new work, joins whole host flight/acquisition/transfers/release and original cleanup, drops source witness only when safe, leaves passive identity. It never clears B2 fence/target or grants fresh capture. Host close synchronously closes admission, joins all original controller work before dependent result service/broker/coordinator close, attempts independent disposers and preserves exact debt. In-process coordinator-owned controller association is a private **lifecycle-only** weak association, not completion authority. Default and injected controllers are joined at coordinator close by adding their join to existing B2/observation/managed close joins after synchronous self-wait checks/revocation; do not replace accepted B2 original-context/IO lifecycle.

FC01: the controller owns every admitted prepare/execute **whole flight**, synchronous closed/retired checks and its own abort/currentness signal. The whole flight includes initial metadata/root/lease acquisition, handoff cleanup, separate target qualification, result validation and retained cleanup debt. The source manager fence/outer observation may end before the target-only barrier; server/controller close must still join the whole request. Host close or explicit in-process retire synchronously fences first/warm new work and joins actual original cleanup before dependent service/broker/native resources close. Do not dispose a dependency that unresolved original cleanup still needs; attempt genuinely independent joins and retain same-owner debt. A coordinator lifecycle association alone does not replace CLI/Gateway server/controller joins before those resources close.

FC07 original observation cleanup: the existing binding-observation owner may expose a package-private coordinator-bound lookup of its exact issued cleanup error to a frozen `{retry():Promise<void>}` handle. Its per-owner weak association registers only the aggregate it actually creates after callback/acquisition has settled, referencing that same scope.cleanup/cleanupFlight. Existing index.ts associates the actual coordinator once; no public coordinator/host/DTO signature or completion/data/permission owner is added. No property/message/code/recursive aggregate inference, fabricated/wrapped error or foreign coordinator grants provenance. Keep original refuseSelf, callbackFinished, retained lock/pin arrays, literal falsy callback failures and consumed-release debt. Retry never waits rejected scope.done, replays a callback, reacquires resources or closes the whole coordinator. Nominal origin remains recognizable if another original close already acknowledged completion; the original handle then reflects idempotent done, not new proof.

Controller catches recognize this original cleanup before ordinary host/policy mapping. Preparation cleanup is retained before any operation holder exists; explicit retry/close joins it, and new execution cannot self-wait behind its own retained preparation scope. Operation debt is joined through original handles before same-operation recovery/new target observation. A later successful callback cannot erase unrelated cleanup debt. Close fences first, joins flights, attempts all independent original disposals and rejects until actual original cleanup succeeds; dependent resources stay retained. Full hosts preserve genuine handles before wrapping failures. Unrecognized errors remain safe host/policy errors, not arbitrary cleanup authority.

Existing public `session/cancel` remains **execution-input cancellation**; it does not promise to cancel an independent fork without a live assembly. No new public fork-cancel RPC or GUI cancellation authority is introduced. A genuine supplied ForkExecutionControl.signal is host/in-process control only. Source Stop can invalidate an actual source view through existing guards; no new Stop→fork-cancel mapping, persisted L1 clear/tombstone or capture reset is added. Passive original recovery stays source-less and checks current target authority. UI selection change/refresh failure retires a navigation ticket, not a server-cancel acknowledgement. Self-close from an owned host/read callback rejects synchronously before joining itself. Preserve coordinator's existing self-wait checks and synchronous observation/capture revocation before original/new joins.

Standalone `forkSession(coordinator,source,options={})` keeps atSeq/title/workspaceId and adds optional issued `controller?:ForkSessionController`. Result is ForkSuccess superset of old sessionId/seedLength/title. Convenience prepares/mints/executes and throws the typed errors. `retryForkSession(coordinator,operation,options?:{controller?:ForkSessionController}):Promise<ForkSuccess>` uses original controller or its coordinator default and never prepares again. Injected controller must be issued for that coordinator, not a caller-shaped object.

Default inline host uses actual metadata observation, outer unmanaged fork F0 and B2 capture. It supports only root/non-subagent/team, absent unmanaged bindings, selected artifacts/local legacy refs empty and no semanticSeed header indicating inherited sidecars. Before B2 it may conservatively require a real host on **any actual typed** managed artifact/ref or local context/result-ref fact, including a hidden/unselected one; no text scan or payload export. Inside the reserved B2 callback it still verifies the actual selected closure is empty before returning its request. If that final check refuses, the reservation remains spent; never export before B2 merely to promise zero reservation effects. No artifacts port returns constant confirmed; B2's actual no-artifact branch skips a throwing unreachable dependency port. Seed-bearing/artifact/project sources require real host and explicit unsupported/target-policy before ordinary target header/seed/grants, not a promise that every refusal precedes the private capture fence. This is the ratified conservative standalone limit; **shipped CLI/Gateway always use full real hosts**, supporting nested/nonempty retention. Never use this limit to weaken original native retrieval oracle. Original semantic baseline remains a real twoarg positive.

## 6. Observation-aware actual result/project policy (required to avoid reentry)

Actual gap: result-store/native-runtime sourceFor and authorize hooks profile source; Gateway broker resolveOwner/ensureVisible profiles source and waits operation maps. Calling them inside real F0/existing-read callback currently self-conflicts or can wait on a source mutation waiting for that callback. Do not remove observation/revocation to make tests pass. Add two bounded host-only adapters in the **existing owners**:

Exact adapter sites at preflight: executor `lifecycle/result-store.ts:51` sourceFor (independent-reader profile59, ancestry profile70/binding75), authorizeResult95 and snapshot101; Gateway `project-scope.ts:67` ensureVisible, load76, resolveOwner116/pending operations134, resultReadScopeFor445/profile446/wait448; Gateway `context-runtime.ts:28` projectScope, sourceFor36 and managed/legacy authorize40/48, plus host visibleRefsFor198–201's snapshot fallback. All must use the actual held data branch for scoped actors. Making a broker/fence owner gate reentrant does not provide held metadata/view or remove these public-policy calls.

Exact current call chains causing this conflict:

- CLI outer F0 → B2 dependencies.confirm → actual ContextOutput confirmSeedDependencies → artifact/bootstrap-transfer's authorized path → result-store authorizeResult → sourceFor → public coordinator.profile(source) → observations.assertOutsideObservedSession → conflict.
- Gateway source-only existing-read callback → targetPreparation.confirm → broker prepare → resolveOwner(source,reading=true) → ensureVisible → public coordinator.profile(source) → the same conflict. resolveOwner also awaits operations.get(source), which can wait for a writer joining the held observation.
- Gateway actual managed transfer authorizeResult → runtime sourceFor → projectScope → public coordinator.profile(source), again inside held source observation.
- Gateway readLegacyObserved/searchLegacyObserved → service allowedObserved → actual options.authorize → runtime sourceFor/projectScope → public coordinator.profile(observed target). Existing catch→false may hide the recursion as denied/empty search; positive actual retrieval plus zero profile-call controls are required, not just absence of a thrown error.

```ts
// executor/lifecycle/result-observation.ts; one instance per existing store/runtime
interface ResultSourceObservation {
  sessionId:string;metadata:Readonly<SessionMeta>;view:SessionView;
  source:NonNullable<ContextCapture['source']>;assertCurrent():void;
}
interface ResultObservationCapture {
  sessionId:string;sessionIds:readonly string[];
  observation:ExistingSessionBindingObservation|SessionBindingObservation;
  document:ManagedDocument;
  currentSource():NonNullable<ContextCapture['source']>;
  assertHostCurrent():void;
}
interface ResultObservationScope {
  run<T>(capture:ResultObservationCapture,use:()=>Promise<T>):Promise<T>;
  current(sessionId:string):ResultSourceObservation|undefined;
}
createResultObservationScope():ResultObservationScope;

// Existing Gateway project broker, host-only callback; no new authority registry.
withBindingObservation<T>(sessionIds:readonly string[],observation:ExistingSessionBindingObservation,
  use:()=>Promise<T>):Promise<T>;
```

Use callback-scoped AsyncLocalStorage, capture actual host descriptors/functions/document without JSON cloning, revoke at callback exit, assert before/after await. `run` is invoked only **inside the original actual F0/existing-read callback**. It reads metadata from that exact observation and view from that actual READY document; it does not accept metadata/view/sourceId JSON as overrides. `currentSource` is the existing owner's canonical workspace/current broker or unmanaged resolver, bracketed by actual scope/host guards, not a client-selected source. SessionIds is the already-held exact set, not authority to expand it. Treat an observed actor lacking a supported current view as refusal, never a public-profile fallback.

No global mutable override or late fallback: if an actor has an expired context, current throws rather than ordinary sourceFor. Context contains **actual held metadata/view/source guard**, no grants/roots/receipt cache; tools/RPC cannot construct it or supply control/observation fields. Unrelated nonobserved actors retain ordinary policy. The recorded ResultSourceObservation is a private derived callback value, not a reusable issued scope or a new client-shaped authority. These adapters provide restrictions/current data to existing policy, never substitute for canonical artifact/legacy membership. No observation is retained as permission after its callback.

Result-store/runtime sourceFor consults its own current observation first and performs no public profile in that branch. Managed authorization uses observed source/view and existing managed/semantic ref policy rather than snapshot/profile reentry; canonical transfer/pins/membership remain real. Legacy authorize in the scoped strict-observed path enforces current host/source/project equality; **L1 already enforces exact typed local/plan/anchor/canonical membership before it**, so do not additionally demand copied raw legacy refs in the child. Unscoped library compatibility path keeps its existing restrictions. Unavailable store/settings/index never becomes empty/true. No ContextOutput service/status signature changes.

Within broker withBindingObservation, ensureVisible/load/resolveOwner consume exactly requested captured metadata/strict bindings, guard and parse through current owner, recompute exact existing lineage and update only existing derived broker maps. No public coordinator.profile/getDocument for held source IDs. If a conflicting broker operation is pending, refuse policy rather than await it while it may be joining this observation. Keep existing broker epoch/reference/binding ABA and confirmed roots authority. Its resultReadScopeFor keeps current signature; while a complete actual scoped lineage is held, it may return the existing-currentness getter for an inherited/unbound consumer without ordinary profile traversal. Unscoped behavior remains. No binding writes or newly acquired ancestor inside callback; source-only observation never includes target during broker preparation.

Broker must keep its current epoch/root availability/session visibility checks before and after each real await even when metadata comes from observation. The adapter cannot turn captured binding into confirmed roots or skip archive/runtime-session policy. Runtime/store authorization still checks current host/session/source policy after asynchronous owner work; zero profile recursion is not blanket profile bypass. Name/placement above are the only necessary host composition extensions; public ContextOutput methods/status and request DTOs do not gain observation/override fields.

This is a frozen necessary composition change, not B2 redesign. Actual host tests must trap source profile/snapshot fallback and pending-operation waits so the adapter cannot be an unused export.

## 7. Actual host sequencing

**CLI full host**, new executor `lifecycle/fork-handoff.ts`, real shared result-store owner:

1. Prepare using actual existing-session metadata/binding observation, bounded provisional source lineage and canonical unmanaged workspace. Actual binding absence only for unmanaged route; no fake project/readScope.
2. After strict receipt routing proves first/warm work, control.withNewWork if supplied; source flush/open/repair and provisional lineage discovery outside F0, or unchanged original warm witness without re-export/open replacement. Acquire actual shared **reader** lease (no assembly/model), source-key first/warm, target-key passive. Undefined service/settings/failed retirement refuses, never empty closure. Disabled new capture still permits genuine retained transfer.
3. Acquire outer `withSessionBindingObservation` with complete existing lineage and original invocation. Recompute exact actual metadata/bindings/lineage, no expansion. Execute result-observation scope around real B2 and transfer policy. Source callbacks combine held observation + original view witness + host/Stop; target preparation validates actual B2 reservation/facts and held absent unmanaged target binding, no ordinary target profile.
4. Lazy targetPreparation creates actual L1 scope from B2 facts after target identity confirmation; legacy confirm/reconcile also runs for empty managed closure and exact empty plan. Real managed ports register full operation/manifest/source/target/document tuple and call confirmSeedDependencies/reconcileSeedDependencies. No success stub.
5. Passive has existingSessionIds[], no source observation/access/profile/open/flush/sourceFor/availability. Actual target identity comes from held target binding and actual B2 facts/receipt owner. Join transfer/L1/preparation before F0 exits, release reader afterward, retain exact original cleanup capability on failure.

**Gateway full host**, new `src/fork-session.ts`, existing manager/broker/native runtime:

1. New dedicated router methods pass a host-only withNewWork callback. Only first/warm source work invokes it: it checks activePrompts/compacting/modelSwitches/other fork flight, registers original operation busy flight before await, runs actual source manager fence/visibility/idle/flush and clears only its own flag. Passive never touches source busy flags. Duplicate original controller flight joins before these checks.
2. Open actual source/retain original warm witness outside observation. Discover source-only lineage; hold existing-session observation across B2 in broker.withBindingObservation and runtime result-observation scope. Source IDs exclude original target, so broker target binding write is legal. No unmanaged outer F0 around broker writes. Current source metadata/archive/lineage, view and broker revision must remain current through await; no source profile reentry.
3. Use actual `prepareBootstrapTransfer(capture,sourceAccess|undefined)`. Broker target confirm/reconcile checks actual reservation/project, then L1 confirm/reconcile with actual B2 facts, then managed dependencies; all before READY. Target sourceId derives broker targetScope after confirmation; no reserved target ordinary profile. B2 source callback runs before any target project/grant/preparation/dependency effects.
4. Passive omits source observation/access and source hooks, requalifies current target broker state only. Remove public-fork post-READY projects.inherit/nativeContext.inheritFork after genuine replacement is connected. C2 inherited-session hooks remain separately owned.
5. Existing transfer.close retires admission; host joins actual B2/preparation/dependency/L1 work and resources before leaving callback/broker/runtime. Cleanup never rolls back issued pins/owners or erases known result.

Manager exposes `withForkSource<T>(sourceSessionId:string,use:()=>Promise<T>):Promise<T>` for the exact existing visibility/fence/idle/flush lifetime. It does not prepare a target or resume a receipt; controller invokes it only in first/warm source mode. Its entire use promise includes actual host/B2/transfer cleanup. Both full hosts and standalone implement the separate withReadyTarget barrier above; target-only authority is not inferred from source permission.

## 8. Pure commitment/read visibility and strict real tool reads

Expose existing ContextOutput `legacy/fork-codec.ts` function only as `captureLegacyRefCommitment(ref:ContextResultRef):LegacyCommitment` through current index. It is the same streamed full metadata codec/domain/count/fractional expiry; no duplicated hashing, descriptor clones/caps or graph access.

Add one pure facade in existing core `conversation/seed-retention.ts`, reusing its facts/visibility/turn metadata and **existing B1 projected-history index**:

```ts
type LegacyVisibilityAnchor={kind:'manifest';seq:0}|{kind:'seed-group';manifestSeq:0;ordinal:number};
type LegacyVisibleRef={ref:Extract<SessionEvent,{type:'context/result-ref'}>['ref'];
  original:{seq:number;part:'context/result-ref.ref'}};
type LegacyReadVisibility={kind:'refused';reason:SeedRefusal|'legacy-anchor-unsupported'}
  |{kind:'visible';local():Iterable<LegacyVisibleRef>;
      anchorVisible(anchor:LegacyVisibilityAnchor,extent:TurnExtent):boolean};
createLegacyReadVisibility(view:SessionView):LegacyReadVisibility;
type LegacyReadObservationRunner=<T>(access:ContextAccess,
  use:(observation:LegacyReadObservation)=>Promise<T>)=>Promise<T>;
createContextOutputTools(service:ContextOutputService,
  options?:{withLegacyReadObservation:LegacyReadObservationRunner}):Tool[];
```

Factor shared structural metadata with existing retention selector; no second history/replacement/ancestor walker or payload export. Transfer's completed selector/child rebase remains unchanged. Read local() permits actual visible local typed ref facts in current unfinished turn, excludes rewound/shadowed ones, validates unique safe coordinates and yields no text-derived authority. Full five-field commitment equality uses actual codec, not ID only.

Read anchor evaluation is **current-coordinate visibility**, not child rebase: validate exact original manifest/group ordinal/seq and full extent/domain. For seed-group require actual current B1 surviving seed-item recipes for that event and coverage of the row's complete framed interval by their extents; hidden/rewound/replacement-consumed group or incomplete/straddling coverage is false/refused as appropriate. Use existing projectHistory replacement consumption; raw event presence/any ordinal is insufficient. Manifest anchor is only exact visible seq0 semantic manifest plus unframed row/domain, not unconditional true. Nested provenance is L1's existing verified plan/row authority, not a host ancestor replay.

Structural corruption/unsupported soundness refuses; known invisible returns false. If a predicate fails after facade creation, host retains that failure and assertCurrent rethrows it so L1's caught denial cannot turn it into a successful empty search. No helper/index/unavailable→[] fallback. Operational delivery facts are excluded via current B1 owner; no inheritance of their authority.

Implement strict runner in executor result-observation owner and Gateway native runtime. Actual ready document opens **outside** existing-session observation. Discover bounded lineage; hold `withExistingSessionBindingObservation` for current metadata/bindings, validate exact chain/current nonarchive/receiving host policy and immutable seed tuple against actual READY view, then derive source scope/pure visibility and call observed read/search inside result/broker observation contexts. Parent source clear must not cause ancestor source profiling for a fork-origin ready target. Snapshot header is not current metadata. No synthetic invocation/target or B2 mutation in this ordinary read callback.

Before/after every host/service await, inside predicates and after body/search IO: assert actual observation, document.assertReady, exact original document/view/events identity+count, host/Stop and broker getter currentness. Same-coordinator append is allowed by metadata observation but invalidates this read result. No public profile/load/open of held IDs or recursive policy/service calls; sourceFor uses scoped observed branch. Only synchronous pure predicates enter ContextOutput jobs/serial/quota; acquire observation outside them.

Set immutable requireObservedLegacyRecipients:true when constructing both real host services, not on a replacement active instance. Default shared store returns a strict runner; supplied Gateway service passes its actual runner through AssemblyOptions `contextOutputLegacyReadObservation?:LegacyReadObservationRunner`; assembly supplies it to tools. Both legacy tool read(refId) and search use observed methods. Managed ref/cursor/catalog branch remains accepted reader. Public service/status contracts stay unchanged despite private HOST index work. Legacy clear/delete/expiry/canonical tombstones and actual membership remain L1-owned; temporary scope ABA/Stop is not persisted clear.

Actual SessionServiceOptions already extends AssemblyOptions and both assembly constructors spread opts (`service.ts:121,615–618,658–661`, also checked only at immutable Task3 a8caffe7). Adding the runner does not itself require service/rewind/delivery changes. Runtime's current coordinator option is only Pick<SessionCoordinator,'profile'|'onDocumentDeleted'> (`context-runtime.ts:12`); explicitly extend/narrow the real host construction type to the READY-document/existing-observation methods consumed, without casting a partial coordinator into a full one. Existing core retention selector remains the structural owner; no second projection walker.

Preserve IC-B's main host environment and independent Session manager: public fork does not assemble source or target and never transfers source manager/activation/ack/request-token authority. The target's later ordinary assembly creates its own manager through the existing host environment. C2/ID owns actual fresh/resident/team/reviewer/detached instruction factory wiring later; do not create another child factory through the assembly runner seam.

## 9. SDK/bridge migration and both UI callback lifetime

Actual shipped hosts advertise only `session-fork-bootstrap:['1']` when all handlers+real host are connected. Do not interpret old session-fork capability as semantic. Old raw-ID `session/fork` and desktop/manage fork are retired/refused before mutation; all other management unchanged. ProtocolVersion unchanged; source-level client.forkSession/HarnessSession.fork uses the new protocol and returns ForkSuccess superset, never old-wire fallback.

```ts
// wire
'session/fork/prepare' : ForkPrepareRequest -> ForkPrepareResult;
'session/fork/begin'|'session/fork/retry' : {operation:ForkOperation} -> ForkOutcome;
// SDK server options, both required to advertise
prepareForkSession?:(request:ForkPrepareRequest)=>Promise<ForkPrepareResult>;
executeForkSession?:(command:ForkCommand,control?:ForkExecutionControl)=>Promise<ForkOutcome>;
// Node SdkServer only: optional host control, never parsed from RPC params.
handleLine(line:string,controls?:{fork?:ForkExecutionControl}):Promise<string|null>;
// SDK public client
prepareForkSession(request:ForkPrepareRequest):Promise<ForkPrepareResult>;
createForkAttempt(prepared:ForkPrepared):ForkClientAttempt;
retryForkSession(operation:ForkOperation):Promise<ForkOutcome>;
interface ForkClientAttempt {readonly operation:ForkOperation;readonly lastOutcome:ForkOutcome|undefined;
  run():Promise<ForkOutcome>}
forkSession(sessionId:string,options?:{atSeq?:number;title?:string;workspaceId?:string}):Promise<ForkSuccess>;
// Desktop bridge
{kind:'desktop/session/fork/prepare';workspaceId:string;request:ForkPrepareRequest}
{kind:'desktop/session/fork/begin'|'desktop/session/fork/retry';workspaceId:string;operation:ForkOperation}
```

Gateway routes these exact session/fork methods before manage busy prechecks, validates and calls base SDK handleLine with its host-only fork control. The base server invokes executeForkSession with that control and remains the validator/knownSessions owner; do not bypass it with a parallel router result path. Only the fork handlers consume the optional control. CLI SDK server passes no fake Gateway gate. RPC params reject control/observation/override extras. Server and client validate every result/error; knownSessions only on actual validated success. IPC known-workspace validation and capability gate forward exact RPC names; receiving workspaceId is authority/routing, not a metadata override. Browser imports `/fork` only.

Track/join actual prepare and execute callbacks as whole requests in the SDK/host lifecycle; current server close only joins its existing prompt/preparation/history owners (`sdk/src/server.ts:890`). CLI joins fork work before service/coordinator teardown (`apps/cli/src/index.ts:863–865`); Gateway joins it before projects/service/native runtime close (`desktop-gateway/src/router.ts:697–711`, `host.ts:524–528`). Include a suspended prepare acquisition and suspended final target check. Keep the source withNewWork fence distinct from this whole-request join. F1 changes this public fork slot before O1; it does not add subscription/source semantics.

Current transport sends once/request, timeout rejects without cancel/resend; runtime restart does not replay arbitrary calls. Tests deliberately resend begin anyway: correctness is B2's fence. ClientAttempt stores operation before first send, marks dispatched before transport, joins concurrent run and uses retry after first send; no new IDs on error. Operation JSON is sufficient remote recovery handle across new connection/process; local convenience error.operation supports retry through original controller/B2. No durable UI seed/receipt registry.

One renderer controller in `renderer/session/fork-operation.ts` serves **both** app.tsx callbacks. Key held attempt by workspace/source; reserve prepare flight synchronously so duplicate callbacks join preparation too. Store full operation before mutating bridge call; store validated success before dashboard refresh. Transport, malformed reply, blocked result, cleanup and refresh failure retain identity/outcome. Pure dashboard refresh may retry without forking or navigating from stale evidence. After failed refresh or scope change, navigation requires **same-operation passive target requalification** plus current/original selection guards across every await; cached historical success alone never navigates. Selection change retires the navigation ticket without claiming server cancellation. No source fallback/new ID. Explicit retry/fresh actions preserve existing controls/style; abandoning error creates a new operation only after explicit intent and safe flight retirement. IDs/digests/capabilities stay implementation details.

## 10. Acceptance and scope limits

Mandatory evidence: unchanged original semantic baseline through actual twoarg fork; actual SDK stdio prepare/begin/retry/error/result-read; Gateway actual router+manager+broker+IPC both callbacks; nested managed catalog+member **and** legacy VISIBLE read/search after source and intermediate-source clear/cold reopen; HIDDEN/FUTURE/foreign/pre-READY/unobserved negatives; disabled capture inheritance; original creators differ from observing fork source; source profile/model/assembly/input/tool counters0 on passive ready adoption; one capture/target/seed/completion/application after lost response or repeated begin.

Warm tests use original document/view witness and B2 owned payload; source re-export counter0. Cold spent reservation payload-required remains blocked. New-source refusal before reservation can later first-capture same intent/cut timing. Unknown/future artifacts and genuine IO/cleanup failure never become empty/absent success. Include source/target metadata/archive/project/deletion/ABA, append during observed read, router originalflight/self-busy, original cleanup retry/late acquire and actual strict policy profile traps. Do not erase accepted callback falsy-error evidence or original F0/B2/L1 populations.

Windows process-restart qualification remains the currently accepted boundary; do not infer unrun Linux or power-loss/native-provider replay. R5 cost/performance and R6 performance/index/large history remain separate. No general decomposition, release, provider, C2/ID or event-delivery completion is inferred. FC01–FC03 resolve the preflight rulings; root has promoted this concrete contract and supplies fixed accepted source before dispatch. No new design round or user approval question is required.

## 11. Bounded refresh/ruling summary

| Review correction | Candidate change |
|---|---|
| C1 | Accepted Task2 Session13/source ports, Task3/PF04 review and8fba729d integration recorded; final MAIN supplied at dispatch; historical B2/birth evidence retained. |
| C2 | Canonical core/intent/invocation capture and unchanged full-operation/target recovery limit explicit; no global operation registry. |
| C3 | Actual broker/sourceFor/authorize/snapshot sites named; revocable captured-data branches and real positive reads/profile0 remain required. |
| C4 + FC01 | Controller/SDK/host own/join whole prepare/execute flights through final barrier; real execution session/cancel semantics preserved; host close/in-process retire owns fork fencing/cleanup, self-close refuses. |
| C5 + FC02 | Private Node ForkTargetPolicyDeniedError is the sole known target-policy mapping; unknown/cleanup remain safe errors; later navigation requires same-operation passive target check. |
| C6 + FC03 | Actual Gateway/Desktop source map, inherited AssemblyOptions seam and runtime type correction retained; F1 public slot precedes O1, independent C2/ID factory reserved. |

Original draft/candidate pairs and contract review are preserved. Promotion consumes accepted D1a/lifecycle and funding correctness source, while historical failures and R5/R6 remain explicit. This document is not an implementation or qualification result; the SDD ledger records source/runtime assignment.

## 12. Execution rulings FC08–FC12 and passive data handoff (2026-10-27)

**FC08–FC09 — evidence and restriction are separate.** Capture presentation starts unknown. Only actual strict target absence with no retained capture/reservation/cleanup evidence supports uncaptured; actual READY supports captured. A safe error cannot contradict its known captured last outcome. Presentation never grants capture permission. Once the actual controller observes this exact full operation/target as reserved or materialized, it retains a local monotone restriction even if later namespace inspection reports absence. That restriction prevents fresh source issuance; only the original genuine warm witness can continue. Unavailable/conflict alone does not establish spent state. This adds no durable/global operation registry or guarantee after all original storage is deleted in a new process.

**FC10–FC12 — ordinary reads preserve original READY recovery.** A real ordinary target read can create a cached ManagedDocument before same-operation passive retry. That must not turn an otherwise valid original READY target into cached-unprepared. The narrow original-owner correction may touch coordinator/managed-document.ts and bootstrap.ts plus its focused tests. A factory-private association binds the exact document to its actual Ownership/held token, view/events/count/header and native prefix. Payload-free resume must prove the canonical original stage, complete invocation, checkBirth, READY seed/completion and original frame receipts under that still-current owner. It reuses the real cache and entry flight and asserts an already-ready document; it cannot fabricate a writable control, replace the cached document, re-export source data or force callers to close the target. Active/new/caller-payload/unproved/raw cases stay refused. Mutable title/tail remain intact; append, metadata/binding ABA, revocation and retirement must invalidate stale observations. No backend, format, public API or readiness-owner replacement belongs to this correction.

**FC11 — full-host cleanup keeps original dependencies.** A private actual-ForkHost/coordinator association may bind only its own exact issued wrapper error to its original composite cleanup handle. Capture the genuine FC07 handle before wrapping. Preserve the exact L1 scope and reader lease; all-settled disposal applies only to genuinely independent post-callback closers. A dependent service/lease stays retained until its prerequisite original cleanup acknowledges completion. B2 original pending IO and disposal order stay with B2. No public DTO/signature/index export, arbitrary AggregateError/callbackResult/property inference or substitute cleanup scope is permitted. The same bridge may serve the actual Gateway host.

**PC06 — passive Code Mode data is a separate connected repair.** The public fork must preserve committed JSON (source7, child7→8, grandchild8), without inheriting globals, workers or execution authority. Keep conservative standalone restrictions: an empty managed table cannot prove that inherited L1 sidecars are absent. The original positive integration fixture must migrate its fork composition to the real reviewed shipping full host/controller while retaining every value and isolation assertion; test standalone typed refusal separately. Core/B2 primitive proof may precede that handoff, but cannot close the full public positive. The passive codec proposal remains separately reviewed and cannot silently widen this plan's format or file ownership.
