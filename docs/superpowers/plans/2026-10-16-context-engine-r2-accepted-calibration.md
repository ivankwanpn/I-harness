# ContextEngine R2B2 — attributable accepted usage and live calibration

> **For agentic workers:** REQUIRED SUB-SKILL: Use subagent-driven-development or executing-plans. Steps use checkbox syntax for tracking.

**Status:** Complete through45636f7aca5ba7dfaaa0d969b473c56f36e96cb7 after fresh full-range review and scoped fix1 approval. Original BASE a7b60c646c2b18118c9a9c4b5a508ac5298366b0. Verification: docs/research/2026-10-16-context-engine-r2b2-verification.md. Whole-program, native authority, cold calibration and R3 guarantees remain outside this completed task gate.

**Goal:** Calibrate only from an attributable accepted request, preserve useful compatible samples across pure candidate probes, and stop reuse after an actual owner/context/binding change without inventing account or lease evidence.

**Architecture:** Existing core-agent acceptance remains the only exchange owner; core-session stores bounded acceptance/usage facts and checks their references. token-meter owns one pure-probe/explicit-retirement calibration state. Provider-runtime and its existing authentication owner supply process-local execution identity; adapters confirm the actual send receipt after existing auth work. R3 retains durable physical-attempt reservations and cross-process fencing. This unit replaces owned v1 calibration; it does not add another attempt, persistence or admission owner.

**Tech Stack:** Existing TypeScript/pnpm/Vitest, random nonsecret process-local IDs, shared core-session data encoding, current format migration/coordinator gates. No new registry dependency.

**Spec/evidence:** redesign/framework, reviewed R1C and R2A, R2B1 plan; `.tmp/context-redesign-20261015/r2b2-root-ruling.md`, `r2b2-attribution-integration.md`, `r2b-identity-contracts.md`. Product planning evidence is pinned to38a2da0b; no claim that proposals are implemented. Root accepts the live-only observation-lifetime contract below, not the earlier proposal's nonexistent executor ownerGeneration.

**Implementation audit ruling, 2026-10-16:** Owned v1 migration removed the last production consumers of private-workspace facade exports deriveContextUsage, validContextCheckpoint and createContextMeter (including its no-argument overload). Root verified both packages are private:true and authorizes retiring those newly orphaned exports; tests alone are not a shipping compatibility requirement. Preserve the actual historical v1 decoder through validContextEvent. Remove the dead no-argument production algorithm if no real consumer remains, rather than create a test-only compatibility module to keep obsolete API tests green. Retain applicable normalization/hash/lineage controls against actual retained/new implementations and disclose removed API-only scenarios. New implementation helpers/types need not be publicly exported without real consumers. No audit waiver, fake consumer or baseline reseed.

## Global Constraints

- User approved continuous redesign. One product writer and fresh GPT6.1Sol review, no recursive delegates. Work in existing development checkout. Product stays0.1.13-rc.1; no installed app/profile, real credential/account/provider/count calls, remote/merge/release or new worktree.
- Preserve six routes, R1 accepted-before-tool barrier, R1C snapshot freshness/historical read latch, B1 final-candidate measurement, raw precedence/defaults and current policy math. No new provider capability or global output default.
- Never hash credentials, account IDs/headers or private identity tuples into public/persisted evidence. Random execution/lifetime labels are process-local observations, not proof of a principal, native replay permission, lease generation or delivery.
- No payload/signature/unit vector in context events;4096-byte bound and strict DTO validators remain. No core-session reverse dependency. New modules normally150–400 lines/functions<=120. Do not enlarge existing codex-management/assembly/turn owners into new monoliths.
- The only version bump here is session data format4, with forward/refusal/migration evidence. Desktop release version is unchanged. No v1→v2 hash/anchor conversion, duplicate usage writer, fabricated public consumer or audit baseline exemption.
- Prior whole verify:all FAILED/incomplete and original27/43 decomposition count remain until their real gates pass. Local success is not live backend, cold calibration or cross-process qualification.

## File/owner map and exact retirement

- core-session `events/conversation.ts`, `events/context.ts`, `conversation/validation.ts`, `projection/context.ts`, `serialization/jsonl.ts`, `events/types.ts`, `index.ts`. Extract shared data-only attribution/usage validator leaves to keep size/cohesion. Extend the existing staged structural index, not another index with a second raw log.
- token-meter checkpoint/calibration normalization and actual consumed factory exports. R2B1 semantic/pricing identities are consumed directly. Owned callers stop reading/writing v1 checkpoints together; the unused private no-argument facade/algorithm is retired under the implementation ruling above, while historical v1 decoding remains at its real consumer.
- llm-seam request/stream controls, prepared wrappers/controls, retry terminal classification; adapter clients bind receipt at their existing transport invocation. Provider profile/build forwarding uses public package contracts. No receipt in wire JSON.
- provider-runtime `runtime/auth.ts`, `selection/{resolve,binding}.ts`, types; credentials bearer result metadata only; coding-plans `codex-management.ts` token boundary plus a private live-identity leaf. Avoid extra authentication calls. Actual model-binding carriers in assembly/CLI/children carry only safe lifetime data where consumed.
- core-agent `agent/{context,request-snapshot,admission,turn,model-step,exchange,finalization,budget}.ts`. Replace mutable latest-budget/boolean acceptance attribution with exact immutable selected candidate and successful receipt.
- session-persistence format registry/preflight/writable gate/incremental index plus `seed.ts` central remapping, `fork.ts` and subagent fork consumer. Recheck exact exports before editing; do not invent a second fork transform. Current Desktop session/project.ts filters operational context facts from chat projection; preserve that boundary and historical v1 support.
- compaction summary preparation/contracts and acceptance/usage callback: own ephemeral piece observations only, never main calibration or forged durable exchange. R3 later supplies summary transaction acceptance/publication linkage.

### Task 1: Replace owned v1 calibration with exact accepted observations

**Consumes:** reviewed B1 semantic/pricing/payload identities and selected-final-candidate measurement; R1 acceptance/action/attempt identities; R1C immutable request evidence; existing resolved-auth and late-auth transport boundaries; existing owned session format gates.

**Produces:** format4-fenced accepted request attribution and usage references; process-local execution receipts; pure candidate calibration probing with explicit retirement; main/child live reuse and honest cold/summary limits.

- [x] **Step 1: Record baseline and add independent attribution/epoch RED fixtures.**

Record baseline for affected checkpoint/normalization, conversation-format/accepted-exchange/seed, retry wrappers, main owned-budget/context-usage, real runtime/Codex-token fixture and summary tests where no source-equivalent receipt exists. Do not exercise real credentials. Add missing/mismatched accepted-reference, probe-A-miss/B-match, missing-usage preservation and pretransport epoch-change controls first. Keep actual failed receipts, fixture mistakes and corrected RED distinguished.

- [x] **Step 2: Version causal attribution at the existing acceptance owner.**

Use bounded data-only contracts in core-session, with no seam/runtime imports:

```ts
interface AcceptedRequestAttributionV1 {
  version: 1;
  ownerSessionId: string;
  observationLifetimeId: string;
  candidateId: string;
  sendId: string;
  semanticId: string;
  payloadId: string;
  payloadKind: 'http-json-body' | 'sdk-command-estimate';
  executionEpochId: string;
  coldCompatible: false;
  snapshot: {
    semanticRevision: string; protectionRevision: string;
    branchId: string; contextEpoch: string; surfaceRevision: string;
  };
  projectionRevision: number;
}
type ExchangeAcceptedEventV2 = Omit<ExchangeAcceptedEventV1, 'version'> & {
  version: 2; request: AcceptedRequestAttributionV1;
};
interface AcceptedUsageReference {
  acceptedSeq: number; exchangeId: string; actionId: string; attemptId: string;
}
```

IDs are nonempty producer values≤256characters, digests64lowercasehex, numeric counts safe nonnegative integers. The old ExchangeAcceptedEvent name becomes a versioned union preserving v1 reading and structural behavior. A trusted built-in attributable main/recovery request writes v2 from the exact selected candidate and successful receipt alongside the existing step identity. A custom unclassified request still accepts conversation through existing v1 behavior; it cannot mint v2 usage evidence. Neither path turns a failed/refused/truncated/incomplete response into accepted context.

Accepted v2 is the independent durable reference; a checkpoint cannot establish its own acceptance by repeating self-declared fields. Before appending it, the acceptance owner compares candidate/receipt/request identities, actual send ID and model-step action/attempt. Return or retain the exact accepted reference even when append succeeds but flush is uncertain. In finalization's finally block, compare the exact written event, not just array position/type. Real usage survives later Stop/flush failure; tool preparation/dispatch still waits for successful existing acceptance flush.

Context usage v2 is a sample or retirement event; use these data shapes, with bounded scalar validators:

```ts
interface ContextUsageCheckpointV2 {
  version: 2; anchorId: string;
  accepted: AcceptedUsageReference;
  request: AcceptedRequestAttributionV1;
  bindingId: string; shapeId: string;
  pricingVersion: string; normalizationVersion: 'input-usage-v1';
  usageSemantics: 'includes-cache' | 'excludes-cache';
  prefixId: string; unitCount: number; heuristicPrefixTokens: number;
  reportedInputTokens: number; reportedOutputTokens?: number;
}
type CalibrationRetirementReason = 'owner-changed' | 'binding-changed' |
  'execution-identity-changed' | 'branch-changed' | 'context-rewritten' |
  'prefix-changed' | 'shape-changed' | 'pricing-changed' |
  'native-incompatible';
type ContextUsageEventV2 =
  | { type: 'context/usage'; version: 2; op: 'sample';
      checkpoint: ContextUsageCheckpointV2; seq?: number }
  | { type: 'context/usage'; version: 2; op: 'retire';
      ownerSessionId: string; anchorId: string;
      reason: CalibrationRetirementReason; branchId: string;
      contextEpoch: string; seq?: number };
```

The request already contains semantic/payload/snapshot IDs; do not duplicate them or store unit vectors. pricingVersion is a bounded producer version label, compared exactly by the consumer; accepting its syntax does not certify an unknown pricing algorithm. A sample anchorId is domain-separated from its validated accepted identity/normalization/usage and prefix facts. Reconstruct safe objects from explicit fields, not arbitrary spreads. Individual ID maxima do not waive the4096-byte whole-event bound.

Extend the existing structural index to validate sample→prior accepted-v2 reference and complete attribution equality, earlier sequence/action/attempt/exchange, sample identity and retirement ownership. Re-read referenced facts to detect mutation after index creation, preserving staged atomic commit. Missing/mismatched references are invalid; v1 acceptance cannot authorize a v2 sample. Validation does not claim cryptographic delivery proof or full source reconstruction from a digest.

Concrete index seam: `createConversationValidationIndex(events, { formatVersion })` and `stage(suffix, { readCurrentEvent })`, with the private append-owner constructor adapted to those same inputs. Full-history validation supplies its actual format; live append reads its current Session array; coordinator stage supplies a callback over the **current operation's freshly read durable prefix**, not the first load captured forever. Verify referenced accepted attribution and structural fields against indexed facts. Index/session caches include formatVersion and are rebuilt after format migration; stage cannot silently retain a3 index beneath4. Do not retain another raw event array in the index or add a separate v2 validator disconnected from real append/load paths.

- [x] **Step 3: Fence format4 and preserve truthful seed/fork history.**

Upgrade CURRENT_FORMAT_VERSION to4, retaining1/2/3 readers and registered stepwise migration. A header4 barrier must be durable under current owned writable-format gates before any accepted-v2/context-v2 append. Older headers refuse new fields/versions; old runtime refuses4 before repair/write. A backend unable to upgrade refuses writing. No ignorable markers or rewrite of original sequence/history/usage values. Keep event4096-byte guard and reject oversized DTOs.

Shipping owners establish writable format before model transport, not after a billable response has arrived. A standalone caller supplying an old mutable Session must use the existing explicit in-memory upgrade API or receive an actionable format precondition before send; core-agent cannot silently change a durable header or infer persistence authority from a flush callback. Do not send first and discover that acceptance cannot be appended. Inventory all shipped accepted/context event consumers (including SDK/renderer validators) before changing the versioned union; preserve historical v1 rendering/reading.

Concrete readiness port: expose coordinator-owned `ensureWritableFormat(sessionId): Promise<{ formatVersion: number }>` through the existing session-operation/ownership and ensureWritableFormatUnlocked gates; it returns only after the backend's current header or successful durable upgrade establishes CURRENT_FORMAT_VERSION. This is format readiness, not a lease-generation receipt. Composition injects `AgentDeps.ensureWritableContext?: () => Promise<void>` into shipping main/CLI/child Agents, invokes that real coordinator method and mirrors the successful explicit upgrade into the actual owned in-memory Session using the existing upgrade helper. Core-agent awaits this port before the first turn's candidate capture/transport and verifies its Session format, never writes a header. If an owned custom coordinator lacks the capability, fail explicitly before send; do not substitute ownerOf or a generic flush callback. Standalone absence retains only in-memory guarantees and requires an already explicitly upgraded Session. Test memory4/backend3, unsupported backend and a formerly cached3 Session/index upgraded under its owner. Reads/hover never call readiness or acquire ownership.

Pass the actual format through both public/full history validation and the incremental index. Pinned createConversationValidationIndex/validateConversationHistory currently construct a default3 index; correct that path, not only the constant or serialization gate. JSONL accepted source-version arrays must include3 explicitly after CURRENT changes. Exercise write-behind, loadOwned, snapshot, upgrade interruption and header/tail recovery using actual coordinator/backends in isolated temp stores.

Central remapConversationSeed handles every fork path, including no-rewind shortcuts: remove operational context samples/retirements; convert inherited accepted-v2 to structural v1 before namespacing/remapping action/attempt/exchange/sequence. Retain existing full-bundle validation/inherited provenance. Do not namespace a parent's send/epoch into apparent child execution. Original archive keeps the original evidence; new child sends create their own v2 records. Accept source format explicitly; no format4 data decoded under a guessed3.

- [x] **Step 4: Produce safe live identities at existing runtime/auth owners.**

Use a narrow seam contract with version1, runtimeId, bindingLifetimeId, authEpoch, scope(binding-credential or managed-subscription) and coldCompatible:false. Mint observationLifetimeId once per real Agent context/session-owner lifetime, not per turn. This is not an executor lease generation: coordinator.ownerOf is boolean and locking optional. R3 still must provide real reservations/fencing.

For API-key bindings, mint a random live epoch after the existing successful auth resolution and own a detached private captured credential/config profile. Settings/headers/raw config cannot mutate that captured lifetime through aliases. Wait/retry-only client rebuilds reuse its epoch; a newly resolved binding gets a new one without comparing/hashing secret strings. Keep control callbacks/AbortSignal/requestScope identity where required by existing contracts. Ambient AWS identity is unclassified unless an actual owner contract provides continuity; do not invent a pinned-key guarantee for it.

For managed subscription, mint/rotate a random process-local epoch inside the existing locked CodexManagement.token operation using its already-read private(sessionId,subject,workspaceId) tuple. Ordinary token refresh retains it; changed identity/session/new login retires it. Export no tuple/account hash/credentials in epoch metadata. Forward the optional epoch through the actual auth result/runtime binding and late resolveCodexAuth callback. Injected clients without a declared continuity contract remain unclassified. This adds no auth/account I/O to prepare/capture/getters.

At the actual transport invocation, after existing late auth and immediately before fetch/send with no intervening await, create/confirm an immutable ExecutionReceipt containing candidateId, fresh sendId, actual live execution identity and selected semantic/payload IDs. Compose its synchronous confirmation with existing freshness/fence checks; do not overwrite them or put receipt data in provider JSON. Receipt collection grants no authority and consumes no independent retry allowance. A direct standalone adapter with mutable caller config gets no false cross-request lifetime; unknown receipts cannot create calibrated samples.

Concrete seam boundary: extend prepared execution with a fourth, private-per-handle `PreparedExecutionContext` argument whose `confirm(identity?: LiveExecutionIdentity): void` closure owns the final frozen semantic/payload facts. It generates a fresh sendId for that invocation and invokes optional `PreparedStreamControl.confirmExecution(confirmation)`, then the existing immediate pretransport guard. Adapters call it once after actual auth and immediately before their fetch/send, replacing the prior direct guard call without duplicating it. This avoids rehashing a body or trusting caller-supplied payload IDs. Confirmation carries version/sendId/final semanticId/payloadId/payloadKind and optional actual identity; the candidate-local collector adds its own bound candidateId and validates the facts against its selected handle. Preserve equivalent request-level control composition through wrappers. If no collector is installed, direct clients retain their ordinary execution behavior with no invented attribution. Neutral custom preparation has no fabricated protocol facts/receipt; finalization uses structural v1 acceptance and no calibrated sample when classified receipt evidence is absent.

- [x] **Step 5: Bind receipts to the exact successful step and bounded local rebuild.**

Allocate candidateId for the selected final prepared handle; a derivative/rebuild gets its own ID. Retain immutable RequestEvidence and measurement with it. Adapter receipts are execution data, not mutation of frozen prepared facts. The per-candidate turn closure associates the send with the current model-step action/attempt; model-step clears receipt alongside content/usage when an actual retry opens another attempt, then returns the successful receipt with end/usage. Wrappers preserve all callback compositions and cannot reuse send1's receipt for send2.

Collectors have an active/settled lifecycle: close the specific stream collector in finally, so a late auth/receipt callback from an already settled or cancelled stream cannot update a later turn's compatibility slot, even on the same binding. Existing guard success marks hasStartedSend immediately before invocation; identity confirmation alone is not a claim that a request reached the provider. A guard/Stop failure after confirmation creates no accepted sample. Observed model output also closes the no-send-rebuild path for custom clients without transport callbacks.

A changed actual auth epoch invalidates the prior anchor and throws EXECUTION_IDENTITY_CHANGED before fetch. Add that code to terminal retry classification even for mode:always. In the existing logical-step candidateState, retain epochRebuilds and sticky hasStartedSend/hasObservedOutput. Permit one local re-admission only before any send/output; preserve claim/hooks/step/action/attempt, compaction/recovery state and stale bounds. The safe newly observed epoch may seed the replacement candidate. A second rejection or one after any earlier real send is terminal, preventing re-entry from resetting the lower retry allowance. No tools are replayed. An auth failure cannot relabel accepted usage and must retire unsafe epoch reuse without logging secrets.

Concrete E→F handoff: the trusted runtime/adapter confirmation supplies private `EpochReadmissionEvidence { candidateId, bindingLifetimeId, observed: { kind: 'known', identity: LiveExecutionIdentity } | { kind: 'unclassified' } }` to the candidate-local receipt collector before throwing the typed rejection. The turn owner stores that evidence privately in logical-step candidateState. The single permitted rebuild explicitly passes it as expected execution compatibility for its new selected candidate, only when the actual runtime/binding lifetime still matches; discard it on a binding change. Its guard compares actualF with expectedF, not the original descriptorE. It changes numeric expectation only: do not mutate frozen prepared facts, R1C snapshot contents or persisted ModelBudgetBinding, and do not refresh auth in getters to obtainF. Require a receipt issued for the rejected candidate; arbitrary error properties are not trusted handoff evidence. E→F→F gives one rejection and one eventual send; E→F→G exhausts the bound. Keep the safe handoff out of diagnostics except allowlisted scalar reason/IDs.

Retain a private **last-observed execution compatibility** slot in the existing Agent context, scoped to its observation lifetime and the actual runtime/binding lifetime. Trusted confirmations (including the bounded no-send handoff) update that numeric-observation slot. Subsequent logical steps on the same binding start from the safely observedF, rather than the initial resolved descriptorE; otherwise every step could retire a validF sample and repeat authentication. A changed binding/runtime lifetime clears the slot; an old candidate's late receipt cannot update a different current binding. Prefer this slot over the initial descriptor only when lifetimes match, and still confirm actual identity immediately before every send. It is not a new source of account truth or native permission, is never persisted as current identity, and performs no I/O. Test E→F→F followed by another stableF step: one total re-admission, useful F calibration, no repeated stale-E loop.

Distinguish reliance on calibration from an unanchored estimate. A first/unanchored request with no prior epoch-rejection handoff may establish its actual epoch at confirmation without a gratuitous rebuild. If admission relied on an anchor and actual identity differs or becomes unclassified, retire that anchor and use the one bounded no-send handoff to re-assess without it. A knownF handoff pins that replacement's expectedF even though its estimate is now unanchored; actualG is terminal after the used rebuild, not a new first-observation exception. Represent unclassified observation explicitly rather than inventing an epoch; an unclassified replacement may execute without calibration, and a newly known identity may be recorded after acceptance without another rebuild. Never grant native compatibility from this numeric rule. The E→F rebuild fixtures establish an E anchor first; add empty-anchor first-send and identity-lost calibrated controls.

Hidden SDK retries remain one locally observed invocation until R3 integrates their real attempts; report that limitation. sendId is not a durable reservation. No frame in this task may claim F09 complete.

- [x] **Step 6: Implement one probe/retirement state and remove owned v1 calibration.**

The new calibration owner keeps empty/live/retired state. `probe(input, capturedCompatibility)` is pure: it returns heuristic/calibrated facts and a compatibility disposition without erasing a sample. Probing initial uncapped A may miss while selected derivative B matches; the final candidate is validated independently before use. Actual observed owner/branch/epoch/rewrite/prune/rebind/native/source changes retire the sample through the existing execution owner. Pure scalar getters do not append events/prepare/auth. R1C's historical budget-read latch stays separate.

Create a v2 factory with actual core-agent consumers, replacing the owned projected-v1 factory. Its narrow methods are `probe(...)`, `recordAccepted(...)` returning sample-or-ignored and `retire(...)` returning an optional retirement fact. token-meter never appends/flushes Session events itself. recordAccepted consumes the exact prepared semantic input, request attribution, accepted-v2 event and usage; absent/unequal evidence returns an explicit ignored reason. The core-agent owner cross-checks the event in its actual Session before recording, and core-session persistence independently validates references. The factory is a measurement owner, not an authority verifier supplied only with a caller's self-attested boolean.

Retired anchor IDs never revive when earlier text later matches. A selected actual source incompatibility may retire; an uncommitted hypothetical derivative alone cannot. A new compatible accepted sample replaces the prior one only after usage normalization and attribution validation. Missing/invalid later usage preserves an earlier still-compatible sample. Failed/unaccepted usage remains billing observation and never creates an anchor. Stable sample IDs make duplicate completion idempotent at the owner; contradictory duplicates are rejected, and coordinator uncertain-write reconciliation remains the one persistence owner.

Normalize once with safe nonnegative counters/overflow checks: includes-cache100/read40/write10 remains100; excludes-cache becomes150. Unknown semantics or invalid counters cannot calibrate. Sum explicitly priced suffix units of the same pricing version; reported input100 plus new7+3 becomes110 regardless of output9000. Do not subtract aggregate totals from different projections/prices.

Read v1 samples as historical legacy facts only; owned main/child code ceases v1 restore/record in this same activation. Keep no dual write/fallback. Current-process v2 reuse requires the same actual owner observation lifetime, execution/binding epoch and valid prefix/shape/branch/epoch/pricing. Cold records cross-check accepted lineage but remain historical because coldCompatible is false; matching configuration alone does not establish account continuity. First new admission uses honest projected estimation and can re-anchor after acceptance. No misleading calibrated label on restart.

Retire unused private-workspace projected-v1 factory overloads/public exports when all real consumers migrate, following the R2A ruling and the concrete implementation audit ruling above. Keep the historical v1 event decoder where actually consumed; do not retain dead compatibility exports or algorithms merely to satisfy an earlier planning assumption or add fake consumers to satisfy the audit. Explain exact removals, obsolete API-only test removal and real call-site migration in the report.

Summary invocation/piece uses its own purpose/origin/candidate/receipt and may report an in-memory summary-piece-accepted observation only after complete/end/quality checks. It never forges model/exchange-accepted, feeds main calibration or claims durable transaction coverage. Child Agents own independent lifetimes/samples even on inherited client bindings. Preserve summary≤8 tracker and split bounds; a no-send epoch reprepare uses its existing charged slot without refund/reset, and after-send change is terminal. Durable summary sample acceptance is explicitly assigned to R3 transaction publication.

- [x] **Step 7: Run independent causality/migration controls and affected gates.**

Required literal oracles:

1. Accepted candidateA/send1/payloadP rejects candidateB/send2/payloadQ in each independent changed field; missing accepted reference, wrong attempt/session/branch/lifetime and mutated prior acceptance fail in actual incremental and cold validators.
2. Failed send1 then completed send2 records only send2/current attempt. Missing completion/refusal/truncation/post-end corruption cannot create an anchor. Later accepted missing/invalid usage keeps an earlier compatible sample; billing facts remain independent.
3. EpochE→F before first fetch rebuilds once with zero extra claims/hooks/tools/sends; E→F→G stops; epoch failure after a sent retry never resets allowance, even retry mode:always. Stop after accepted append preserves real usage while failed flush prevents tool effects.
4. Pure A-miss→B-match retains calibration; actual rewrite/rewind/rebind then matching B cannot revive retirement. Cache-marker movement preserves v2 prefix; system/schema/reasoning/native changes invalidate appropriately. Same settings after restart yields historical usage plus heuristic admission.
5. API-key profile alias mutation cannot change a captured lifetime; wait/retry rebuild preserves epoch; fresh binding rotates it. Synthetic managed-token refresh retains epoch, new session/identity rotates it, no account secret appears in public/events/logs. Capture/read/prepare auth counters remain zero.
6. Format1/2/3 histories remain readable, old reader refuses4 before mutation, interrupted header upgrade cannot write v2 under3, unsupported backend refuses; real cold/index paths validate exact accepted lineage and4096-byte bounds.
7. Parent v2 fork/seed becomes structural inherited v1 without operational anchors/receipts across rewind/no-rewind and child paths; child fresh send records its own owner. Summary piece success followed by transaction failure remains only its own observation.
8. Includes/excludes cache arithmetic, invalid/overflow counters, explicitly priced suffix110 and hidden output9000 follow literal expectations, not implementation-generated answers. Duplicate same completion does not append a second logical sample.

Run affected suites sequentially maxWorkers2/minWorkers1: core-session full, session-persistence full, token-meter full, seam full, provider/provider-runtime affected auth/wiring plus all identity tests, coding-plans token-management fixture suites, five adapter prepared/retry/stream-isolation scopes, core-agent acceptance/owned-budget/context-usage/retry/snapshot/deep controls, executor inherited/cold/service controls, subagent seed/fork/child, compaction summary controls and six-route corpus. Verify actual file names before commands; add meaningful RED before code. Reuse unaffected receipts after scope-limited fixes; do not rerun unrelated passes or weaken timeouts.

Actual relevant existing files verified during preflight: core-session request-context/conversation-state/conversation-projection/context-recovery; persistence conversation-format/seed-semantics/fork/ownership/model-retry-event; core-agent accepted-exchange/context-usage/context-update/context-snapshot/context-effect-freshness/model-recovery/protocol-recovery/request-scope/deep-context-request; runtime runtime/file-runtime/budget-binding; coding-plans codex-management; subagent fork-isolation/native-context-role. These are test/<name>.test.ts in each package. Add focused receipt/epoch fixtures where needed, and preserve B1 prepared-prefix tests plus final-candidate/summary controls. Never substitute a guessed nonexistent seam prepared.test.ts for the actual prepared-wrappers/model-data/payload-identity files.

Typecheck every changed package/actual consumer and e2e. Exact reachability/acyclic reachable graph with no baseline reseed. Format/runtime carrier changes require fresh phase-owned Gateway/CLI package smoke including actual current-format roundtrip and receipt propagation using fake transports/isolated stores; preserve old artifacts. No installed profile or real credentials.

Report BASE/HEAD, exact type/owner/public API map, retired v1 paths, version migration behavior, local-lifetime versus R3 guarantees, phase counts/receipts/failed intermediate attempts and warnings. Fresh full-range spec/quality review before progression. Do not claim cold calibration, exact physical-attempt accounting, native account authorization, whole-program readiness or additional S/CX completion from these observations.
