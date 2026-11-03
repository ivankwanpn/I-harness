# R4B Semantic Inheritance and Owned Bootstrap Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver bounded semantic inheritance, qualified target bootstrap and inherited-native request safety through the existing history, persistence, artifact and execution owners.

**Architecture:** Source export selects current effective history through the sole structural history owner, then captures only selected typed payloads into codec1. Persistence compiles dedicated format11 seed records and commits them through the existing managed-document owner; artifact transfers and native target preparation use their existing owners and narrow ports. B1, B2 and B3 are separately reviewed; whole B is withheld until their connected real-consumer range qualifies.

**Tech Stack:** TypeScript ESM, Node.js, pnpm, Vitest, existing JSONL owned fact journal and Windows fs-lock.

**Spec:** [approved R4B design](../specs/2026-10-22-context-r4b-semantic-inheritance.md), [root decisions](../../research/2026-10-22-context-r4b-design-decisions.md), [R4 source qualification](../../research/2026-10-16-context-engine-r4-seed-delivery-preflight.md), [owner rebase](../../research/2026-10-18-context-engine-r4b-current-owner-rebase.md), and [framework](../specs/2026-10-15-context-engine-framework.md).

Task2 source refinement: [R-B-20 through R-B-27](../../research/2026-10-23-context-r4b-b2-owner-rulings.md) bind the existing registry/pump, original header staging, partial-header token, exact noncircular hashes, historical-frame confirmation and dependency/task boundaries. These specific rulings supersede the earlier abbreviated bootstrap signatures where they differ; no Task3/4 consumer or whole-B acceptance is implied.

## Global constraints and status

- **ROOT APPROVED FOR IMPLEMENTATION2026-10-22.** Existing user approval covers the redesign and continued root-led GPT6.1Sol development. Root reviewed the contracts and recorded the explicit rulings linked above. Design promotion is not implementation acceptance; no product/runtime/test operation was performed in this design pass.
- Accepted starting source: documentation `5f95ce1825168b2f49cbe83df209cdc2806267cd`, R4A product `678af03dd54659e22dd5f941112c06ec9917e812`; branch `codex/v0.1.13-development`. Rebase exact line numbers at dispatch without another broad census.
- Session format11; codec1. Product stays `0.1.13-rc.1`. No push, merge, tag, release, R4C, decomposition-only batches, new raw/artifact/ACL store, scheduler, writable opening map or auth-management lease.
- Default none performs no parent payload projection/clone. Role/model/tool/current instruction/permission floors and original child action start/deadline survive all awaits.
- Keep correct raw remapping/proof closure as a distinct raw export. Do not flatten inherited semantic messages into fabricated local accepted/tool/result facts.
- Never execute a child model/tool before confirmed header, exact dependency transfer, seed and initial-input/completion receipts. Ready/reentry is not permission to rerun an already launched or uncertain action.
- Source inspection/export/native source lookup stays credential/provider/model-free. The pure native fallback loop does not auth/count/send; actual target model resolution remains the existing execution preparation boundary.
- Source/reader, bootstrap/consumer and native/request gates require one writer and fresh functional review. New public exports need their real consumers at the connected gate; no fake graph consumer or exemption.

---

## Closed data contracts

The following names are root-selected for this implementation. Cohesive helper files under the stated owner directories may be added for codec validation, structural turn selection or payload capture when required; do not make a single large module or unrelated extraction. Any contract/owner deviation must return to root before implementation. Imported names already exist: core-session's `SessionView`, `SessionEvent`, `LLMMessage`, `ManagedArtifactRef`, `ResultEnvelope`, `ResultExecution`, `ConversationProvenance`, `ConversationCoverage`, `ConversationItemRef`, `JournalPrefix`, `FactReceipt`, `EncodedFactBatch`, `FactOutcome`; persistence's `SessionMeta`, `SessionModelSelection`, `IssuingFactOwner`, `HeldFactOwner`, `ManagedDocument`; and llm-seam's `ModelClient`, `LLMRequest`, `PreparedModelRequest`, `ExecutionConfirmation`, `LiveExecutionIdentity`, `RouteKind`, `GenerationControl`, `PreparedValidation`. New definitions below must be introduced with their real consuming task. Core-only data contracts do not import persistence/executor/provider types; model-selection creation metadata stays in persistence, and foundational bootstrap event data stays in core-session.

### Source selection and codec1 — core-session data, no executor/provider imports

Create `packages/core-session/src/conversation/seed-types.ts`:

```ts
type Digest = string; // closed codec requires lowercase SHA256, exactly64 chars
type SeedSourceLabel = {kind:'session';sessionId:string}|{kind:'anonymous'};
type SeedOrigin =
  | { kind: 'session'; sessionId: string; revision: Digest } // observation, not freshness
  | { kind: 'anonymous'; contentDigest: Digest };
type TurnInterval = readonly [first: number, last: number]; // positive, inclusive
interface SeedTurnDomain {
  total: number; completed: readonly TurnInterval[]; unframedPrefix: boolean;
}
type TurnExtent = { kind: 'framed'; first: number; last: number }
  | { kind: 'unframed' };
type SeedSelection = { kind: 'none' } | { kind: 'all' }
  | { kind: 'last-turns'; count: number }
  | { kind: 'completed'; atSeq?: number };
type SeedRefusal = 'invalid-selection' | 'source-unsupported' | 'ambiguous-boundary'
  | 'no-completed-boundary' | 'straddling-group' | 'unsafe-input-component'
  | 'invalid-seed' | 'source-changed';
interface SeedOriginAddress { origin: number; seq: number; part: string }
interface SeedOmission {
  source: readonly SeedOriginAddress[]; digest: Digest; extent: TurnExtent;
  state: 'open' | 'unresolved'; calls: number; relatedInputs: readonly number[];
}
interface SeedArtifact {
  ref: ManagedArtifactRef; // unique by full immutable identity in this table
  origins: readonly SeedOriginAddress[];
  uses:readonly ({kind:'result'}|{kind:'dependency-catalog';count:number})[];
}
type SeedSourceRetention =
  { kind: 'inline-observation'; encodedBytes: number; sourceValueDigest?:Digest }
  | { kind: 'artifact'; artifact: number }
  | { kind: 'unavailable'; reason: 'quota' | 'encoding' | 'storage-refused'
      | 'unsupported-owner' | 'capture-canceled'; observedEncodedBytes?: number };
interface SeedResultBase {
  message:number;source:readonly SeedOriginAddress[];
  media: readonly { message: number; part: number }[];
}
type SeedResult=
  | (SeedResultBase & {kind:'legacy';isError?:true})
  | (SeedResultBase & {kind:'envelope';execution:ResultExecution;
      sourceRetention:SeedSourceRetention;
      dependencies?:{kind:'catalog';artifact:number;count:number}
        |{kind:'unavailable';reason:Extract<SeedSourceRetention,
          {kind:'unavailable'}>['reason'];count:number}});
interface SeedCall {
  id: string; name: string; assistantMessage: number; call: number;
  result: number; outcome: 'success' | 'error' | 'not-dispatched';
  source: readonly SeedOriginAddress[];
}
interface SeedSourceProvenance {
  origin:number;kind:ConversationProvenance['kind'];
  authority:ConversationProvenance['authority'];scope:'turn'|'session';
  producer?:string;
}
interface SeedItemBase {
  extent: TurnExtent;
  scope: 'turn' | 'session'; producer?: string;
  origins: readonly SeedOriginAddress[];
  sourceProvenance:readonly SeedSourceProvenance[];
  messages: readonly LLMMessage[];
}
type SeedItem=
  | (SeedItemBase & {kind:'input';input:{raw:readonly SeedOriginAddress[];
    derivedContext: readonly SeedOriginAddress[];
    media: readonly { message: number; part: number }[];
    omittedWork?:number}})
  | (SeedItemBase & {kind:'summary'})
  | (SeedItemBase & {kind:'exchange';calls:readonly SeedCall[];
      results:readonly SeedResult[];
      sourceAcceptance:'explicit'|'legacy-inferred'|'inherited-observation'});
interface SeedGroup { extent: TurnExtent; items: readonly SeedItem[] }
interface SemanticSeedV1 {
  version: 1; origins: readonly SeedOrigin[]; selection: Exclude<SeedSelection,
    { kind: 'none' }>; turns: SeedTurnDomain;
  omissions: readonly SeedOmission[]; artifacts: readonly SeedArtifact[];
  groups: readonly SeedGroup[];
}
type SeedExport = { kind: 'none' }
  | { kind: 'seed'; seed: SemanticSeedV1; digest: Digest;
      sourceObservationDigest:Digest }
  | { kind: 'refused'; reason: SeedRefusal };
exportConversationSeed(view: SessionView, sourceLabel:SeedSourceLabel,
  selection: SeedSelection): SeedExport;
validateSemanticSeed(value: unknown): SemanticSeedV1;
```

Messages contain the selected projected wire-facing content only. A legacy/inline selected result may contain that actual content; consumed original bodies are never copied. Legacy results explicitly preserve projected content/isError/media with no invented ResultExecution or retention descriptor. Envelope-backed results preserve their actual typed execution/retention/catalog metadata as **source observation**. `sourceRetention.inline-observation` is size/optional original digest evidence, not a promise that the full original inline program value exists in the child, especially after source pruning. Include sourceValueDigest only when the genuine source owner already supplies it or it is computed from selected unpruned source data; absent digest is honest, and projected/pruned text cannot manufacture the original-value digest. Do not read/clone a pruned-away original inline value merely to populate this optional field. A source address is observation and any later source lookup still requires real read authority. No wire-text parsing fabricates an envelope/dispatch/retention claim.

Exact typed refs live once in `artifacts`; `uses` permits the same exact ref in both result and catalog roles. Deduplicate uses; validate catalog count consistency and each use's codec, and refuse same id/revision with contradictory immutable identity. An existing projected text string may itself contain JSON describing a ref and must remain exact, but it is never parsed to grant access. Calls point into existing assistant toolCalls rather than duplicating args; media descriptors point into message parts rather than duplicating image bytes. Source addresses are **observations**, not local coverage addresses or ACLs.

`sourceProvenance` retains original human/plugin/child-report/model/tool/summary kind, original authority/scope/producer and origin linkage as a nested observation descriptor. Even original authority=`request` is historical data only. The target's actual projected provenance is always kind=`inherited`, authority=`observation`, with the separately selected protection scope; it cannot grant local human/instruction/tool/permission authority. Nested export keeps original source descriptors rather than replacing them with an unexplained inherited label.

Root R-B-11 fixes `SeedOmission.relatedInputs` as sorted unique zero-based **input-only ordinals** across emitted seed input items in semantic group/item order. These are not event sequences, group/all-item positions or authority. Each input.omittedWork is an omission-table index, and relatedInputs is its exact reverse relation: every linked input appears once in that omission's list and each reverse entry must have the matching forward link. Empty lists are valid when no retained input links to an omitted interval. Recompute both sides after selection/nested export; never copy historical numeric indices verbatim. Reject duplicates, out-of-range or mismatched reverse entries. Preserve original source/unit observations separately.

Root R-B-14 adds required omission.extent in the same semantic turn domain as groups. Derive it from the enclosing original omitted interval plus its related safe input components; include extent in the omission hash. Nested selection considers every historical omission, including entries with no surviving linked inputs or messages. All retains them; N/completed keeps wholly contained extents, excludes wholly outside, and refuses straddling-group when an inseparable omission interval crosses the requested boundary. Never clip/invent a range or silently retain unrelated omissions. Unframed follows the existing all-prefix/N rule. Rebase selected extents, omission-table indices and both input relation directions together. This can conservatively refuse a narrow fork whose audit interval crosses the boundary; it never creates local waits/execution authority. Metadata-only all/N/completed, nested unlinked omissions and straddle controls are required.

Closed codec rules: own enumerable data only, ordinary/null record prototypes, dense arrays, exact key sets/discriminants; safe nonnegative counts/indices and positive framed ordinals; no operational request/action/attempt/admission/preparation/permission/usage/receipt fields. The nested sourceProvenance.authority is an explicit historical enum, not an operational request field. Validate indices, role order, complete call/result pairing, exact IDs/name/args positions, source-derived outcomes, media companions, unavailable retention, table identity/uses and origin references. The discriminated union forbids `calls/results/sourceAcceptance` on input/summary and `input` on exchange/summary; summaries contain their actual text as user message and no executable call. Session-scope source input remains session-scope protection, with inherited observation authority.

Canonical digest convention is SHA256 of UTF-8 `domain + '\0' + canonicalJsonData(value)`, using the existing core canonical JSON semantics (object-key order canonical, array order retained, opaque strings exact). Domains are `ih.semantic-seed.v1`, `ih.semantic-seed.dependencies.v1`, `ih.bootstrap.request.v1`, `ih.bootstrap.manifest.v1`, `ih.bootstrap.initial-input.v1`, `ih.native-transfer.plan.v1`, `ih.semantic-seed.source.v1` and `ih.semantic-seed.omission.v1`. Source input is **only a label**, never a caller-supplied revision/contentDigest. The exporter computes the observation digest from its one captured selected result using this closed noncircular preimage:

```ts
interface SeedSourcePreimageV1 {
  version:1;source:SeedSourceLabel;
  inheritedOrigins:readonly SeedOrigin[];
  selection:SemanticSeedV1['selection'];turns:SeedTurnDomain;
  omissions:SemanticSeedV1['omissions'];artifacts:SemanticSeedV1['artifacts'];
  groups:SemanticSeedV1['groups'];
}
```

Normalize origin slots **before** hashing. Reserve logical slot0 for the current source label. Collect every reachable inherited origin descriptor from selected already-seeded items, omissions, artifact provenance, sourceProvenance and prepared-input relationships, resolving each old index through its actual containing manifest's origin table. An old manifest's slot0 is an inherited descriptor here, not the new current slot0. Reject invalid/out-of-range indices. Deduplicate inherited descriptors by their entire canonical value, sort by UTF-8 canonical value bytes, and assign slots1..n; remove unreachable historical entries. Rebase every affected address and provenance index to these slots, including references in results/calls/input links/omissions/artifacts. Newly captured source-local addresses use slot0. Keep slot0 distinct even if an equal historical descriptor exists; it denotes this export's current source, while inherited descriptors remain historical observations. Do not reorder semantic groups/messages, omission order, artifact roles or turn extents to normalize origins.

The preimage's `inheritedOrigins[j]` describes logical slot j+1; slot0 is described only by `source`. Current-origin output digest/revision, final `origins` array, final seed.digest, compiled records/header fields, bootstrap identity/clocks, host freshness tokens and runtime native proof are absent from the preimage. Previously inherited descriptors' stored digests are ordinary historical data, copied without fetching/reprojecting ancestors or rehashing their original bodies. Recompute each omission.digest after rebasing as H(`ih.semantic-seed.omission.v1`, `{source,state,calls,relatedInputs,extent}`), excluding its own digest and without dereferencing origin digests. Then compute sourceObservationDigest = H(`ih.semantic-seed.source.v1`, preimage).

Fill final origins[0] as `{kind:'session',sessionId,revision:sourceObservationDigest}` or `{kind:'anonymous',contentDigest:sourceObservationDigest}`, append the normalized inherited descriptors, and compute final seed digest = H(`ih.semantic-seed.v1`, completed SemanticSeedV1). This consumes the same captured selected data; no second projector/payload pass and no current digest hashes itself. Target codec validation can reconstruct the preimage from origins[0]'s label, origins.slice(1) and the selected data; it does not need an ancestor archive. The observation names selected semantic content, not the full raw archive or a durable session for anonymous data. A false original inline digest cannot be inferred from projected text.

This hash is **not** a host freshness/authority guard: identical selected data can have the same observation digest even when an owner generation, journal prefix, policy or required instruction state changed. The existing actual source/target owner and current guards remain separately captured host capabilities and rechecked across awaits. A label or matching hash grants neither ownership nor artifact access. None returns `{kind:'none'}` before source-label fields, view projection/payloads, inherited normalization or any source/seed/dependency hash is read/computed.

`completed` intervals are canonical sorted, nonoverlapping and merged when adjacent; upper bounds <=total. They are context-selection facts, never task/physical completion certificates. Ordinals are rebased to the selected child domain; keep hidden/empty turns in its total. N includes original framed turns, including current open. Unframed prefix counts0, retained only when N>=total. An active inherited source turn remains absent from completed intervals; new child-local turns append after inherited total. All/non-none with no messages still emits metadata. None returns before source projection/payload, source observation hashing or dependency resolution; target compilation may subsequently use its fixed canonical empty-seed constants without observing the parent.

### Target records and local addressing — persistence compiles, core history reads

Create `packages/session-persistence/src/semantic-seed.ts`:

```ts
interface SeedManifestRecord {
  type: 'conversation/seed-manifest'; version: 1; seq: number; // runtime requires0
  codec: 'semantic-seed-v1'; digest: Digest; groupCount: number;
  origins: SemanticSeedV1['origins']; selection: SemanticSeedV1['selection'];
  turns: SeedTurnDomain; omissions: SemanticSeedV1['omissions'];
  artifacts: SemanticSeedV1['artifacts'];
}
interface SeedGroupRecord {
  type: 'conversation/seed-group'; version: 1; seq: number;
  manifestSeq: 0; ordinal: number; group: SeedGroup;
}
interface CompiledSemanticSeed {
  digest: Digest; dependencyDigest: Digest;
  sourceObservation:{kind:'none'}|{kind:'semantic';digest:Digest};
  records: readonly (SeedManifestRecord | SeedGroupRecord)[];
}
compileSemanticSeed(exported: Exclude<SeedExport,
  { kind: 'refused' }>): CompiledSemanticSeed;
```

For none, records=[], sourceObservation={kind:'none'}, and target compiler uses fixed canonical empty semantic-seed/dependency digest constants; the source exporter performs no hash. For non-none, compiler copies the exporter-computed sourceObservationDigest into sourceObservation and requires it matches final origins[0]; it never accepts an independently supplied source revision/hash. Records are manifest at0 then groups ordinal0..n-1 at seq1..n; inherited seedLength is exactly1+n. Root R-B-09 keeps seq:number in the shared addressed event DTO to match existing event preparation/remapping, while the compiler emits0 and actual runtime validation requires exactly0; no alternate union-only schema or optional concrete sequence is introduced. Metadata arrays live in the non-ignorable manifest record, never the bounded header. Group records cannot occur outside this exact prefix, refer to another manifest or change after install. A non-none observations-only export has seedLength1. Empty fact frames remain forbidden.

Root R-B-12 fixes the shared empty constants: H(`ih.semantic-seed.v1`, `{kind:'none'}`) is `f682547f170c025d0519512768a13bd41a570527aa5aee1c3f69be82424f2498`; H(`ih.semantic-seed.dependencies.v1`, `[]`) is `7fd4c9f0169abf80e5e11e8cab2e06d9e8bf8bf2cd3d9ee63e17ea0345c6a29c`. Use one core definition consumed by target validator/compiler, with independent literal derivation tests. None source export performs no hashing. Zero-prefix readiness requires these exact seed/dependency values, not arbitrary matching header/completion strings.

Local parts are deterministic ASCII and <=64bytes: `group`, `item:<i>`, `item:<i>:call:<j>`, `item:<i>:result:<j>`, `item:<i>:media:<j>`. Use safe integer decimal indices. Every item includes its local item address **and** common group address in exact local sources/coverage; call/result/media refs use the same record seq with these parts. Original origin refs stay outside local `sources`/`provenance.evidence`. Imported exchanges project `acceptance:'inherited-observation'`; any explicit/legacy source acceptance remains observation only. Imported containers are complete; omitted parent units retain their real open/unresolved observation. No fake step, dispatch, result event or live receipt is created.

### Shared structural selection functions

Create `packages/core-session/src/conversation/history/intervals.ts` for one payload-free function used by reduction and inheritance:

```ts
closeSourceIntervals(sourceKeys: readonly (readonly string[])[]):
  readonly { first: number; last: number }[];
```

It is the current union-by-shared-ref followed by interval closure, with unchanged order; no token/pricing/protection policy enters it. `reduction/selection.ts` builds its current key sets and uses it. The seed selector first partitions eligible input components: only input/admission/raw-prepared-context/image evidence; any tool/call/result/dispatch/tool-image edge forbids the input exception. Remove physical-unit edges only from that derived input-observation component and store the relationship in omissions. Complete the whole input evidence component, then use the same interval algorithm. Non-input open/unresolved intervals and all their siblings/results/media are omitted as a whole.

Extend the sole `HistoryFact` with structural seed descriptors: item kind/ordinal/scope/extent, call/result/message-index metadata, origin-independent local addresses and inherited acceptance discriminator. Extend `HistoryRecipe` with `{kind:'seed-item';index:number;item:number}`. Do not retain LLM messages/native/text/result bodies in the index. Payload rendering reads the referenced seed record; sources/coverage/protection use the structural descriptors. Future replacement extents derive from union/enclosing extents of their coverage in this same history owner; no parent raw archive is needed.

**Root R-B-10, selected-source validation:** current createConversationValidationIndex fully validates every envelope and seed payload, including consumed bodies. The semantic exporter therefore uses a package-private structural source profile in that SAME validation/history owner, not a second index/projector or public option. Retain sequence/acceptance/generation/input/replacement/rewind/turn and bootstrap-readiness structural checks; read required envelope execution/disposition, media shape/presence, retention/ref/catalog metadata without traversing hidden value/text/native/image bytes. For previously seeded sources validate header/manifest/group/completion structure and matching stored scalar identities without rehashing all consumed payloads. Capture fully validates actual selected typed components and exact refs; validate/hash the complete newly exported codec. This path certifies selected semantic export only, not whole original source-archive/seed-payload integrity or a recovered receipt. Historical origin hashes remain observations. Full validation remains unchanged for intake, public append/load/fromJSONL and target publication. Actual shipping sources are already loaded/owned under those checks; detached caller data receives selected-content validation only. Tests must distinguish consumed envelope/seed payload traps from selected malformed values, preserve structural refusal, and demonstrate strict public full-validator rejection of malformed hidden values. A structural check that genuinely needs a hidden body requires a further root ruling, not silent omission.

Boundary resolution and current selection remain distinct internal functions in `conversation/seed-selection.ts`:

```ts
type SemanticTurnBoundary = { last: number; localCutSeq?: number };
resolveSeedBoundary(view: SessionView, selection: SeedSelection):
  | { kind:'resolved'; boundary:SemanticTurnBoundary }
  | { kind:'refused'; reason:SeedRefusal };
```

For ordinary local seq, use existing first recorded turn/end>=atSeq and include records until next turn/start. Beyond archive uses latest completed boundary; no completed boundary refuses. A seed-group seq with extent spanning >1 ordinal refuses ambiguous-boundary; one-ordinal records resolve through completed intervals. Manifest/omission-only positions without a single turn mapping refuse ambiguous-boundary. Then select **current** branch/effective/monotone history within the original extent. Any surviving interval/summary extent crossing selection refuses; wholly enclosed later summaries are usable, and hidden later summaries never restore originals. Do not call history(throughSeq) as the source of effective payloads.

## Bootstrap and artifact contracts

Create `packages/session-persistence/src/coordinator/bootstrap-types.ts`:

```ts
interface BootstrapInvocation {
  version:1; operationId:string; targetSessionId:string;
  createdAt:string; requestDigest:Digest;
}
interface BootstrapCallerMetadata {
  title?:string;workspaceId?:string;modelSelection?:SessionModelSelection;
}
interface BootstrapLineage {
  parentSession?:string;
  origin:'subagent'|'approval-review'|'team'|'fork'|'import';
  delegationDepth?:number;subagentProtocolVersion?:1;
}
interface ChildBootstrapIntent {
  version:1;invocation:BootstrapInvocation;
  startedAt:number;expiresAt:number;
}
interface SeedHeaderV1 {
  version:1; codec:'semantic-seed-v1'; operationId:string;
  requestDigest:Digest; manifestDigest:Digest; seedDigest:Digest;
  dependencyDigest:Digest; seedLength:number; groupCount:number;
  initialInputId?:string; initialInputDigest?:Digest;
  initialStartedAt?:number;initialExpiresAt?:number;
}
interface BootstrapCompleteRecord {
  type:'session/bootstrap';version:1;operationId:string;manifestDigest:Digest;
  dependencyClosureDigest:Digest;seedLength:number;initialInputId?:string;seq?:number;
  initialStartedAt?:number;initialExpiresAt?:number;
}
type BootstrapTarget = {kind:'new'}
  | {kind:'existing-empty';expectedHeaderDigest:Digest;expectedPrefix:JournalPrefix}
  | {kind:'resume';manifestDigest:Digest};
interface BootstrapInitial {
  inputId:string; text:string; parentSessionId?:string;
  startedAt:number;expiresAt:number;
}
interface BootstrapRequest {
  invocation:BootstrapInvocation; target:BootstrapTarget;
  metadata:BootstrapCallerMetadata;lineage:BootstrapLineage;
  seed:CompiledSemanticSeed;
  initial?:BootstrapInitial;
}
type BootstrapPhase='header'|'dependencies'|'seed'|'completion';
type BootstrapResumeToken =
  | {version:1;invocation:BootstrapInvocation;manifestDigest:Digest;phase:BootstrapPhase}
  | {version:1;invocation:BootstrapInvocation;phase:'header';manifest:'unknown'};
interface BootstrapReceipt {
  version:1; invocation:BootstrapInvocation; manifestDigest:Digest;
  seedLength:number; dependencyClosureDigest:Digest;
  seed?:FactReceipt; completion:FactReceipt;
  initial?:{inputId:string;seq:number;startedAt:number;expiresAt:number};
}
type BootstrapOutcome =
  | {kind:'ready'|'already-ready';receipt:BootstrapReceipt;document:ManagedDocument}
  | {kind:'not-issued';reason:'cancelled'|'stale-source'|'unsupported'}
  | {kind:'blocked';token:BootstrapResumeToken;
      reason:'unknown'|'payload-required'|'dependency-unavailable'|'source-changed'}
  | {kind:'refused';reason:'conflict'|'nonempty'|'cached-unprepared'|'wrong-view'
      |'incompatible'|'manifest-invalid'|'target-policy'};
interface BootstrapGuards {
  signal?:AbortSignal;
  assertCurrent():void; // actual source+target instruction+Stop fence
  dependencies:BootstrapDependencyPort;
}
interface BootstrapInspection {
  kind:'absent'|'reserved'|'ready'|'conflict'|'unavailable';
  invocation:BootstrapInvocation; token?:BootstrapResumeToken;
  needsConfirmation:boolean;
}
SessionCoordinator.bootstrapSemanticTarget(request:BootstrapRequest,
  guards:BootstrapGuards):Promise<BootstrapOutcome>;
SessionCoordinator.resumeSemanticTarget(invocation:BootstrapInvocation,
  guards:BootstrapGuards,originalPayload?:BootstrapRequest):Promise<BootstrapOutcome>;
SessionCoordinator.inspectBootstrap(invocation:BootstrapInvocation):
  Promise<BootstrapInspection>;
```

Metadata, protected lineage and invocation are fixed before issuance and validated as separate closed records. Caller metadata admits only title/workspaceId/modelSelection; it cannot set id/createdAt/parentSession/seedLength/origin/depth/protocol/format/journal/reservation. Use a **rejecting creation codec**, not current parseModelSelection's drop-invalid compatibility behavior: title is a string <=32768UTF-8bytes, workspaceId is nonempty <=256chars, and modelSelection has only nonempty provider/model<=256chars, optional protocol from existing PROVIDER_PROTOCOLS, and optional nonempty reasoningEffort<=256chars. Unknown keys/accessors/symbols/invalid enums refuse; no truncation or silent fallback. SessionId/createdAt come from the fixed invocation; format11/journal and derived prefix fields come only from the owner/compiler; lineage is host-created from actual source/caller and cannot be supplied by model/tool/RPC metadata. Require protocol1 iff ordinary subagent origin, and validate actual parent source identity/depth before source await/issue. Existing target metadata not explicitly selected by the original caller remains byte-equivalent through reservation; changed caller metadata on resume conflicts. Store reservation at `SessionHeader.semanticSeed?:SeedHeaderV1`; existing scalar header.seedLength must exactly equal reservation.seedLength. `createdAt` is metadata, never child deadline authority. Trusted host captures initial startedAt/expiresAt before resolver/bootstrap awaits; these are all-or-none, safe integers with expiresAt>startedAt, bound into initialInputDigest and matching header/completion/receipt. Live monotonic start remains host-only; cold recovery never resets persisted deadline. Source identity/digest, exact selected compiled bytes, target fields, dependency table and initial input digest enter manifestDigest. Complete manifest validation precedes header issue. A none child may have real parent lineage with seedLength0, but no semantic source payload is read. An anonymous import never gains parentSession.

Storage-ready is distinct from request-ready: public conversation fork/import has no model execution request and must not resolve credentials, instantiate an Agent, prepare/count a provider request or do capacity/native compatibility work merely to create/inspect the target. Native bytes remain observations; optional genuine warm proof may be attached only when already available. Compatibility/capacity is enforced when that target actually prepares its first model request. Subagent spawn has a real initial execution request: select its role binding/current fresh surface through the existing execution owner and confirm storage bootstrap before launch. Neither storage-ready nor native observations authorize replay of an initial task.

Root R-B-13 fixes `initialInputDigest` as H(`ih.bootstrap.initial-input.v1`, `{input,startedAt,expiresAt}`), where input is the complete validated captured `agent/input/admitted` event with only its physical seq field omitted. All type/version/inputId/text/delivery/intent/provenance and supported own optional fields participate. The B2 owner deterministically constructs the actual existing subagent.initial-style admission from BootstrapInitial/lineage, hashes those captured bytes and then constructs reservation/manifest; callers cannot supply a digest. B1 readers recompute from the adjacent actual admitted event and matching header/completion clocks after normal event validation; physical seq independently must equal seedLength+1. No-initial requires all initial ID/digest/clock fields absent. Changed text/provenance/optional field/clocks must refuse; an opaque header scalar is insufficient. This is one shared core hashing contract, not a second admission owner.

`inspectBootstrap` is strictly read-only: it reports structural phase hints and never repairs/truncates/syncs or manufactures a current owned receipt. `resumeSemanticTarget` joins the original owner and confirms/reconciles the same actual frame bytes under the held lease. For a complete target it reconstructs original deterministic batches from committed target records, confirms receipts and adopts without exporting changed source or admitting/running another input; for incomplete target it requires exact original payload or returns payload-required. A recovered receipt attests the same batch key under the current held owner; it does not pretend an old process incarnation remains live. Header-only/torn recovery never invents missing bytes from a digest.

Qualified backend methods (new `coordinator/bootstrap-header.ts` plus JSONL leaf `backend/bootstrap-header.ts`):

```ts
type HeaderOutcome={kind:'committed';headerDigest:Digest}
  |{kind:'absent'|'unknown'|'conflict'}|{kind:'not-issued';reason:'cancelled'|'stale-source'};
interface BootstrapHeaderOperation {
  invocation:BootstrapInvocation;
  target:Exclude<BootstrapTarget,{kind:'resume'}>;
  stageBytes:Uint8Array;headerBytes:Uint8Array;
}
prepareBootstrapHeader(id:string,owner:IssuingFactOwner,
  operation:BootstrapHeaderOperation):Promise<HeaderOutcome>;
reconcileBootstrapHeader(id:string,owner:HeldFactOwner,
  operation:BootstrapHeaderOperation):Promise<HeaderOutcome>;
```

Both join the existing session lane/lease. New-target is exclusive/no-clobber; existing-empty requires exact header+prefix and zero events, no write-behind/open owner. Fixed transaction staging path/bytes and sync evidence reconcile the original operation; preserve unrelated metadata, no target deletion/rollback. A matching full published header may be sync-confirmed; mismatching/partial foreign state refuses/blocks. Windows directory-sync limits remain honest. Header reservation is immutable and bounded; parse/build/view preserve it. Cold load recognizes incomplete reservation before ordinary repair. Same existing managed registry owns private bootstrap attachment; public open/actions/received inputs/snapshots refuse incomplete state. No nested public lane call while already holding that lane.

R-B-21 additionally retains the bounded original header transaction for later original-metadata/manifest verification, with readBootstrapState(invocation) for no-repair inspection, deterministic stage/publication paths and exact guarded original-operation continuation. R-B-24 adds held historical-frame confirmation after later complete live records; ordinary terminal-suffix reconciliation is unchanged. No original request text or semantic groups enter the header stage. The full closed binding/hash/limits/lifecycle contract is in the linked Task2 rulings.

### Exact parent and team observation schemas/fences

Place foundational data-only `BootstrapInvocation`, `BootstrapPhase`, `BootstrapResumeToken`, `ChildBootstrapIntent`, `SeedHeaderV1` and completion-record DTOs in `core-session/src/events/bootstrap.ts`. Persistence imports/reexports those data types; core-session never imports persistence. New parent observation and team schemas use that same core data, not structurally divergent copies:

```ts
interface SubagentStartV2 {
  type:'subagent/start';version:2;taskId:string;agentPath:string;
  role:string;description:string;parentSessionId?:string;
  bootstrap:ChildBootstrapIntent;seq?:number;
}
type TeamBootstrapObservation=
  |{kind:'pending';intent:ChildBootstrapIntent}
  |{kind:'blocked';intent:ChildBootstrapIntent;token:BootstrapResumeToken;
      reason:'unknown'|'payload-required'|'dependency-unavailable'|'source-changed'}
  |{kind:'ready';intent:ChildBootstrapIntent;manifestDigest:Digest;
      completionBatchId:string;initialInputId:string};
interface TeamMemberV2 {
  id:string;name:string;description:string;provider:'spawn';context:'fresh'|'fork';
  phase:'provisioning'|'active'|'failed';sessionId:string;error?:string;
  bootstrap:TeamBootstrapObservation;
}
interface TeamMemberEventV2 {
  type:'team/member';version:2;teamId:string;member:TeamMemberV2;seq?:number;
}
```

Require Session format11 before appending either new version; preserve v1 legacy readers without synthesizing invocation. Exact own-field validation, nonempty bounded IDs and ISO createdAt, SHA256 request/manifest digests, safe clocks, matching intent/token/target/requestDigest and all fixed identity fields. Team sessionId equals intent.invocation.targetSessionId from provisioning onward; this is **intended target identity**, never proof the file exists. Existing team/member zod strict union and core event union both gain version2; v1 stays version1 and cannot silently carry bootstrap fields. Team fold allows v2 same-intent provisioning pending→blocked→ready observation updates and monotone exact receipt adoption, never another target/clock; phase active requires ready plus actual known publication. Cold ready without publication remains provisioning/recovery-visible and never reruns the task. Failed may retain blocked/ready evidence but must not imply execution succeeded. Legacy provisioning remains its prior qualified legacy behavior, with no invented new receipt.

Existing `subagent/start` captured action source persists V2 intent before child mutation. Same trusted source-call retry uses the original committed V2 fact, or reconciles its original unknown capture, before touching target. It cannot write another start or derive an invocation from arbitrary model parameters. `subagent/end` keeps its existing version1 schema and recovery-required/error outcomes; no new end field, result envelope or completed outcome is fabricated. Keep the typed recovery token available in the source/tool error object even when terminal persistence is uncertain. After cold restore, the committed V2 start invocation identifies the same target; inspect/resume obtains its actual phase/manifest or honestly reports payload-required, rather than reconstructing an invented successful end.

### Validation scope, cache key and readiness

Add `conversationScopeKey(header)` in `core-session/src/conversation/validation.ts`. Its canonical tuple includes sessionId, parentSession, seedLength and **all semanticSeed reservation scalars** (codec/version/op/request/manifest/seed/dependency digests/counts/initial IDs/digests/clocks). Capture/freeze these fields in the validation index's scope. Keep the existing `generationScope` public property name for cache compatibility but compute it with this common function; `events/append.ts` and `managed/memory-group.ts` must compare that key, not their current three-field JSON tuple. Mutating a standalone header manifest/count/digest forces index rebuild/full validation and cannot reuse the old index. Header/seed/initial field mismatches refuse, not silently normalize.

The public createConversationIndex/createConversationValidationIndex path always requires public readiness. Root R-B-08 fixes the cross-package composition: add core-session/package.json export `./internal/bootstrap` backed by package-private staging code. The managed-state constructor is consumed only by the real persistence bootstrap owner; the atomic memory-bootstrap operation is consumed by actual standalone child/import composition. Public facade createManagedSessionState remains ready-only. This is a reviewed API/source boundary, not a same-process sandbox. No public skip-readiness boolean/string, duplicate state/index or cross-package private relative import. A private composition capability inside core managed/memory bootstrap selects growing-prefix validation; it is not a public string option, Session/JSON field or header bit. Public projection/fromJSONL/append/admission rejects reservation without exact complete inherited records plus matching completion marker; header-only or partial seed is bootstrap-incomplete, not empty context. Private staging validates a growing prefix (manifest0 then exact ordinal/seq groups with matching descriptor) and completion without allowing optional execution/received inputs beforehand. A malformed complete prefix is invalid, distinct from a valid incomplete reservation requiring original reconciliation. Persistence's private `loadBootstrapOwned(invocation)` path reuses the same lease/lane/load helpers and checks this staging form before constructing its sole blocked owner; it does not call public loadOwned preflight and then suppress a readiness error. Public normal load/open refuses instead. Snapshot/read-only inspection can expose scalar incomplete status without constructing a writable runtime or repairing bytes.

Standalone bootstrap uses the same compiled records through a private `bootstrapMemorySession(session, header, recordsWithCompletion, current)` composition port in core-session's existing nondurable owner. It requires pristine unbound/empty target, validates/stages the **whole** group with bootstrap-stage index, then synchronously installs header/events/index and exposes public-ready view before observers. It returns `MemoryBootstrapReceipt {kind:'memory-ready';seedLength;initial?:{inputId,seq,startedAt,expiresAt}}`, never FactReceipt or cross-process recovery. Public append cannot create a partially usable reservation by appending seed records one at a time. Source literal tests may build complete event arrays and call fromJSONL validation; private fixture staging is never a shipping public authority toggle.

Root R-B-15 detects already-bound empty memory targets by a package-private read-only predicate over nondurable.ts's existing memoryRecoveryHolds registration (inserted when the fact owner is created). No new registry and no eager validation/index creation added to ordinary owner construction just to manufacture a binding signal. Source structural metadata validation precedes boundary derivation; scalar accessor fields are rejected before reads, while payload exclusion remains as R-B-10. Actual fresh-target versus previously-created-owner refusal and accessor counters qualify these boundaries.

Root R-B-16 (independent review): strict public JSONL append and replaceEvents must validate candidate seed/bootstrap readiness before publishing bytes, using the same core owner. Preserve ordinary legacy append/canonical-rewrite semantics and private owned-batch growing-prefix staging; do not export a skip-readiness capability. For semantic-reserved targets, public updateMeta protects the entire semanticSeed value and seedLength, parentSession, origin, delegationDepth, subagentProtocolVersion, sessionId and createdAt, in addition to the existing formatVersion/journal fences. Public metadata updates cannot introduce semanticSeed on a plain target or remove/change reservation/birth fields. Descriptor-safe equivalent/no-op fields may be accepted. Preserve mutable title/archive/model/workspace metadata and byte-exact body/torn-tail behavior; a title change must not require a whole-body parse. New reservations belong only to the qualified bootstrap owner.

Root R-B-17 (independent review): maintained predecessor qualification must work from a clean checkout plus supported Node/pnpm dependencies. Provision the exact accepted format10 graph as a committed compressed fixture capsule with portable relative paths, pinned product identity, whole-capsule and per-file hashes, and retained third-party license files. Generate it once from the accepted hash-mapped graph, checking against the sealed input inventory; keep regeneration tooling/provenance explicit. Normal tests consume only that committed fixture, extract into a fresh checked temporary root, and execute the genuine unchanged old reader under Node plus the existing tsx dependency. They must not depend on workstation .tmp paths, Bun, Git history availability or network downloads. Validate extraction paths/duplicates/bounds and hashes; resolve old product imports solely inside the extracted graph. Preserve genuine ready/header-only/interrupted11 refusal, unchanged-byte and zero-provider assertions, and fail strictly on absent/corrupt fixtures. This supersedes the initial maintained-test dependence on R-B-05's local source graph; the original local qualification remains historical evidence.

Root R-B-18 (F2 residual): prepared-input text equality is payload validation. The private semantic-source profile must keep preparation/reference/action/producer/promotion structural checks in the existing input-preparation owner, while deferring raw/admission/derived/observation text checks until the selected complete input component is captured. Extract/reuse those text checks from the same owner; ordinary public append/load/full validators remain strict. The source-only input-preparation shape check must likewise avoid traversing discarded observation text while checking its structural descriptors/producer/count. Validate selected raw/admitted/derived/observation text by descriptor before any equality, JSON formatting or provenance rendering; use the same owned selected capture/read path so the renderer and provenance reader do not reread original body slots. No second preparation index, public bypass or full-source payload preflight. Selected data mismatches and benign getters refuse before calls; consumed prepared components remain unread; normal valid preparation semantics and public full-validation checks are unchanged.

Root R-B-19 (F4 residual): metadata comparison must bind the actual serialized header that will be written, not mutable caller references observed before ordinary metadata evaluation. Capture the previous protected-field expectations into owner-controlled values before materializing caller data; preserve protected descriptor rejection without executing getters. Materialize the allowed ordinary metadata once, serialize/snapshot to owned JSON data and revalidate all final protected fields (including absence/removal) against those original expectations before any write. Serialization callbacks cannot run after the final comparison or mutate its expected values. Write the exact validated header bytes and return detached data; do not expose a checked reservation alias from the patch. Preserve computed ordinary titles where supported, exact body/torn-tail bytes, no-op protected metadata and existing version/journal errors. No new permission/lifecycle owner is introduced.

Required malformed controls: seed records with no header; manifest at nonzero seq; duplicate/missing/out-of-order group ordinal; out-of-prefix record; wrong manifest/digest/count/groupCount; forged completion before all groups; completion/input outside fixed scope; changed mutable memory header; incomplete source passed to actual projectConversation/fromJSONL/append/nondurable action. Exercise both fresh and cached indexes and ensure no public read repairs or acquires authority.

Private bootstrap phase admissions use deterministic IDs `bootstrap:<operationId>:seed` and `bootstrap:<operationId>:complete`, isolated from ordinary coalescing; the current managed queue/capacity/stage/index/pending/quarantine handles exact encoded batches and original reconciliation. Completion group contains `session/bootstrap` version1 confirmation then optional deterministic `agent/input/admitted`; marker is outside inherited prefix and carries manifestDigest/dependencyClosureDigest only, no grant authority. Zero-length seeds have no seed frame. Initial generation consumes receipt.inputId/seq once; normal generation/action facts remain local after the seed prefix.

Define the data-only `BootstrapDependencyRequest` and `BootstrapDependencyOutcome` below beside the core-session seed descriptors; the bootstrap port itself belongs to persistence's bootstrap-types. The artifact service consumes those core data contracts through its own `confirmSeedDependencies`/`reconcileSeedDependencies` methods. Host composition adapts these methods to BootstrapDependencyPort; context-output must not import persistence internals. Create `packages/context-output/src/artifact/bootstrap-transfer.ts` in the existing artifact owner:

```ts
interface BootstrapDependencyRequest {
  operationId:string;targetSessionId:string;manifestDigest:Digest;
  sourceSessionId:string;artifacts:readonly SeedArtifact[];
}
type BootstrapDependencyOutcome={kind:'confirmed';closureDigest:Digest}
  |{kind:'blocked';reason:'unknown'|'unavailable'|'conflict'|'policy'};
interface BootstrapDependencyPort {
  confirm(request:BootstrapDependencyRequest,current:()=>boolean):
    Promise<BootstrapDependencyOutcome>;
  reconcile(request:BootstrapDependencyRequest):Promise<BootstrapDependencyOutcome>;
}
```

The actual host captures source authorization outside DTOs and binds this port to the target operation; parsing these strings/refs cannot mint it. Anonymous refs without actual source authorization refuse, while portable inline content can import. Confirm exact root refs and bounded catalog metadata/member closure via current workspace artifact mutation chain, original operations and target pins/ACLs. No result body materialization or <=100 generic ID-grant workaround. Reconcile same intended pin/access/companion bytes after uncertainty; do not invoke a fresh void grant and call it recovery.

Add **transferred membership version2 in the existing companion path**. Required fields: version2/kind=`result-dependency-transfer`, workspaceId, target documentId/sessionId, exact catalogRef/memberRef, original catalogOwner (including its real document/source), original catalogOperationId, original memberOperationId, sourceId, ordinal, manifestDigest. Pin operationIds stay the original artifact operations. Never recapture catalog ownership for child. Validate exact committed catalog/member operations and both target pins, ordinal/member identity and current target authorization. Nested transfer derives another target companion from an authorized existing v1/v2 membership and keeps original catalog/member identities. No new ACL store.

Current authorization remains pre/post actual body I/O (`artifact/ownership.ts:94–127`): target sourceId must match original artifact sourceId, and exact ref/catalog needs the existing host's durable target-reference evidence. Current `result-store.ts:authorizeResult` scans archive ref facts excluding rewind cuts; compaction replacement/reset consumption does **not** revoke retained retrieval. Preserve that distinction when adding seed ref evidence: retain exact manifest/group dependency associations and apply the same actual branch/reference policy, rather than substituting current prompt visibility for retrieval authorization. Source-policy/project change, missing target pin, unavailable host authority or an actual disallowed ref denies access; no blanket descendant rights. Parent runtime close/reopen is compatible when an actual host-provided target scope/read registration remains available. Preserve current `result-store.ts:sourceFor` lineage checks unless the existing host project owner genuinely confirms the target's own current scope; a copied header/projectId or reader registration alone cannot mint it. If parent deletion or missing host context makes current authorization unavailable, typed denial is correct. Do not unconditionally bypass lineage traversal for all bootstrapped children. Gateway confirms target project binding through its existing project owner before dependency/ready (its current post-fork onFork ordering is insufficient). Required project-binding uncertainty becomes blocked under the same token, not a new target.

Add core data reader `semanticSeedResultRefs(view:SessionView):readonly ManagedArtifactRef[]`, used by the real executor/Gateway authorization readers alongside existing managedResultRefs. It follows each branch-eligible seed group's result/catalog indices into its manifest table, **not** a blanket all-manifest grant; ordinary rewind cuts can exclude a group even when manifest0 remains. It does not filter groups merely because replacement/reset consumed their prompt representation. Codec validates every artifact use is associated with an actual selected result/catalog cell; unreferenced table entries cannot expand access. This is durable reference evidence only, never a replacement for pins/current host source policy.

Deletion releases only deleted document's pins/companions. Remaining target pins retain original operation/body/catalog metadata; source-pin release alone does not erase target-owned pins. **Retention is distinct from access**: current target policy still must authorize reads. Gateway permanent deletion already refuses descendants; do not redesign general orphan/parent-deletion authority for B. A lower-level source-pin-release test proves physical retention only, and may correctly observe authorization denial if the source/host scope is unavailable. Target deletion/pin revocation denies; close/reopen alone does not revoke durable pins when genuine current scope is available. Read recovery must not create an assembly/model or bypass confirmed project roots. Legacy v1 memberships keep their existing checks.

## Native contracts — llm-seam owns contracts, execution/binding own capabilities

Create `packages/llm-seam/src/prepared/native-transfer.ts`:

```ts
interface NativeUnitPlan {
  unitId:string;unitDigest:Digest;
  messages:readonly {index:number;digest:Digest}[];
  mode:'native-candidate'|'portable';portableAvailable:boolean;
}
interface NativeTransferPlan {version:1;digest:Digest;units:readonly NativeUnitPlan[]}
interface NativePreservation {unitId:string;unitDigest:Digest;projectionDigest:Digest}
type TransferPreparation=
  |{kind:'prepared';prepared:PreparedModelRequest;
     native:readonly NativePreservation[];plan:NativeTransferPlan}
  |{kind:'portable-required';units:readonly string[];reason:'prefix'|'order'|'calls'|'raw-override'}
  |{kind:'blocked';unitId:string;reason:'opaque-only'|'source-unverified'
      |'binding'|'native-contract-unavailable'|'invalid-request'};
interface NativeSourceProof {readonly opaque:unique symbol}
interface NativeTransferConstraint {
  assertBeforeIssue(actual:ExecutionConfirmation):void;
}
interface NativeIssuePermit {readonly opaque:unique symbol}
interface NativeSourceFacts {
  identity:LiveExecutionIdentity;route:RouteKind;modelId:string;
}
interface NativeTransferTarget {
  // Implemented by the real binding's private immutable profile closure.
  constrainSource(source:NativeSourceFacts,unitDigest:Digest):
    NativeTransferConstraint|undefined;
}
interface NativeSourceVerifier {
  constrain(proof:NativeSourceProof,unitDigest:Digest,
    target:NativeTransferTarget):NativeTransferConstraint|undefined;
}
interface NativeSourceLookup {
  lookup(view:SessionView,unit:ConversationItemRef,unitDigest:Digest):
    {kind:'live';proof:NativeSourceProof}|{kind:'unverified'};
}
interface NativeTransferBinding {
  assess(proof:NativeSourceProof|undefined,unitDigest:Digest,
    portableAvailable:boolean,verifier:NativeSourceVerifier):
    |{kind:'candidate';constraint:NativeTransferConstraint}
    |{kind:'portable'}|{kind:'blocked';reason:'opaque-only'|'source-unverified'|'binding'};
}
```

`NativeTransferBinding.assess` supplies its own private immutable-profile NativeTransferTarget to the injected source verifier, which verifies the original proof association before passing transient source facts to that binding closure. These functions are host composition capabilities, not objects deserialized from arguments. This permits source execution and target binding owners to cooperate using llm-seam contracts without either importing the other's implementation or installing a global registry. No public arbitrary proof registration. `LiveExecutionIdentity` and `RouteKind` are existing llm-seam types and stay transient here.

**Source proof has two times:** at committed accepted assistant publication, tools have not run. The existing execution owner weakly registers only actual immutable assistant/acceptance/call-reference objects, original assistant+native+accepted-call digest, original successful owned-terminal receipt and its live source scope. It cannot register a completed unitDigest or future result/media closure then. Registration is optional evidence: unsupported terminal, missing identity, source scope closure or inability to retain attestation yields unverified later; it must not fail or revoke an otherwise successful ordinary parent acceptance.

At later `NativeSourceLookup.lookup`, resolve the requested exact current unit through the **real shared history/snapshot owner**. Require it is currently selected/complete with exact actual accepted assistants/calls/results/media and matching requested unitDigest; validate each required original assistant/native/call digest against the original weak associations, then bind the current completed selection digest into a live transfer proof. A unit spanning several accepted assistants requires all of their genuine associations; no result is authenticated merely by a model receipt. Preserve live/closed source scope and current-source checks; no extra auth/model/provider work. Failed/open/unknown, stale/different-selection, cold/copied/local-test/custom or closed-unattestable source returns unverified without changing parent facts. Warm nested transfer validates its current selected inherited unit against the unchanged forwarded original proof and source bytes; it never remints provenance from JSON or invents a new local assistant acceptance. No archived full runtime/auth tuple is added.

`ModelClient` gains optional `prepareTransfer(request:LLMRequest,plan:NativeTransferPlan):Promise<TransferPreparation>` on supported trusted prepared clients. Normal prepare/stream behavior is unchanged. `PreparedModelRequest` gains readonly transferPlan/preservation data on supported transferred handles; its `withOutputCap` rederives report and plan, and fixed wrappers explicitly propagate/rederive them. Non-transfer custom clients return blocked for opaque units or explicit portable rendering through existing normal preparation, never native authority from a lookalike field.

### Synchronous cap derivatives and actual prepare+assess integration

Keep `PreparedModelRequest.withOutputCap(cap):PreparedModelRequest` synchronous. On a transfer-aware handle it must run normal derivation **and** per-unit transfer validation against the derived final body. A valid derivative returns a fresh immutable prepared handle with its exact new payload identity/plan/preservation. A derivative needing downgrade or blocked throws an internally branded `NativeTransferDerivativeFailure`; no invalid handle/measurement is returned. Export only its narrow reader `readNativeTransferDerivativeFailure(error):Extract<TransferPreparation,{kind:'portable-required'|'blocked'}>|undefined` through llm-seam. Trusted payload/adapter internals alone construct/register failures; WeakMap identity lookup rejects copied/name/code/message lookalikes. Generic schema/body/media errors remain their real errors and cannot trigger portable reprepare. Existing original handle remains unchanged.

Replace the prepare-only helper with this actual prepare+assess owner loop:

```ts
type TransferBlock=Extract<TransferPreparation,{kind:'blocked'}>;
prepareAndAssessInheritedRequest<T extends {prepared:PreparedModelRequest}>(
  model:ModelClient,request:LLMRequest,plan:NativeTransferPlan,
  assertOpen:()=>void,assess:(prepared:PreparedModelRequest)=>T
):Promise<{kind:'assessed';assessment:T;plan:NativeTransferPlan}|TransferBlock>;
```

Each pass calls prepareTransfer, then invokes the **existing injected assessor** synchronously. It catches branded derivative failures from `withOutputCap` during that assessor, batches their unit downgrades in the same monotone set and retries the entire prepare+assess pass. Both prepare-stage and cap-stage failures spend the same max nativeUnits+1/deadline budget. The successful return uses `assessment.prepared` (the actual cap derivative), not stale pre-cap measurement. No new capacity assessor or cached capacity owner. Current `ownedBudget.assess` installs latest observation only after its successful result; failed derivation cannot checkpoint a stale accepted handle. `ownedBudget.probe` remains nonpublishing.

Actual production consumers: `core-agent/agent/admission.ts:24–28` wraps initial preparation **and** ownedBudget.assess; `agent/context-reduction/bridge.ts:43–44` wraps candidate preparation plus ownedBudget.probe; `agent/context-reduction/composition.ts:40–41` wraps auto-reduction baseline preparation plus probe. These use the same helper and existing source/assessment-revision guards, so their cap errors cannot escape into a generic catch and falsely become capacity-unavailable or trigger a second native loop. Recovery's selectOutputCap=false reassessment uses the already valid selected derivative; any branded transfer failure still returns through that same run budget. No extra inbox claim/tool/spawn/action is created.

**Root-selected native boundary:** add host-only `NativeIssuePermit` to PreparedStreamControl (not LLMRequest/data plan). Active `core-agent/src/agent/execution.ts` candidate authorizes the **final assessed real handle's** payload/plan, original GenerationControl identity (or explicit nondurable mode), its own active candidate lifetime and exact retained native constraints/current guard. Fixed preparedControls/wrappers preserve this capability by reference, never clone/serialize it. At synchronous final confirm, PreparedExecutionContext validates genuine permit/owned-terminal provenance, invokes the permit's active/current/Stop/native constraints **once before control.confirmExecution**, then follows existing ordinary confirmation/validation/cancellation guards, reservation.issue and fetch. Thus native mismatch precedes candidate receipt. Candidate retains/authorizes constraints but does not separately run them in its confirmation callback. Transfer-aware native handles reject direct stream without permit, wrong payload/cap/plan/generation, closed candidate or copied permit. All-portable handles need no native source permit but keep normal current/admission/generation checks. Permit confers no allowance/account lease. Valid cap derivative requires authorization tied to its new real payload; normal non-transfer handles keep existing behavior.

**Root-selected exact source boundary:** `packages/llm-seam/package.json` adds `"./internal/native-transfer-issue":"./src/prepared/native-transfer-issue.ts"`, matching the existing internal/bedrock-terminal pattern. The sole production importer is `packages/core-agent/src/agent/execution.ts`. This entry exports only the authorization function below, never through facade/ModelClient/tools. It is an API/source boundary, **not an in-process JavaScript sandbox**; trusted code capable of importing internal entries is not cryptographically isolated. Do not claim arbitrary hostile same-process code is prevented from invoking it. Keep actual source/proof/owned-terminal checks and caller boundaries rather than trusting caller-shaped public fields.

```ts
authorizeNativeIssue(prepared:PreparedModelRequest,
  generation:GenerationControl|undefined,
  constraints:readonly {unitId:string;constraint:NativeTransferConstraint}[],
  candidate:{candidateId:string;assertActiveAndCurrent:()=>void}):NativeIssuePermit;
```

Package-private validator signature in `prepared/native-transfer.ts`, imported only by llm-seam's own payload/execution code and **not reexported** by the authorization entry or facade:

```ts
assertNativeIssue(permit:NativeIssuePermit|undefined,
  preparedPayloadId:Digest,plan:NativeTransferPlan,
  generation:GenerationControl|undefined,actual:ExecutionConfirmation):void;
```

Authorization reads actual real prepared handle/owned-terminal provenance; the actual prepared payload supplies immutable plan/payload identity from its private closure at execution. Neither step trusts a lookalike PreparedModelRequest.transferPlan/measurement from the caller. Private permit state binds that handle's real payload+plan, original control, candidateId/active closure and complete native candidate constraint coverage. Check active/current first, then native constraints once, then control.confirmExecution/candidate receipt, ordinary guards and issue/fetch in that order. Candidate.close invalidates every permit bound to that candidate, including one retained by a wrapper. Tests use the actual candidate authorization path, not a public permit constructor; copied errors/permits, lookalike fields, closed candidate and direct stream are negative controls.

Original proof/callbacks stay on host request candidate, outside LLMRequest deep-cloning/serialized seed. Per-unit data plan binds exact message indexes/digests before image/protocol lowering; adapters report final preservation tied to actual payload identity. Raw overrides cannot claim mapper preservation. Aggregate native=unverified remains truthful; it is not per-unit transfer proof.

Pure preparation loop takes immutable source messages, plan and deadline, batches portable-required IDs, flips >=1 candidate to portable per failed pass, recomputes downstream native prefix dependencies and re-prepares. Max passes original native candidate count+1. IDs must be nonempty, belong to current candidate set and never repeat as still-native after removal; invalid reports block. Opaque-only failure blocks; original real visible text/calls/results/media supplies portable data, no invented thinking summary. At final execution confirmation, PreparedExecutionContext performs the permit's unconditional native checks once **before** candidate receipt and issue/fetch, independent of calibration; candidate does not invoke them a second time. Actual Codex returned token/account/epoch and sent headers remain the current terminal's captured snapshot; no management lease redesign. Final mismatch uses only existing bounded unsent/unobserved rebuild, same action/deadline/allowance, with newly measured portable rendering and no tool/input/spawn replay. Bedrock ambient native transfer remains portable/opaque-blocked because actual credential continuity is unavailable.

The loop's only public-to-core-agent name is `prepareAndAssessInheritedRequest` above; there is no separate prepare-only bypass. Existing action/current-deadline guard supplies assertOpen before/after each prepare await and assessment; no new clock. Host candidate retains constraints keyed by unitId and authorizes only final native candidates. Flipped portable units retain source observations but no native-send constraint. Every caller consumes the final assessor result and returned monotone plan.

## Real invocation/consumer ownership

`BootstrapInvocation` is minted once before the first potentially mutating call; resume always sends that exact descriptor. Hash operationId+qualified namespace to targetSessionId; requestDigest binds source ID/selection/task/role/creation intent. Existing-ready lookup by invocation precedes any fresh source export, so a lost ready response can adopt the historical receipt even after source changes. Different requestDigest conflicts. If incomplete exact payload is lost, cold resume returns payload-required. Original trusted action start `{wall,monotonic}` is captured before resolver/bootstrap awaits; generation opens after receipt with original start/expiresAt, never a new deadline.

| Real entry / exact files | Invocation and outcome owner |
| --- | --- |
| `subagent/src/tools/spawn.ts` → `child.ts`; `tools/spawn-source.ts`, `child/types.ts`, `child/generation.ts`, `child/lifecycle.ts` | Trusted actual parent session/callEventSeq/callId plus task/registry namespace derives operationId. Persist the fixed invocation/target/start in the existing parent `subagent/start` fact before child mutation; same-call adoption looks up that fact. `SpawnOptions.bootstrap` carries it privately, never model args. `spawnChild` returns started versus adopted-not-restarted versus bootstrap-blocked/refused. Parent task must not claim executed success from a blocked/ready-only result; keep recovery token in existing task/source observation. |
| `agent-team/src/roster.ts`, `types.ts`, `fold.ts`, `scheduler.ts`, `scheduler/teammate-lifecycle.ts`, `scheduler/recovery.ts` | Roster already durably mints a provisioning member UUID. Persist invocation and use its fixed targetSessionId through real spawner instead of letting child allocate a second ID. Keep provisioning on bootstrap uncertainty with token; reconcile exact bootstrap receipt, not mere archive/prompt existence. Existing member phase and activity chain remain scheduling owners. No new team registry/store. |
| `guard-approval/src/guardian/reviewer.ts`, `reviewer-spawn.ts` | Review invocation mints once in the actual review lifetime and forwards none seed plus shared purpose-bound approval generation. Catch exposes original token and never repeats uncertain reviewer spawn. No normal child allowance or tools are gained; current approval exception stays exact. |
| `session-persistence/src/fork.ts` | `ForkSessionOptions` adds required-for-durable-retry `invocation?:BootstrapInvocation`; convenience genuine invocation mints once and throws/returns token on uncertainty. `forkSession` returns discriminated `SessionForkOutcome`; existing `remapConversationSeed` remains the honestly raw export/compile operation, never a semantic fallback or newly renamed public facade. |
| `sdk/src/protocol.ts`, `client.ts`, `server.ts`; `apps/cli/src/index.ts:770` | `SessionForkRequest {sessionId,invocation,atSeq?}`; result ready/adopted `{kind,sessionId,invocation}` or blocked/refused typed outcome. SDK client creates invocation before request and attaches it to transport failure (`ForkTransportError.invocation`); explicit retry supplies same descriptor. Server requires new invocation-capable fork capability and validates fields, passing them to real CLI callback. Old missing-token RPC refuses before target creation; do not invent a server token the client can lose. Session/create stays unchanged. |
| `desktop/src/renderer/app.tsx` two manage callbacks; actual bridge request union and Gateway `router.ts`, `session-management.ts`, `context-runtime.ts` | Renderer mints fork invocation before bridge request and retains/returns it on transport failure; Gateway validates/threads it through mutate's fork arm. Other session actions keep their contract. Gateway resolves/commits target project association through existing project owner before artifact/ready confirmation. Navigate only on ready outcome; blocked target is explicit, not successful new conversation execution. |
| `session-executor/src/lifecycle/managed-document.ts`, `detached-seed.ts`, `assembly.ts`, `durable-session.ts` | `ExecutorDocumentOptions.detachedBootstrap?:BootstrapInvocation` accompanies actual detached import; factory invokes bootstrap before normal owned open. Supplied external view must still equal sole owned view. Cached-unprepared/nonempty/wrong-view refuse without mutation. Public caller owns exact retry token; none/inline standalone remains explicitly nondurable. Remove full Session captureLegacyFact clone from semantic detached import. |

Freeze shipping wire capability as `session-fork-bootstrap: ['1']` in SDK initialization and Desktop capabilities. The new method result uses a closed validator; missing capability causes explicit unsupported at the new client, no raw fallback. Extend actual `packages/desktop/src/shared/bridge.ts` manage request and `packages/desktop/src/main/ipc.ts` forwarding with the fork-only invocation; no new transport.

```ts
interface SessionForkRequest {
  sessionId:string;invocation:BootstrapInvocation;atSeq?:number;
}
type BootstrapFailure=Exclude<BootstrapOutcome,
  {kind:'ready'|'already-ready'}>;
type SessionForkOutcome=
  |{kind:'ready'|'adopted';sessionId:string;invocation:BootstrapInvocation}
  |BootstrapFailure;
type SpawnChildOutcome=
  |{kind:'started';path:string;jobId:string;sessionId?:string;modelLabel?:string;
      receipt?:BootstrapReceipt}
  |{kind:'adopted-not-restarted';sessionId:string;receipt:BootstrapReceipt}
  |{kind:'bootstrap-blocked';token:BootstrapResumeToken;
      reason:'unknown'|'payload-required'|'dependency-unavailable'|'source-changed'}
  |{kind:'not-issued';reason:'cancelled'|'stale-source'|'unsupported';
      invocation:BootstrapInvocation}
  |{kind:'refused';reason:Extract<BootstrapOutcome,{kind:'refused'}>['reason']};
class ForkTransportError extends Error {
  constructor(message:string,readonly invocation:BootstrapInvocation) {super(message)}
}
```

SDK wire definitions mirror only these closed data fields, never import ManagedDocument or persistence runtime. Ready/adopted/refused/blocked mapping strips all owner objects. Current spawn tool claims a job only on `started`; adopted-not-restarted and blocked are explicit recovery observations and do not terminalize parent task as child completed successfully. Not-issued cancellation/staleness remains a typed not-issued tool failure with the retained invocation, not another spawn. Same descriptor retry cannot change role/task/requestDigest.

---

## Gate B1 — source/reader contract

### Task 1: B1 source/reader contract

B1.1 and B1.2 below form one implementation/review gate (root R-B-06).

#### B1.1: Seed codec, turn algebra, interval closure and current selection

**Files**
- Create: `packages/core-session/src/conversation/seed-types.ts`, `seed-selection.ts`, `seed-export.ts`, `history/intervals.ts`.
- Modify: `core-session/src/conversation/history/{facts,types,group,replacements,index}.ts`, `conversation/{types,render-items,sources,state,validation}.ts`, `core-session/src/{index.ts,events/types.ts,events/conversation.ts}`; `context-engine/src/reduction/{selection,prune}.ts`.
- Test: create `packages/core-session/test/semantic-seed.test.ts`, `semantic-seed-turns.test.ts`, `packages/session-persistence/test/semantic-fork-baseline.test.ts`, and exact dedicated reduction consumer `packages/context-engine/test/semantic-seed-reduction.test.ts`.

**Interfaces:** produces the source/record/history contracts above; consumes existing raw history/validation and result projection. `closeSourceIntervals` has two real production consumers in this task.

- [ ] **Step1 causal baseline RED through existing API:** Create `packages/session-persistence/test/semantic-fork-baseline.test.ts` importing only today's `forkSession`, existing coordinator/JSONL factory and current valid source fixture building APIs. A completed parent contains a large consumed tool body marked `CONSUMED-PROOF-ONLY`, replacement summary `summary twelve`, and small typed tail. Call actual forkSession, read actual child archive, and assert the consumed marker is absent while expected first visible request is the literal summary+tail. Current raw fork retains proof bodies, so the archive assertion should fail for that reason. Capture actual failed assertion/bytes, not a missing new import. Use a bounded body here; the100MiB run is the single connected volume oracle.

```ts
const forked = await forkSession(coordinator, 'parent');
if (!('sessionId' in forked)) throw new Error('fork did not return a ready target');
const child = await backend.read(forked.sessionId);
expect(JSON.stringify(child.events)).not.toContain('CONSUMED-PROOF-ONLY');
```

- [ ] **Step2 new-contract tests:** Add literal source sessions with T1 input `old`, T2 input `kept`, closed assistant text, plus later replacement whose text is `summary twelve`. Assert semantic atSeq T1 refuses when extent spans T1+T2, atSeq T2 uses exactly `summary twelve`, later rewind hiding it exports neither summary nor original `old`. Use direct literals, not expected output generated by compiler. A failure because the new export is absent establishes only new-contract coverage, not the causal old defect.

```ts
const sourceLabel = {kind:'session' as const,sessionId:'parent'};
expect(exportConversationSeed(source, sourceLabel, {kind:'none'})).toEqual({kind:'none'});
expect(exportConversationSeed(source, sourceLabel,
  {kind:'completed',atSeq:t1InputSeq})).toEqual({kind:'refused',reason:'straddling-group'});
expect(closeSourceIntervals([['a'],['b'],['a'],['c']]))
  .toEqual([{first:0,last:2},{first:3,last:3}]);
```

Literal test fixture builder lives in the new test file, uses current `createSession`/`append` and known event seqs, and returns source plus named seq scalars; caller supplies only `{kind:'session',sessionId:'parent'}` or `{kind:'anonymous'}`, never a revision/hash. Do not import the semantic compiler into expected-value generation. Add accessor traps on consumed100MiB payload and, for none, all source-label/view fields plus a hash-invocation counter; none visits none of them. Validate source structural metadata without cloning it. New-contract digest controls use a literal SeedSourcePreimageV1 and independent node:crypto SHA256 calculation, not the exporter's own digest helper. Two inherited manifests with different old origin-table orders but equivalent referenced observations normalize identically; their old slot0 descriptors rebase to >=1, while new local refs remain0. Cover all call/result/media/input/provenance/artifact/omission origin slots, malformed inherited indices, unrelated historical entries removed, and no second payload pass. A host freshness/authority change with identical selected bytes must still fail the actual guard despite unchanged observation hash.
- [ ] **Step3 run:** `pnpm --filter @i-harness/session-persistence exec vitest run test/semantic-fork-baseline.test.ts`; then `pnpm --filter @i-harness/core-session exec vitest run test/semantic-seed.test.ts test/semantic-seed-turns.test.ts`. Record causal baseline and new-contract failures separately.
- [ ] **Step4 implementation:** Apply fixed turn rules, partition eligible input before shared closure, capture only selected recipes once, normalize/rebase current+reachable inherited origin slots and hash the specified noncircular preimage before filling current origin/final seed digest. Keep host freshness separate; no caller-supplied revision/contentDigest. New history descriptors render directly from seed record and derive replacement extents. Add malformed closed-codec negatives and nested T1–T3 seed + localT4 + summary T2–T4 selection controls. None returns before projection/payload/hash. No `captureLegacyFact(view)` or `JSON.stringify(view)` in source export.

```ts
if (selection.kind === 'none') return {kind:'none'};
const boundary = resolveSeedBoundary(view, selection);
if (boundary.kind === 'refused') return boundary;
// Current history is projected before applying the resolved semantic extent.
// Payload capture reads only selected complete recipes after input partition.
```

- [ ] **Step5 contract GREEN:** rerun core new-contract tests and `pnpm --filter @i-harness/core-session typecheck`; add managed and explicit memory append/cold fromJSONL controls for new records. The actual fork baseline remains red until B2 switches its real production consumer; retain it honestly rather than bypassing it. Preserve raw-source tests. Review B1.1 diff against scalar/body separation; checkpoint only after root review.

#### B1.2: Whole-group rewrites, protection, no-seed-prune and format11 fence

**Files**
- Create: `packages/core-session/src/events/bootstrap.ts`, `packages/core-session/src/managed/memory-bootstrap.ts` for the actual standalone bootstrap consumer, and `packages/core-session/src/managed/bootstrap.ts` for the narrow internal composition entry; modify core-session/package.json per root R-B-08.
- Modify: `core-session/src/events/{types,header,conversation,append}.ts`, `serialization/{jsonl,fact-journal}.ts`, `conversation/history/{group,replacements,facts}.ts`, `conversation/{state,sources,validation}.ts`, `managed/{view,memory-group,nondurable}.ts`, `projection/pruning.ts`, `context-engine/src/reduction/prune.ts`; `session-persistence/src/format/{registry,validation}.ts`, `coordinator/writable-format.ts`; `session-persistence-jsonl/src/{format,index}.ts`, `backend/{fact-journal,format-upgrade}.ts`.
- Create/test: `packages/core-session/test/semantic-seed-replacement.test.ts`, `packages/context-engine/test/semantic-seed-reduction.test.ts`, `packages/session-persistence-jsonl/test/format11-predecessor.test.ts`, and immutable literal fixture `packages/core-session/test/fixtures/format11-seed.ts`.

**Interfaces:** consumes B1.1 record descriptors; produces current read/write format11, inherited-observation exchange classification, explicit seed boundary in all scope readers and no inherited pending/effect authority.

- [ ] **Step1 new-contract tests:** Write literal seed with two items sharing local group address. Exact whole-group coverage succeeds; one-item coverage fails incomplete-unit; replace all, hide summary, confirm originals remain consumed. Session-scope inherited input remains protected; local pending/delegation/effect lists are empty before new input. Anonymous seed uses no parentSession. Include human versus plugin versus child-report source provenance observations, legacy tool result without fabricated envelope, pruned inline source with no full retained value/digest promise, and one exact ref used as both result and catalog. These are new-contract controls, not claims about a prior sent-request defect.

```ts
expect(projected.items[0].exchange?.acceptance).toBe('inherited-observation');
expect(state.pendingInputIds).toEqual([]);
expect(state.unsettledDelegationIds).toEqual([]);
expect(seedToolTextAfterLocalV1Prune).toBe('seed exact');
expect(reductionProgress(before, {...before} ,false)).toBe(false);
```

Use a local raw result and inherited result both named callId=`same`, a seed-only v1 prune marker, actual full request inputFingerprint/tokens, and whole-group summary fallback. No-effect marker never gets published/reported as reduction or renewed soft allowance; current conservative raw ambiguity checks may skip local collision too. Seed renderer never consults global v1 substitute map. No addressed prune-v2.
- [ ] **Step2 RED run:** `pnpm --filter @i-harness/core-session exec vitest run test/semantic-seed-replacement.test.ts`; `pnpm --filter @i-harness/context-engine exec vitest run test/semantic-seed-reduction.test.ts`.
- [ ] **Step3 implementation:** Wire exact local source part grammar and semantic scope/cache key through history/projection/index, actual append/memory-group and normal legacy readers; own format11 typed record validation and unknown/non-ignorable event registration. Keep public readiness separate from private growing-prefix staging; managed/memory bootstrap can stage but public projection/fromJSONL/action cannot use header-only/partial prefixes. Cover changed standalone header with cached index, malformed count/digest/order/out-of-prefix records and exact parse→buildSession→managed view preservation. Extend journal-version branches intentionally, not via accidental future-version fallback. Read-only low-level profile may report format11; execution reader must reject unsupported predecessor format before repair. No backfilled ready certificate on old upgrades.
- [ ] **Step4 predecessor control:** Use the accepted format10 predecessor reader bundle already available to the qualification harness, pinned by product commit. If no immutable bundle exists, root must provision a read-only pinned predecessor before this gate qualifies; do not emulate the predecessor with changed current code or change Git in the product checkout. Feed literal11 ready, header-only and interrupted files; assert no bytes changed and zero auth/fetch/dispatch. Current11 reads literal10 preserving old semantics; existing raw remapper tests stay green.
- [ ] **Step5 GREEN/review:** Run targeted tests plus package typechecks for core-session/context-engine/persistence/JSONL. Fresh B1 review checks independent literal expected content, no payload retention in history facts and no accidental source authority. B1 remains internal contract staging until connected consumers qualify.

## Gate B2 — owned bootstrap and real consumers

### Task 2: B2.1 — Header reservation and deterministic document phase owner

Binding source refinement: [R-B-20..27](../../research/2026-10-23-context-r4b-b2-owner-rulings.md). Keep actual fork/spawn consumer cutover inTask4 even where a broad original file list mentions fork.ts. The original fork regression remains a disclosed staged gate. Include retained staging cleanup, unknown-manifest token, partial-header guarded continuation, original manifest after metadata edits and historical-frame confirmation in this task's tests.

**Files**
- Create: `session-persistence/src/semantic-seed.ts`, `coordinator/{bootstrap-types,bootstrap-header,bootstrap}.ts`, `session-persistence-jsonl/src/backend/bootstrap-header.ts`.
- Modify: `session-persistence/src/{index,fork}.ts`, `coordinator/{types,fact-types,mutations,managed-documents,managed-document,load}.ts`, `format/validation.ts`; JSONL `{index,format}.ts`; core `events/header.ts` and new bootstrap completion event validation.
- Test: `packages/session-persistence/test/semantic-bootstrap.test.ts`, `packages/session-persistence-jsonl/test/bootstrap-physical.test.ts`.

**Interfaces:** consumes B1 export and its explicit internal/bootstrap managed-state composition entry (R-B-08); produces coordinator/backend request/outcome contracts, same-registry private phase admissions, ready receipt and pure inspect by invocation.

- [ ] **Step1 RED:** Test absent target, exact uncached empty, cached-unprepared refusal, nonempty no-turn target refusal, same-op cached join, same-ID different manifest conflict and already-ready live suffix adoption. Record physical file header/body independently. Before completion all public action/source/open/snapshot paths refuse; same managed view remains sole owner.

```ts
expect(outcome).toMatchObject({kind:'blocked',token:{phase:'seed'}});
expect(await coordinator.inspectBootstrap(invocation)).toMatchObject({kind:'reserved'});
expect(await backend.list()).toEqual([invocation.targetSessionId]);
expect(initialAdmissions.filter(e=>e.inputId===initial.inputId)).toHaveLength(1);
```

- [ ] **Step2 RED run:** `pnpm --filter @i-harness/session-persistence exec vitest run test/semantic-bootstrap.test.ts`; `pnpm --filter @i-harness/session-persistence-jsonl exec vitest run test/bootstrap-physical.test.ts`.
- [ ] **Step3 implementation:** Add final synchronous guard to header/phase issuance; original pending bytes and deterministic batch IDs use current lane/queue/index/quarantine. Header parse/build captures immutable scalar reservation. Inspect/resume never refreshes original creation timestamp. Reconcile original header before seed; committed seed before completion; dependencies before ready. A ready marker and initial input share one batch. Keep existing fact statuses truthful; cleanup error after sync cannot erase receipt.
- [ ] **Step4 crash cuts:** Inject failure before header write, partial header/staging, sync/rename/response, between phases, full seed fsync/before install/response, partial seed, completion+input fsync/before response, close and cold reload. Matching original full bytes can sync-confirm; matching partial suffix can only use original journal's absence proof. Changed source during await returns not-issued before reservation or blocked with original token after it. Missing cold payload returns payload-required; no new random spawn, target deletion or rollback. Preserve source/Stop checks around issuance and no new optional work under unknown.
- [ ] **Step5 GREEN/review:** Rerun two suites and persistence/JSONL/core typechecks. Fresh review verifies actual fsync/lease evidence and no duplicate opening map, nested lane deadlock or immutable header/view mismatch.

### Task 3: B2.2 — Exact artifact and transferred-membership confirmation

**Files**
- Create: `context-output/src/artifact/bootstrap-transfer.ts`.
- Modify: `context-output/src/{types,service}.ts`, `artifact/{ownership,dependency-membership,pins}.ts`; `core-session/src/results/projection.ts` and seed dependency visibility helper consumed by actual `session-executor/src/lifecycle/result-store.ts` and `desktop-gateway/src/{context-runtime,host}.ts`; `session-executor/src/context-output.ts` legacy inherited hook decision.
- Test: `packages/context-output/test/bootstrap-transfer.test.ts`, `packages/session-executor/test/semantic-seed-retrieval.test.ts`, `packages/desktop-gateway/test/native-context-fork.test.ts`.

**Interfaces:** produces exact BootstrapDependencyPort and transferred companionv2; consumes canonical SeedArtifact table and existing original artifact authorization/pin owners.

- [ ] **Step1 RED:** Literal catalog has members ordinals0 and1 with distinct refs; grant target pins alone demonstrably fails existing v1 owner==reader witness. Assert new exact target companion makes authorized viaCatalog read work while original catalog.owner and operationIds stay byte-identical.

```ts
expect(originalCatalogAfter.owner).toEqual(originalCatalogBefore.owner);
expect(targetMemberPin.operationId).toBe(originalMemberOperationId);
expect(await readAfterParentClose()).toEqual({text:'member zero'});
await expect(readWithWrongOrdinal()).rejects.toThrow(/unavailable|unauthorized|conflict/i);
```

Named read helpers in the test are local wrappers around the actual ContextOutputService.readExecResult/readResult, with literal refs/ordinal fixtures; no expected result is derived from the transfer implementation.
- [ ] **Step2 RED run:** `pnpm --filter @i-harness/context-output exec vitest run test/bootstrap-transfer.test.ts`; `pnpm --filter @i-harness/session-executor exec vitest run test/semantic-seed-retrieval.test.ts`.
- [ ] **Step3 implementation:** Capture trusted source access before target mutation, validate immutable roots/catalog members in bounded pages, issue target pins/ACL/companion and confirm exact original keys. Version2 validator handles original owner distinct from target; v1 stays unchanged. Add seed durable-ref evidence using structural manifest/group associations and the existing host's actual rewind/reference policy; replacement/reset does not silently revoke retrieval of retained results. Current target source policy comparison stays pre/post body I/O. Confirm target scope with its actual existing project owner before ready; do not borrow arbitrary source strings as authority.
- [ ] **Step4 independent cuts/policy:** Parent runtime close/reopen positive and target close/reopen positive **with genuine existing host-confirmed current scope**; nested target transfer; wrong catalog/revision/memberoperation/ordinal; source policy/project change; target pin removal; source-pin release while target pins remain; target deletion; pin-before-ACL and companion pending rename/response cuts. Assert physical retention separately from access authorization. Gateway descendant deletion retains its current refusal. When parent deletion/host scope makes current authorization unavailable, expect typed denial, not invented orphan access. Pre/post body reauthorization rejects mid-read policy/pin revocation. Read-only recovery creates no assembly/model and bypasses no roots.
- [ ] **Step5 GREEN/review:** Run artifact, executor and Gateway affected tests/typechecks. Review capability cannot be created by parsed ref alone, source-owner checks are not replaced by a broad grant API, and unknown reconciliation reuses original bytes.

### Task 4: B2.3 — Switch real consumers and preserve invocation over RPC failure

**Files**
- Modify the exact consumer files in the invocation table; `packages/sdk/src/{protocol,client,server}.ts`; `apps/cli/src/index.ts`; `packages/desktop-gateway/src/{router,session-management}.ts`; `packages/desktop/src/{renderer/app.tsx,shared/bridge.ts,main/ipc.ts}`; `packages/agent-team/src/{roster,types,fold,scheduler}.ts`, `scheduler/{teammate-lifecycle,recovery}.ts`; guard reviewer paths; executor detached/attachment paths; subagent spawn/source/generation/lifecycle/types.
- Tests: extend `subagent/test/{managed-child,managed-spawn-recovery,fork-isolation}.test.ts`, `agent-team/test/managed-transact.test.ts`, `session-persistence/test/fork.test.ts`, `apps/cli/test/sdk-wire-v11.test.ts`, `desktop-gateway/test/native-context-fork.test.ts`; create `session-executor/test/semantic-detached-bootstrap.test.ts`, `sdk/test/fork-bootstrap.test.ts`, and `subagent/test/native-transfer-baseline.test.ts` as the causal B3 baseline.

**Interfaces:** consumes B1/B2 receipts; shipping `SpawnChildOutcome = started | adopted-not-restarted | bootstrap-blocked | refused` carries exact receipt/token. Actual SDK/Gateway discriminated fork outcomes and transport error retain the original invocation.

- [ ] **Step1 new-contract qualification:** Accepted/dispatched actual spawn_agent/all with its own missing result and parallel siblings; inspect actual child's first prepared request. Expected user input `continue here` and delegated task `inspect files` remain; parent call `spawn_agent` and sibling calls/results/media absent; explicit omission metadata remains unknown, zero invented success. Existing raw projection already suppresses incomplete exchanges; do not describe this as proving today's unmatched calls are sent. Add standalone equivalent and team fresh/fork defaultnone/N.
- [ ] **Step2 RED:** Lose RPC response after target completion, catch client invocation, retry exactly it after changing source. Assert same historical target receipt and no second seed/input/action run. Cold incomplete lost payload gives payload-required. Team provisioning persists fixed target; archive existence alone cannot activate/claim execution. Parent task receives blocked/recovery truth, not child completed success. Reviewer shared approval none input keeps original allowance.

```ts
expect(second.sessionId).toBe(firstTargetId);
expect(recordedTargetCreates).toEqual([firstTargetId]);
expect(childInitialInputCount).toBe(1);
expect(childRunAdmittedCount).toBe(1); // ready adoption does not start it again
expect(blockedToolResult).toMatchObject({status:'recovery-required'});
```

- [ ] **Step3 implementation:** Mint and retain invocation in actual callers before request/mutation, replace child random create/import sequence with coordinator bootstrap, preserve original trusted start clock/deadline, initial-generation receipt adoption and role/instruction/tool floors. Default none bypasses parent source projection entirely. Detached import invokes owner before normal open and preserves exact supplied-view rule. Retire semantic raw clone/remapper call paths and duplicate inherited semantic ref granting; raw structural export keeps explicit genuine consumer only.
- [ ] **Step4 public controls:** Managed/standalone/team/reviewer, completed atSeq/N/nested forks, anonymous linked prepared-input relationships, cached-empty/nonempty/wrong-view, actual SDK server/CLI callback, Gateway manage and two Desktop callbacks. Verify request failure invocation survives before any response. Capabilities and closed params reject old missing-token requests before mutation. Target project association is confirmed before artifact readiness and does not silently widen scope.
- [ ] **Step5 GREEN/review:** Run these test files, the actual `semantic-fork-baseline.test.ts`, and package typechecks for subagent/agent-team/guard-approval/sdk/cli/session-executor/desktop-gateway/desktop. Review all production spawnChild and forkSession calls now either supply invocation or intentionally mint once per genuine standalone invocation. No test-only path substitutes for shipping consumer wiring.

## Gate B3 — inherited native and actual prepared request

### Task 5: B3.1 — Live source proof and binding-owned final constraints

**Files**
- Create: `packages/llm-seam/src/prepared/native-transfer.ts` (contracts/package-private validation) and `packages/llm-seam/src/prepared/native-transfer-issue.ts` (only authorization export).
- Modify: `packages/llm-seam/package.json` exact `./internal/native-transfer-issue` export; `llm-seam/src/{index,binding}.ts` for selected contract types/normal flow only, never authorization/validator reexports; `prepared/{types,wrappers,execution,payload}.ts`; `core-agent/src/agent/{execution,exchange,finalization,request-snapshot,admission,response}.ts`, its existing deps/assembly ports; `provider-runtime/src/{types,selection/binding}.ts`; child/executor composition passes proof/constraints outside serialized requests. Sole production importer of authorization entry is core-agent/src/agent/execution.ts.
- Test: `core-agent/test/inherited-native-identity.test.ts`, `provider-runtime/test/native-transfer-binding.test.ts`, `llm-seam/test/native-transfer-wrappers.test.ts`.

**Interfaces:** produces live-only NativeSourceProof lookup, NativeTransferBinding and root-selected final-confirm permit checks; data plan/result contract lives in llm-seam. Candidate authorizes/retains constraints, package-private final execution invokes them once. Provider runtime has no runtime core-agent dependency; internal export is a source/API boundary, not a JavaScript sandbox.

- [ ] **Step1 causal baseline RED through actual spawn/all:** Add `packages/subagent/test/native-transfer-baseline.test.ts` using today's spawnChild/Agent/adapter APIs and controlled loopback Responses providers. Complete a parent native+visible unit through the actual owned terminal, then fork/all to a different actual binding/fixture credential with identical provider/model labels. Independently inspect target loopback request: expected visible text/calls remain and source-native reasoning is absent. Current label-only transfer can retain it; record the actual sent-body failure, not a missing prepareTransfer import. Fixture credentials are synthetic, not real accounts; no external provider is contacted. Retain this baseline red through B2 if the native boundary has not yet switched.
- [ ] **Step2 new-contract source lifecycle tests:** At successful acceptance register only actual assistant/acceptance/call refs and assistant/native digest; assert tool result is not required or pre-bound and an optional registration failure does not fail the parent turn. Lookup before result/closure is unverified; after actual committed results/media close the selected unit, history-backed lookup binds that current unitDigest and succeeds. Changed result/media/selection/digest, closed source scope, copied JSON, cold Session, pre-issue-only confirmation, discarded/failed output, fake executionIdentity and local-test/custom terminal are unverified. Same live binding positive, second resolve with same labels negative. Warm nested proof validates current selection while forwarding original origin, never remints.
- [ ] **Step3 new-contract final-boundary control:** Codex actual auth returns changed/missing epoch after prepare with calibration=false; assert constraint rejects before control.confirmExecution/candidate receipt, reservation.issue or network. Same actual epoch proceeds with exactly one permit current/Stop/native check, then callback/receipt and issue, not a second candidate constraint invocation. Closed candidate rejects before native/receipt/issue/network. Permit bound to wrong final assessed payload/plan/original control or caller-shaped fake fields rejects. Management change after token capture still sends captured header/epoch pair and claims no active lease. Existing ordinary source/target/Stop guards remain in effect.

```ts
expect(fetchCalls).toBe(0);
expect(issueCalls).toBe(0);
expect(confirmExecutionCalls).toBe(0); // mismatched native never creates a receipt
expect(nativeConstraintCalls).toBe(1); // final-confirm owns this check, not candidate callback
expect(sourceToolDispatches).toBe(1);
expect(await copiedSourceLookup()).toEqual({kind:'unverified'});
```

- [ ] **Step4 implementation:** Register optional assistant/native/call-reference evidence only after committed acceptance matched original physical receipt; weak association stores receipt scalars/original digests, no future result/unit closure or transcript copies. At later lookup use actual history/snapshot owner to validate current completed selection/call-result-media closure and bind unitDigest. Unavailable attestation stays unverified and never fails ordinary accepted parent success. Binding provenance/injected verifier replaces label-only assumptions. Add root-selected exact internal authorization export and sole execution.ts importer; package-private validator uses real payload/plan/owned-terminal provenance. Candidate authorizes active lifetime/original generation/final assessed handle; synchronous prepared final confirm runs retained checks once before callback/receipt/issue, candidate does not duplicate them. Keep ordinary live/closed source, semantic/payload/current/control-error checks. No archived identity field/account registry/allowance/lease or JavaScript-sandbox claim.
- [ ] **Step5 contract GREEN/review:** Target tests/typechecks and normal dependency graph; bounded source check confirms exact internal export, authorization-only entry, sole production execution.ts importer and no facade/ModelClient/tool authorization/validator exposure. Check current/native execution count/order and candidate-close invalidation through real wrappers. Callback/proof never passes through snapshotModelData or persisted seed; wrapper/withOutputCap plan/report cannot disappear. Final-auth rebuild cannot launder old native through identity handoff or reset allowance. Actual native transfer baseline turns green only after B3.2 integration, never by weakening expected body.

### Task 6: B3.2 — Adapter per-unit preservation and bounded portable preparation

**Files**
- Modify existing `client.ts`, `request/messages.ts`, `request/validate.ts` and applicable `request/validate-native.ts` in `llm-openai`, `llm-openai-compatible`, `llm-anthropic`, `llm-gemini`, `llm-bedrock`; existing final prepared payload/validation wrapper composition. Create host prepare+assess loop in `core-agent/src/agent/native-transfer.ts`; modify actual `agent/admission.ts` and `agent/context-reduction/{bridge,composition}.ts` to use it with their existing assess/probe owners.
- Test: create `test/inherited-transfer.test.ts` in each of those five adapter packages; extend `core-agent/test/native-final-validation-routes.test.ts` and create `core-agent/test/native-transfer-progress.test.ts`.

**Interfaces:** adapters implement real prepareTransfer union and payload-tied per-unit reports; loop consumes immutable source plan and original deadline, returns prepared complete request or typed block.

- [ ] **Step1 RED route literals:** Responses ordered text/reasoning/call/result/media; public↔subscription negative. Chat reasoning_content exact same assistant/call positive and opaque-only mismatch negative. Anthropic original prefix/toolBindings/thinking/order positive; fresh child role/tools prefix mismatch downgrades visible unit, blocks redacted-only. Gemini exact signed part/call args positive; reordered signature/args/raw override negative. Bedrock ambient always portable/opaque-blocked for inherited native even if SDK object same; preserve normal local replay.
- [ ] **Step2 new-contract prepare+assess loop literal:** Three native units; pass1 prepare rejects A+B, pass2 an assessor-chosen synchronous cap derivative invalidates C's prefix/thinking facts, pass3 returns an assessed portable handle. Assert candidate sets `[A,B,C]`, `[C]`, `[]`, exactly3 combined passes, final measurement is pass3's assessed derivative; repeated/noncandidate ID blocks malformed report, opaque-only blocks immediately, deadline stops loop. None invokes auth/count/fetch. Run through actual main admission and actual reduction bridge/auto baseline, not a prepare-only test helper. Assert no stale budget checkpoint/latest measurement survives the failed cap.

```ts
expect(visitedCandidateSets).toEqual([['A','B','C'],['C'],[]]);
expect(prepares).toBeLessThanOrEqual(4);
expect(authCalls).toBe(0);
expect(finalMessages.filter(m=>m.role==='tool').map(m=>m.toolCallId))
  .toEqual(['original-call']);
```

- [ ] **Step3 implementation:** Compare inherited units with final lowered payload; aggregate native unverified is not per-unit proof. Portable fallback keeps real visible text/calls/results/media and whole closure. Recoverable prepare/cap failures use the same combined loop; unrelated schema/media/call errors block. withOutputCap returns valid immutable measured handle/report or throws without invalid derivative. Wrappers preserve data/reference capabilities. Only the active execution.ts candidate authorizes final assessed real payload/plan and original generation; private final confirm runs native checks once before callback/receipt. Negative raw stream without permit, copied/lookalike permit/fields, closed candidate, pre-cap permit on derivative, wrong generation, copied derivative error and raw override refuse before receipt/issue/network. Loop removes>=1 per failure, never mutates measured bytes; fresh role/system/tools/task/raw options remain included. Final-auth mismatch without calibration gets only existing bounded unsent/unobserved rebuild with same action/deadline.
- [ ] **Step4 GREEN/review:** Each adapter inherited-transfer suite, core-agent two suites, actual subagent `native-transfer-baseline.test.ts` and affected typechecks. Inspect final body/counters independently from compiler output. Existing main/local/cold controls remain unchanged. Loopback qualification is offline transport/credential-fixture evidence, never real-account/provider qualification.

## Connected B acceptance and promotion

### Task 7: B.4 — Actual entries,100MiB consumed source and fixed-range acceptance

**Files**
- Tests: `e2e/context-semantic-inheritance.e2e.ts`; extend actual CLI process test `apps/cli/test/sdk-wire-v11.test.ts` and Gateway real host tests; no fake graph consumers.
- Documentation after root acceptance only: normative progress/acceptance records in their existing locations; this draft remains historical.

- [ ] **Step1 connected oracle:** Actual managed and standalone spawn/all unresolved-self-call controls; SDK true CLI entry through its real stdio transport; Gateway actual host/router manage. Independently count stable target, inherited records, one delegated input, current instructions/tools, first prepared payload, actual attempted transport and tool dispatch. Repeat after cold open at each bootstrap phase; uncertainty resumes original operation or refuses, never repeats initial run.
- [ ] **Step2 volume oracle:** Parent source includes100MiB consumed result body and small current summary+typed tail+R4A catalog. Instrument selected payload reads and copy paths, assert original consumed body accessor is not invoked/duplicated, compare literal effective request and catalog refs; seed/request growth tracks retained items/dependencies. Active unpruned100MiB legacy source may block fit honestly. No R6 whole-history streaming/cold-memory claim.
- [ ] **Step3 versions/policy:** Immutable predecessor10 ready/header-only/interrupted11 refusal with unchanged bytes/zero provider work; current11 old10 raw semantic compatibility; parent runtime close/reopen with genuine scope, physical source-pin release versus remaining target retention, current target scope/policy revocation, existing Gateway descendant-deletion refusal, nested target reopen, wrong membership evidence and native cold portable/refusal. Missing parent/host authority may correctly deny body access even when pins retain bytes. Project visibility and real role/permission floors are not bypassed by lineage metadata.
- [ ] **Step4 commands:** targeted suites already named above; then `pnpm typecheck`, `pnpm verify:reachability`, `pnpm test`, and actual affected CLI/Gateway entry controls on one fixed integrated HEAD. Do not repeat broad green checks after no further changes. Retain exact failed/red evidence and any platform skips; never claim runtime/provider qualification from offline fixtures. Existing qualification prerequisites still apply; no release action follows.
- [ ] **Step5 review/promotion:** Fresh connected functional review verifies B1/B2/B3 consumer and failure boundaries, old semantic paths retired and no hidden authority/duplicate owner. Root alone accepts/promotes the draft and records whole B completion after all connected obligations pass. Keep completed28/43 and unrelated decomposition work unchanged. Decomposition-only qualification is deferred; functional module boundaries and existing owner reuse remain required. Commit only the reviewed authorized functional range; no push/merge/tag/release.

## Root review dispositions

1. Approved exact seed/turn/record/part grammar and boundary examples, including manifest positions without a unique turn and post-import replacement extent propagation.
2. Approved bootstrap wire API incompatibility for old missing-token fork RPC, stable caller-owned operation descriptor and blocked/adopted-not-restarted outcomes across actual consumers.
3. Approved target current-scope confirmation ordering and transferred companionv2 policy. The current membership witness requires owner==reader; pins alone cannot implement inheritance. Existing target authorization and deletion semantics stay authoritative.
4. Accepted format10 predecessor graph is the sealed R4A copy `.tmp/r4hc-02/g/node_modules/@i-harness` with CLI `.tmp/r4hc-02/g/cli`, product678af03d. Copy/hash-check required inputs into a fresh qualification root; never execute or mutate sealed runners/roots. A missing/unusable graph prevents predecessor qualification, not permission to simulate it with current code.
5. Selected task dispatch order: combined B1 (Task1) → B2 (Tasks2–4) → B3 (Tasks5–6) → connected acceptance (Task7). No task may call staged functionality shipping/completed before its real consumers and fixed-range evidence qualify.

Self-review performed on this draft: every selected ruling maps to a task; optional archived native tuples, account-lease redesign, seed prune-v2, R4C and decomposition-only work are excluded. Any root adjustment to the closed contracts requires updating their consuming task signatures before dispatch.
