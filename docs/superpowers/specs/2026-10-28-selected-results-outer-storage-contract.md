> Root bounded promotion2026-10-28: independent review accepts ONLY pure units1–2 (DTO/domain and public V3 stage/manifest/preparation) for implementation. Captured report SHA2568B7590D4853163A297C3B26B9E8626CCB3EE24C2F6A474B08B9FD72C9AF20F54. Two Important integration gaps remain: original inherited-observation handoff and B2 result/read/control interfaces. The full proposed body follows for context; sections5–7/units3–5 have no implementation authority until the separate addendum is reviewed. Product remains0.1.13-rc.1/Session13, no release. Use ROOT task-3-pure-implementation-brief.md as exact execution boundary.

# Task 3 outer/storage contract preflight

2026-10-28. Research-only proposed freeze for root review. No Task 3 implementation, test execution, runtime/probe, network, dependency or Git mutation was performed. The only authored artifact is this report. No release or later-task acceptance is implied.

## 1. Evidence and disposition

Implementation source is immutable HOST `61320f2878e34a89f4a9a5b68a43c4c5cbebcca1`, read with `git show` in `C:/Users/inkik/.codex/worktrees/context-host-transfer/I-harness-main`. Normative design/plan and codec addendum are the named ROOT files; they are not present at that HOST commit, so they were read explicitly from ROOT. Task 2 acceptance is the named `task-2-rereview.md`, including immutable metadata, cumulative collection bound and safe-layout corrections. Historical compatibility inspection below is explicitly `cf60c67784dafc4e0161e47ada42a785730e4592`, not a candidate transplant or executed old-process result.

Research scope caveat: one discovery command used `git ls-tree -r --name-only <frozen commit> -- packages` piped to a JSONL-src filter. Although its returned output contained only JSONL source paths and no protected file contents were read, this traversed a broader tracked-name namespace than the brief permitted. Subsequent source reads used explicit paths. This report does not claim strict compliance with the no-enumeration constraint for that command.

The accepted codec is sufficient for a separately versioned storage route. It is **not** sufficient to make the existing public route V3-capable. Freeze a third exhaustive route arm, dedicated V2 outer readers and V2 stage/birth validation, while retaining existing public and child-v1 readers and bytes. The current integration baseline already contains the reviewed route owner; the older design's warning about absent route owners on dd is historical, not a reason to copy another checkout.

Source findings that determine this proposal:

| Frozen owner | Finding / required consequence |
| --- | --- |
| persistence `fork-contract.ts`, `bootstrap-intent.ts` | Existing DTOs are V1; request intent hashes are V1. Dedicated V2 readers/domains are necessary. |
| `bootstrap-route.ts` | Public routes retain invocation only; child routes retain the full request. Multiple helpers default unknown non-child kinds to public. Replace those fallthroughs with exhaustive cases, preserving old cases verbatim. |
| `bootstrap.ts:captureTarget` | Actual target lease/reservation is acquired before callback; only `committed-new` enters it. B2 retains `ownedRequest`; callback throws leave spent reservation. Preserve that state machine. |
| `bootstrap-header.ts` | Old header/stage reconstruction accepts V1/V2 only; groupCount is records.length-1. Neither expression may be reused for V3. |
| JSONL `bootstrap-stage.ts` | Centralized full namespace lookup recognizes only old public and child keys. All route/header lookups must add the new candidate. |
| JSONL `bootstrap-capture.ts` | Partial promotion uses matching-prefix continuation, original reservation and held IO ledger. New strict lookup needs a deliberate warm partial-promotion path; merely admitting a new parser is insufficient. |
| `bootstrap.ts:dependencies` | Empty conversation artifacts currently return EMPTY_SEMANTIC_DEPENDENCY_DIGEST without a port call. Forbidden for V3: resources may exist without conversation artifacts. |
| `managed-documents.ts` | Cold opening calls readJournalPrefix before resolveBirth. V3 birth validation must precede any prefix repair/truncation, not be added afterward. |
| JSONL `fact-journal.ts` | Task 2 explicitly denies V3 prefix repair and frame ACK; append/reconcile use shared header/namespace checks. V3 authoring requires a dedicated validated route-aware lane, without removing legacy denials. |

## 2. Closed outer V2 types

These are exact proposed field sets. Existing named scalar contracts below are reused unchanged, not widened: BootstrapInvocation remains V1; BootstrapCallerMetadata, BootstrapProjectIntent and completed selection retain frozen V1 validation limits. `Digest` is lowercase 64-hex SHA256. `Readonly` applies deeply to all returned snapshots. Optional fields are absent, never present-undefined. There is no initial input, child profile, none selection, supplied candidate list or supplied seed on the public V2 request.

```ts
type Completed = {kind:'completed';atSeq?:number};
type ForkPrepareRequestV2 = {
  version:2; sourceSessionId:string; selection?:Completed;
  metadata?:BootstrapCallerMetadata; results:'selected-results-v1';
};
type ForkRequestCoreV2 = {
  version:2; kind:'session-fork-core'; sourceSessionId:string;
  selection:Completed; sourceCapture:'first-authorized-capture';
  metadata:BootstrapCallerMetadata; results:'selected-results-v1';
};
type SelectedResultsRequestIntentV2 = {
  version:2; kind:'selected-results-fork-intent';
  requestCoreDigest:Digest; project:BootstrapProjectIntent;
};
type ForkPreparedV2 = {
  version:2; kind:'session-fork-prepared'; core:ForkRequestCoreV2;
  requestIntent:SelectedResultsRequestIntentV2; requestDigest:Digest;
};
type ForkPrepareResultV2 =
  {kind:'prepared';prepared:ForkPreparedV2} |
  {kind:'unavailable';reason:'unsupported'|'source-unavailable'|'policy'|'unavailable'};
type ForkOperationV2 = {
  version:2; kind:'session-fork-operation'; prepared:ForkPreparedV2;
  invocation:BootstrapInvocation;
};
type ForkCommandV2 = {operation:ForkOperationV2;mode:'begin'|'retry'};
type CaptureState = 'uncaptured'|'captured'|'unknown';
type ResumeTokenV2 =
  {version:2;invocation:BootstrapInvocation;phase:'header';manifest:'unknown'} |
  {version:2;invocation:BootstrapInvocation;
   phase:'header'|'dependencies'|'seed'|'completion';manifestDigest:Digest};
type ForkReceiptSummaryV2 = {
  version:2; invocation:BootstrapInvocation; manifestDigest:Digest;
  seedLength:number; dependencyClosureDigest:Digest;
  seedDigest:Digest; sourceObservation:{kind:'semantic';digest:Digest};
  results:ResultsSummaryV1;
};
type NotIssuedV2 = 'cancelled'|'stale-source'|'unsupported'|'busy'|
  'source-unavailable'|'policy'|'unavailable';
type RefusalV2 = 'conflict'|'nonempty'|'cached-unprepared'|'wrong-view'|
  'incompatible'|'manifest-invalid'|'target-policy'|'invalid-selection'|
  'source-unsupported'|'ambiguous-boundary'|'no-completed-boundary'|
  'straddling-group'|'unsafe-input-component'|'invalid-seed'|'source-changed'|
  'legacy-anchor-unsupported'|'ambiguous'|'unsupported-history'|'metadata-limit';
type ForkOutcomeV2 =
  {version:2;kind:'ready'|'adopted';operation:ForkOperationV2;capture:'captured';
   sessionId:string;seedLength:number;receipt:ForkReceiptSummaryV2;title?:string} |
  {version:2;kind:'not-issued';operation:ForkOperationV2;capture:CaptureState;reason:NotIssuedV2} |
  {version:2;kind:'blocked';operation:ForkOperationV2;capture:CaptureState;
   reason:'unknown'|'payload-required'|'dependency-unavailable'|'source-changed';token:ResumeTokenV2} |
  {version:2;kind:'refused';operation:ForkOperationV2;capture:CaptureState;reason:RefusalV2};
type ForkHostErrorDataV2 = {
  version:2;kind:'session-fork-error';operation:ForkOperationV2;capture:CaptureState;
  reason:'host-unavailable'|'cleanup-incomplete'|'internal';lastOutcome?:ForkOutcomeV2;
};
```

Keep existing kind strings on V2 outer objects; version and the required results discriminator separate them. Reservation/stage kinds below are new. `results` is mandatory on prepare/core even though omitted selection/metadata normalize to completed/empty metadata. Do not put result digests in preparation or operation: these precede capture. The receipt carries the captured commitment; it does not make it authority.

Every object is closed recursively: reject unknown own string/symbol keys, accessors, nonenumerable data, inherited required fields, nonplain prototypes, proxies on Node admission, cycles, sparse/extended arrays, undefined, nonfinite numbers and unsafe integers. Browser readers must use own descriptors without calling getters; Node trust admission independently rejects proxies. Preserve original safe ID/path restrictions, 256-character IDs, 237 printable-ASCII operationId limit, canonical UTC millisecond timestamp, UTF-8 title <=32768 bytes, exact model protocol enumeration, project rules and nonnegative safe atSeq. Required hashes are validated, not coerced. Freeze detached snapshots; do not return a spread of caller input.

Prepared/operation admission recomputes both V2 hashes, compares canonical complete intent/core/project, requires invocation.requestDigest = prepared.requestDigest and target != source. Outcome/error readers require exact canonical operation equality against expected operation, not only operationId. Ready/adopted require exact target ID, receipt invocation, seedLength and requested title; count >=1 and summary structural validation. Source/result/seed equality against actual installed birth is a host qualification check, not something the browser can infer from operation. Preserve capture monotonicity when lastOutcome already proves captured. Unknown transport/host replies retain the original operation and cannot mint another invocation or downgrade.

## 3. Route, reservation, stage and preparation

```ts
type SelectedResultsCaptureRequestV1 = {
  invocation:BootstrapInvocation;
  core:ForkRequestCoreV2; requestIntent:SelectedResultsRequestIntentV2;
}; // name is V1; no extra version property on this closed request
type SelectedResultsRoute = {
  protocol:'public-results-v1';request:SelectedResultsCaptureRequestV1;
};
type SelectedResultsReservationV1 = {
  version:1;kind:'semantic-bootstrap-selected-results-capture';
  request:SelectedResultsCaptureRequestV1;
};
type SelectedResultsBootstrapRequest = {
  invocation:BootstrapInvocation;target:{kind:'new'}|{kind:'resume';manifestDigest:Digest};
  metadata:BootstrapCallerMetadata;lineage:{origin:'fork';parentSession:string};
  seed:CompiledSelectedResultsSemanticSeed;
};
type SelectedResultsStageSeed = {
  digest:Digest;dependencyDigest:Digest;sourceObservation:{kind:'semantic';digest:Digest};
  seedLength:number;groupCount:number;resultPageCount:number;
  profile:'public-completed';results:ResultsSummaryV1;
};
type SelectedResultsHeaderBase = {
  formatVersion:13;sessionId:string;createdAt:string;
  journal:{version:1;legacyBodyBytes:0;legacyEventCount:0;
           legacyPrefixDigest:Digest;separatorBytes:0};
  seedLength:number;origin:'fork';parentSession:string;
  title?:string;workspaceId?:string;modelSelection?:SessionModelSelection;
};
type SelectedResultsHeaderStageV2 = {
  version:2;kind:'semantic-bootstrap-selected-results-header';
  captureReservation:SelectedResultsReservationV1;invocation:BootstrapInvocation;
  originalTarget:{kind:'new'};metadata:BootstrapCallerMetadata;
  lineage:{origin:'fork';parentSession:string};headerBase:SelectedResultsHeaderBase;
  seed:SelectedResultsStageSeed;headerBytes:string;
};
type SelectedResultsHeader = SelectedResultsHeaderBase & {
  semanticSeed: Omit<SeedHeaderV3,'initialInputId'|'initialInputDigest'|
    'initialStartedAt'|'initialExpiresAt'|'profile'> & {profile:'public-completed'};
};
type SelectedResultsPreparationFacts = Omit<BootstrapPreparationFactsV2,'semantic'> & {
  semantic:Extract<BootstrapPreparationFactsV2['semantic'],{profile:'public-completed'}>;
};
```

The invocation and metadata in a stage must equal its reservation; lineage is exactly fork/sourceSessionId. Its source observation is semantic only; records[0] is V3 public-completed, origins[0] is the actual source session and revision equals sourceObservation.digest. Manifest selection equals core selection exactly, including absent atSeq. `initial`, delegation fields, existing-empty target, child profile and none are forbidden, not ignored. Resume is only an internal same-operation transition; stage.originalTarget stays new. There is no selected-results generic supplied-seed writer exposed to callers. Authentic controller capture admission supplies the compiled request; pure compiler validation alone cannot authorize publication.

Build headerBase directly from the validated fields above; never spread an existing header or extra SessionMeta fields. Its empty legacyPrefixDigest is the existing legacyPrefixDigest(0, emptyBytes). SemanticSeedV3 fields are exactly accepted Task 2 header fields with no initial tuple. Match header/manifest/summary/profile/layout using Task 2 helpers, including safe completion count arithmetic. Stage seedLength = 1 + resultPageCount + groupCount; results.pages = resultPageCount. Stage and header canonical UTF-8 plus LF retain existing 262144/65536 byte limits. Reservation uses canonical UTF-8 plus LF and <=262144 bytes; parsers roundtrip bytes exactly. Full seed records are not duplicated into the stage.

Route/reservation/stage parsers dispatch by exact discriminants. Missing reservation on a V2 stage fails. A V3 header does not imply a route; cold lookup must find and validate the unique full selected-results stage and request. Old no-reservation stages retain their old public inference **only after** successful old-stage validation. There is no V3 fallback.

Preparation uses the accepted `captureSelectedResultsBootstrapPreparationFacts` with public-profile narrowing: version2, exact invocation, manifestDigest, seedDigest, dependencyDigest, semantic source observation, seedLength, groupCount, resultPageCount and semantic {version3, profile, selection, turns, results}. Derive these from original validated capture or reconstructed and checked birth records. No caller-supplied facts, second projection or substitute summary. Existing V1 `preparationFacts` stays V1-only.

## 4. Hash inputs and complete binding

`H(domain,x) = bootstrapHash(domain,x) = SHA256(UTF8(domain + NUL + canonicalJsonData(x)))`. Use the existing canonical implementation. All new domains below are literal; field names are part of the contract.

| Commitment | Exact input |
| --- | --- |
| requestCoreDigest | H('ih.bootstrap.selected-results.core.v1', normalized ForkRequestCoreV2) |
| requestDigest | H('ih.bootstrap.selected-results.request.v1', complete SelectedResultsRequestIntentV2) |
| path key | H('ih.bootstrap.selected-results.path.v1', complete captured invocation) |
| sourceObservation.digest | Existing H('ih.semantic-seed.source.v3', seedPreimage(seed)); seedPreimage removes origins, uses source label without revision and inheritedOrigins = origins.slice(1), and includes version/profile/selection/turns/omissions/artifacts/groups/results/passive exactly as accepted Task 2. |
| seed.digest | Existing H('ih.semantic-seed.v3', complete validated SemanticSeedV3Public) |
| dependencyDigest | Existing H('ih.semantic-seed.dependencies.v3', {version:3,profile,selection,artifacts,results:seed.results}); results includes summary AND pages. |
| outer manifestDigest | H('ih.bootstrap.selected-results.manifest.v1', {version:2,route:{protocol:'public-results-v1',request:stage.captureReservation.request},captureReservation:stage.captureReservation,invocation:stage.invocation,target:stage.originalTarget,metadata:stage.metadata,lineage:stage.lineage,headerBase:stage.headerBase,seed:{digest:stage.seed.digest,dependencyDigest:stage.seed.dependencyDigest,sourceObservation:stage.seed.sourceObservation,seedLength:stage.seed.seedLength,groupCount:stage.seed.groupCount,resultPageCount:stage.seed.resultPageCount,profile:stage.seed.profile,results:stage.seed.results,records}}) |

Outer manifest deliberately includes request/reservation, full record bytes as canonical data and the summary/layout copies; redundant fields are validated for equality before hashing. headerBytes and semanticSeed.manifestDigest are excluded from preimage, preventing a cycle. HeaderBase has no semanticSeed. Header receives the computed manifestDigest afterward. No new results-fold domain is introduced: use the accepted selected-results codec fold verbatim. No Task 3 closure-digest formula is invented; actual protocol proof remains Task 5.

Validation order: capture outer DTO → recompute intent → reserve → original factory context → one results projection and origin-plan finalization → one selected conversation payload capture and one passive CodeStore capture via accepted exporter → compile/recompute source+seed+dependency → stage binding+outer manifest → canonical header → target preparation/dependency proof → seed/completion publication. On reconstitution, rebuild the accepted seed from exact records and check all hashes again. Structurally valid but mismatched source/selection/origin/table/summary/seed/intent is refusal, never selection downgrade.

## 5. Original owners and retry state machine

The controller retains operation identity, attempt/spent flags, original ForkSourceWitness and cleanup handles. The genuine source host supplies one held managed document/view and source/binding currentness; it additionally supplies the original held inherited metadata reader. B1 creates the authentic CompletedPassiveContext inside the once-only capture callback, from that exact source owner and core selection. `exportSelectedResultsConversationSeed` owns projectSelectedResults, the registered held origin plan, one payload capture and one passive capture. The controller must not pre-project and then call the exporter again. Do not expose copied contexts, public candidate lists, fabricated empty inherited readers or injected summaries as authority.

B2 retains the immutable compiled `ownedRequest` and constructed stage; it does not persist a callback, context or plan. The factory's one-use plan is spent after export; warm retries reuse B2's captured DTO, never rerun it. The original source witness remains retained for warm currentness checks until ready/retirement/close and cleanup settlement. Inherited observation lifetime is part of the same original host scope and must be checked during every projection await/advance and before publication. Copying source digest is not retaining currentness.

Use the existing pinOwnership/session-operation lease and actual target tombstone checks. Original target lease/IO ledger stays held through reservation, callback and subsequent publication as the existing owner requires. Capture enters only after the current attempt receives committed-new and settlement/currentness succeeds; a readback showing a reservation does not authorize callback entry. AsyncLocalStorage reentrancy denial and original callback error identity stay intact.

| Observed state | Allowed result / action; callback count |
| --- | --- |
| Truly absent, current original source, no prior attempt/debt | New exclusive reservation; committed-new allows one capture. |
| Cancelled/stale before issue with proved absence | not-issued cancelled/stale-source, uncaptured; zero callbacks. |
| Reservation issued; cancellation/currentness lost before callback | blocked unknown/source-changed; reservation spent; zero callbacks, never replay later. |
| Existing full reservation, including same invocation | payload-required; zero callbacks for retry, even if original process remembers an unentered callback. |
| Zero-byte/torn reservation or lost reservation reply | unknown; retain tuple/debt; no continuation into callback. |
| Warm captured DTO plus exact reservation | Revalidate original currentness and request; may materialize/publish original bytes without capture. |
| Warm captured DTO plus matching partial promote/header | Strict same route/key/namespace plus exact prefix of retained expected bytes allows continuation; no recapture. |
| Cold reservation + partial/full promote but no promoted stage | unavailable/unknown or payload-required; do not treat promotion as new capture authority. A separate read-only diagnosis may recognize a complete matching promote; this contract does not let it reconstruct absent payload. |
| Full stage, no header; or empty/torn header | Warm original DTO can resume exact header/records. Cold stage lacks records: payload-required (unknown if malformed/torn bytes cannot bind), no reacquiring source. |
| Full stage + complete seed frame, completion missing | Reconstruct/check records from committed seed frame. Reconciliation may confirm already-issued facts; a new completion write still requires valid original currentness and actual protocol confirmations. Without that, blocked. |
| Full stage + complete birth, lost ready reply | Passive reconciliation checks exact route/birth/frames and actual dependency/target proofs; can adopt without source recapture or ancestor reopen. |
| Header retained, original stage missing | unavailable; never generic public fallback or fabricated stage. |
| Foreign/mixed/duplicate keys or request mismatch | conflict; no mutation or callbacks. |
| Tombstone/owned deletion | terminal existing deletion semantics; no recreation or alternate root. |

Capture presentation is conservative: only proved absent with no attempt/reservation/debt is uncaptured; successful birth is captured; ambiguous issued work is unknown. Callback failure does not become not-issued merely because its thrown value resembles cancellation. Cleanup debt retains the actual owner handle and operation; settle pending IO and close/release in the existing order. Failed cleanup never makes operation reusable, remints identity, or releases a fresh-operation guard. Retire/close fence new work, join flights, settle debt, then release source references; passive reconciliation of prior issued facts must not issue new work through a stale guard.

## 6. Task 5 boundary and internal port contract

Task 3 may implement private V2 handoff plumbing, not protocol grants. Keep existing V1 dependency/preparation ports unchanged. New internal ports consume the same captured/checked facts and records, and are independently typed so old ports cannot receive them accidentally:

```ts
type SelectedResultsDependencyInput = {
  version:2;route:SelectedResultsRoute;
  facts:SelectedResultsPreparationFacts;
  seed:CompiledSelectedResultsSemanticSeed;
};
interface SelectedResultsDependencyPort {
  confirm(input:SelectedResultsDependencyInput,current:()=>boolean):Promise<BootstrapDependencyOutcome>;
  reconcile(input:SelectedResultsDependencyInput):Promise<BootstrapDependencyOutcome>;
}
interface SelectedResultsTargetPreparationPort {
  confirm(request:{invocation:BootstrapInvocation;manifestDigest:Digest},
    current:()=>boolean,facts:SelectedResultsPreparationFacts):Promise<BootstrapTargetPreparationOutcome>;
  reconcile(request:{invocation:BootstrapInvocation;manifestDigest:Digest},
    facts:SelectedResultsPreparationFacts):Promise<BootstrapTargetPreparationOutcome>;
  assertTargetCurrent():void;
}
type SelectedResultsGuards = {
  signal?:AbortSignal;assertCurrent():void;
  dependencies:SelectedResultsDependencyPort;
  targetPreparation:SelectedResultsTargetPreparationPort;
};
```

Input data is closed/frozen and cross-validated to the same route/facts/stage/records; functions are descriptor-captured with original receivers and genuine signal validation. These are internal capabilities supplied by the owning host, not JSON credentials. `BootstrapDependencyOutcome` retains its existing exact confirmed {closureDigest} / blocked {unknown|unavailable|conflict|policy} shape. Task 5's adapter must verify real managed plus L1 proof and exact binding before returning confirmed. A digest does not create that capability. Require both V2 ports for the selected route; missing support fails before capture as unsupported, and unavailable later confirmation blocks dependency-unavailable. Never fall back to V1 ports or the artifacts-empty shortcut. Even empty results take the V2 protocol path until an independently reviewed empty-proof rule exists. Fixture ports can prove storage sequencing only, with that limitation explicit in receipts; they cannot qualify production READY.

No Gateway/SDK endpoints or advertised capabilities are enabled by Task 3. Keep exports internal to persistence/controller composition needed by tests; later Task 6 owns shipping host wiring. Native positives, body reads, recipient proofs, model discovery, child all/N and defaults remain later gates.

## 7. Namespace and immutable birth requirements

For the same sessionPath, derive old public key unchanged, childBootstrapPathKey unchanged, and new selected key. Explicitly compare all three and fail conflict on any collision. Never choose an alternate key. The selected route filenames are existing `.bootstrap-${key}.stage|promote|publish`; publish is structurally recognized but forbidden for this new-only route. Existing-empty publication remains old-route behavior.

Inspect the entire basename `.bootstrap-` namespace under the same real target lease. Unknown suffix/name is unavailable; any foreign operation/route key, extra matching sibling, multiple candidate stages or mismatched discriminant/key is conflict. Zero bytes are present, not absent. Full reservation + partial promotion can only be continued by the live retained DTO after validating exact reservation and expected byte prefix; cold broad lookup stays unavailable. Original public diagnostic fallbacks remain scoped to public, never copied as a generic new-route fallback. All awaits are followed by held/currentness checks before any issue.

| Consumer that must change | Mandatory precondition before mutation or ACK |
| --- | --- |
| bootstrapPathsForRoute; lookupBootstrapStage route/header expectations | Third exact candidate; all-key disjointness, full namespace, route/request/key equality. |
| capture backend read/reserve/prepare/reconcile | Exact reservation kind + route arm; same ledger; new-only header path; no child/public boolean dispatch. |
| header backend readState/resolveBirth/prepare/reconcile | Parse selected stage explicitly; headerless retained artifacts remain selected; no old `parseBootstrapHeaderStage` fallback accepting V3. |
| coordinator run/checkBirth/stageRoute/inspect/resume/adopt | Dedicated V3 compiler/layout/manifest/facts path; route absent on selected birth is unavailable. |
| binding-observation wrappers and controller | New typed route/guards with original receivers; retain original source/binding observation and cleanup owners. |
| managed cold opening/cached ready | Resolve/validate original V3 birth before V3 prefix-repair/attachment; cached route must equal actual birth route. Missing backend capability fails. |
| ordinary create | Always reject selected header supplied through old create; namespace reserves target even before header exists. |
| ordinary append/replaceEvents/repair/updateMeta | Validate original retained stage, exact immutable birth header fields and seed/completion frames first. Suffix/title edits may proceed only through new validated route-aware support. Preserve original birth frame bytes and keys. |
| upgradeSessionFormat | V3 is already format13; route-aware no-op still validates birth. No downgrade/rewrite-through-old upgrade. Old guard remains. |
| owned readJournalPrefix | Selected-only validated birth/prefix before any torn-tail truncate/sync; source failure leaves bytes unchanged. |
| owned append/reconcile and confirmBootstrapFrames | Exact resolved route, stage and phase scope before write/truncate/fsync/receipt. During bootstrap validate staged prefix plus incoming exact phase; after completion validate immutable complete birth. Never require complete birth before first seed write. |

Keep ordinary metadata comparison scoped to immutable header fields already used by preserveBootstrapBirth (sessionId, createdAt, journal, parentSession, seedLength, origin, delegationDepth, subagentProtocolVersion, semanticSeed). Stage stores original metadata; later valid title/model/workspace changes do not change the birth commitment. Reject protected-field patching. Suffix rewrites keep original seed/completion frames byte-for-byte; they may not re-encode those frames with fresh IDs. Completion remains accepted session/bootstrap V1 at seedLength with original bootstrap batch IDs; public selected route has no initial event. Read-only metadata/listing is not readiness.

## 8. Internal consistency and limitations

| Potential contradiction | Frozen resolution |
| --- | --- |
| V2 outer, V1 invocation/reservation, V3 seed | Intent and route select versions explicitly; no globalSession bump; global format remains13. |
| Stage <=256KiB vs result metadata up to8MiB | Stage contains summary/layout only; records live in original retained DTO/journal. Headerless cold stage cannot reconstruct records. |
| Results-only capture with zero selected groups | seedLength = 1+pages, not1+groups; no empty-artifact dependency bypass. |
| First authorized capture vs retry | Durable reservation authorizes exactly the issuing original callback once; presence is never replay permission. |
| Immutable birth vs ordinary title/suffix changes | Preserve immutable fields+original frames; mutable metadata/suffix does not remint manifest. |
| Cold adoption vs source currentness | Reconcile original issued birth/protocol receipts without source capture; new writes require original valid scope. |
| Compiler validity vs authority | Compiler proves commitments; authentic context/host/lease and later protocol ports supply authority. |
| Supported V3 reads vs old writer denial | New explicit route-aware lane; keep legacy entry guards. Do not globally delete Task2 denials. |
| Public V3 vs child | Child-v1 all/N remains unsupported on V3 source; literal none reads no history and retains old bytes. |

No source-inspected path establishes an unavoidable old cooperating-writer bypass for canonical V3 headers at cf60: its parseHeader calls validateSubagentHeader, whose validateSeedHeader is closed to versions1/2 and the old field set. Ordinary updateMeta/repair/upgrade also enter birth checks; new stage names are foreign to old route lookup. This is a **source prediction only**. The genuine frozen dd/cf60 ACTIVE matrix is still mandatory; this report did not run it, inspect every historical revision, or certify older releases.

Known impossibilities must be retained as outcomes, not hidden: cold full-stage/no-journal capture recovery cannot recover payload; a lost committed reservation reply cannot safely replay callback; Task 3 cannot produce real selected-result READY without Task 5 proof; the existing stage-size cap cannot be bypassed by embedding 8MiB records. A future observed old non-delete mutation that drops protected data requires a normal protocol/format-boundary ruling. New guards cannot retroactively fix an immutable old process; do not add sentinels, parallel roots, false parser-only claims or relax the matrix to accommodate it.

## 9. Bounded implementation units and staged verification

1. **Pure outer contract**: `selected-results-fork-contract.ts` plus `coordinator/selected-results-intent.ts`. Exact DTOs, immutable snapshots, intent and path inputs; no IO. Negative unknown-property/getter/proxy/unsafe count/profile/version/source-target controls; golden V1 bytes and V2 retry identity.
2. **Pure stage/birth contract**: `coordinator/selected-results-header.ts` and `selected-results-preparation.ts`. Compile validation, stage/parser, manifest, facts, layout and public-only narrowing. Pure roundtrip and every independently tampered binding field; same-digest structurally altered table denial; zero-page/zero-group/result-only and safe arithmetic edges. Reuse accepted codec limits rather than duplicate it.
3. **Route/namespace storage**: focused extension to bootstrap-route and JSONL stage/capture/header leaves. Add exact selected path matrix, foreign/collision/duplicate/wrong-discriminant controls, torn/empty reservation and promotion/header byte-preservation. Preserve old route literals. Separate pure namespace fixture tests from actual lease IO tests.
4. **Original capture owner**: `coordinator/selected-results-bootstrap.ts` and a small shared lifecycle integration in bootstrap.ts; `selected-results-fork-controller.ts` (or small controller adapter), binding wrappers and exports. Reuse target owner/IO/debt lifecycle, do not clone a 600-line bootstrap engine into another monolith. Instrument one factory/projection/plan/capture/passive capture, no old exporter/recapture; cancellation before/after reserve, callback throw, original receiver, poisoned aliases, stale inherited observation, close and cleanup failure.
5. **Birth-preserving mutation/adoption**: focused route-aware helpers in JSONL fact-journal and coordinator managed opening. Verify cold resolve before destructive prefix repair, complete-frame ACK scope, exact original frame identity, legitimate suffix/title changes, missing/foreign stage, headerless warm recovery and cold payload-required. Keep old explicit denies until selected lane is in place.
6. **Bounded composition/review**: run only root-released new tests and named compatibility controls, then independent review. No Gateway exposure. Task 4 is a separate gate, followed by Task 5 actual protocol integration.

Recommended new focused tests: persistence `test/selected-results-fork-contract.test.ts`, `test/selected-results-bootstrap.test.ts`, `test/selected-results-capture.test.ts`; JSONL plan-named `test/selected-results-bootstrap.test.ts` with ordinary birth controls split into `test/selected-results-birth.test.ts` if size warrants. Test names here are proposed work, not existing receipts. Reuse named Task2 compatibility candidates: persistence semantic-bootstrap/bootstrap-capture/bootstrap-cached-ready/child-bootstrap-routes/passive-code-store-bootstrap; JSONL bootstrap-public-compatibility/bootstrap-physical/child-bootstrap-stage/meta/retained-format-ownership; core selected-results codec and immutable-source controls. Root must authorize the exact bounded command set and protected-excluding type graph before execution; no glob/broad suite.

Task 4 must exercise actual immutable old owners against fresh shared roots: zero-byte/torn/full reservation; headerless stage; partial/full promotion; empty/torn/full header with stage; retained header missing stage; same invocation; actual same-target lease race; create/append/replace/repair/meta/upgrade and owned prefix/append/reconcile/ACK. Snapshot target and stage bytes around each attempted action, including negative no-callback/no-truncate results. Do not substitute a copied matchingPrefix or mocked parser for genuine ACTIVE evidence. Task 3 tests are current-build storage evidence only.

## 10. Freeze recommendation

Accept this explicit outer/storage proposal only after root review, particularly the exact manifest domain/preimage, receipt commitment fields, internal V2 ports and cold-no-payload outcomes. Implementation should preserve those decisions as closed codecs and explicit route arms. No remaining Task 3 ambiguity needs protocol-body or child-route design to be guessed: both remain independently gated and selected production readiness stays unavailable until their required owners exist.
