# Semantic result transfer and host preparation implementation plan

> **For agentic workers:** use subagent-driven-development with an independent review for each task. Tasks1/2 run in isolated checkouts; Task3 follows their reviewed integration.

**Goal:** Complete original R4B Task3's actual result transfer and genuine pre-ready host authority, including empty-artifact initialization and passive original confirmation.

**Architecture:** Preserve the existing artifact mutation owner, coordinator bootstrap owner and project broker. A separately captured host preparation port runs before dependency publication and READY; artifact transfer distinguishes new source-authorized publication from passive confirmation of exact target publications. Actual fork/spawn/transport caller cutover stays original Task4.

**Tech stack:** TypeScript, Node24, pnpm, Vitest, existing JSONL/managed facts and immutable result artifacts.

**Spec:** [approved R4B](../specs/2026-10-22-context-r4b-semantic-inheritance.md), [original plan](2026-10-22-context-r4b-semantic-inheritance.md). The [accepted parallel foundations](../../research/2026-10-23-context-parallel-foundations-acceptance.md) supply verified immutable I/O, bounded catalog parsing, semantic refs and genuine READY scopes. This plan freezes the specific new contracts below, superseding the earlier preflight proposals where stated.

## Global constraints

- Product0.1.13-rc.1 / Session11; no publication or decomposition-only work. Existing28/43 decomposition credit does not advance.
- All new subagents use gpt-6-astra until the user changes it. No recursive agents. One writer/runtime per isolated checkout; root alone integrates after review.
- Keep the same storage/mutation/lease/history/project owners. No second raw store, artifact index, ACL store, reservation manager or public authority registrar through tools/RPC.
- Source body/history size is not serialized request size. No result-body materialization for transfer; bound catalog pages32768bytes and entry descriptors8192bytes, preserving count-dependent identity bookkeeping honestly.
- Preserve original full refs/operations, all catalog occurrences and selected seed associations. No <=100 generic-grant workaround, copied roots, fake receipts, fake graph consumers, exemptions or reachability reseed.
- Empty dependency closure stays the accepted literal and calls neither dependency method. Host preparation is a separate optional phase, including empty artifacts.
- Tests use actual owners/bytes/controlled failures and isolated IH_CONFIG_DIR/evidence roots. New-API/setup failures are not behavioral RED. Sequential commands per checkout, maxWorkers2/minWorkers1, exact source/time/commit binding and explicit known failures.
- This plan supplies storage/host capability primitives and their genuine adapter. Real fork/spawn/team/reviewer/SDK/CLI/Desktop intent capture and execution cutover remain original Task4; do not silently start or duplicate a child here.

## Frozen host and artifact interfaces

Use the actual core BootstrapDependencyRequest/Outcome without importing persistence into context-output. Add types under context-output's artifact owner and normal service facade only:

```ts
interface SeedDependencyTransferScope { readonly kind:'seed-dependency-transfer' }
interface SeedDependencyTransferBinding {
  operationId:string; manifestDigest:string; sourceSessionId:string;
  targetSessionId:string; targetDocumentId:string;
}
interface SeedDependencyHostAccess {
  binding:SeedDependencyTransferBinding;
  sourceAccess:ContextAccess;
  sourceAvailable():boolean;
  assertSourceCurrent():void;
  targetAvailable():boolean;
  targetScope():{source:NonNullable<ContextCapture['source']>;revision:string};
  assertTargetCurrent():void;
}
// Added to the actual ContextOutputService; model tools expose none of these.
registerSeedDependencyTransfer(access:SeedDependencyHostAccess):SeedDependencyTransferScope;
confirmSeedDependencies(scope:SeedDependencyTransferScope,
  request:BootstrapDependencyRequest,current:()=>boolean):Promise<BootstrapDependencyOutcome>;
reconcileSeedDependencies(scope:SeedDependencyTransferScope,
  request:BootstrapDependencyRequest):Promise<BootstrapDependencyOutcome>;
```

Capture closed own data and function references synchronously; no getters, proxies, hidden fields, symbol keys or toJSON drops. Private WeakMap membership identifies genuine service registration; targetDocumentId equals targetSessionId for this session bootstrap. Registration may capture sourceAvailable=false for passive recovery. NEW confirm requires source checks, caller current and target checks; PASSIVE reconcile ignores original source runtime/action availability, but requires exact original metadata/publications and current target authority. No target/source header string restores roots. Every callback is trusted host composition, not an in-process JavaScript sandbox.

T-04: BootstrapDependencyRequest contains no origin table or seed groups. Reuse existing full-ref/strict-data/canonical codecs, with a private closed transfer-request validator for exact artifact/use/address fields; do not fabricate a seed graph or export core internals. Origin upper bounds and group-use associations remain the actual coordinator's full-seed validation responsibility, not claims made by this narrower DTO codec. Capture the full first request in the original registered scope and require exact request agreement on retries, including artifacts/uses/origins, not only binding strings. Origins confer no access. Source authorization and original artifact/target evidence remain mandatory.

Persistence owns this separate optional port on BootstrapGuards:

```ts
interface BootstrapTargetPreparationRequest {
  invocation:BootstrapInvocation; manifestDigest:string;
}
type BootstrapTargetPreparationOutcome={kind:'confirmed'} |
  {kind:'blocked';reason:'unknown'|'unavailable'|'conflict'|'policy'};
interface BootstrapTargetPreparationPort {
  confirm(request:BootstrapTargetPreparationRequest,current:()=>boolean):Promise<BootstrapTargetPreparationOutcome>;
  reconcile(request:BootstrapTargetPreparationRequest):Promise<BootstrapTargetPreparationOutcome>;
  assertTargetCurrent():void;
}
// Existing signal/assertCurrent/dependencies remain unchanged.
interface BootstrapGuards { targetPreparation?:BootstrapTargetPreparationPort }

type BootstrapProjectIntent={kind:'unmanaged'}|{kind:'unassigned'}|{kind:'project';projectId:string};
interface BootstrapRequestIntent {version:1;requestCoreDigest:string;project:BootstrapProjectIntent}
```

Pure request-intent helpers belong in persistence/coordinator/bootstrap-intent.ts (SDK already depends on persistence). `createBootstrapRequestIntent(core:unknown,project)` returns `{intent:BootstrapRequestIntent,requestDigest:string}` after strict data capture. `captureBootstrapRequestIntent(invocation,intent)` validates closed fields and matching digest and returns detached frozen intent. Hash H is existing bootstrapHash, UTF8 domain+NUL+canonicalJsonData. Core digest H(`ih.bootstrap.request.core.v1`,core); outer digest H(`ih.bootstrap.request.v1`,{version:1,requestCoreDigest,project}). Existing caller logical preimage is core; it excludes roots/live revision/manifest/closure/receipts and the outer digest. These helpers hash observations, not authority. Export only helpers/types with a real consuming task; do not add a facade export solely for tests.

Gateway adds the host-only broker method with the following captured input/result:

```ts
interface BootstrapProjectCapture {
  invocation:BootstrapInvocation;requestIntent:BootstrapRequestIntent;
  sourceSessionId?:string;
  sourceAvailable():boolean;assertNewWorkCurrent():void;
  targetAvailable():boolean;
}
interface BootstrapTargetScope {projectId?:string;scope?:SessionProjectContext;revision:string}
interface BootstrapProjectPreparation {
  targetPreparation:BootstrapTargetPreparationPort;
  targetScope():BootstrapTargetScope;
  assertSourceCurrent():void;
  close():void;
}
prepareBootstrapInheritance(capture:BootstrapProjectCapture):BootstrapProjectPreparation;
```

The factory captures synchronously and rejects unmanaged mode. It can be created before the manifest is known; confirm/reconcile receive the actual manifest and require actual coordinator.inspectBootstrap(full original invocation) to prove reserved/ready with that exact token. Public target profile/snapshot/open is forbidden while incomplete. Its first successful revision baseline is immutable for that attempt, including confirm followed by final reconcile. Revocation/reconfigure ABA invalidates the attempt permanently; a new genuine attempt may acquire a new baseline with unchanged immutable intent.

T-06: coordinator capture includes optional preparation absence before its first await. Reject configured inherited/accessor/hidden forms without getter calls or reservation; own data undefined is captured absence. Preserve other existing live guards and their original receivers. T-07: staging uses the genuine target capability and checks every original owner sourceId, when present, against target sourceId; it never uses ordinary READY target read authorization. Actual body reads retain that authorizer. T-08: NEW source authorization covers every distinct direct-root/member-via-catalog relation and is renewed after preflight, around the relevant publications and after final integrity checks. PASSIVE uses no source authorization or hooks.

The broker's returned assertSourceCurrent is a read-only NEW-work check over the genuine source binding/catalog revision captured by confirm, plus capture.sourceAvailable/assertNewWorkCurrent. It is unavailable before source confirmation and is never called by passive reconciliation. This closes the gap between initial source confirmation and later artifact awaits without making the target getter depend on the parent's runtime. It uses the existing broker observation/authority owner, not a copied roots closure or new authority store.

Original project intent must already match requestDigest before transport. Saved target project documents only supply a recovery candidate if the retained original requestCoreDigest verifies it. Absence differs from explicit broker-unassigned; no broker means explicit unmanaged. Invocation alone cannot invert a hash. Missing original intent/payload blocks honestly; no current-source recapture or replacement operation. Actual wire/start/team intent fields are Task4, not changed by this wave.

### Task 1: Original-operation artifact transfer and v2 witnesses

**Owner/files:** context-output/src/artifact/{ownership,pins,dependency-membership,bootstrap-transfer}.ts plus cohesive private codecs/fold helpers in that directory; src/{types,service,index}.ts only the required service API. Tests context-output/test/bootstrap-transfer.test.ts and focused existing artifact tests. No host/persistence/native production edits. Main checkout.

**Interfaces:** consumes accepted immutable continueAtomicJson/confirmAtomicJson, readDependencyCatalog and the actual original-operation authorizer; produces the three service methods above. No reentrant call through public mutate-owned readResult inside artifact mutate.

- [ ] Write actual service/bytes controls for two retained members, unavailable entry and repeated member sourceIds. New API absence is recorded separately. Existing real grant/pin layout establishes original source, not a manufactured transfer receipt. Assert no member body reads, all catalog entries retained, canonical-first v2 ordinal, original operation/body/catalog bytes unchanged, and target reads via exact catalog after transfer.
- [ ] Register scope with strict captured binding/hooks; validate request full refs through existing codecs and exact request/use/count/address fields at the narrower T-04 boundary. Validate all root/catalog metadata to EOF and all original source operation/pin/catalog membership evidence before any target write. For NEW work, source branch/current project checks remain real authorization. Recheck source/caller/target after waits and immediately before every mutation. Matching labels or parsed refs alone grant nothing.
- [ ] Extend new target pin with closed `seedTransfer` equal to the captured transfer binding; keep original artifact operationId/revision and actual target document/session, `state:'committed'`. Existing target pins lacking/differing transfer binding conflict rather than becoming this operation's receipt. Keep existing access pointer format/path. Legacy ordinary pins/reads retain compatibility. New optional binding is strictly validated when present.
- [ ] Add closed v2 companion at the existing singular path: version2/kind=result-dependency-transfer, workspaceId, documentId/sessionId, full catalogRef/memberRef, full ORIGINAL catalogOwner, original catalogOperationId/memberOperationId, sourceId, lowest matching ordinal, manifestDigest, transferOperationId, sourceSessionId. Max8192encodedbytes; oversized original owner yields typed unavailable. Validate actual catalog entry/canonical alias and both target pins on v2 read; return original catalog owner/ref to host authorization. Nested transfer validates source v1/v2 evidence and retains original identities.
- [ ] Continue exact target pin/access/companion bytes under the existing mutation lease using accepted no-clobber helpers. All final/pending evidence participates; no overwrite/conflicting-final cleanup. Passive reconciliation only sync-confirms existing exact publications: no source authorization prerequisite, no missing-pin recreation, no generic void grant. Preserve original operation metadata and current target scope; missing source pins alone do not revoke surviving target pins. Owner close/deletion/current target policy still gate work.
- [ ] Implement the nonempty canonical closure fold from the prior preflight section4, now normative: H start domain `ih.bootstrap.dependencies.closure.start.v1` over `{version:1,workspaceId,operationId,targetDocumentId,targetSessionId,sourceSessionId,manifestDigest}`; roots sorted canonicalJsonData(full ref), each root H root-domain over `{previous,ref,owner:originalRootOwner,uses:canonical-sortedUses}`; catalog roots in same order, entries in ordinal order H entry-domain over `{previous,catalogRef,catalogOwner,catalogOperationId,ordinal,entry,...retainedMemberOwnerAndOperation}`; end H end-domain over `{previous,rootCount,catalogCount,entryCount,retainedMembershipCount}`. Domains are `ih.bootstrap.dependencies.closure.{root,entry,end}.v1`. Retained extra fields are `memberOperationId,memberOwner`. Include every unavailable/alias occurrence; counts mean occurrences, not deduplicated pins. No mutable policy, pending path, completion record or closure digest enters its own preimage. Empty remains the existing literal/no dependency call.
- [ ] Add independent literal hash vectors, >100entry catalogs, wrong full refs/uses/count/ordinal/sourceId/manifest, nested transfer, wrong target/source capability, source policy revocation before issuance, target revision ABA mid-I/O, target deletion/pin removal, source pin release with target retained, and real pin-before-access/companion link/sync/response cuts. Validate physical retention separately from authorization. PASSIVE must call source access zero times and never mutate inventory except sync; missing/partial original work returns unavailable/unknown/conflict appropriately. Bodyless failure is not success, and no partial closure is returned confirmed.
- [ ] Stable context-output tests/types plus affected native dependency controls with fresh evidence roots; commit only owned files, report exact range/hash/commands/limitations. Fresh review before integration. Genuine broker composition remains Task3 below, so callback-only tests are storage-boundary evidence only.

### Task 2: Same-owner host phase and genuine pre-ready broker preparation

**Owner/files:** persistence/coordinator/{bootstrap-types,bootstrap,bootstrap-header,bootstrap-intent}.ts and narrow facade exports; Gateway/project-scope.ts and same-owner helper files; focused persistence/JSONL bootstrap and Gateway project tests. Host worktree. No context-output/native changes or actual fork/spawn/wire cutover. May add the deferred distinct catalog-only helper test, without changing its product implementation.

**Interfaces:** produces exact targetPreparation/project intent/broker interfaces above; consumes actual inspectBootstrap/full invocation and accepted broker revisions. This task does not depend on Task1's implementation to qualify its own owner ordering.

- [ ] In the same coordinator owner, after confirmed header/incomplete attachment and outside withSessionOperation, call host confirm before dependency confirmation even for zero artifacts. Recheck assertTargetCurrent after await, before each seed/completion issue through original admission guards and before READY. NEW source/action/Stop checks remain. In adopt: birth validation, passive host reconcile/current, passive dependencies, original closure comparison, held original-frame confirmation, final target current, READY. Passive adopt does not require a live source action merely to confirm original issued work. Configured failure yields existing blocked/dependency-unavailable/token; preserve phase/event/version unions.
- [ ] Add strict target phase outcome/request and intent codecs. The original bootstrap closed-record helper's hidden-property gap must not be repeated; fix that shared own-field check when touching it, with a real nonenumerable DTO rejection control and valid ordinary metadata positives. Do not alter intended allowed model/title fields or original header bytes on retries.
- [ ] Implement real broker factory and unchanged document layout. Under existing target serial, inspect original operation/manifest; refresh durable target binding after load rather than trusting cached uncertain save. NEW path validates actual source selection/current revision or admitted explicit import selection, then writes only the captured project intent if absent. Passive path requires existing exact binding, never writes or reads source profile/runtime. Missing/different/malformed/readback-failed binding cannot confirm. `putDocument` void completion alone is not proof.
- [ ] Resolve actual canonical scope without entering catalog queue/drain from its own active admission. Check broker/reference/target lifetime before and after waits. Freeze first successful target baseline and expose copied live getter; getter never refreshes its baseline. Target-only passive authority remains independent of sourceAvailable. No public incomplete profile, synthetic SessionMeta visibility, copied roots or sourceFor(incomplete target).
- [ ] Correct actual move lock ordering to `fence.exclusive(target,()=>serial(target,work),preflight)` so it does not hold target broker serial while draining a registered bootstrap queued behind it. Preserve idle/descendant/document/currentness checks and existing drains. Do not change public fork arm yet; actual Task4 will use admitted source/target work outside long exclusive locks.
- [ ] Actual tests: real reserved JSONL target + real configured broker/canonical directories, public profile remains unavailable during preparation, zero-artifact dependency methods called zero times, same-run confirm/reconcile cannot reset ABA baseline, wrong invocation/manifest/current source, saved unassigned/foreign/missing binding, close/revoke/reconfigure while put/readback/scope resolve waits, landed-write/lost-response then passive exact recovery, passive source counters0/writes0. A queued move behind an earlier broker operation must drain without deadlock. Root closure hashes are independently literal; unmanaged/unassigned cannot interchange.
- [ ] Run only changed persistence/JSONL/Gateway scopes and types on stable source; preserve existing fork RED and report any staged export honestly. Commit assigned files and report. Fresh review, then root integration before Task3's actual adapter tests.

### Task 3: Genuine host-artifact composition and connected Task3 qualification

**Owner/files:** Gateway/context-runtime.ts host-only preparation adapter, host/service composition types only as needed; executor result-store lease exposure only when required for the actual non-Gateway owner; actual bootstrap-transfer/Gateway integration tests. Root assigns one writer after Tasks1/2 reviewed integration; no parallel edits to these shared seams.

**Interfaces:** add host-only `prepareBootstrapTransfer(capture:BootstrapProjectCapture,sourceAccess:ContextAccess|undefined):{targetPreparation:BootstrapTargetPreparationPort;dependencies:BootstrapDependencyPort;close():void}` to the actual native context runtime, using the broker preparation factory supplied by host composition. Gateway uses its supplied-service fast path. Capture source authorization from original host access, not model or header DTO. The dependency port lazily registers exact scope on its first actual manifest-bearing request, reuses the same binding thereafter, derives target source identity via existing contextSourceIdentity and broker getter, uses the broker's assertSourceCurrent for NEW work, and delegates confirm/reconcile to actual service. NEW nonempty confirmation requires matching supplied sourceAccess and genuine live source predicates; anonymous observations cannot invent source authority. `close` synchronously invalidates only the attempt capability, not original artifact ownership or durable target pins; the existing caller joins its bootstrap/port work before normal cleanup, and early invalidation is observed by the original owners' guards. No second queue is added. Generic unmanaged hosts must use actual existing source/target owner; absence of project owner cannot fabricate cold authority.

T-09: ContextAccess itself is a session-label/signal DTO, not permission. A cold PASSIVE-only factory may lack the original live source access object. From the actual coordinator-generated, strict original dependency request it may capture only `{sessionId:request.sourceSessionId}` for registration, with NEW source availability forced false and source-current assertion refusing; no source hook, profile, signal or authorizer is evaluated. Exact target operation/manifest/project authority and existing bound publications still must confirm. Such a registration cannot later upgrade to NEW work; a fresh attempt with genuine source access is required. If supplied sourceAccess exists, require exact sourceId agreement in both modes. Do not expose this adapter through raw model/RPC dependency DTOs or manufacture missing publications. Test cold passive adoption without source access and refusal of subsequent NEW use of that same factory.

- [ ] Implement actual adapter and tests using real broker, coordinator, source/target scopes, catalog/member bytes and target pins. Empty seeds exercise host phase without dependency callbacks. Nonempty transfer establishes genuine ready target and actual read after source runtime closes. Passive reconcile must skip source profile/access but require target live revision. Missing target publication refuses without recreation; wrong catalog/fullref/manifest and mid-read/publish target revocation deny.
- [ ] Integrate the distinct catalog-only ref fixture promised in the earlier review and test rewind versus reset/replacement with separately indexed result and catalog. Preserve old observer typed denial and all successful-page final checks.
- [ ] Run connected affected suites/types and normal reachability on fixed integrated source. Original fork/spawn cutover remains original Task4 and its RED remains disclosed. Review full plan range, close findings, preserve source-bound raw evidence and update canonical progress; no publication or unrelated decomposition.

## Execution checks

Task1 and Task2 share only frozen data contracts above; artifact code imports core data, broker imports persistence types, neither imports the other's new implementation. Task3 consumes both after root integration. Existing source/target policy and immutable record conflicts are typed outcomes; no unresolved API placeholder permits guessing at authority. Authoritative next native-source report is separate work and does not grant edits in this plan's files.
