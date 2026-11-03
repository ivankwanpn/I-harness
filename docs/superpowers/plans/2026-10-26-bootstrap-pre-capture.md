# B2 pre-capture reservation prerequisite implementation plan

Status: root-promoted executable prerequisite under the approved continuous program. Root records immutable dispatch BASE; only this owner task is authorized.

> Use subagent-driven-development with one GPT-6.1 Sol implementer and independent full-range review. The writer executes this connected task without recursive agents or public caller/UI work.

**Goal:** Make every new public-fork source capture follow a confirmed original B2 reservation, so repeated requests/process restart cannot capture changed source under the same invocation.

**Architecture:** Add a seed-free variant to existing invocation-keyed `.stage`; only its original newly publishing flight gets one source callback. Preserve that reservation during monotone `.promote`→full `.stage` transition, then use existing B2 header/dependencies/seed/completion/receipt. Strict target-only inspection precedes source work. Unknown/reserved state never grants new capture.

**Spec:** [binding root decisions](../specs/2026-10-26-bootstrap-pre-capture.md).

**Binding sources:** sibling `f1-pre-capture-reservation-addendum-20261025.md`, `f1-public-fork-contract-draft-20261025.md`; actual B2/F0/existing-read code; `docs/research/2026-10-25-existing-binding-observation-acceptance.md`. Existing-read is accepted at8fa88c96. Earlier root-supplied MAIN was c1124514/productcf753bc9; do not infer unverified later product state.

## Global constraints

- Product `0.1.13-rc.1`, Session12, SemanticSeedV1 and original full-stage/session/event formats remain accepted. This task adds an explicit **private stage variant/optional full-stage field/pending path**, not a format-neutral change.
- Qualified guarantee is existing B2 **process-interruption/restart** and controlled process-cut model. Windows optional directory flush is **intentionally skipped**, not attempted under catch-all. Required file IO, close/readback/rename and actual claims stay strict. No power-loss claim, boot ID, native-volume flush or general filesystem subsystem.
- No second store/receipt/completion authority or seed cache; phase and IO debt live with existing B2 ManagedEntry/backend owner. No placeholder session header, raw-history copy, fake empty closure or new total-ref/descriptor cap.
- Preserve all original F0/existing-read exact target/no-target semantics, B2 initial-input/child/generic APIs, predecessor literal full stages, receipt ownership and real cleanup failures. No C2/instruction/D2/B3 redesign.
- Headerless spent reservations remain durably fenced. No new GC/admin/delete API and no eager unlink/reset after Stop/failure/READY.
- Public SDK/RPC handlers, Desktop UI, persistence `forkSession` cutover, host adapters, strict-reader visibility/commitment rollout remain the later connected vertical task. No ContextStore/native index/ContextOutput changes or staged release copies.
- Package-CWD Vitest sequentially uses `--maxWorkers=2 --minWorkers=1`; preserve raw setup/RED/GREEN/source/CWD/exit/resource evidence. No providers/live profiles, release/push/tag or reachability exemptions.

## 1. Frozen minimal data and browser-safe owner

Create `packages/session-persistence/src/fork-contract.ts` and export only this minimal data+reader through `@i-harness/session-persistence/fork-contract` now. Later public DTOs extend this same leaf; do not create competing definitions in SDK. Normal persistence entry re-exports types/reader. The leaf has **no runtime Node, persistence main-entry, SDK, core-session main-entry or engine import**; existing metadata/protocol types are `import type` only. The reader does no hashing or visibility/projection work.

```ts
export interface ForkRequestCore {
  version:1;
  kind:'session-fork-core';
  sourceSessionId:string;
  selection:{kind:'completed';atSeq?:number};
  sourceCapture:'first-authorized-capture';
  metadata:import('./coordinator/bootstrap-types.ts').BootstrapCallerMetadata;
}
export function readForkRequestCore(input:unknown):Readonly<ForkRequestCore>;
```

Reader returns deeply frozen captured own data or throws TypeError. Exact fields only; no extra/undefined/symbol/accessor/hidden field. Each object is plain own JSON; selection completed only; atSeq is safe nonnegative integer. Source ID uses existing F0 safety (nonempty≤256, no slash/backslash/control/DEL/`..`). Metadata is exact existing B2 title/workspaceId/modelSelection data: title UTF-8≤32768; workspaceId nonempty≤256; modelSelection required provider/model nonempty≤256, optional reasoningEffort nonempty≤256 and existing protocol enum `openai-completions|openai-responses|anthropic-messages|gemini|bedrock`. No new unset/null/default resolution. Freeze a plain copy from descriptors, without invoking getters. Browser reader cannot promise detection of proxy traps; Node entry rejects proxy/non-strict data before invoking it. A focused parity test compares protocol set/metadata limits to current B2/settings owner rather than altering their meaning.

Preparation/default resolution is **not** implemented here: caller supplies already-resolved metadata. Completed default cut remains at the first authorized capture after reservation; core does not promise source-at-click. Protocol values/metadata are validated data, not provider/model authority.

Narrowly export existing `createBootstrapRequestIntent` and type `BootstrapProjectIntent` from persistence normal entry. Its existing domains/canonical owner remain the only core/intent hashing implementation. Do not move hashing into the browser leaf or add any visibility export in this prerequisite.

## 2. Frozen coordinator/backend contracts

Add these closed types to existing `coordinator/bootstrap-types.ts`, importing ForkRequestCore by type. Reuse actual BootstrapInvocation, BootstrapRequestIntent, BootstrapGuards, BootstrapRequest, BootstrapOutcome and Held/IssuingFactOwner.

```ts
export interface BootstrapCaptureRequest {
  invocation:BootstrapInvocation;
  core:ForkRequestCore;
  requestIntent:BootstrapRequestIntent;
}
export interface BootstrapCaptureReservation {
  version:1;
  kind:'semantic-bootstrap-capture';
  request:BootstrapCaptureRequest;
}
export type BootstrapCaptureInspection =
  | {kind:'absent'}
  | {kind:'reserved';reservation:BootstrapCaptureReservation}
  | {kind:'materialized'}
  | {kind:'conflict'|'unavailable'};
export type BootstrapCaptureReserveOutcome =
  | {kind:'committed-new'}
  | {kind:'present'}
  | {kind:'not-issued';reason:'cancelled'|'stale-source'}
  | {kind:'unknown'|'conflict'|'unsupported'};

// Optional SessionCoordinator members, present together under gate below.
inspectBootstrapCapture?(request:BootstrapCaptureRequest):Promise<BootstrapCaptureInspection>;
bootstrapSemanticTargetWithCapture?(
  request:BootstrapCaptureRequest,guards:BootstrapGuards,
  capture:()=>Promise<BootstrapRequest>,
):Promise<BootstrapOutcome>;

// New optional PersistenceBackend members, required together for new capability.
checkBootstrapCaptureRoot?():Promise<void>;
readBootstrapCapture?(id:string,owner:HeldFactOwner,
  request:BootstrapCaptureRequest):Promise<BootstrapCaptureInspection>;
prepareBootstrapCapture?(id:string,owner:IssuingFactOwner,
  reservationBytes:Uint8Array):Promise<BootstrapCaptureReserveOutcome>;
settleBootstrapCaptureIO?(id:string,owner:HeldFactOwner):Promise<void>;
```

Declare those same four backend signatures optional on BootstrapBackend and use corresponding optional forwarding members on PersistenceBackend. `checkBootstrapCaptureRoot` is a read-only actual-backend root availability check, called **before acquiring a native claim**; it never creates a root or returns absence. This is necessary because current fs-lock `acquireSessionLock` recursively mkdirSyncs its lock parent, which can otherwise recreate a previously missing storage root when default lockRoot equals storageRoot. The strict backend scan still rechecks after acquisition. This does not add root lifecycle authority or protection against noncooperative external root replacement during acquisition.

The IO settle hook is a narrow necessary resource seam: it joins/retries only actual original capture-inspection/reservation/promotion FileHandles issued under this owner identity. Backend keys resources by the **same actual issued OwnerToken object identity** (held/issuing contexts preserve it), verifies `isHeldFactOwner`/session/current claim, and never accepts a caller-shaped token or session-label cleanup. It does not determine capture phase, create records, run source or close an unrelated owner's work. B2 retains the corresponding actual claim/context until its IO debt settles; no replacement owner proves original disposal. No public cleanup tool/registry is added.

Expose the two optional coordinator members only when: `ownership.lockEnabled`, actual platform win32/linux, all existing B2 backend methods (`prepareBootstrapHeader`, `reconcileBootstrapHeader`, `readBootstrapState`, `confirmBootstrapFrames`, `appendOwnedBatch`, `reconcileOwnedBatch`), and all **four** new backend methods exist. Do not make this depend on SDK advertisement or invent a string capability now. Generic existing bootstrap/resume stay present and retain original unsupported-before-caller-inspection decisions. Missing new capability means undefined optional methods; no fallback to old capture ordering. JSONL supplies the four methods from its existing bootstrap backend composition.

`createBootstrapHeaderBackend` constructs exactly one cohesive capture-IO helper instance and returns its four new methods with existing header methods. Existing prepare/reconcile header code delegates capture-stage promotion/resource work to that **same instance**. `createJsonlBackend` keeps its existing single bootstrap-backend composition; do not create disjoint resource trackers by spreading a second independent factory.

Pass the already-resolved actual JSONL `rootPath` as a third internal factory argument: `createBootstrapHeaderBackend(filePath,assertNotDeleted,rootPath)`. Its capture helper receives that exact root alongside existing path/tombstone functions. Do not derive a root by inventing an empty/fake session ID, ask the caller for another root, or inspect a lock-root substitute. `checkBootstrapCaptureRoot` checks actual storage root availability without creating it; the supplied existing lock root remains owned by current Ownership.

Add Node-owned pure helpers in `coordinator/bootstrap-capture.ts`:

```ts
captureBootstrapCaptureRequest(input:unknown):BootstrapCaptureRequest;
parseBootstrapCaptureReservation(bytes:Uint8Array):BootstrapCaptureReservation;
encodeBootstrapCaptureReservation(value:BootstrapCaptureReservation):Uint8Array;
```

They validate complete closed data and canonical exact bytes, use existing invocation/canonical intent owners, recompute `createBootstrapRequestIntent(core,requestIntent.project)`, and compare the **entire** captured intent plus invocation.requestDigest. TargetSessionId must be F0-safe and differ from core.sourceSessionId. Project ID follows existing intent codec, not a new filesystem path rule. Invalid request throws TypeError from read-only inspection before acquisition; new mutating entry returns existing refused manifest-invalid without callback/write. Callback must be an actual function captured once; reject proxy/accessor-shaped host arguments before entering owner.

Unsupported gate is checked before guards/callback inspection. No wire DTO/result/error union is introduced. Callback fault is rethrown as the original local error after marking reservation spent and settling original cleanup; combined cleanup errors preserve original callback error/result diagnostics. Invalid callback return yields refused manifest-invalid and spent reservation. New inspection maps native lock contention→conflict and IO/root/tombstone failure→unavailable, never absent. Cleanup failures reject aggregate diagnostics with exact invocation and known inspection/outcome while retaining same-owner retry; do not silently return a usable absence result.

## 3. Frozen closed on-disk format and limits

Keep existing `key=SHA256(canonicalJsonData(complete BootstrapInvocation))` and exact names under actual target file path:

```text
<target>.jsonl.bootstrap-<key>.stage
<target>.jsonl.bootstrap-<key>.promote
<target>.jsonl.bootstrap-<key>.publish   # existing role unchanged
```

`.stage` contains either existing canonical `BootstrapHeaderStage` or the exact canonical BootstrapCaptureReservation above, followed by one newline. Both are limited to the **existing262144-byte stage ceiling**. `.promote` contains exact final full stage bytes (same ceiling), including its original captureReservation. Existing header/publication limit65536 is unchanged; do not reuse `.publish` for full-stage promotion. No new body/descriptor/ref count limit.

Extend actual full `BootstrapHeaderStage` with one optional own field:

```ts
captureReservation?:BootstrapCaptureReservation;
```

No undefined field; omit it for predecessor stages. Pre-capture record has no seed/header/manifest/initial input. Promoted full stage contains all actual existing fields and the preserved exact reservation. `bootstrapManifest` continues its current existing preimage/hash domains (invocation.requestDigest already binds core/intent); do not silently change old manifest or header/event bytes by hashing the new private optional field as a new preimage. Parse/build/checkBirth validate the preserved reservation binding explicitly instead.

`parseBootstrapHeaderStage` continues to parse **full stages only**. It accepts exact old bytes unchanged, or the one new optional field; unknown kind/version/field refuses. On promoted full-stage parse validate reservation invocation, new target, resolved metadata, fork lineage/source and semantic source-observation kind against the actual full stage/header. Actual request build/checkBirth additionally validate seed manifest selection and original session origin against reservation core. No valid none/empty bootstrap may masquerade as a semantic public fork. No target header is created until actual full stage/header preparation.

Extend BootstrapReadState by only these host-private optional fields:

```ts
stagePresent?:boolean; // observed .stage exists even if empty/partial/unreadable
captureReservation?:BootstrapCaptureReservation;
promotionPresent?:boolean;
promotionBytes?:Uint8Array;
```

`stageBytes` still carries only actual full header stage bytes. Pre-capture record goes in captureReservation; empty/malformed/future stage is unavailable with stagePresent retained, not absent. Seen stage/promotion bytes mark issued state before any failure path can evict the entry. Existing inspectBootstrap may report valid capture-only state as reserved with original header/manifest-unknown token; readiness remains actual B2 resume only. The new strict inspection, not ordinary inspectBootstrap absence, controls first capture.

## 4. Full-stage reconstruction must preserve the original reservation

Change the private existing builder signature exactly:

```ts
buildBootstrapHeader(request:BootstrapRequest,original?:BootstrapHeaderStage,
  existing?:Record<string,unknown>,captureReservation?:BootstrapCaptureReservation):
  {stage:BootstrapHeaderStage;operation:BootstrapHeaderOperation;initial?:SessionEvent};
```

Rules:

1. With `original`, effective reservation is **original.captureReservation**, including its absence. If a fourth argument is supplied it must exactly equal the original optional value; never inject a new capture field into a predecessor stage or drop an existing one.
2. Without original, a fourth argument is allowed only from the actual existing B2 capture-owned entry after its callback/request validation. Validate and freeze it; include it verbatim in full canonical stage bytes.
3. Every existing `buildBootstrapHeader(b.request,b.stage)` reconstruction in run/initial handling preserves optional field automatically. Cold stage+original-payload comparison must rebuild exact promoted bytes; a valid resume cannot fail merely because code forgot captureReservation.
4. `sameBootstrapData(stage,original)` and stageBytes/header comparison remain strict. Changed reservation/core/intent/seed/metadata/source/selection conflicts; no “ignore new field for equality” fast path.
5. `checkBirth` checks actual immutable full stage/reservation against actual seed manifest selection/origin and full birth header, while mutable title/model/archive/workspace edits after READY remain governed by existing allowed metadata semantics. Reservation's original child metadata compares to original stage/headerBase, not later mutable target profile.

Required literal tests cover predecessor bytes with no field, promoted bytes with the field, same original payload after cold reopen, omitted fourth argument on rebuild, deliberate field loss/addition/change and allowed current target metadata/suffix changes. No format/version bump or parser relaxation hides mismatch.

## 5. Existing owner admission, one original flight and generic conflict rules

State lives on existing `ManagedEntry.bootstrap`, never a second target map. Add a capture substate with original captured request/reservation, `unreserved|reserving|reserved|capturing|captured|spent` phase, actual original request provenance, capture-entered flag and owned IO resources/claims. `bootstrap.request` assigned by a **generic caller** is not proof that this owner performed original capture. Store original callback-produced owned request and existing bootstrap.request atomically after full validation. Preserve that provenance separately from data equality.

Register the complete new flight synchronously before first await. Capture guards using existing method-receiver/closed target-preparation rules. New facade enters the **same** binding-observation bootstrapMutation with captured invocation; exact outer fork F0 target is the only exception. Existing-read target callback still conflicts. New owner delegates to its private existing run after capture; no recursive coordinator facade call installing a second mutation.

Duplicate same capture binding joins original entire flight, ignoring a later supplied callback. Different request/invocation/core/target conflicts before callback. Reentrant call from inside its own active capture callback targeting the same identity must conflict rather than await its own flight. Add narrow B2 callback AsyncLocalStorage self-wait checks for same-target bootstrap/resume/capture and global close/target retire/delete before changing admission; this is owner lifecycle only. Preserve original F0 callback bootstrap permission outside this distinct capture callback. Do not broaden it into managed fact freezing.

Freeze these rules for **all** bootstrap entry points:

| Actual original state | New withCapture | Generic bootstrapSemanticTarget / resume with payload | Resume without payload |
|---|---|---|---|
| Strictly absent, no retained phase/debt | May publish original reservation then callback once | Existing predecessor B2 path unchanged (not a claim about future public handlers) | Existing no-payload behavior; no source callback. |
| Original new capture flight reserving/capturing | Exact binding joins; no second callback | Same-target supplied generic payload conflicts before assigning it as original; no self-join | Exact external invocation can join original flight; self-call inside capture callback conflicts. |
| Capture-only marker, no actual owned callback payload (cold/spent/uncertain) | No callback; blocked payload-required/unknown or conflict | Mismatched core-compatible fields conflict; even matching metadata/core with newly supplied seed **cannot fill slot**: blocked payload-required. Never assign generic request as captured provenance. | Blocked original token, zero source hooks. |
| Original callback payload retained, unchanged host witness supplied by later caller guards | Continue accepted B2 run using that actual original request; callback0 | Equal request may join/continue actual original cached request; changed request conflicts. | Use existing original cache with guards; cold/passive guards cannot issue missing work. |
| Full promoted stage, cache lost | No callback; route to existing resume | May use exact stage-bound original payload only under existing B2 rules/guards; rebuild retains original captureReservation. Changed payload conflicts. | Actual completed target adopts; incomplete payload-required/unknown. |
| Old full stage without captureReservation | No callback; original B2 resume/refusal only; never retrofit reservation | Preserve literal predecessor behavior and full equality | Preserve original receipt adoption. |
| Future/malformed/foreign stage or sibling/promotion, target presence, tombstone, unavailable root | No callback; conflict/unavailable/blocked as actual owner proves | Never overwrite/reset reserved/future state | Source-free refusal/blocked, never fresh capture. |

Mark reservation-issued before first possible file create/write and capture-entered before invoking callback. Currentness checked immediately before callback and after its await; caller returns complete original BootstrapRequest only after source-safe B1 export/compile under actual host lifetime. Source busy/guard refusal before reservation remains genuinely uncaptured and retryable; cancellation/error after reservation cannot erase marker even if actual export count0. Callback error/invalid return/Stop leaves spent reservation and no second callback.

Classify actual full promoted stage before the capture-only rule: a cold entry may lack original in-memory callback payload while disk already binds the seed in a full stage. That permits only existing full-stage payload equality/resume behavior, never callback reentry. Private capture phase alone must neither erase actual stage evidence nor incorrectly block valid exact full-stage cold reconstruction.

Source-safe first capture requires successful qualified reservation barrier, settled original publication FileHandles, exact actual target/source claims still held, original flight and fresh source/host/Stop guard. No caller label/digest/committed result object or an inspected exact marker grants a new callback. No source-at-click promise; no stale or changed source recapture. Later public begin and retry share these owner rules, independent of transport resend behavior.

## 6. Read-only strict inspection and future artifacts

`inspectBootstrapCapture` validates/captures request before await, calls actual backend `checkBootstrapCaptureRoot` before any native lease acquisition, then acquires an actual **temporary** target claim and short target session lane, reads strict capture state, settles its original IO, then releases only that claim. The capture mutator likewise calls the root check before its own claim acquisition. This prevents lock-parent mkdir from turning an already missing storage root into false absence. It does not profile/load/create target or write session/stage/promotion/header, repair files, construct model/assembly or invoke source. Native lease acquisition is lifecycle, not a session mutation. It must not install a B2 pending mutation across subsequent source preflight/F0 acquisition.

Absent requires all: actual storage root accessible/current; tombstones absent; no target `.jsonl`; no stage/publish/promote or unknown sibling for exact target bootstrap prefix; no retained reserving/issued/captured phase or cleanup debt. Only exact child ENOENT can support absence after root/tombstone checks before/after reads. Do not reuse `bootstrapArtifacts` missing-directory→[] or generic pre-issue catch→absent. Lock conflict→conflict; tombstone/IO/root failure→unavailable. Keep original failure cause internally.

Inspect **all** names under the target's `.jsonl.bootstrap-` prefix: unknown suffix/hash/record kind/version or future metadata is unavailable/foreign, never silently ignored as no known artifact. Same-key partial/zero-byte stage is unavailable/reserved evidence; promote without stage is unavailable; foreign invocation recognized stage/promote/publish conflicts. An ordinary target with no semantic header still prevents fresh capture. Existing target/header/seed verification remains the existing owned resume path, not inspection success.

After read-only routing absence, later first-capture method rechecks under actual target claim/lane immediately before issuance, closing TOCTOU. CLI acquires outer fork F0 **before** that method, not inside a held B2 mutation/lane; Gateway broker target binding remains its alternative actual owner. Tests must prove no new session lane/docChain held during source callback or host policy awaits. No general snapshot/ordinary read API is added.

## 7. Required publication, monotone promotion and IO lifetime

JSONL implements exact exclusive `.stage` creation. Write complete canonical reservation, await actual file.sync, exact readback under same owner/root/tombstone guards, close every original write/readback handle, then return committed-new only to that actual newly-creating call. EEXIST→present only after exact readback; different bytes→conflict; unreadable/partial→unknown. Present never grants callback. Required write/zero-progress/sync/readback/close/currentness uncertainty→unknown/debt or original blocked, never successful admission. Before-issue cancelled/stale can return not-issued; other inspection IO failures are unavailable/unknown, never absent.

For this new path on Windows **skip optional directory-flush attempt intentionally** and record that limitation in evidence. Do not catch required file errors as an unsupported-directory success. On other supported platform, if directory sync is attempted its unexpected error/handle debt is unknown; no blanket errno allowlist. These process-cut results do not claim power-loss safety. Existing generic B2 post-sync header close-diagnostic behavior stays unchanged; new callback permission has the stricter resource gate.

Promotion is a separate private monotone transition inside existing `prepareBootstrapHeader`: build original full stage including captureReservation; create/continue exact deterministic `.promote` prefix under original issuer, sync/readback/close, verify `.stage` is still exact original reservation, rename promote over stage **without first unlinking/truncating stage**, confirm exact full-stage bytes. Rename failure/response loss→unknown until original exact readback proves effect; no new capture, no rollback to absent. Existing `.publish` header semantics remain unchanged. Only actual capture-owned original payload provenance may authorize promotion of a capture-only stage.

Partial promote leaves original `.stage` fence. Warm original payload+witness may continue exact pending bytes without source export. Cold pre-capture-stage plus promote cannot promote/recreate header/new payload; it blocks. Stage already full after lost rename response proceeds only through original B2 reconciliation. Never expose a pending promote as committed full stage or READY.

The backend IO tracker is per actual owner-token identity and records a native handle immediately after acquire **before** any after-await guard can fail. Its pending task is registered before its first await; settle joins late acquisitions and original operations. Attempt independent closes; preserve original failed handle/release outcome. A close that consumed held/fd state before throwing stays debt, not later no-op success. Settle performs no source/model/producer/canonical publication. B2 invokes settle before callback admission, before dropping original claims, at attempt end and from explicit lifecycle retry as necessary; no automatic ordinary inspection retries an unrelated debtor's cleanup.

Coordinator/managed close synchronously revokes new capture admission/guards, joins whole original flights/callbacks/IO outside lanes, attempts independent cleanup and retains dependent actual claims on unresolved debt. Add narrow callback self-wait check before close/retire/delete admission changes. Do not promise cancellation forcibly ends a nonsettling callback.

**Settled headerless spent reservation:** if original callback never produced usable payload and every original IO resource has settled, no header/promotion action is uncertain. Close may drop its in-memory entry and release claims while retaining `.stage`; do not flag it as an unprovable header write forever. Cold reopen remains reserved/payload-required. **Actual unknown promotion/header/IO:** preserve existing B2 recovery failure/ownership debt rather than reporting close success or clearing issued state. Distinguish safe persistent fence from unproved native cleanup.

## 8. Inventory, ordinary target fencing and predecessor compatibility

Add `.promote` exactly to bootstrapPaths, owned inventory, foreign scans and JSONL delete-owned exact file whitelist. Older `.stage`/`.publish` names and literal bytes remain unchanged. `assertPublicBootstrap` continues fencing ordinary create/open/metadata mutation around capture-only stage; no `.jsonl` placeholder/listing appears. No headerless reservation delete API: leave it safely fenced. Existing actual target deletion tombstones before artifact cleanup and includes original stage/promote; tombstone prevents replay even after files disappear.

Keep owned deletion inventory separate from strict namespace discovery: `bootstrapArtifacts` returns only exact recognized stage/publish/promote names; a private namespace scan observes **all** files under that target prefix and marks unknown/malformed/future names as refusal evidence. Use that refusal scan in existing header read/prepare/reconcile too, so generic payload entry cannot bypass the new future-artifact rule. Never put unknown names into an owned deletion whitelist or silently filter them into absence.

Unknown/future artifacts cannot be swept/overwritten to regain absence. Do not change unrelated external files or ContextStore/index logic. Old owner versions recognize `.stage` presence but reject the new private variant/optional promoted field; new public operations require upgraded B2 owner. Do not promise downgrade recovery. Existing full stage without field remains literal-compatible; parent/initial/subagent generic B2 paths are not forced into this capture API. Preserve existing format11 birth→12 writer handling and actual immutable birth preservation.

## 9. One connected task, frozen file map

| Files | Owned change |
|---|---|
| New persistence `src/fork-contract.ts`; `package.json`; `src/index.ts` | Minimal browser-safe core/reader leaf only, narrow existing intent constructor/type export. No public prepare/operation/RPC contract rollout. |
| New persistence `src/coordinator/bootstrap-capture.ts` | Pure closed request/record codec and cohesive existing-B2 helper functions; no independent documents/target/completion map. |
| Existing persistence `coordinator/{bootstrap-types,bootstrap-header,bootstrap,managed-documents,types,binding-observation}.ts`, facade index | Exact optional contracts/gate, same entry/flight/admission, strict inspection/claims, generic conflict provenance, full-stage reservation preservation, callback reentrancy/close/IO integration. |
| New JSONL `src/backend/bootstrap-capture.ts`; existing `backend/bootstrap-header.ts`, `src/index.ts` | Strict capture reads/exclusive reserve/promotion IO helper+original resource tracking, Windows explicit directory skip, exact inventory/ordinary create/delete fence. Helper owned by existing bootstrap backend, not a second persistence layer. |
| JSONL `backend/fact-journal.ts` | Only causal full-stage/capture variant/birth compatibility guards needed by this integration; no journal redesign. |
| New persistence `test/bootstrap-capture.test.ts`, `test/fork-core-contract.test.ts`; new JSONL `test/bootstrap-capture-physical.test.ts` | Actual API/byte/native-resource process cuts, provenance/promotion/cold/generic conflicts, pure reader/browser graph checks. |
| Existing tests `semantic-bootstrap`, `binding-observation`, `existing-binding-observation`, JSONL `bootstrap-physical`, `delete-owned`, `retained-format-ownership`, `fact-batch-journal` | Preserve original populations and literal assertions; add only causal mixed-owner/format controls, no moving old RED to helper route. |

## Task 1: Complete B2 capture gate and qualify entire connected range

**Consumes:** exact data/contracts/records/state/resource rules above; actual current B2/native lock/JSONL owners. **Produces:** optional host-only capture-gated B2 path, strict source-free inspection and literal predecessor compatibility. No shipping public fork claim.

- [ ] **1. Record BASE and causal gap.** Read existing full B2 tests, private record readers and actual close/admission owners. Preserve current source-export-before-stage ordering as baseline; missing optional method/type is setup evidence, not behavioral RED. Root supplies exact checkout/BASE; this draft performs no Git action.
- [ ] **2. Add the exact core/request/record types and failing focused controls.** New tests use real JSONL/temporary roots/actual coordinator; inspect literal canonical records, not only self-generated equality. Core reader has no Node runtime imports and imports by browser leaf; parity tests preserve metadata/protocol limits. No SDK or visibility changes.
- [ ] **3. Implement strict owned backend reservation and resource hook.** Gate new optional methods; strict absent vs current/future/foreign/unavailable; exclusive marker publication, required file sync/readback/close, explicit Windows directory skip, original-token IO tracking/settle. Run focused tests, record actual failures and fix owner causes; no fake committed-new stub qualifies source safety.
- [ ] **4. Connect existing B2 one-flight capture and generic refusal provenance.** Publish before callback, enter once, validate returned original request/core/seed, preserve spent state on fault, no generic fill of capture-only state. Keep F0 exact target admission and read-only inspection outside mutation/source preflight. Add self-wait controls before lifecycle admission.
- [ ] **5. Implement monotone promotion and exact cold rebuild.** Preserve captureReservation automatically from original stage; pending promote exact byte continuation/rename/readback and existing header/seed/completion run. Qualify lost-response cold ready adoption and partial warm continuation without callback2. Preserve old full-stage literal bytes/manifests and allowed target metadata/suffix edits.
- [ ] **6. Qualify close/claims/deletion/future artifacts and run affected range.** Distinguish settled headerless fence from unknown IO, retry exact original resources and keep consumed-close debt. Run matrix and commands below sequentially; preserve raw outputs/platform limitations. No public handlers/UI/host-read rollout or ContextStore/index edit.
- [ ] **7. Report whole BASE..HEAD for root promotion/integration review.** Report scope, new private schema, real RED/GREEN/cuts, exact source/CWD/exit/native counts, process-model/Windows limitation and all remaining vertical obligations. Root owns integration and any commit policy; no self-declared public fork/release completion.

## 10. Actual RED/GREEN controls

Use deterministic promise barriers and actual native filesystem/locks; wrapper mocks may position/fail real operations but cannot return fake success. Tests attach expected rejection before revocation and release barriers/native fixture resources in finally. Do not use real user data. Controlled process cut/reopen of persisted roots must prove behavior independently of retained JavaScript maps.

| ID | Setup/trigger | Required oracle |
|---|---|---|
| P01 contract/gate | Valid core/request plus extra/undefined/accessor/proxy/unsafe ID/clock/digest/selection/metadata/protocol; each missing new backend method, old required method, disabled lock | Invalid before IO/callback; canonical owner recomputation; optional coordinator members present together only when complete supported gate. Old generic unsupported-before-capture remains. Browser leaf has no Node/SDK runtime cycle. |
| P02 record before capture | Actual source completed turn, real B1 export/compile inside callback. Read stage from callback before export | Literal capture record has invocation/core/intent only, no header/seed/manifest; actual file sync/readback/handle settle precede export; no target `.jsonl` exists yet; actual B2 later returns ready. |
| P03 zero-capture pre-issue | Guard/busy/acquisition unavailable before marker | No stage/callback; later same request can first-capture once with current completed cut and originally supplied resolved metadata. Later source-at-click claim is not inferred. |
| P04 duplicate originalflight | Simultaneous new capture calls with same request but different callbacks; generic external resume while first callback blocked | Exactly first callback once; exact duplicate/join returns original operation/result; resume cannot manufacture request; changed core/invocation/payload refuses before mutation. Repeat with two actual coordinators/OS lock conflict. |
| P05 spent callback | Callback throws literal error, invalid return, source guard changes, Stop before/inside callback | Marker retained; original diagnostic/refusal and cleanup evidence preserved. No callback on later exact call, even if source later completes/changes. Known settled headerless close can succeed without deleting fence; cold blocked. |
| P06 reservation cuts | Real exclusive create, partial0/short writes, file-sync/readback/close failure; process stop after confirmed reservation before callback | No uncertain admission/export; zero-byte/partial remains nonabsent. Reopen new backend/coordinator and call withCapture again with changed/closed source: callback0, original token payload-required/unknown. |
| P07 strict absence/future | Missing/inaccessible root, child ENOENT vs EACCES/EIO, target ordinary/headerless/tombstone, foreign key, future stage version/kind/field, unknown `.bootstrap-*` suffix, orphan promote | Only full proved absence returns absent; all others conflict/unavailable; no source/profile/target repair. Missing-root rejection occurs before native acquire/mkdir; verify root remains missing. Strict inspect changes no session/artifact bytes and releases temporaries. Retained captured phase plus apparent absent does not reset. |
| P08 generic overwrite trap | Cold capture-only record; supply new valid full seed under same invocation/core/metadata through generic bootstrap and resume payload; alternate seed/selection/source | No promotion/header/seed writes. Matching unsourced payload remains payload-required; mismatched expected fields conflict. Generic assignment to b.request does not become original provenance. |
| P09 promotion cuts | Actual full callback result, partial `.promote`, sync/readback failure, failed/lost-response rename, process stop after rename | Original stage never unlinked/truncated; reservation or exact full stage persists. Warm unchanged original request may continue bytes with callback0; cold reservation+pending promote cannot issue missing promotion/source; full stage resumes only actual B2 evidence. |
| P10 preserved optional field | Cold full promoted stage with original payload passed to resume; automatic builder reconstructs using original only | New captureReservation preserved byte-exact without fourth arg; no false conflict. Deliberate drop/change/add to predecessor refuses. Original header/manifest/seed/completion receipts unchanged; mutable target title/model/archive/workspace and later complete suffix remain compatible per old B2 rules. |
| P11 predecessor literal | Literal old full stage/header/seed/completion and format11 original birth, no captureReservation | Old parser/build/resume/birth preservation behavior and exact bytes unchanged. New pre-capture/full optional variants are deliberately rejected by predecessor parser, while .stage still fences create; no downgrade recovery claim. |
| P12 actual F0 topology | Existing source ManagedDocument open before outer fork F0; call new capture method inside exact invocation callback | Works one pass; source/target guard real; no target ordinary profile or binding write inside F0. Different invocation/existing-read callback self-bootstrap rejects; target-only strict inspection acquires no source/assembly/model work. Preserve original F0/existing-read tests. |
| P13 self-wait/close | Direct new capture callback (without relying on F0) invokes own target bootstrap/resume/capture, retire/delete or coordinator.close | Immediate conflict before admission mutation/self-flight wait; original guard remains current after caught refusal. External close revokes/joins complete callback/IO outside lanes; no force timeout. |
| P14 late/failed original IO | Pause native open before returning actual handle; close/Stop; inject close once before native action then same-handle success, and consumed-close-then-throw separately | Late handle registered before guard; independent disposers attempted. Original publication handles settle before capture. Cleanup retry same token/handle; consumed uncertainty stays debt. Actual dependent claims retained; temporary claim cannot release persistent adopter. |
| P15 capture-only cleanup | Known spent marker with all IO settled vs unknown promotion/header/handle | First can close/release actual claims and retain file; second preserves original B2 recovery/debt error and owners. No eager unlink/new owner proves disposal. Headerless reservation not listed/navigable/deletable via new admin API. |
| P16 actual deletion inventory | Ready captured target, actual deleteOwnedSession exact original files | stage/promote/publish inventoried exactly; tombstone before removal; later inspect/capture cannot see fresh absence/replay. Unknown future artifact not swept to regain absence. |
| P17 no early future work | Real target preparation/dependency traps and native carrier/result refs in actual seed | Pre-capture reserve performs no project association, legacy/result owner grant, dependency confirm, input/model/tool. After actual full materialization accepted B2 facts/real ports run normally. No visibility/hash/ContextStore substitute. |
| P18 directory scope | On Windows tag optional directory-flush branch; inject required stage file-sync/readback/rename/close failures separately | Optional directory attempt intentionally absent, limitation reported; required failures yield zero export. Process restart controls do not claim power loss or unrun platform qualification. |

Focused sample for P02/P04 (fixture uses actual controlled temp source/coordinator and original source witness; `captureRequest` is encoded through the frozen canonical owner):

```ts
let captures = 0;
const gate = Promise.withResolvers<void>();
const entered = Promise.withResolvers<void>();
const first = coordinator.bootstrapSemanticTargetWithCapture!(captureRequest, guards, async () => {
  captures++;
  const literal = JSON.parse(await readFile(stagePath, 'utf8'));
  expect(literal.kind).toBe('semantic-bootstrap-capture');
  expect(literal.request.invocation).toEqual(captureRequest.invocation);
  expect(literal.request.core.metadata).toEqual({title:'original title'});
  expect('seed' in literal).toBe(false);
  await expect(readFile(targetPath)).rejects.toMatchObject({code:'ENOENT'});
  entered.resolve(); await gate.promise;
  source.assertReady(); assertOriginalSourceWitness();
  const exported = exportConversationSeed(source.view,
    {kind:'session',sessionId:'source'}, {kind:'completed'});
  if (exported.kind !== 'seed') throw new Error('actual B1 selection refused');
  return originalRequest(compileSemanticSeed(exported));
});
await entered.promise;
const duplicate = coordinator.bootstrapSemanticTargetWithCapture!(captureRequest, guards,
  async () => { throw new Error('duplicate capture must never run'); });
try { expect(captures).toBe(1); } finally { gate.resolve(); }
const [a,b] = await Promise.all([first,duplicate]);
expect(a.kind).toBe('ready'); expect(b).toBe(a); expect(captures).toBe(1);
```

P10 must use an independently retained literal promoted stage and explicit original payload after **new backend/coordinator**; an in-memory warm assertion cannot catch dropped optional field on cold reconstruction. P06/P09 process-cut artifacts must survive a fresh owner/root read, not be recreated from expected JSON during test setup. Preserve original same-owner receipt/resource checks and no callback2 counts.

## 11. Verification commands and handoff

Run sequentially from actual package CWD. Use focused causal cycle first; broaden once implementation stabilizes:

```text
CWD packages/session-persistence
pnpm exec vitest run test/fork-core-contract.test.ts test/bootstrap-capture.test.ts test/semantic-bootstrap.test.ts test/binding-observation.test.ts test/existing-binding-observation.test.ts --maxWorkers=2 --minWorkers=1
pnpm exec vitest run test/bootstrap-intent.test.ts test/ownership.test.ts test/strict-document.test.ts test/managed-fact-batch.test.ts test/load-gate-coverage.test.ts --maxWorkers=2 --minWorkers=1
pnpm typecheck

CWD packages/session-persistence-jsonl
pnpm exec vitest run test/bootstrap-capture-physical.test.ts test/bootstrap-physical.test.ts test/delete-owned.test.ts test/retained-format-ownership.test.ts test/fact-batch-journal.test.ts test/document-observed-read.test.ts --maxWorkers=2 --minWorkers=1
pnpm typecheck
```

Add only causally affected original tests if owner changes demand it; no unrelated suite repetition. Preserve package-config/setup issues separately from behavior RED. Windows is the currently accepted observation qualification environment; report Linux only if actually exercised. Root reviews one immutable connected candidate and downstream types on integration; no public UI/build/release or provider work in this prerequisite.

Acceptance is new optional actual owner reachability, source capture after qualified original reservation only, originalflight once, no generic fill of capture-only state, exact promotion/cold optional-field preservation, strict absence/future-artifact behavior, complete original IO/claims cleanup evidence and unchanged predecessor/F0 populations. Headerless spent reservations may remain blocked forever under original identity. Successful public nested/nonempty retrieval, standalone fork compatibility cutover, prepared operation/RPC migration, both Desktop callbacks and strict host read helpers remain later vertical-task obligations; no weakened oracle or helper-only public completion claim.

## 12. Root lifecycle clarification — exact contexts and inspection resources (2026-10-26)

This section freezes the remaining lifetime details without adding public/backend methods or broadening the task. It refines sections2/5/6/7; the four backend hooks and all format/capture rules above remain.

### 12a. Retain actual held/issuer objects, not reconstructed token values

Actual `fact-owner.ts` `heldFactOwner(inputToken,ownership,assertLive)` creates **a cloned, frozen** `context.owner`. It registers the context object in its private WeakSet. `issuingFactOwner(held,beforeIssue)` spreads that context and therefore preserves the **same `held.owner` object reference**. Creating another held context from equal token values clones again; it is not the original backend IO owner. Current `bootstrap.run` unconditionally constructs a fresh held context/incarnation each run. That behavior cannot be copied for an entry that already owns capture/promotion IO debt.

For each new capture-owned existing ManagedEntry, retain one private IO ownership bundle on that entry for the entire local capture/promotion/retry/cleanup lifetime:

```ts
// Private existing-entry state, never wire/persisted/public construction.
captureIO: {
  claim: Awaited<ReturnType<Ownership['pinOwnership']>>;
  held: HeldFactOwner;
  issuer: IssuingFactOwner;
  activeIssue?: () => void;
  // original resource/cleanup status already described above
}
```

Acquire/retain that actual claim first. Construct `held` **once**, with its `assertLive` closure calling that same original `claim.assertHeld()`; do not capture entry.revoked, coordinator admission, F0/broker scope or source/Stop guard in this cleanup ownership assertion. Construct `issuer` once from that held context. Its beforeIssue dispatches only to entry.captureIO.activeIssue and throws the existing precondition/cancel refusal when no current issue phase is installed. Register backend IO by **captureIO.held.owner**, the constructor's actual cloned reference, not by the initial inputToken object, JSON values, sessionId or incarnation string.

`activeIssue` is installed only by existing B2 owner while the exact admitted original flight is actively issuing reservation/promotion/header bytes under fresh actual phase guards. Clear it before retiring that phase/attempt and synchronously at close/revocation. A warm attempt may install its fresh legitimate guard on the same existing bundle after original cleanup/currentness checks; it does not retain an expired F0/broker/source-signal closure. This dispatcher is not capture permission: original reservation provenance/phase still gates callback exactly once. It performs no source callback by itself.

For capture-owned entries, `run`, generic bootstrap/resume continuing that entry, reservation, header preparation, promotion and close **reuse this exact held and issuer context**. Replace run's unconditional fresh-context allocation on that branch; preserve predecessor generic entry behavior otherwise. A helper must accept/use the already retained contexts, not call heldFactOwner/issuingFactOwner around copied values. Every settlement call for that bundle is exactly `settleBootstrapCaptureIO(id,captureIO.held)`. Its call path never invokes issuer.beforeIssue, activeIssue, source assertion/export/capture or new publication. An issued context cannot be used as a reason to call a source callback during cleanup.

A cold process has no surviving native FileHandle/claim or in-memory bundle from its predecessor. It may establish a **new local** held bundle for new local read/reconciliation resources under existing durable stage/receipt rules. That is not settlement of old in-process debt and never authorizes recapture. In the same process, an existing bundle with unresolved original IO/claim must not be replaced by that cold/new-context pattern. Preserving source capture provenance and preserving original IO ownership are separate requirements; neither is inferred from equal data.

Backend settlement refuses replacement-token requests: a freshly constructed valid held context with equal OwnerToken values has a different owner reference and cannot settle or mark resolved another record. Track an original issued owner until its resources and explicit settlement complete, even when its current handle set becomes empty. A no-resource success is valid only for that registered original owner whose operations/cleanup were proved settled; it cannot clear another owner's debt or make its outcome successful. Ordinary new requests do not iterate/retry unrelated debtors. Backend records may be removed after confirmed original settlement; B2 also records that settlement and does not later relabel a new token's no-op as proof of the retired original.

### 12b. Strict inspection has a resource-only whole-flight set

Strict inspection must **not** install an unprepared ManagedEntry, bootstrap request, source phase, target reservation or completion cache merely to keep temporary IO alive. Add a resource-only set **inside the existing B2 owner** for inspection calls. Each item owns only its captured inspection request, whole-flight/done promise, checking-root/acquiring/reading/settling/releasing lifecycle, revoked flag, original pending acquisition, optional actual temporary claim+held context, known read result/error and original cleanup flight/debt. These are resource lifetimes, not durable truth/capture phase or an alternate target registry. Remove each successful item promptly after original cleanup; retain only unresolved original resources. It cannot answer absent/ready independently of actual backend state or override existing captured ManagedEntry phase.

Register the item and whole-flight promise synchronously **before the first `checkBootstrapCaptureRoot` await**. Close therefore sees an inspection that has no claim yet. After root check, recheck admission before starting acquire. If close wins during acquisition, await that exact acquisition promise; immediately record any resulting original claim before testing revocation. Do not race/cancel away a late acquired handle. If read IO was admitted, its original handles/token live on this same item. Final successful inspection result may return only after current admission check and all original readback-handle/claim cleanup; a revoked call must not return a usable absence result.

Create the inspection held context once after actual claim acquisition, with `assertLive:()=>originalClaim.assertHeld()`. Key its backend IO by that actual held.owner reference. Use that same held context for its read/settle. On read or publication-handle cleanup failure, retain the exact claim/context/item and original cleanup flight; do not release the claim needed by settle and create another one later. Only after backend IO settlement is proved may that item release its temporary claim. If claim release itself fails, retain that exact release capability/debt; no backend IO needs to be rerun, and a consumed-native no-op is still not proof of release. Unrelated persistent/adopter claims remain untouched.

An explicit coordinator close can retry the original cleanup of its retained inspection items after their original root/acquire/read flight settles, just as accepted observation close retries original disposers. A later ordinary inspection of the same or another target cannot trigger a debtor's retry or borrow its resources. Close starts settlement attempts for each owned item independently and aggregates failures; one debtor must not prevent another late acquisition from being joined.

### 12c. Why cleanup remains valid after admission closes

Actual ownership assertions are distinct from new-work admission. `observations.closeAdmission` marks observation scopes revoked/closed, and managed close marks entries revoked; neither by itself releases the native session slot. `ownership.assertHeld(id)` checks enabled locking, actual slot lock.held and slot debt, not observation/coordinator admission. More strongly, the original borrow/pin claim's `assertHeld()` checks its own retired flag, original slot incarnation, actual native held bit and slot debt. Neither reads the capture callback's revoked flag. `heldFactOwner.assertHeld` calls its supplied assertLive and then ownership.assertHeld; using the original-claim closure above therefore remains valid for cleanup while that original claim is retained and actually held.

This does **not** make a revoked callback current or allow writes: source/host/Stop/observation guards and activeIssue are separately revoked/cleared. Cleanup uses only the original held context and held original claim. If the actual native claim is lost, retired, releasing/debt-bearing or consumed, assertHeld must fail and settlement remains unresolved; do not swap in a fresh slot/token or weaken assertHeld to a label/no-op. No fact-owner.ts/ownership.ts semantic rewrite is needed for this distinction.

Facade close first performs the already-required self-wait checks, synchronously closes existing observation admission **and** new capture/inspection admission before its first await, and clears issue admission. Join both original observation work and B2 capture/inspection whole lifetimes, attempting both joins even if either reports a failure. A failed observation join must not cause the inspection root/acquisition set to be skipped. Only after those resource joins/settlement succeed may dependent managed/lifecycle release proceed; otherwise preserve required claims and attempt independent drainage under existing `lifecycle.close(false)` discipline. Subsequent explicit close retries the same retained original cleanup bundles/items, never creates replacements or re-enters source capture.

### 12d. Narrow file/test clarification

Keep this work within already assigned `bootstrap.ts`/cohesive `bootstrap-capture.ts`, `managed-documents.ts`, facade index and existing JSONL capture IO helper/tests. No public signature or format addition and no new general registry/module is required. Existing fact-owner/ownership constructors remain the actual authority; use them correctly rather than changing cloning or claim semantics.

Extend P04/P14/P15 with literal object-identity and resource-lifetime assertions:

- Original `held.owner` is not the constructor input token; original issuer.owner is **the same object** as held.owner. Warm retries, generic run/promotion and close pass that same held/issuer/owner reference. A fresh equal-valued held context cannot settle the old ledger; original debt remains and no beforeIssue/source counter runs during settle.
- Pause root check before any claim, pause actual claim acquisition before returning it, and pause backend read/settle separately. External coordinator close stays pending through each original whole flight, revokes result admission, joins late resources and leaves zero temporaries after proved success. No unprepared target ManagedEntry/completion cache appears on a successful absent inspection.
- Fail original inspection FileHandle cleanup while a real temporary claim is held; verify close uses that exact held context/claim, retries only its original disposer and does not release a persistent adopter. Also inject a consumed-native claim release failure and preserve unresolved debt without replacement-token settlement.
- Close admission while original IO remains cleanup-valid: original held.assertHeld succeeds only while its original claim/native slot is actually held, source/new-work/activeIssue guards refuse, backend settle succeeds without beforeIssue. After claim release or actual native debt, original held.assertHeld fails; an equal-valued fresh context does not repair it.
- Make observation join fail while a separate inspection root/acquire is pending. Capture/inspection close still joins/settles that original item, aggregates both original errors and preserves only actual unresolved dependent resources. No callback/receipt phase is inferred from the resource-only set.
