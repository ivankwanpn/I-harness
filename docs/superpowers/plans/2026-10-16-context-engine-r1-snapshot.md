# ContextEngine R1C — immutable snapshot and actual request ownership implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use subagent-driven-development or executing-plans to implement this plan task-by-task. Steps use checkbox syntax for tracking.

**Goal:** Capture one immutable model-visible context/request surface, use it for actual core-agent preparation, and use the same identities for live/cold freshness without provider work on reads.

**Architecture:** core-session remains the only conversation fold and derives source/branch/protection facts. A small new context-engine package owns validated snapshot capture and domain-separated revisions. core-agent retains its current budget/recovery decisions until R2/R3, but supplies those owners with captured evidence instead of independently sampling changing history/getters.

**Tech Stack:** Existing TypeScript ESM workspace, Node 24, pnpm, Vitest. No new third-party dependency.

**Spec:** `docs/superpowers/specs/2026-10-15-context-engine-redesign.md`, `2026-10-15-context-engine-framework.md`, `2026-10-15-context-engine-r1-contracts.md`.

**Reviewed prerequisite:** R1B commit `4d09ed4fae34db85d607a4ec467e0770a9924922`, fresh spec/quality PASS,691 focused tests. Read `docs/research/2026-10-16-context-engine-r1b-verification.md`; its disclosed historical baseline gap and previous whole-program failure remain.

## Global Constraints

- Execute only after R1B acceptance/provenance/persistence has passed its independent gate. Read its final report/API before edits; never work from a concurrent unreviewed product state.
- User authorized continuous R0–R6 execution; all delegated implementers/reviewers use GPT6.1Sol, one product writer, no recursive agents.
- Product version remains0.1.13-rc.1; current session format3 remains. No live provider, installed profile, unrelated worktree, merge or release action.
- Preserve six routes, ordered native sidecars/images, declared child model ownership, dynamic binding/schema/effort accessors, controls/requestScope reference identity, existing budget formula/calibration limits, retry/Stop/dispatch/checkpoint ownership.
- No secondary raw log, semantic fold, inbox, scheduler, budget assessor or engine factory without a real consumer. No concrete adapter imports from context-engine and no core-session dependency on context-engine/llm-seam.
- Source/provenance does not authorize execution; protected inputs are continuity anchors, not fresh authority. Failed/unaccepted model observations remain audit-only under R1B.
- Production modules normally150–400 lines/functions<=120; extract coherent responsibilities rather than moving closures/all-local bags. Tests/tool scripts are outside decomposition targets.
- R1C creates the snapshot boundary, not a second compaction implementation or a claim of full S20/CX1 decomposition. R1D selects whole groups and introduces positional replacement; R3 handles transactional publication.
- Keep original historical verify:all FAILED visible. Focused receipts establish this unit only; do not weaken assertions/timeouts, add skips or reseed audit baselines.

## File ownership

Create `packages/context-engine/{package.json,tsconfig.json,README.md,src/index.ts}` plus `src/contracts/snapshot.ts`, `src/snapshot/{data,build,revision,protected}.ts`, and focused tests `test/{snapshot,revision,protection}.test.ts`. These files respectively own public DTOs, safe data capture, composition, identity and protection mapping. No empty future admission/transaction modules.

core-session: modify `conversation/{project,render,types}.ts` and public exports; create a cohesive `conversation/state.ts` for effective archive/turn/branch/rewrite/pending metadata, and a narrow `conversation/payload.ts` if source-safe payload access needs its own responsibility. Extend `events/context.ts` only for strict scalar identity fields. Tests: new `test/conversation-state.test.ts`, existing conversation/image/rewind/compaction fixtures, and context-event validation tests.

core-agent: modify `agent/{create,context,step-input,admission,budget,finalization,turn}.ts` and types only as needed at their current seams. Extract captured-surface assembly/freshness to `agent/request-snapshot.ts` if context.ts would otherwise accumulate another owner. Extend `test/{owned-budget,context-update,context-usage,main-response-fence,request-scope,step-inputs}.test.ts`; add `test/context-snapshot.test.ts` for held-await and dynamic-surface cases.

session-executor: extract observation-only context reading from `service.ts` into `service/context-state.ts` with narrow live/snapshot/metadata readers, preserving live-owner rechecks after each await. This is an actual reused S20 responsibility, not completion credit for service as a whole. Extend `test/{cold-state-inspection,inherited-context-budget}.test.ts`.

Update core-agent and session-executor manifests, pnpm-lock importer/link records, workspace test project registration only if not discovered from existing globs. New package manifest runtime dependency core-session; llm-seam is declared but imports are type-only. Check actual CLI/gateway package inclusion through existing builders. Keep leaf functions reachable through public package entries; no deep cross-package imports or audit exemption.

### Task 1: Publish captured snapshots and replace request/read freshness consumers

**Consumes:** R1B `projectConversation` accepted exchanges/provenance and existing `renderConversation`, the format3 acceptance fence/seed contracts, existing `PreparedModelRequest`, immutable prepared cap derivatives, `BudgetRead`/`RequestBudgetSnapshot`, and the current core-agent budget/recovery owner.

**Produces:** A production-used `@i-harness/context-engine` snapshot/coordinate API; one request-surface capture per candidate; scalar persisted identity and historical observation semantics; real main/child and cold UI consumers.

- [ ] **Step 1: Define the exact public capture contract and independent RED cases.**

```ts
type ContextRevision = string; // versioned, domain-separated lowercase64-hex digest
type ImmutableJson = null | boolean | number | string |
  readonly ImmutableJson[] | { readonly [key: string]: ImmutableJson };
type Captured<T> = unknown extends T ? ImmutableJson :
  T extends readonly (infer E)[] ? readonly Captured<E>[] :
  T extends object ? { readonly [K in keyof T]: Captured<T[K]> } : T;
interface ContextCoordinates {
  readonly ownerSessionId: string;
  readonly archive: { readonly eventCount: number; readonly lastSeq?: number };
  readonly semanticRevision: ContextRevision;
  readonly protectionRevision: ContextRevision;
  readonly branchId: ContextRevision;
  readonly contextEpoch: ContextRevision;
}
interface ContextProtection {
  readonly itemIds: readonly string[];
  readonly sourceIds: readonly string[];
  readonly pendingInputIds: readonly string[];
  readonly unsettledDelegationIds: readonly string[];
}
interface RequestSurfaceInput {
  systemPrompt: string;
  tools: readonly ToolSchema[];
  reasoningEffort?: ReasoningEffort;
  maxOutputTokens?: number;
  contextWindow?: number;
  binding?: ContextBindingMetadata;
}
interface CapturedRequestSurface {
  readonly systemPrompt: string;
  readonly tools: readonly Captured<ToolSchema>[];
  readonly reasoningEffort?: ReasoningEffort;
  readonly maxOutputTokens?: number;
  readonly contextWindow?: number;
  readonly binding?: Captured<ContextBindingMetadata>;
}
interface ContextSnapshot {
  readonly version: 1;
  readonly coordinates: ContextCoordinates;
  readonly conversation: Captured<ConversationProjection>;
  readonly protection: ContextProtection;
  readonly surface: CapturedRequestSurface;
  readonly surfaceRevision: ContextRevision;
}
type ContextCapture = { kind: 'captured'; snapshot: ContextSnapshot } |
  { kind: 'unsupported'; code: 'CONTEXT_SNAPSHOT_UNSUPPORTED' | 'CONTEXT_STATE_AMBIGUOUS';
    component: 'conversation' | 'surface' | 'protection'; sourceIds: readonly string[] };
// Owned input types can retain existing unknown schema/args types; capture validates them.
declare function captureContextSnapshot(session: Session, input: {
  ownerSessionId: string; surface: RequestSurfaceInput
}): ContextCapture;
declare function readContextCoordinates(session: Session, input: { ownerSessionId: string }):
  { kind: 'available'; coordinates: ContextCoordinates; observationRevision: ContextRevision } |
  Extract<ContextCapture, { kind: 'unsupported' }>;
```

`RequestSurfaceInput` uses existing mutable seam ToolSchema/ReasoningEffort and core-session ContextBindingMetadata contracts with the same optional fields as the captured surface; it contains no callbacks. `Captured<ConversationProjection>` narrows unknown args to immutable JSON and keeps readonly native/message structure; do not claim arbitrary unknown objects are frozen. Add type-level assignment checks and compile consumers rather than scattering unsafe casts.

Use literal source records/native payloads and expected hashes or equality/inequality relations independent of the implementation. Example test construction:

```ts
const source = createSession();
append(source, { type: 'user/message', text: 'retain this request' });
append(source, { type: 'assistant/message', text: 'answer' });
const surface = { systemPrompt: 'system', tools: [] };
const result = captureContextSnapshot(source, { ownerSessionId: 'owner-A', surface });
expect(result.kind).toBe('captured');
if (result.kind !== 'captured') throw new Error('fixture must capture');
const before = result.snapshot;
append(source, { type: 'model/activity', version: 1, ts: 1,
  activity: { requestId: 'request-A', phase: 'connecting', startedAt: 1,
    waitingFor: 'first-response' } });
const after = readContextCoordinates(source, { ownerSessionId: 'owner-A' });
expect(after.kind).toBe('available');
if (after.kind !== 'available') throw new Error('fixture must read');
expect(after.coordinates.semanticRevision).toBe(before.coordinates.semanticRevision);
expect(after.coordinates.archive.eventCount).toBeGreaterThan(before.coordinates.archive.eventCount);
```

This valid model/activity fixture proves archive-only appends do not invalidate input. Add initial RED for missing API, then behavior-specific RED when a fixture exercises a faulty intermediate implementation. No assertion that simply regenerates expected JSON with the production serializer.

- [ ] **Step 2: Implement safe supported-data capture at the existing source fold.**

Use a descriptor-based explicit-stack clone/validation walk. Accept null/string/boolean/lossless finite numbers, dense arrays and plain/null-prototype own enumerable data records. Omit undefined record fields consistently. Reject undefined array entries, holes, extra array properties, cycles, symbols/nonenumerable properties, accessors, functions/toJSON methods, bigint, -0/nonlossless numbers and nonplain prototypes. Inspect descriptors before reading unknown values. Preserve own `__proto__` via defineProperty; retain a noncallable own toJSON as data. Never invoke arbitrary getters/toJSON, freeze original Session/events, or claim arbitrary Proxy inspection is side-effect-free. Detect nested plain→class→plain graphs as unsupported without changing them.

Factor supported-data cloning/canonical encoding so keys sort for identity, arrays/order/native strings remain exact, and publication recursively freezes newly owned nodes only. Canonicalization never uses JSON.stringify on the original unknown graph. Rendering from captured data returns fresh adapter-owned containers using core-session's single renderer; the adapter cannot mutate the snapshot.

Preflight must happen before core-session's toolResultText stringification or container-copy Object.entries. Add a narrow optional source-payload capture seam to the existing projector, not a second fold. A cohesive payload reader inspects selected event property's descriptor before passing its data value and ConversationSourceRef to the engine's clone function. Call it before native arrays/images/args/output are dereferenced. Also use descriptor-safe outcome-field reads in the legacy/accepted metadata path before inspecting unknown output.code/replay; a rejected accessor must never execute merely to classify an outcome. Default legacy deriveMessages behavior remains source-compatible; capture mode validates only payload contributing to the requested active view. Invisible failed/shadowed raw data must not be copied merely to produce a snapshot. For pruned output, validate its actually retained preview and image component, not an excluded full raw result. Preserve R1B acceptance and legacy ordering.

Unsupported captured data returns the typed union; the actual core-agent request path throws its bounded error before prepare/transport. No automatic opaque fallback. JSON-data custom stream-only clients retain seam's existing neutral-only measurement. Errors/logs expose component/code/source IDs, never payload/native signatures/credentials or arbitrary property names.

- [ ] **Step 3: Derive protection and identities once from the same semantic projection.**

core-session's pure state helper takes the Session plus already-built projection, uses the existing rewind visibility rules, and returns archive cursor, effective branch/rewrite marker descriptors, protected input/item/source IDs, pending mailbox IDs and known unsettled delegation IDs. It does not create scheduling/claim authority. Derive effective owner-local open turn from turn/start/end outside rewound and inherited seed regions. Read both turn/start and turn/end from the effective branch even when their content seq is hidden by compaction; the pinned visibility.lifecycle predicate does not currently retain turn/end, so blindly using that predicate would falsely reopen a closed turn. Malformed ambiguous lifecycle yields CONTEXT_STATE_AMBIGUOUS rather than invented anchors.

During the active turn protect its exact initial input and subsequent input/steering items with image/admission companions, including unknown/plugin input for continuity without changing provenance. Protect applicable session-scope instruction items and genuinely open/unresolved exchanges. Existing pending admissions/cancellations/promotions drive protection even before a message is visible; promotion without its matching message stays conservative. Known subagent start/end facts are evidence only; R4 later owns delivery disposition. Never infer an active child turn from parent seed. An idle session does not fabricate a current human anchor. A user anchor plus50closed exchanges plus1open exchange protects the anchor/open bundle, leaving the50closed items eligible for R1D.

```text
semanticRevision = H(domain, owner, ordered visible typed items+source/acceptance/provenance/native/media)
protectionRevision = H(domain, owner, protected IDs+pending mailbox states+unsettled evidence)
branchId = H(domain, owner, effective rewind/cut lineage)
contextEpoch = H(domain, owner, active summary/reset/prune/branch rewrite lineage)
surfaceRevision = H(domain, detached system/tools/effort/window/output preference/binding metadata)
observationRevision = H(domain, owner, semanticRevision, protectionRevision, branchId, contextEpoch)
```

Do not include archiveEventCount/throughSeq/telemetry in semantic identity. Hash model-visible item data and explicitly accepted structural identity; omit audit-only unaccepted fragments even if the projector exposes their empty-message metadata. Unsettled effect evidence belongs in protection. Same text with a newly accepted source changes semantic identity. Budget/usage append changes cursor only. Pending input and turn/end can change protection alone. Use stable per-Agent requestSessionId as owner for standalone agents; no second anonymous ID in budget/context. Branch/epoch are replay-derived digests, not durable lease generations or result-promotion authorization. Binding identityCoverage remains partial unless the existing producer proves complete.

Coordinate reads reuse the same validated projection/state helpers without surface getters/provider work; synchronous rewalks are an explicit initial cost, not a claimed incremental optimization. No length-only mutable-session cache. Cold replay with stable owner reproduces keys. Capture itself must not project twice.

- [ ] **Step 4: Replace actual core-agent request preparation and freshness with the capture.**

After hooks/claim/logical-step opening, refresh inherited binding, sample model/private binding references once, sample the pure request surface once, and synchronously capture context. Build the LLMRequest only from that snapshot plus original live controls (signal/requestScope/retryOutput/sessionId/promptCache/callbacks). Keep requestScope reference identity and model/session attribution intact.

```ts
const captured = captureCandidate(); // one owned surface + projection, selected concrete client
const initial = await prepareModelRequest(captured.model, captured.request);
assertCandidateCurrent(captured);    // new pure sample validates; never rebuilds request in place
const assessed = ownedBudget.assess(initial, captured.evidence);
await checkpointOrRecovery();
assertCandidateCurrent(captured);
return { ...assessed, validateBeforeTransport: () => {
  signal?.throwIfAborted();
  assertCandidateCurrent(captured);
  validateExistingRecovery();
} };
```

The helper names above describe the unit's private seams; implement them explicitly in request-snapshot/admission using existing recovery/checkpoint APIs, with narrow typed inputs. Validate after prepare, recovery, compaction and flush awaits, and through existing prepared execution-wrapper hook immediately before physical send. Compare semantic/protection/branch/epoch/surface digests and concrete model/binding identities; archive-only append is harmless. A separately sampled fresh surface is validation only. Preserve max3local stale rebuilds, one hooks/inbox claim per logical step, R1B attempt IDs and no tool effects before accepted flush. Stale after physical send never grants replay permission.

Live modelToolSchemas/systemPrompt/maxOutput/effort and inherited descriptor updates remain effective at the next permitted boundary; do not spread deps at construction and freeze callbacks forever. Ensure captured metadata is used for calibration after a response even if live binding changes during streaming. Existing budget/admission formula and recovery limits stay single-owned. Summary requestShape/summary guard retain their existing R3 boundary and cannot claim to use the new main snapshot unless they actually do.

- [ ] **Step 5: Persist honest scalar request identity and retain historical readings.**

Extend RequestBudgetSnapshot with this exact optional strict-field shape, leaving legacy records readable and the4096-byte context-event gate intact:

```ts
requestContext?: { version: 1; semanticRevision: string; protectionRevision: string;
  branchId: string; contextEpoch: string; surfaceRevision: string };
postResponseContextRevision?: string;
```

All identity strings must match lowercase64-hex. postResponseContextRevision requires requestContext; reject partial/extra fields and oversized records. No prompt/source list/native payload in persistence facts.

assess stores the captured request IDs/metadata/projectionRevision/neutralFingerprint belonging to the measured input. An output-cap derivative preserves captured input identity. record uses captured request metadata and actual measurement/accepted usage; it never attributes old usage using current live metadata. After acceptance, keep all measured-input fields/requestContext unchanged, set admission unavailable with the existing accepted-output explanation, and optionally save the pure post-response observation digest. Failure to capture that digest cannot revoke acceptance or drop real usage.

read retains known historical measurements as `BudgetRead {kind:'ready',snapshot:{...old,admission:'unavailable',reason}}` when identity/binding/surface/turn protection changes. contextStateFromBudget already exposes unavailable with snapshot. Ready means readable facts, never authorization to send. A read never replaces old IDs with new current IDs or sets a historical observation back to fit. Current recovery can conservatively overlay status; pressure used as a current decision must not be certified from stale unavailable data.

Cold context-state uses the same pure coordinates and strict saved fields; preserve last-input facts on mismatch. A saved fit needs current surface/binding evidence as well, which existing metadata-only cold service cannot generally supply; withhold fit rather than constructing an assembly/getting auth/preparing a request. Legacy missing requestContext stays historically readable but cannot manufacture new freshness, especially because its old neutralFingerprint could have been overwritten after output. Preserve live main/child rechecks after every cold await.

- [ ] **Step 6: Run focused behavioral, consumer, graph and package verification.**

New tests: mutate nested args/native/signatures/images/schema after capture and after deriving an adapter copy; captured request unchanged and originals not frozen. Dense JSON/property edge cases and unsupported accessor counters remain zero. Same-text new accepted source, telemetry-only append, pending-only protection, turn/end, rewind/prune, explicit owner cold/live equality, independent parent/child snapshots,50closed-tool-step turn protection and inherited seed lifecycle all have literal expected assertions.

Held prepare/execution/flush fixtures append pending input, rewind/prune or change getters/effort/binding and prove zero stale physical sends; hooks and claim remain once. No-end/retry acceptance from R1B stays unchanged. UI live/cold reads prove prepare/auth/resolve/network counters unchanged and historical facts retained with unavailable admission. Six-route corpus keeps actual request capture/native order and original/derived handle mutation checks.

Run these commands sequentially; redirect each run to a distinct SDD evidence log and capture LASTEXITCODE immediately:

```powershell
pnpm --filter @i-harness/context-engine exec vitest run --maxWorkers=2 --minWorkers=1
pnpm --filter @i-harness/core-session exec vitest run --maxWorkers=2 --minWorkers=1
pnpm --filter @i-harness/core-agent exec vitest run test/context-snapshot.test.ts test/owned-budget.test.ts test/context-update.test.ts test/context-usage.test.ts test/compaction-binding.test.ts test/projection-rewrite.test.ts test/prefix-continuity.test.ts test/main-response-fence.test.ts test/request-scope.test.ts test/step-inputs.test.ts test/context-recovery.test.ts test/stop-continuation.test.ts test/model-policies.test.ts test/accepted-exchange.test.ts --maxWorkers=2 --minWorkers=1
pnpm --filter @i-harness/session-executor exec vitest run test/cold-state-inspection.test.ts test/inherited-context-budget.test.ts --maxWorkers=2 --minWorkers=1
pnpm --filter @i-harness/sdk exec vitest run test/admitted-context.test.ts --maxWorkers=2 --minWorkers=1
pnpm --filter @i-harness/desktop-gateway exec vitest run test/usage-host.test.ts --maxWorkers=2 --minWorkers=1
pnpm --filter @i-harness/subagent exec vitest run test/child.test.ts test/task-control.test.ts test/fork-isolation.test.ts test/code-mode.test.ts --maxWorkers=2 --minWorkers=1
pnpm exec vitest run e2e/context-corpus.e2e.ts --config e2e/vitest.config.ts --maxWorkers=2 --minWorkers=1
pnpm --filter @i-harness/context-engine --filter @i-harness/core-session --filter @i-harness/core-agent --filter @i-harness/session-executor --filter @i-harness/sdk --filter @i-harness/desktop-gateway --filter @i-harness/subagent typecheck
pnpm verify:reachability
```

The pinned subagent checkout has no followup.test.ts: resident followup coverage belongs to child/task-control/task-protocol suites; include task-protocol if its call path changes. Verify new R1B filenames against its final report. Run a manifest-based acyclic/application-reachable graph check equivalent to scripts/qualification/wsl-product/package-graph.mjs, writing only this phase's evidence, not overwriting its hard-coded old report path. Do not repeat unchanged suites after a tiny fix unless it changes their concern.

Use `pnpm install --offline --ignore-scripts` only for workspace linking if required; inspect lock changes and forbid registry dependency drift. Build isolated gateway and CLI artifacts with `node packages/desktop/scripts/build-gateway.mjs --out .tmp/context-r1c-gateway` and `node scripts/build-dist.mjs --out .tmp/context-r1c-cli`; the explicit target paths must be new or belong solely to this phase and resolve beneath D:/I-harness-main before any removal/rebuild. Gateway must contain node_modules/@i-harness/context-engine/package.json and src/index.ts, and a smoke module inside that gateway must import the public snapshot API using its own node_modules/tsx runtime. CLI smoke is `node scripts/verify-dist.mjs --out .tmp/context-r1c-cli`. Preserve prior release artifacts. These are isolated outputs, not installed app changes. Record exact commands, exit receipts, counts, limitations and unexpected warning noise in the SDD evidence directory. Whole fixed-HEAD qualification remains R6.

- [ ] **Step 7: Commit and independent task review.**

Commit only the task's explicit product/tests/manifests/docs. Record changed API/file responsibilities, RED/GREEN, graph/reachability and packaging evidence, previous whole-suite failure, and remaining R1D/R2+ limits. Root creates a full BASE→HEAD review package for a fresh GPT6.1Sol task review. Fix Important/Critical findings with new receipts and scoped re-review. S20/CX completion counts remain unchanged.
