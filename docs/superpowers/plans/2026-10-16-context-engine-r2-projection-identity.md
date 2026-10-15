# ContextEngine R2B1 — semantic and payload identity implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use subagent-driven-development or executing-plans. Steps use checkbox syntax for tracking.

**Status:** Ready to execute after R2A fresh specification/quality PASS at `fcea7638a0682fc047427527a7bcf78c42770947`. Root checked the actual prepared APIs, budget/admission/summary consumers and test paths. The phase ledger records the exact subsequent documentation BASE. R2A's reviewed contract names remain ModelBudgetBinding, semantic request surface and outputParameter; no new account/count capability is inferred.

**Goal:** Give every built-in prepared route an independently versioned identity for effective model input and for the actual encoded request, preserve adapter-owned cache semantics, and recompute measurements after output-cap derivation.

**Architecture:** token-meter owns content digests, semantic pricing/prefix primitives and their versions; adapters own effective protocol structure and cache-edit provenance; llm-seam owns the private immutable payload and exact HTTP-body identity. Existing R1C snapshot/freshness and R2A binding evidence remain their respective owners. R2B2 will replace the production usage anchor with exact accepted-request/execution attribution. This unit is not a second calibration or budget engine.

**Tech Stack:** Existing TypeScript/pnpm/Vitest and shared stack-based core-session JSON encoder. No package/registry dependency additions are expected.

**Spec:** ContextEngine redesign/framework and R2A plan. Source proposal `.tmp/context-redesign-20261015/r2b-identity-contracts.md`; source observations pinned to `0ed6db05`. This plan's explicit staging/contract choices supersede the proposal where stated.

## Global Constraints

- Continuous user-authorized R0–R6 execution, one product writer and fresh GPT6.1Sol reviewer; no recursive delegation. Version stays0.1.13-rc.1. No installed profile/account/provider/count/network requests, merge or release.
- Preserve the six route families, raw-option precedence, native order/signatures, all existing output preferences and wrapper/signal/requestScope semantics. Final protocol validators remain R2C/D; one admission-policy activation remains R2E.
- Preserve public `projectionFingerprint` serialization and the standalone legacy meter API. Changes in a built-in projection's hash caused by an explicitly new semantic/pricing version are intentional invalidation, not a reinterpretation of old evidence. Do not relabel v1 hashes as v2.
- v2 content identity proves encoded input equivalence, not account/tenant ownership, native replay authorization, transport reservation or durable acceptance. R2B2 supplies separate execution compatibility and accepted lineage; R3 owns reservations. No speculative account read/hash or credential-bearing descriptor.
- No full payload, per-message digest vector, cache edit manifest or arbitrary options enters logs/persisted context DTOs. Existing scalar event4096-byte bound remains. No session format bump or durable v2 usage writer in this unit.
- Product modules normally150–400 lines/functions<=120; cohesive private leaves, public package entry imports. No giant identity.ts, generic locals bag, fake audit consumers, audit baseline reseed, weakened assertions/timeouts or new skips. Tests/scripts are not decomposition targets. Existing S/CX completion counts do not increase for this work alone.
- Prior full verify:all FAILED and any real new baseline failure remain disclosed. Isolated receipts are not whole-program or live-provider qualification.

## File map and retirement boundary

- token-meter `projection/{types,measure,fingerprint,pricing}.ts`; add cohesive `projection/identity.ts` and a typed SDK-value encoder leaf only if needed. Keep the shared core-session encoder rather than reintroduce recursive clone/stringify/sort. Add v2 identity contracts exported only for actual seam/adapter consumers.
- llm-seam `prepared/{types,payload,fallback,wrappers}.ts`: describe each actual derivative; exact payload digest, typed SDK-command estimate; existing callbacks and guards remain composed. No credentials or retry owner here.
- Actual adapter `context.ts`, `client.ts`, `request/body.ts` for llm-openai/public+subscription, llm-openai-compatible, llm-anthropic, llm-gemini, llm-bedrock. Extract adapter-private cache edits/effective input leaves only where real responsibility requires them.
- Existing consumer owners `core-agent/agent/{budget,admission}.ts` and `compaction/summarizer.ts`: recheck and publish facts for the selected derivative. This integration is inseparable from derivative remeasurement; preserve their current formulas and migrate policy ownership only at R2E. Inspect turn/finalization's exact selected-handle forwarding without pulling R2B2 accepted-lineage work into this unit. summarizer.ts is337lines with a long orchestration function at planning time; extract a cohesive private prepared-summary leaf if the correction would extend that monolith. Its existing private math must still retire at R2E; extraction cannot establish another policy owner.
- New token-meter `test/projection-identity.test.ts`; seam prepared/wrapper coverage; actual adapter `test/prepared.test.ts` plus cache/native fixtures; `e2e/context-corpus.e2e.ts`. Existing deep-context request tests remain required.
- R2B1 retires frozen-initial measurement reuse on derivatives and ambiguous final-payload identity. R2B2 retires owned v1 calibration/restoration/boolean-acceptance plumbing as one unit. Do not create a production v2 anchor alongside the v1 anchor here.

### Task 1: Version effective input identity and immutable encoded payloads

**Consumes:** reviewed R1C request snapshot, stack JSON helpers, immutable PreparedModelRequest; reviewed R2A route/binding evidence; actual final adapter bodies and their current cache transformation code.

**Produces:** versioned semantic identity and payload identity for all built-in routes, safe adapter-owned cache exclusions, versioned semantic pricing units, derivative remeasurement, unchanged actual wire precedence/capabilities.

- [ ] **Step 1: Capture baseline and RED at actual preparation boundaries.**

Before editing, record token-meter projection/checkpoint tests, seam prepared wrappers, all five adapters' prepared tests and the six-route corpus unless an exact source-equivalent receipt already exists. Add literal oracle cases before the implementation. Missing new fields, moving owned-cache prefixes and changed thinking-budget derivatives must fail for their intended reasons; preserve those receipts.

- [ ] **Step 2: Add versioned identities without conflating compatibility.**

Use these small data contracts (readonly properties and validated digest/version strings):

```ts
interface SemanticInputIdentityV2 {
  version: 2;
  schema: 'projected-input-v2';
  pricingVersion: 'projected-pricing-v2';
  bindingId: string; //64 lowercase hex
  shapeId: string;
  semanticId: string;
}
interface PayloadIdentityV2 {
  version: 2;
  kind: 'http-json-body' | 'sdk-command-estimate';
  id: string;
}
// Extend existing facts; do not duplicate the entire unit array.
// ProjectedInputFacts.semanticIdentity?: SemanticInputIdentityV2
// ProjectedInputFacts.units[number].semanticId?: string
// PreparedRequestMeasurement.payloadIdentity?: PayloadIdentityV2
```

Built-in complete/incomplete projections have semantic identities and every unit has a semanticId. Incomplete remote/opaque coverage stays incomplete; a digest is not a token count. Neutral-only custom fallback has no protocol/payload identity. One actual descriptor implementation generates identity and pricing together; no identity implementation copies the mapper into a second independent content pipeline.

Hash UTF-8 `i-harness:projection:v2:<domain>\0` plus stack-canonical data; separate binding/shape/unit/input/prefix-seed/prefix-link domains. bindingId identifies adapter revision, route, effective provider/model selection, not a verified account. shapeId binds effective fixed system/schema, semantic options and native replay policy; units bind ordered role/block/tool IDs/args/results/images/native data/signatures. semanticId binds binding/shape/ordered unit IDs and remote-reference/native compatibility evidence. Preserve real string/array/block distinctions except a recorded adapter cache wrapper described below.

Unknown model-visible final raw fields conservatively affect shape. Explicit generation-only output-cap paths and known transport-only fields are adapter-specific; never blanket-exclude reasoning, thinking, output_config or generationConfig. A shadowed raw value producing the same final input does not need a different semanticId; the existing R1C source/surface revision still captures source changes.

Pricing uses the same effective semantic input after only verified adapter-owned cache normalization. Cache marker bytes remain measured in packet metadata; do not price those generated markers as task text/schema. All v2 units use the named pricing version and independently computed per-unit cost. Since this changes costs and identifies options omitted by the previous shape, derive built-in legacy shapeFingerprint from `projectionFingerprint(['projection-compat-v2', semanticIdentity.shapeId, semanticIdentity.pricingVersion])`. Both semantic shape and pricing version must participate: pricing rotation alone would still permit reuse across reasoning/raw option changes. Existing v1 checkpoints fail matching rather than mix old costs/options with new suffixes. This is an explicit invalidation boundary; the public legacy hash function/ordinary serialization and legacy nonprojected meter stay unchanged. R2B2 will consume semanticId/pricingVersion and sum exact suffix unit costs rather than subtract unlike aggregate totals.

- [ ] **Step 3: Record cache edits where they are made, then normalize only those owned edits.**

Cache application returns adapter-private provenance: adapter/revision, exact inserted paths and values, plus exact representation transforms such as source string→one text block. Produce it at insertion; do not accept user manifests or infer ownership from field spelling. Normalize only matching recorded insertions/wrappers in the actual final candidate; if an expected value/path no longer matches, keep the value identity-bearing or produce explicit incomplete identity, never erase unrelated content. Use iterative owned-data traversal and preserve `__proto__`, arrays and numeric-key behavior.

Anthropic: existing pre-cache body alone is insufficient because cache-off can remove caller-supplied marker fields. Derive from the actual post-policy payload with verified additions undone; pre-existing markers remain content when retained. Generated system/tools/latest-user markers and string wrappers are excluded. Nested tool args/schema fields named cache_control stay untouched. Cache-off current output behavior is unchanged and its resulting input is described honestly.

Responses: annotate only the automatically generated subscription affinity key. Raw/config/request-provided keys remain identity-bearing; a request key is not generated merely because it lands in the same field. Subscription/public routes retain separate namespace/allowlist/store/include behavior. Other routes currently generate no marker: user cachePoint, cachedContent and corresponding raw fields remain identity-bearing. No generic recursive cache-field stripper.

- [ ] **Step 4: Measure and hash the exact derivative sent by the prepared handle.**

Replace createPreparedPayload's one frozen initial input with an adapter `describe(actualBody, actualRequest, ownedSemanticEvidence)` callback. Each original/cap derivative uses its own final body, output facts, input description and packet metrics. Derivatives still originate from the original frozen body and original request intent; repeated cap calls must not cumulatively mutate or drift reasoning settings. Preserve both wrapper APIs and synchronous pretransport guards after asynchronous auth/image work.

HTTP payload ID hashes the exact source-order serialized string that execute receives, including JSON escaping/key order/cache fields; bodyBytes is Buffer.byteLength of that same UTF-8 string. Run semantic description against a representation demonstrably equivalent to that final JSON. If wider input values have existing serialization semantics, lower once from the serialized JSON or a proven equivalent data value; do not invoke mutable accessors/toJSON twice or describe an earlier neutral request.

For Bedrock, the actual Converse command object remains the transport input. Build a versioned typed command-data representation that distinguishes Uint8Array/Buffer byte content from ordinary JSON arrays and lookalike marker objects. Tag all node kinds or otherwise prove collision freedom; a single reserved user-visible object key is insufficient. Hash/count this representation as sdk-command-estimate, never HTTP-body bytes, header bytes or proven AWS base64 encoding. Preserve actual command objects and SDK controls.

Cap-only public Responses/Chat/Gemini/Bedrock changes may keep semantic identity only where the effective model input/semantic options are unchanged; payload identity changes. Managed Anthropic/Bedrock thinking-budget changes must change semantic shape and be repriced. Unsupported subscription cap changes preserve actual payload identity while actual request policy remains distinct in R1C surface/output facts. No old admission certificate is carried across a changed derivative.

Inseparable consumer correction: the initial estimate may select **one** derivative using today's formula and cap preference. The existing main budget owner then re-estimates that exact candidate with its same calibration owner and builds fit/coverage/components/identity/pressure/remaining-budget facts from its final measurement, cap support/effective cap/minimum. Reapply today's unchanged fit formula; failure follows existing compact/blocked paths. Feed this selected measurement into recovery admission and telemetry too, including recovery-authorized reassessment. Do not add a second assessor, recursive cap-convergence loop or reuse an initial fit certificate. A provisional shape mismatch may conservatively retire an old anchor; disclose that until R2B2 fixes lifecycle attribution.

Summary similarly retains its current5% margin/preferences/floor/splitting policy, but rechecks the selected derivative's input, coverage/reserve/floor and room before reporting or sending. Split/reduction progress compares final candidates on both sides; costs for rejected input refer to the candidate actually rejected. Final failure follows existing bounded split/block handling without spending a provider call. If this integration cannot pass review, derivative remeasurement remains unactivated; do not knowingly assess A, execute B and record B.

- [ ] **Step 5: Exercise independent literal oracles and actual consumers.**

Required cases:

1. Literal Anthropic user string `中` versus its generated text-block/cache wrapper: equal semantic unit only with verified ownership, different wire identity/bytes; same wrapper supplied by caller stays distinct.
2. Moving a generated cache breakpoint with a newly appended user message preserves prior semantic prefix and prior unit prices; changing earlier text invalidates. Schema/system markers receive the same control. Existing user marker TTL/value changes remain identity-bearing.
3. Tool input/schema keys cache_control/cachePoint/cachedContent change semantic identity as ordinary data. Top-level Gemini cachedContent remains a remote reference with incomplete coverage.
4. Literal role/block order/tool ID/args/result/image/native signature changes affect identity; complete parallel-call groups preserve protocol ordering. No common reordering imposed across routes.
5. Temperature, reasoning effort, thinking budget, semantic raw options, schema and actual model changes invalidate shape/input. Cap64→32 alone preserves semantic identity when truthful; an enabled managed thinking budget changes with cap and therefore changes identity.
6. Exact HTTP string `{"x":"中"}` is11 UTF-8 bytes. `{"b":2,"a":1}` and `{"a":1,"b":2}` share canonical semantic content but have different payload IDs. Hash domains cannot collide by using the same literal string in another domain.
7. Bedrock bytes[1,2] differ from JSON array[1,2] and a user object imitating any encoding marker. Captured sdkCommandBytesEstimate cannot satisfy an HTTP-byte assertion.
8. Caller mutation after prepare, original send, derivative send, repeated cap restore and guard/wait/retry wrappers all use frozen own body/facts; once-only hooks and no stale send remain.
9. Legacy v1 persisted checkpoint cannot calibrate a new semantic-pricing revision; ordinary legacy serializer/fingerprint API bytes remain unchanged. This unit creates no durable v2 anchor.
10. Built-in actual deep2000/6000 JSON request preparation/identity/transport remains stack-safe; neutral fallback still executes its supported-data contract without fictitious wire identity. Do not claim all provider/SDK serialization depths from one route's pass.
11. Six route actual wire fixtures prove unchanged caller/raw precedence, subscription cap stripping and Anthropic/Gemini/Bedrock thinking behavior. ModelBudgetBinding and identity data never enter provider JSON.
12. Prepare/getters remain network/auth/count-free; only explicit stream calls reach controlled fake transports. No live providers or account operations.
13. Main window100/margin0: provisional calibrated90+cap10 fits, but selected derivative repriced105 never sends. Final incomplete derivative cannot fit. Snapshot, recovery/telemetry, summary callback and accepted recording all reference selected facts. A reasoning option change within the same pricing version invalidates legacy calibration. Summary final-shape failure follows its existing bounded split/block path without a hidden call.

Expected fixtures must be literal oracles rather than the same mapper/hasher used to produce the value. Inspect that a deliberately wrong owned path/cache normalization or frozen derivative fails the tests; do not claim mutation testing without running it.

- [ ] **Step 6: Run the affected gate, report retirement and commit the reviewed unit.**

Run suites sequentially with actual log/exit receipts and maxWorkers2/minWorkers1: token-meter full; llm-seam full; five adapters full; core-session serialization/context selected controls; core-agent owned-budget/context-usage/deep-context-request/compaction-binding; compaction summarizer/context-efficiency; six-route corpus. Inspect actual filenames before command execution. Reuse unchanged valid receipts; extend/repeat only after a relevant failure/change.

Selected filenames verified atfcea7638: core-session `test/json-data.test.ts`; core-agent `test/owned-budget.test.ts`, `test/context-usage.test.ts`, `test/deep-context-request.test.ts`, `test/compaction-binding.test.ts`; compaction `test/summarizer.test.ts`, `test/summarizer-prefix.test.ts`, `test/context-efficiency.test.ts`; every adapter has `test/prepared.test.ts`. Baseline checkpoint/projection and seam wrappers use their existing named files. Add new identity cases in their actual package test tree, not a fake public consumer.

Typecheck token-meter, seam, all five adapters, context-engine, core-agent, compaction, provider, provider-runtime, session-executor and e2e. Run exact reachability and application-reachable acyclic workspace graph. No fake consumers/baseline changes. Since no package/graph change is expected, reuse current isolated package inclusion proof with an explicit reason; refresh a phase-owned gateway/CLI probe if source/runtime linkage or graph changed. R6 still owns all-route packaged/deep durable qualification.

Report BASE/HEAD, exact exported contracts, module sizes/owners, independent RED/GREEN receipts, v1→v2 pricing invalidation, original/derivative wire evidence and any incomplete coverage. Preserve all historical failed baseline/full gate evidence. Fresh spec/quality review required; after corrections continue directly to R2B2 exact accepted-usage attribution and versioned persistence, not a release or task stop.
