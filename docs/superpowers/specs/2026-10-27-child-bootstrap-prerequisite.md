# C2 child bootstrap prerequisite A — implementation specification, 2026-10-27

Status: **same-reviewer design PASS; root approved bounded implementation tasks**. Original design, rulings and reviews remain preserved. Incorporates R1–R3 and review I1–I3/M1–M2; runtime qualification remains unrun. Root releases individual task slices, not all future callers.
Source: immutable MAIN `d62c85ea24e7cb87c3a674a38e6a9476a6b891d1`; relevant bootstrap, Documents and birth-journal owners were read at `8ea95aa417a48a908a9855f58f1ac2fd59a57f97` and an immutable scoped diff to this MAIN is empty. No moving checkout/profile/network/runtime/test/Git/product mutations. Package paths below begin at `packages/`.
Goal: one original B2 owner reserves a bounded closed child intent before capture, binds exact original initial input/clock without storing prompt text in the stage, and reconciles child birth safely through warm/cold/READY and ordinary birth-preserving mutation.
Scope A ends at birth/receipt/compatibility. No actual spawn, initial-generation receipt adoption, task/Team/reviewer launch/publication, Team event migration, L1 all/N transfer, instruction-factory replacement, Agent reentry or passive CodeStore child transfer. Public ForkRequestCore/RPC/readers/key/bytes remain unchanged; Session13 and V1 child seeds remain.

## 1. Closed private data and canonical owners

New Node-only types live with existing persistence bootstrap owners and are exported only from its normal Node entry; no browser/SDK/RPC leaf change. Every object/union has exact own fields, no extra/undefined/accessor/hidden/symbol/proxy values, strict JSON data and frozen captured copies. Imported existing types below retain their present definitions.

```ts
type ChildCaller =
 | {kind:'task';taskId:string;parentSessionId:string;callEventSeq?:number;toolCallId?:string}
 | {kind:'team';teamId:string;memberId:string}
 | {kind:'approval-review';reviewId:string};
type ChildHistory = {selection:{kind:'none'}}
 | {selection:{kind:'all'}|{kind:'last-turns';count:number};source:SeedSourceLabel};
type ChildInitialCommitment = {
 inputId:string;digest:string;startedAt:number;expiresAt:number;parentSessionId?:string;
};
type ChildExecutionIntent = {
 roleName:string;roleDigest:string;toolNames:readonly string[];
 model:{kind:'inherit-parent'}|{kind:'declared';selection:SessionModelSelection};
 approval:'ordinary'|'parent-review';timeoutMs?:number;maxAttempts?:number;
};
type ChildLineage =
 | {origin:'subagent';subagentProtocolVersion:1;parentSession?:string;delegationDepth?:number}
 | {origin:'team'|'approval-review';parentSession?:string;delegationDepth?:number};
type ChildBootstrapCore = {
 version:1;kind:'child-bootstrap-core';caller:ChildCaller;history:ChildHistory;
 metadata:BootstrapCallerMetadata;lineage:ChildLineage;
 initial:ChildInitialCommitment;execution:ChildExecutionIntent;
};
type ChildBootstrapRequestIntent = {
 version:1;kind:'child-bootstrap-intent';requestCoreDigest:string;project:BootstrapProjectIntent;
};
type ChildBootstrapCaptureRequest = {
 version:1;kind:'child-bootstrap-capture-request';invocation:BootstrapInvocation;
 core:ChildBootstrapCore;requestIntent:ChildBootstrapRequestIntent;
};
type ChildBootstrapReservation = {
 version:1;kind:'semantic-bootstrap-child-capture';request:ChildBootstrapCaptureRequest;
};
type ChildBootstrapCaptureInspection = {kind:'absent'}
 | {kind:'reserved';reservation:ChildBootstrapReservation}
 | {kind:'materialized'} | {kind:'conflict'|'unavailable'};
```

Freeze these pure Node functions: `captureChildBootstrapCore(input:unknown):ChildBootstrapCore`; `createChildBootstrapRequestIntent(core:unknown,project:BootstrapProjectIntent):{intent:ChildBootstrapRequestIntent;requestDigest:string}`; `captureChildBootstrapCaptureRequest(input:unknown):ChildBootstrapCaptureRequest`; `encodeChildBootstrapReservation(value:ChildBootstrapReservation):Uint8Array`; `parseChildBootstrapReservation(bytes:Uint8Array):ChildBootstrapReservation`; `childInitialCommitment(request:BootstrapRequest):ChildInitialCommitment`; `validateChildCaptureStage(reservation:ChildBootstrapReservation,stage:BootstrapHeaderStage,records?:BootstrapRequest['seed']['records']):void`.
`childInitialCommitment` requires existing valid initial and returns its own inputId/parent/start/expiry plus **exact** `bootstrapInitialInputDigest(initialAdmission(request)!, startedAt, expiresAt)`. Use existing normalized admitted event/provenance and seq omission; no text-only hash, UTF8 approximation, secondary clock or new initial event shape.
Domains: core `ih.bootstrap.child.core.v1`; intent `ih.bootstrap.child.request.v1`; role snapshot `ih.bootstrap.child.role.v1`; paths `ih.bootstrap.child.path.v1`. All use existing bootstrapHash/canonical JSON owner. Core/intent are recomputed in Node; public request domains remain literal-compatible. Role digest commits the original captured SubagentRole data, including optional absence; A validates digest shape, never claims to resolve role authority from that digest.
Existing initial-input, B1 V1 source/seed, dependency, manifest and receipt domains remain unchanged. Existing manifest binds requestDigest through invocation and original initial digest/clock; preserve reservation exactly across rebuild, including predecessor reservation absence. Stages remain canonical newline-terminated bytes, max262144; headers max65536. **Prompt text is absent from reservation/full-stage initial commitment**, remains frozen only in original live payload and actual admitted event, and receives no new 256KiB admission limit. Existing completion batch/event limits still apply.

## 2. Complete validation matrix and timing

| Closed datum | Exact validation/binding |
|---|---|
| Invocation/project/metadata | Reuse captureBootstrapInvocation, existing project codec and validateCreation's metadata rules: operationId printable ASCII1..237, canonical UTC millisecond createdAt; safe target/source/session path IDs; metadata title UTF8≤32768, IDs/model strings1..256, existing five protocol enum values. No UUID-only identity rule/provider resolution. |
| Caller↔lineage↔approval | task→subagent+protocol1+ordinary; team→team+ordinary; review→approval-review+parent-review+tools[]. Reject every other combination, including ordinary approval-review. Task parentSessionId preserves actual TaskIdentity string: nonempty must equal lineage parent; empty requires absent lineage/initial parent. Task callEventSeq optional safe nonnegative integer; toolCallId optional string as copied from actual identity, no invented value/UUID/extra length bound; both may be absent. Other caller IDs are nonempty strings, data only. |
| Initial | inputId existing1..256; digest lowercase SHA25664; start/expiry safe nonnegative integers; expiry>start; optional parent has exact existing absence semantics and equals lineage.parentSession. No full initial text in core. |
| History/anonymous | none forbids source entirely. all/N accepts exact session/anonymous source label; N positive safe integer. If lineage parent exists, source must be session with same ID (existing captureBootstrapRequest restriction). Anonymous all/N requires absent lineage/initial parent, including empty task parent. Do not fabricate parent IDs, widen B1 or accept anonymous seed with durable parent. |
| Execution/lineage numbers | roleName/toolNames are original nonempty strings, roleDigest SHA25664; ordered dense toolNames preserves original order/absence semantics of containing fields. Declared model uses existing metadata modelSelection validator; if metadata.modelSelection is supplied with declared intent, require exact equality. Inherit-parent stays explicit data. timeoutMs/maxAttempts, when present, positive safe integers as generation owner requires; startedAt+timeoutMs must be safe and original expiry cannot exceed it. Absent stays absent, no default synthesized in A. delegationDepth optional safe nonnegative; protocol1 exists iff subagent. |
| Target/full-stage | Safe target distinct from any actual source or lineage parent. Child original target only new. Exact invocation/metadata/lineage and commitment against stage.initial (parent binds via lineage); full child stage requires exact child reservation. none requires empty compiled seed/sourceObservation none; all/N requires V1 semantic source, exact origin/selection and existing compiled/source/dependency validation; no passive option. |

Malformed closed DTO/tuple/model/project/route rejects before claim/source/callback. Actual text is received only in capture payload: recompute commitment after the original callback, compare with core and stage before promotion/header publication. Changed text/provenance/input/parent/clock after reservation returns refused/manifest-invalid and **spends original reservation**; no callback2. Full-stage resume payload mismatch returns refused/conflict before header/append. A digest is not prompt reconstruction or input/launch permission.

## 3. Exact private facade and one internal route

All three optional coordinator members are exposed together only when original `captureSupported()` succeeds and the complete routed backend port below exists; unsupported means no child fallback. Public signatures and parsers remain unchanged.

```ts
inspectChildBootstrapCapture?(request:ChildBootstrapCaptureRequest):Promise<ChildBootstrapCaptureInspection>;
bootstrapChildTargetWithCapture?(request:ChildBootstrapCaptureRequest,guards:BootstrapGuards,
 capture:()=>Promise<BootstrapRequest>):Promise<BootstrapOutcome>;
resumeChildTarget?(request:ChildBootstrapCaptureRequest,guards:BootstrapGuards,
 originalPayload?:BootstrapRequest):Promise<BootstrapOutcome>;
type BootstrapRoute = {protocol:'public';invocation:BootstrapInvocation}
 | {protocol:'child-v1';request:ChildBootstrapCaptureRequest};
type BootstrapCaptureRoute = {protocol:'public';request:BootstrapCaptureRequest}
 | {protocol:'child-v1';request:ChildBootstrapCaptureRequest};
type OwnedCaptureReservation = BootstrapCaptureReservation|ChildBootstrapReservation;
type OwnedCaptureInspection = BootstrapCaptureInspection|ChildBootstrapCaptureInspection;
type ResolvedBootstrapBirth = {route:BootstrapRoute;stage:BootstrapHeaderStage};
// Optional private backend capability on PersistenceBackend; one existing helper instance supplies it.
interface BootstrapRouteBackend {
 readState(route:BootstrapRoute):Promise<BootstrapReadState>;
 readCapture(id:string,owner:HeldFactOwner,route:BootstrapCaptureRoute):Promise<OwnedCaptureInspection>;
 reserveCapture(id:string,owner:IssuingFactOwner,route:BootstrapCaptureRoute,bytes:Uint8Array):Promise<BootstrapCaptureReserveOutcome>;
 resolveBirth(id:string):Promise<ResolvedBootstrapBirth|undefined>;
}
// PersistenceBackend.bootstrapRoutes?: BootstrapRouteBackend
```

BootstrapHeaderStage.captureReservation and internal read-state reservation become OwnedCaptureReservation; coordinator public BootstrapCaptureInspection remains public-only. `captureBootstrapRoute(input:unknown):BootstrapRoute` and `captureBootstrapCaptureRoute(input:unknown):BootstrapCaptureRoute` validate exact discriminator/branch request and recompute bindings. Original public backend method signatures remain; JSONL delegates their public route to this same port/helper. B2 uses readState for explicit routes when port exists, original public hook otherwise; child gate never falls back. Header prepare/reconcile derives route from its validated exact preserved reservation; reservation-free predecessor means public only.
Store validated route/request identity on **existing ManagedEntry** before installing/joining a bootstrap flight; no separate map/factory. Every start/capture/resume checks protocol then complete request/invocation equality before entry.flight. Public generic bootstrap/resume/capture must refuse child with conflict even when invocation matches and child flight is running/READY; no public same-flight join. Child mismatch similarly refuses. New generic public cold reads public route and sees child namespace foreign before prepare. Digests and header.origin do not choose protocol.
Ordinary managed open after loadOwned resolves actual semantic birth using backend.bootstrapRoutes.resolveBirth under the same ownership before attaching/tagging entry; returned child/public route is validated from unique stage, never header.origin. Failure retains normal open cleanup; an opening entry without resolved route is not an admissible bootstrap-flight join. Existing non-bootstrap documents remain cached-unprepared for mutating birth. Candidate cached adoption uses the same entry/document/flight plus captureManagedReadyObservation, route-aware read, exact prefix/view/ownership checks, target/dependency reconciliation and actual frame receipt confirmation; ordinary opened READY child private resume returns already-ready without callback/admission/run. Public route check occurs before joining child entry's flight.

## 4. Documents admission, original guards and lifetime

Keep facade forwarding in persistence index.ts and createBindingObservations; do not expose internal managed methods directly. Freeze `withChildBootstrapCapture(request:ChildBootstrapCaptureRequest,guards:BootstrapGuards,capture:()=>Promise<BootstrapRequest>,run:(request:ChildBootstrapCaptureRequest,guards:BootstrapGuards,capture:()=>Promise<BootstrapRequest>)=>Promise<BootstrapOutcome>):Promise<BootstrapOutcome>` and `withChildBootstrapResume(request:ChildBootstrapCaptureRequest,guards:BootstrapGuards,payload:BootstrapRequest|undefined,run:(request:ChildBootstrapCaptureRequest,guards:BootstrapGuards,payload?:BootstrapRequest)=>Promise<BootstrapOutcome>):Promise<BootstrapOutcome>`. Factor their strict capture-host snapshot from existing withBootstrapCapture and dispatch the child validator explicitly; public wrapper still uses only public validator.
Before first await, capture request/payload descriptors once, validate callback/function/proxy/accessor shapes, snapshot signal and assertCurrent/dependency confirm/reconcile with original receivers, and snapshot optional targetPreparation including its absence. Child resume uses this same strict host snapshot, not generic lazy guard lookup. Payload must match request invocation; defer text-versus-commitment decision only when text arrives from capture. Unsupported gate precedes host argument inspection as existing owner requires.
Then use original `bootstrapMutation(exactInvocation, run)` and its existing admission.join/finally.finish; preserve exact original fork-target observation exemption, existing-read no-exemption, observation revoke/join, retirement/deletion admission and receiver lifetimes. Read-only inspection uses original capture inspection resource flight/root-before-claim/cleanup model; it grants no mutation exemption. Preserve facade captureSelfConflict checks before changing admission, and extend them to private wrapped request/private resume. Callback self bootstrap/resume/target-open/delete/retire/close must refuse before self-join/admission changes.
External close synchronously revokes new admission/issue, joins late observation/claim/callback/IO acquisitions, settles original ledger by same held.owner object and retains exact failed cleanup debt. Cleanup uses original held ownership, not revoked new-work guards; attempt independent cleanup and preserve falsey original failures. D1 Stop/source identities and O1 retirement authority are untouched by A.

## 5. State transitions and recovery results

| Route/state | Required behavior |
|---|---|
| Child inspection absent | Root/tombstone/complete namespace and local issued/IO state prove strict absence; no source/target header/ManagedEntry/model work; return only after original read/claim cleanup. |
| New capture absent | One existing entry/claim/held/issuer/IO ledger; exclusive sole child-key stage; only confirmed committed-new original flight transitions unreserved→reserving→reserved→capturing once. |
| Reservation present, unknown/torn/future, spent/cold | Never enter callback; known exact reservation without retained owned payload returns blocked/payload-required, unknown returns blocked/unknown, foreign/conflicting returns refused/conflict. A newly supplied callback or resume payload cannot refill reservation. Child unavailable state stops before build/reconcile/prepare; no generic unavailable fallthrough. |
| Warm original owned payload | Exact same request resumes same flight/owned payload; settle original IO first; no recapture. Post-callback commitment/seed validation precedes owned payload acceptance. |
| Full stage/header/seed/initial cut | Route/request/reservation/stage exact; cold originalPayload may fill missing seed/initial bytes only after buildBootstrapHeader(originalPayload,originalStage) exact equality and commitment validation. Without necessary payload return payload-required. Reconcile original headers/batches; no new identity/initial admission. |
| READY, including cold or ordinary-open cached READY | Shared run/cached adoption validates original child stage/manifest/reservation/initial and confirms actual frame receipts; ready/already-ready existing outcome. No callback or run, no inspect-derived receipt. Retain stage and original birth frame bytes. |

Promotion remains original exact flushed/readback/closed `.promote`→atomic replacement of `.stage`; no unlink gap, sentinel or eager cleanup on Stop/READY. All stages preserve exact reservation. None callback builds compileSemanticSeed({kind:'none'}) directly, zero parent export/hash/history/legacy/CodeStore walk; original caller/target guards and initial tuple still required. All/N intent validation and exact existing B1 payload binding belong to A; structural transfer/caller acceptance do not.

## 6. One validated namespace/birth lookup

Public key remains SHA256(canonical invocation); child key is bootstrapHash('ih.bootstrap.child.path.v1',invocation), rejected before issue if equal. Same recognized `<target>.jsonl.bootstrap-<64hex>.{stage,promote,publish}` roles, one stage/owner. Child target is new, so unexpected publish stays fenced; no repurposing publish for promotion.
Add one JSONL backend/bootstrap-stage.ts leaf with the exact private APIs below, existing public bootstrapPaths(path,invocation) compatibility wrapper and broad namespace/recognized artifact inventory. Capture paths inject original tracked ledger reads; ordinary owners supply bounded reads under their actual ownership. No helper owns phase, claims or cleanup.

```ts
type StagePaths={stage:string;promote:string;publish:string};
type StageExpectation={kind:'route';route:BootstrapRoute}|{kind:'header';meta:SessionMeta};
type StageLookupIO={namespace():Promise<readonly string[]>;
 read(path:string,limit:number):Promise<Uint8Array|undefined>;assertCurrent():void};
type StageLookup={kind:'absent'}
 | {kind:'reserved';route:BootstrapRoute;reservation:OwnedCaptureReservation;exactBytes:Uint8Array}
 | {kind:'full';route:BootstrapRoute;stage:BootstrapHeaderStage;exactBytes:Uint8Array}
 | {kind:'conflict'|'unavailable';present:boolean};
bootstrapPathsForRoute(path:string,route:BootstrapRoute):StagePaths;
lookupBootstrapStage(path:string,expectation:StageExpectation,io:StageLookupIO):Promise<StageLookup>;
```
Header expectation reconstructs complete invocation from actual semantic header and derives **only two exact candidate keys**; require one unique stage, exact canonical parser, protocol/reservation/request/invocation/header immutable binding. Child-key stage always requires child reservation; public stage permits its legitimate literal predecessor absence. Reject both stages, wrong-key protocol, child on public key, reservation-free child, foreign/future/torn/oversize/artifact mismatch and orphan promotion/publication. Namespace discovery grants no adoption; header origin is never routing authority. Route expectation accepts only its exact candidate plus valid original promotion, never another protocol.
Use this same lookup in readState, readCapture/reserve/promotion/reconcile, resolveBirth and both fact-journal callers. JSONL fact-journal.ts preserveBootstrapBirth retains its actual immutable-header comparison/upgraded11/12 rule, recomputes manifest with actual decoded seed records, compares immutable birth events and retains exact original phase frame keys/bytes. Its historical append header lane uses the same selected stage, exact original header and original seed/complete batch layout, validating combined prefix/batch before issue. No alternate public hardcoded lookup remains.
JSONL index.ts ordinary replaceEvents uses preserveBootstrapBirth; repair may change only valid suffix after complete birth; metadata update and supported format upgrade preserve birth scope and frame bytes; format-upgrade.ts continues through that same preserve owner. resolveBirth uses actual header/body to confirm complete immutable birth/manifest before annotating ordinary managed entry. Missing/ambiguous/bad child stage cannot fall back to generic replacement. Existing tombstone/header requirements and recognized deletion inventory remain; no new headerless delete/GC capability.

## 7. Genuine predecessor boundary and required qualification

Old active generic run does not generally stop on unavailable stage; same-key complete new JSON may conflict but short common-prefix/old zero stage can be continued. Session13/union/parser changes cannot prove headerless refusal. Child key is a recognized foreign stage to genuine format11/12/13/current readers; old run and header backend reject foreign before target/header preparation independent of stage byte count. Fence starts at exclusive creation of sole child stage; an older writer winning ownership earlier yields conflict to new child before capture. This is source-derived, all process controls **unrun**.
Exercise real unmodified graph capsules: format11 b7ba78b0ae2c977f61709052f4180acae4977fdc; format12 c76a56011e16057030c2fa7106d358b1eac99657; codec1/Session13 9d0c1a3433ce3d98cc972aab4387b3133f7bfdfd; complete pinned pre-child MAINd62c85ea graph. Record complete manifest/blob/file/Node/native-lock/import-resolution hashes; independent process with no workspace escape/provider/network; no edited CURRENT_FORMAT_VERSION/parser constant fake predecessor.
For each graph and child stage complete/empty/one-byte/common-prefix/oversize/torn/future, same and different supplied invocation: passive inspect/optional capture-inspect; ordinary read/snapshot/load/loadOwned/direct repair/create; **active bootstrapSemanticTarget and resumeSemanticTarget with a valid old generic payload**, plus payloadless resume. Assert no child callback/source/model work, no target/header/new stage mutation and exact bytes/names unchanged; distinguish permitted lock artifacts. Add clean old absent-target writer→READY positive and same-key-prefix counterexample where applicable. Original V1 public/reservation-free stages11/12/13 ready/header-only/torn must positively resume on new owner preserving original stage/birth bytes and supported upgrade; public completed V2 remains positive.

## 8. A acceptance, file boundary and review closure

A controls additionally require: closed validator adversaries and long valid >262144UTF8 initial prompt parity with generic bootstrap; none real B2 READY and exact receipt/initial; reservation/promotion/seed/completion process cuts; warm/cold/ordinary-cached private routes and exact-invocation public cross-calls before flight join; observation/retirement/deletion/self-wait/guard-receiver/late-IO controls; none READY→ordinary read→suffix replacement/repair/metadata/append→private cached/cold resume preserving original birth frames and receipt keys. Reject conflicting keys/tampered reservations/header/initial/manifest before mutation; preserve public/predecessor positive oracles. No full caller/L1/Team controls required for A acceptance.
Owned files: persistence coordinator/{bootstrap-types,bootstrap-intent,bootstrap-capture,bootstrap-header,bootstrap,binding-observation,managed-documents,types}.ts and index.ts; JSONL backend/{bootstrap-stage(new),bootstrap-header,bootstrap-capture,fact-journal}.ts and index.ts. format-upgrade.ts is a mandatory consumed owner; edit only a demonstrated lookup call requirement. No core-session digest/seed policy change or public fork-contract/RPC edit. New tests named in sibling task plan; no source edits authorized yet.
I1 closes through shared validated unique lookup plus both fact-journal lanes and ordinary mutation controls. I2 closes through exact private inspect/capture/resume, typed route/port, entry identity before flight, and cached READY resolution. I3 closes through existing Documents wrappers/admission/guard receivers/self-wait. M1 closes through exact digest-only tuple and timing/long-prompt oracle. M2 closes through validation matrix and existing anonymous/durable-parent restriction. Same-reviewer rereview and root release remain required.
