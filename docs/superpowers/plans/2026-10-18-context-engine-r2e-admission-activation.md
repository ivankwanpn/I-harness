# R2E — shared admission and durable pressure policy implementation plan

**Accepted2026-10-18:** connected task through9fb933f69627b015c086472bd2533e7ff7c8e0f2 after fresh full-range review and two original-reviewer scoped correction rounds. See [verification and retained limits](../../research/2026-10-18-context-engine-r2e-verification.md). R4/R5/R6 and release remain pending.

> **For agentic workers:** REQUIRED SUB-SKILL: Use subagent-driven-development for one implementation writer and a fresh task review. Steps use checkbox syntax. No product work before root's executable-contract self-review is recorded.

**Goal:** Replace the remaining main/summary/auxiliary budget calculations with one actual final-candidate decision and durable automatic-reduction policy, preserving protocol-specific validation and F4 execution ownership.

**Architecture:** ContextEngine owns pure capacity and pressure decisions; token-meter owns estimates/calibration; adapters own final encoding/validation; the existing F1 document owns versioned observations and soft-reduction facts. Existing C3 private candidate/publication and F4 generation/terminal capabilities remain the only paths to replacement or physical work. Every real purpose switches together; no shadow assessor or parallel writer ships.

**Tech Stack:** Existing TypeScript ESM workspace, Node24.15.0, Vitest/TypeScript, managed JSONL journal and current Gateway/CLI build/copy tools. No new external dependency.

**Spec:** [redesign](../specs/2026-10-15-context-engine-redesign.md), [framework](../specs/2026-10-15-context-engine-framework.md), [approved policy](../specs/2026-10-18-context-engine-admission-policy.md), [actual-owner rebase](../../research/2026-10-18-context-engine-r2e-post-c3-rebase.md).

**Starting state:** accepted F4 producte82a26b0 and documentation checkpoint80fea9a86721e81e113f5b285c7725a9f29bc36b. Task1 was dispatched from plan commit221051b2630de429038fe04900122e757f55711d. That commit was pushed and independently confirmed by remote ref after the earlier connection failures. This plan is not implementation completion.

## Global constraints

- Root writes documents/evidence/rulings only. One fresh GPT6.1Sol/high implementer, fresh same-model review; no recursive agents or extra research seats.
- Existing branch/workspace/version0.1.13-rc.1; no release, merge, installed profile/account or live provider/count request.
- Preserve all six routes and their native state: public/subscription Responses, compatible Chat, Messages, Gemini and Bedrock. No provider-name shortcut, universal window/cap assumption or weakened final validation.
- One existing F1 writer and derived index. No new raw log, spend store, authority sidecar, fake Session or generic guarded-write escape.
- F4 bounds, origin, selected-client/terminal provenance, original clocks, exact captures and conservative unknown settlement remain unchanged. Pure assessment spends0attempts and performs0auth/network/tools.
- Original human input, accepted exchanges and executed tools remain truthful. Reduction cannot replay effects or discard the protected current input/open exchange.
- Usually150–400line product leaves and<=120line functions; use actual public package boundaries. Tests/scripts are not decomposition targets. No fake consumer, audit baseline reseed or allowlist change.
- E-DEP-01: direct workspace:* dependencies on the existing ContextEngine public owner are permitted for guard-approval, session-title and provider-runtime. Keep the graph acyclic and update only necessary tracked lockfile importer rows; no new external package, unrelated resolution change or façade introduced merely to hide a real dependency. The task brief's generic dependency prohibition is narrowed by this ruling.
- E-INDEX-01: a measured new long-growth regression may be repaired by reusing the existing private structural index for its exact registered managed Session view. Existing stage/install commits owned events and index synchronously. The lookup remains internal, candidate staging remains noncommitting, and raw/mutable/copied/wrapped views retain full source validation. Preserve payload capture, atomic visibility and final freshness checks. This is E regression repair, not broad R6 scaling completion; the original30s growth controls must pass without timeout inflation.
- Preserve source-timed failures/warnings, renderer failure and dynamic-TS limitations. F4-M1 repeated history scans stays R6; general detached semantic import bootstrap stays R4B.

## One connected task and actual file ownership

This activation is one task: its pure formulas, real callers, private derivative handling, durable policy and observations must agree. Intermediate commits are allowed; none is a separate global-admission completion.

| Responsibility | Existing owner to modify | Cohesive new leaves when needed |
| --- | --- | --- |
| Sourced capacity and output intent | token-meter/src/binding-evidence.ts; llm-seam/src/binding.ts; provider/src/catalog/context.ts; provider-runtime/src/selection/metadata.ts and binding.ts | Small evidence/capacity contracts beside existing owners. |
| Shared pure assessment | context-engine/src/contracts/assessment.ts and admission/assess.ts | contracts/policy.ts; admission/capacity.ts, pressure.ts, output-selection.ts, observation.ts. |
| Actual final validation/derivative | llm-seam/src/prepared/payload.ts, validation.ts, wrappers.ts; real adapter request validators/context producers | Narrow private provisional-cap state beside prepared owner, only if required by a genuine validator upper bound. |
| Main calibration/observation facade | core-agent/src/agent/budget.ts, admission.ts, context.ts and request-snapshot.ts | Retain narrow calibration/freshness owner; remove its duplicate decision math. |
| Summary and exact reduction | compaction/src/prepared-summary.ts, config.ts, summary/port.ts; core-agent/src/agent/context-reduction/composition.ts and bridge.ts; context-engine/src/reduction/contracts.ts and proposal.ts | Shared decision adapter plus pure progress/soft-policy leaves, without another reducer. |
| Soft policy facts and current index | core-session/src/events and conversation validation/index; existing persistence F1 capture/group owners | events/soft-reduction.ts, conversation/soft-reduction.ts and narrow closed capture family. |
| Versioned observation | core-session/src/events/context.ts, context-state.ts, projection/context.ts and public exports; actual SDK/Gateway safe readers; desktop/src/main/runtime-diagnostics.ts | Browser-safe scalar admission DTO/codec leaf, distinct from Node execution authority. |
| Auxiliary purposes | guard-approval/src/guardian/isolated-reviewer.ts and reviewer composition; session-title/src/index.ts and execution.ts; provider-runtime/src/video-audio.ts | Purpose adapters to the same assessor, preserving existing result parsing and F4 owners. |
| Actual versioned readers | core-session/src serialization, session-persistence/src format/journal/upgrade/seed, session-query/src/file-backed/inspection.ts and index-refresh.ts | Extend existing format registry and explicit readers, no second format detector. |

Paths in the table are under packages/. Read actual files before editing; names are responsibility boundaries, not permission to create empty exports. Retire an old owner when its consumer switches.

## Frozen pure decision contract

Use these semantic unions as the canonical interface; combine names with existing exported types without a second numeric policy.

~~~ts
type AdmissionPurpose = 'main' | 'recovery' | 'summary' | 'approval' | 'title' | 'media';
type CapacityDomain = 'shared-context' | 'input-only';
type UnknownReason = 'unconfigured' | 'coupling-unverified' | 'output-unbounded'
  | 'token-cost-unavailable' | 'remote-input-unavailable' | 'protocol-unverified'
  | 'body-limit-unverified' | 'stale';
type UnknownFact = { kind: 'unknown'; reason: UnknownReason };
type Sourced<T> = { kind: 'known'; value: T; sourceId: string } | UnknownFact;
type Estimate = { kind: 'estimated'; value: number;
  source: 'projected-heuristic' | 'provider-anchor-plus-projection' | 'neutral-only' } | UnknownFact;
type Dimension = 'context' | 'input' | 'output' | 'http-bytes' | 'protocol';
type DimensionResult = { dimension: Dimension; state: 'pass' | 'fail' | 'unchecked';
  actual?: number; limit?: number; sourceId?: string };
type Pressure = { kind: 'known'; basis: 'shared-context' | 'input-only' | 'legacy-shared-assumption';
  input: number; inputBudget: number; trigger: number; target: number;
  hardFits: boolean; softNeeded: boolean; targetReady: boolean }
  | { kind: 'unavailable'; reason: UnknownReason };
type AdmissionDisposition = 'admit' | 'compatibility' | 'reduce' | 'blocked';
interface CapacityInput {
  purpose: AdmissionPurpose;
  estimate: Estimate;
  limits: import('@i-harness/token-meter').ModelLimits;
  capacityDomain: Sourced<CapacityDomain>;
  output: { capSupport: 'supported' | 'unsupported' | 'unknown';
    parameter: 'required' | 'optional' | 'unsupported' | 'unknown';
    effectiveCap?: number; minimumCap: number; explicitUnsupportedAllowance?: number };
  packet: { kind: 'http-json-body' | 'sdk-command-estimate' | 'audio-json-body'
    | 'neutral-envelope-estimate'; bytes?: number };
  policy: { safetyRatio: number; triggerRatio: number; targetRatio: number;
    strictCapacity: boolean };
}
interface CapacityAssessment {
  disposition: AdmissionDisposition;
  pressure: Pressure;
  dimensions: readonly DimensionResult[];
  reason?: 'capacity-unknown' | 'capacity-conflict' | 'input-overflow'
    | 'body-overflow' | 'output-floor' | 'output-ceiling' | 'strict-capacity-required';
}
declare function assessCapacity(input: Readonly<CapacityInput>): CapacityAssessment;
~~~

Unknown reason/source strings in durable/public DTOs must be bounded closed producer enums/labels, not raw errors or payload paths. Finite safe integers, exact own data fields, bounded unique dimension arrays and coherent known/unknown alternatives are validated. A numeric estimate remains labelled as an estimate; it is not exact provider token count.

CapacityDomain and its sourced evidence belong beside token-meter's existing binding evidence, with actual provider/seam/assessor consumers; the union above shows the contract, not a reverse dependency. ContextEngine aliases/imports that evidence. The pure CapacityAssessment covers capacity dimensions; the prepared orchestrator combines it with the actual adapter validation and private selected candidate before returning the final decision. It cannot turn protocol rejection into a capacity-only pass.

The complete internal decision binds the actual owner/purpose/policy, captured source/protection/binding, selected semantic/payload identity and checked dimensions. Keep executable proof private; serialized decision facts never authorize a send. Main uses the real B2 pure probe. Auxiliary/summary estimates do not borrow the parent's usage anchor.

Define a pure assessCapacity input from actual ModelLimits, capacityDomain evidence, final output facts, selected estimate, exact packet facts, purpose policy and strictness. Its output contains the disposition, pressure, dimension results and closed block/reduction reason. At most one output-cap proposal is allowed by the preparation orchestrator; assessCapacity itself does not prepare, send, mutate calibration or allocate.

## Numeric policy and explicit compatibility

- Known shared planning window W: H=ceil(W*h). Bounded output or explicit unsupported allowance R gives B=W-R-H. Omitted/provider-managed output gives B=W-H with output bound unknown. Combine an independent input limit by min; input-only capacity does not subtract output.
- Main/recovery h=.10; summary h=.05; approval/title adopt the documented inherited-main local safety. Preserve explicit reserveRatio via h=1-ratio.
- Default trigger=floor(.8B), target=floor(.7B), hard fit I<=B, trigger at I>=trigger, ready at I<=target. Explicit target must be lower than explicit trigger. If absent default target conflicts with explicit trigger, use .875*trigger.
- Add targetRatio and accepted-exchange cooldown configuration to actual resolver/per-model/capture-refresh paths. Validate before effects/attempts; no unused configuration-only field.
- Generic context provenance does not prove coupling. Unknown coupling uses the named legacy shared planning assumption and unchecked provider coupling. Missing active window is not replaced with contextCeilingTokens; above-ceiling configuration cannot be certified silently.
- Complete valid local input with unknown capacity or unpriced media uses explicit compatibility, never fake0/fit/percentage. Missing remote/incompatible native input remains blocked. Known HTTP-body limits stay independently checked; SDK-command estimates cannot certify HTTP bytes.
- Compatibility never bypasses F4 unsupported terminal/local provenance. No live counting fallback.

## Output selection and protocol bounds

Prepare A and probe it without installing calibration. Preserve request/raw/stored intent and actual precedence. Remove only unambiguous legacy-catalog-default request caps; independent model ceiling evidence remains. Ambiguous refresh-written rows remain configured. No numeric-equality migration or settings rewrite.

Optional routes omit cap without intent. Subscription preserves unsupported wire behavior. Messages retains128000 local fallback and actual thinking floors; Bedrock8192 remains only its existing managed legacy-thinking branch. Summary4096/guardian2048 remain task preferences, not provider limits; title gets no new default.

Select at most one cap B within actual intent/default, sourced output ceiling and shared available room W-I-H, never below the final required floor. Fully prepare/validate/reprice B, including changed reasoning/input, then decide only B. No second iteration, A-fit reuse or hypothetical-A calibration retirement.

A protocol-valid A above a capacity/model ceiling is not a fabricated validator error. A genuinely validator-rejected upper-bound candidate may remain as a private nontransportable provisional handle ONLY with actual direction-known sourced upper-bound evidence, no omitted/additional issue and valid positive safe-integer input. Generic output-range/type/floor/native/shape/binding errors cannot acquire that path. Preserve truthful public invalid/provisional diagnostics; direct streaming A must refuse before auth/reservation/handoff. Forged/copied public reports do not confer eligibility. Real owned factories/structured derivatives must retain the actual private source. No arbitrary registrar or boolean bypass.

## Durable soft sequence and publication

Replace automatic.ts WeakMap state with derived state from closed facts through the existing document. The existing C3 source selection/private candidate/publisher remains authoritative.

A soft work key uses accepted closed-exchange advances, newly eligible human/child/tool-result input, actual protection/source state and relevant policy/binding. Exclude budget/usage/attempt diagnostics, unrelated settings/global revision and self-generated bookkeeping. Own reduction must not manufacture fresh eligible work merely by changing its checkpoint representation.

One key gets one soft sequence. Default cooldown is3accepted closed-exchange advances; explicit legacy minTurnsBeforeRecompact retains human-turn counting. Reject conflicting simultaneous controls. Hard overflow/confirmed recovery bypasses soft cooldown, never F4 allowance.

Resolve explicit presence and configuration precedence before filling defaults. Human-turn and exchange cooldown fields are mutually exclusive within one configuration layer, even if their numbers match; a more specific model layer selects its explicit mode and suppresses the lower layer's alternative. Do not materialize the new default field in a way that turns an existing explicit legacy setting into a conflict. Trigger/target remain value overlays: an inherited explicit target is still explicit and must be valid against the selected trigger; only an actually absent target receives the derived default.

Persist sequence start before summary work. Terminal state distinguishes failed/blocked/unchanged/reduced-over-target/target-ready and binds the exact original start/source and publication disposition. Pieces, quality rounds and physical retries are subordinate to ONE sequence. Three failed sequences open the recorded breaker; a genuinely changed eligible key permits one attempt without clearing failure history. Only committed target-ready resets it. Unknown start/publication retains the original capture for reconciliation and cannot grant a fresh sequence or successful reset.

For a committed own rewrite, bind the consumed before/after representation keys to the SAME guarded publication receipt so it cannot immediately retrigger solely on its new checkpoint. Extend the dedicated closed reduction group with an optional strictly validated soft-sequence terminal; do not use a later independent write to claim an atomic target-ready reset. The terminal references the exact own-session start and the actual private final candidate/publication. Its consumed representation keys come from that assessed candidate, not an arbitrary post-commit snapshot that could include unrelated later input. Unknown publication retains the original grouped capture; matching reconciliation installs rewrite and policy terminal together, absent publication cannot reset. Failed or blocked work with no publication uses an original required settlement source, with no new generation grant. Old calls without a soft sequence keep their existing closed family, including wrong-family/accessor refusal.

A failed sequence increments the consecutive failure count once. Blocked/unchanged/reduced-over-target or canceled sequences preserve that count, and their consumed key prevents an unchanged retry. A pending/unknown sequence is not mislabeled failed or successful and remains nonrenewable for that key. Only committed target-ready resets the count. Record the exact closed start/terminal schema and structural reference rules in the implementation notes as a concrete representation of this contract before the first production edit; an owner incompatibility goes to root for a recorded ruling.

Preserve final candidate input/byte measurement domains. Lower output cap or changed payload ID alone is not input-recovery progress. Unknown measurements cannot prove monotone token reduction. Summary splitting stays finite under C3/F4, no recursive compactor/intermediate checkpoint publication.

## Observation and version migration

Introduce a closed versioned successor to RequestBudgetSnapshot v1, using the canonical disposition/dimensions/pressure/estimate facts above with existing owner/model/protocol/freshness coordinates. Preserve component estimates as labelled components; do not turn unknown total into0. Retain historical v1 reads and safe unavailable compatibility for unsupported/stale views. Active main/SDK/Gateway/diagnostic readers must report the same decision, never a shadow legacy budget.

Use the next actual session format gate after8 for new operational/observation facts as required by existing registry semantics. Update memory/staged/cold/upgrade/query/seed consumers coherently. Soft operational state is own-session, not an inherited child grant. Existing semantic raw/derived seed links remain intact. Include file-backed search and actual Gateway search, which F4 demonstrated can be missed.

Public/diagnostic DTOs contain no request bodies, image bytes, credentials, signatures or per-message hash vectors. Browser-safe scalar decoding performs0prepare/auth/count/model/tool work. R5 owns broader UI presentation and renderer boundary repair, not later invention of E arithmetic.

## Required literal oracles and actual consumer controls

These expected values are fixed independently of production calculations:

~~~ts
const numeric = (value: number) => ({ value, origin: 'explicit-route' as const, sourceId: 'fixture-capacity' });
function shared({ W, H, R, I }: { W: number; H: number; R: number; I: number }) {
  const result = assessCapacity({
    purpose: 'main', estimate: { kind: 'estimated', value: I, source: 'projected-heuristic' },
    limits: { contextTokens: numeric(W) },
    capacityDomain: { kind: 'known', value: 'shared-context', sourceId: 'fixture-domain' },
    output: { capSupport: 'supported', parameter: 'optional', effectiveCap: R, minimumCap: 1 },
    packet: { kind: 'http-json-body', bytes: 100 },
    policy: { safetyRatio: H / W, triggerRatio: .8, targetRatio: .7, strictCapacity: false },
  });
  if (result.pressure.kind !== 'known') throw new Error('Expected known fixture pressure');
  return { B: result.pressure.inputBudget, ...result.pressure };
}
expect(shared({ W: 10000, H: 1000, R: 600, I: 8400 }))
  .toMatchObject({ B: 8400, trigger: 6720, target: 5880, hardFits: true, targetReady: false });
expect(shared({ W: 10000, H: 1000, R: 600, I: 8401 }).hardFits).toBe(false);
expect(shared({ W: 10000, H: 1000, R: 600, I: 6720 }).softNeeded).toBe(true);
expect(shared({ W: 10000, H: 1000, R: 600, I: 6719 }).softNeeded).toBe(false);
expect(shared({ W: 10000, H: 1000, R: 2000, I: 0 }))
  .toMatchObject({ B: 7000, trigger: 5600, target: 4900 });
~~~

Here shared is a test fixture adapter to assessCapacity: it supplies actual sourced shared-context facts, explicit bounded output and h=H/W, and aliases returned inputBudget as B. It must not compute expected outcomes. Additional fixed cases: summaryH500/R600→B8900; omission→B9000/unbounded-output; input-only10000 remains10000; trigger.6/absenttarget→.525 and5040/4410atB8400.

Required actual boundaries:
1. Required A128000/ceiling8192, W10000/H1000/I1000/floor1025 selects one8000 cap; exactB I1000fits, I1010fails. Available500belowfloor blocks/reduces, no cap500send.
2. Real protocol-valid A versus actual provisional upper rejection; malformed/floor/additional/omitted/native failures and copied/forged provisional sources all refuse. Direct invalid/provisional A stream0auth/0reservation/0send.
3. Optional catalog65536 disappears from actual final body; explicit stored/raw65536 remains. Preserve subscription unsupported allowance, Messages required fallback, Bedrock ordinary/managed/adaptive distinction and exact native/cache/thinking order.
4. HTTP body101/limit100 fails regardless of tokenfit; SDKestimate101 is not verified HTTPsize. Complete token-unknown localaudio compatibility versus incomplete remote/native blocking, F4media1.
5. Main/child/recovery/summary/both approval modes/title use one decision owner with actual final binding/purpose. Preserve existing guardian4000chars/no-tools/16KiBverdict/2048/deadline; title4000chars/120bytes/eightwords/preference/fallback. F4counts/clocks do not reset.
6. A B2miss/Bmatch pure probe keeps the valid sample; threshold-only policy changes its certificate/key without itself retiring input-compatible sample. Real execution/source changes still retire through B2.
7. Final reduction hard-fit/over-target/target-ready use sameB. Protected-only/noeligibleinput/fixedschema blocked; over-target/failed/unknown publication cannot claimready/reset.
8. Three accepted closed tool exchanges in one human turn advance default cooldown; explicit oldhuman3doesnot. Metadata/usage/action/attempt appends0advance. Samekey/reopen0newsequence; own rewrite0freshwork; relevant externalnewinput permits one.
9. Failure counts are per sequence, not summarypiece/retry. Start/terminal/publish crash cuts, Stop before/afterissue, unknown→absent/committed and late eligible input retain original captures and correct no-renewal/reset behavior.
10. Actual memory/staged/JSONL/cold/query and fork/seed history support old and new forms; no inherited breaker/grant, no fabricated currentv1snapshot.
11. Actual SDK/Gateway/context/diagnostic reads0prepare/auth/model/toolcalls; unknown/stale readings are not0orfit.
12. Actual fresh copied Gateway and bundledCLI exercise main+summary/recovery/read/child+aux paths; identity/call counts and exact source/copy manifests, not build-only.

## Task 1: Activate the shared policy through every actual consumer

- [ ] Read specs, this plan and actual accepted owners; create source/file map, final contract types, closed event/group/cold-fold choice and old-owner retirement checklist. Record concrete root rulings before affected product behavior changes.
- [ ] Capture only needed current-source baselines and meaningful failing literal/actual-consumer tests. Use existing exact receipts where source-equivalent; preserve failed/setup/incomplete results.
- [ ] Implement sourced facts and shared pure capacity/output/pressure decision with real main/summary/aux callers, exact A/B validation and all unknown/compatibility cases. Do not mark partial scaffolding complete.
- [ ] Implement the closed durable soft-sequence owner and versioned observations through existing F1/history, with the selected atomic/receipt recovery contract and actual config refresh.
- [ ] Cut over all purposes and readers; remove duplicate formulas/WeakMap/legacy-ready fallback in the same gate. Preserve actual protocol fields and F4 source ownership.
- [ ] Run meaningful RED→GREEN and appropriate full affected package/types/route corpus once at stable source, sequential max2/min1 (CLI1). Classify each failure against exact BASE only where needed. No recursive pnpm through a BASE node_modules junction.
- [ ] Check maintained file/function responsibility, imports/audit without reseed/allowlist, and actual build/copy execution. Renderer/dynamic-TS limitations remain honestly reported until their own repairs; new added risk is not waived by a prior failure.
- [ ] Commit coherent units on the existing branch; exclude root docs, keep product clean; deliver report, actual owner/purpose/reader matrix, exact retirement list, all failure/source-time qualifications, immutable evidence/source/copy seals. Exclude active ledgers from seals or snapshot them.
- [ ] Fresh full-task GPT6.1Sol spec/quality review; original writer scoped fixes and original reviewer re-review. Root acceptance/checkpoint/sync follows, then R4A/B/C→R5→R6. No whole-redesign/release claim from E alone.

## Plan self-review gate

Root must record a table covering this one task's internal agreement and shared interfaces: capacityfacts↔adapters/assessor, decision↔allactualpurposes, publication↔softterminal, versionedDTO↔realreaders, configrefresh↔workkey/calibration, F4↔newpureassessment, and scope↔verification/retirement. Every identified ambiguity needs a ruling before dispatch. No additional reviewer/research seat is required for this plan scan.
