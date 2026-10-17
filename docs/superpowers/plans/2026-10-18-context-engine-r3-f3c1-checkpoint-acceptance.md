# ContextEngine R3 F3c1 — Summary Output and Checkpoint Acceptance Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. One GPT6.1Sol/high implementer followed by a fresh task reviewer; no recursive agents. Steps use checkbox (`- [ ]`) syntax.

**Status:** Executable rebase on reviewed F3b product468fb626 and pause checkpoint95b79734. User resumed the approved whole redesign on2026-10-18. Exact documentation BASE is supplied at dispatch.

**Goal:** Make the actual summary caller require a known text-compatible final request and a complete bounded checkpoint, preserving protocol ownership and observed failed-attempt usage.

**Architecture:** Each adapter describes text-output eligibility from its actual lowered body through the existing prepared handle. The existing summary consumer validates its selected final derivative, then accepts only complete framed checkpoint text. Extract prompt, checkpoint parsing and stream collection into cohesive summary leaves; do not create a second compaction engine or touch selection/publication yet.

**Tech Stack:** Existing TypeScript/pnpm/Vitest packages and controlled transports; no dependency or persisted format changes.

**Spec:** `docs/superpowers/specs/2026-10-15-context-engine-{redesign,framework,r1-contracts}.md`; `docs/research/2026-10-16-context-engine-r3-f3-preflight.md`, especially complete-checkpoint and final-body-carrier rulings. Existing F3a/B/F1 qualification limits remain binding.

## Global Constraints

- One product writer; GPT6.1Sol/high implementer/reviewer, no recursive agents. Product0.1.13-rc.1 and original27/43 unchanged.
- No installed profile/account/provider request, release, dependency, audit baseline/allowlist change, fake consumer or unrelated decomposition. Controlled fixtures deny unmatched transports.
- Adapters own protocol interpretation and final-body lowering. Keep public Responses and Codex subscription distinct, raw-option precedence, native/media order, cache semantics and actual selected output caps unchanged.
- A text-output observation is not request validity, token capacity, execution permission, provider authenticity, a source receipt or proof of factual summary quality. Unknown/custom coverage is explicit.
- No selector, replacement publication, hidden option stripping, automatic model switching, new settings, F4 physical budget or R2E policy migration in this task. Existing R-history old-reducer refusal stays until connected F3 production.
- Keep default retained hint1024, minimum500 and maximum4096 JavaScript code units; existing explicit retention/wire-output preferences, two quality rounds and transaction-local maximum8 stream invocations remain. These invocations are not a claim about hidden physical retries, which F4 owns.
- New cohesive functions stay at most120lines; normal leaves150–400 but small DTO/parser helpers require no filler. No mega-file expansion; tests/scripts exempt.
- Preserve failed receipts and known F1/B2/F3a/R6 limitations. Matching BASE failures are not final-qualification exemptions. No assertion weakening, timeout inflation or production compatibility escape just to keep an old fixture green.

### Task 1: Connect route-owned text eligibility and enforce complete checkpoint acceptance

**Files and responsibilities:**

- Create `packages/llm-seam/src/prepared/text-output.ts`: small data-only observation union, safe normalization/reading; actual prepared and summary consumers only.
- Modify seam `prepared/{types,payload,wrappers,fallback}.ts` and `src/index.ts`: optional observation, final-body callback, immutable capture and derivative/wrapper propagation. Export only the observation type and reader needed by actual external consumers; normalization stays an internal module export.
- Create `packages/llm-{openai,openai-compatible,anthropic,gemini,bedrock}/src/request/text-output.ts`; connect each existing `src/client.ts` to its route-local observer. The openai leaf covers both public/subscription final bodies. Reuse actual request vocabulary; if a top-level known-field list must serve both validator and observer, move that list to that adapter's small `request/fields.ts` leaf and update its real validator consumer. No adapter-to-adapter import and no copy of an entire validator.
- Create `packages/compaction/src/summary/{prompt,checkpoint,stream}.ts`: prompt/template, pure structural acceptance, bounded stream/usage/terminal collection respectively.
- Modify `compaction/src/{summarizer,prepared-summary,summary-errors}.ts`: existing orchestrator consumes those leaves and final eligibility, with safe typed reasons. Update `engine/commit.ts` to import errors from their real owner if retiring the summarizer compatibility re-export.
- Tests: new seam `test/text-output.test.ts`, each adapter `test/text-output.test.ts`, compaction `test/checkpoint-acceptance.test.ts`; extend existing prepared-wrapper/prepared/final-validation/summary-observation/bounded-checkpoint/instructions consumers. Migrate affected positive summary fixtures within compaction and the actual core-agent/session-executor test consumers without changing their unrelated oracles. A test-only `compaction/test/fixtures/checkpoint.ts` can provide a literal complete checkpoint and an explicitly declared text fixture client; no production test export.

**Contracts:**

```ts
// prepared/text-output.ts
export type PreparedTextOutput =
  | Readonly<{ status: 'allowed'; reason: 'ordinary-text' }>
  | Readonly<{ status: 'blocked'; reason: 'structured-output' | 'forced-tool' }>
  | Readonly<{ status: 'unknown'; reason: 'unsupported-output-options' | 'not-declared' | 'invalid-declaration' }>;
export function readPreparedTextOutput(
  prepared: { readonly textOutput?: PreparedTextOutput },
): PreparedTextOutput;
// PreparedModelRequest adds readonly textOutput?: PreparedTextOutput.
// createPreparedPayload adds optional:
// textOutput: (actualBody: T) => PreparedTextOutput

// summary/checkpoint.ts; internal, no package barrel
export type CheckpointShape =
  | { readonly kind: 'complete'; readonly text: string }
  | { readonly kind: 'invalid'; readonly reason: 'framing' | 'sections' | 'empty-section' };
export function inspectCheckpoint(text: string): CheckpointShape;

// summary/stream.ts; internal
export interface SummaryStreamResult {
  readonly text: string; // bounded retained prefix; usable only if overflow=false
  readonly chars: number; // trimmed JS code units observed, safe scalar
  readonly overflow: boolean;
  readonly observation?: import('../summary-observation.ts').SummaryPieceObservation;
}
export function readSummaryStream(
  candidate: import('@i-harness/llm-seam').PreparedModelRequest,
  limits: Pick<import('../prepared-summary.ts').SummaryLimits,
    'signal' | 'validateBeforeTransport' | 'onUsage'> & { maxRetainedChars: number },
): Promise<SummaryStreamResult>;
```

The reader accepts only own ordinary data fields `status` and `reason` with one valid pair; no extra raw data, inherited/accessor properties or symbol keys. Missing observation becomes not-declared, malformed observation invalid-declaration; getters must not run. Return an owned frozen DTO. Normalize callback output at the prepared-payload owner and read at the summary boundary; wrappers retain sanitized data. Callback execution must be pure, on the actual serialized/lowered body already used by describe/output/validate. Every cap derivative recomputes its own observation; never copy A's observation onto B.

- [ ] **Step 1: Bind BASE and record baseline consumers before edits.**

Record supplied BASE, clean product/index and actual preparation/wrapper/summary call sites. Inspect the named leaves, not unrelated subsystems. The existing `prepareSummary` selects one final derivative and the existing engine already selects `config.summarizationModel ?? deps.model`; use that existing explicit choice. Do not retry with another binding after an incompatible result.

Run current compaction full and the affected core-agent and executor scopes from Step8 before fixture migration. Preserve actual exits and assertion summaries. Existing F3a failures are recorded separately in `docs/research/2026-10-17-context-engine-f3a-baseline-gaps.md`; compare exact BASE where a covering failure occurs, never skip or silently rewrite it. Baseline fixture shortcomings do not license production fallback.

- [ ] **Step 2: Write actual-carrier and checkpoint RED cases.**

Use actual adapter preparation and selected derivatives. At least one length-valid malformed checkpoint must reach the old summary caller and be incorrectly accepted before product edits; at least one JSON/forced-mode request currently streams and must become a zero-send refusal. Bind tests to independently literal output, not the product parser/template constants.

```ts
const complete = '<compacted-summary>\n## Objective\nResume work.\n'
  + '## Important Details\n(none)\n## Work State\nTests passed.\n'
  + '## Next Move\nReview changes.\n## Relevant Files\nsrc/a.ts\n'
  + '## Sensitive Instructions\n(none)\n## Tool Work Summary\nRead completed.\n'
  + '</compacted-summary>';
// Literal expected strings are kept independently of product heading constants.
expect(inspectCheckpoint(complete)).toEqual({ kind: 'complete', text: complete });
expect(inspectCheckpoint(complete.replace('## Next Move', '## Objective')).kind).toBe('invalid');
expect(inspectCheckpoint('```\n' + complete + '\n```').kind).toBe('invalid');
// Actual summarizer: sectionless text >=500 and <=4096 currently passes.
// After the change, two such completed outputs => typed checkpoint-format,
// two local attempts, no accepted-piece notification or summary publication.
```

Also write final-derivative A-allowed/B-blocked and A-blocked/B-allowed controls with the actual `createPreparedPayload` observer; the selected B decides eligibility. Missing/custom/malformed observations must be unknown, not admitted by a generic final-validation partial status. Capture RED command/output before changes, using sequential focused Vitest commands with `--maxWorkers=2 --minWorkers=1`.

- [ ] **Step 3: Implement the observation carrier and route-local interpretation.**

Add the optional prepared fact, final-body callback, safe data normalization, and read function. `createPreparedPayload` always records either its observer result or not-declared; generic stream-only fallback records not-declared. `wrapPreparedRequest` preserves the observation recursively through cap derivatives and retry/recording wrappers. Do not normalize a custom client by marking it allowed merely because it has stream/prepare.

Interpret only the actual final known request controls, after current raw precedence and subscription filtering. Use this exact policy; ordinary-text means a text attempt is possible, not guaranteed:

| Owner | Allowed text attempt | Blocked or unknown |
|---|---|---|
| Chat | absent/default or explicit text response_format; none/auto tool_choice; allowed_tools with auto; known reasoning_effort | JSON object/schema => structured-output; required or named function/custom choice, allowed_tools required => forced-tool; unrecognized format/choice/generation extension => unknown |
| Responses public/subscription | absent/default or text `text.format`, normal verbosity/reasoning fields; none/auto choice; allowed_tools auto | JSON object/schema => structured-output; required or recognized named tool choice/allowed_tools required => forced-tool; unfamiliar choices/format/extensions => unknown. Subscription sees only the actual retained body, not discarded raw options |
| Messages | absent output_config or effort-only; recognized thinking modes/fields; auto/none tool_choice | output_config.format JSON/schema => structured-output; any/tool => forced-tool; unknown output/thinking/choice extensions => unknown |
| Gemini | absent/default/empty/text/plain MIME without schema; normal thinking controls; function mode unspecified/AUTO/NONE/VALIDATED, including numeric0/1/3/4 | application/json, text/x.enum or present responseSchema/responseJsonSchema => structured-output; ANY/numeric2 => forced-tool; unknown MIME/modes/generation controls => unknown. Use existing ProtoJSON field/alias/null semantics; no duplicate JSON-name reader |
| Converse | default text, toolChoice absent/auto; recognized Claude thinking plus effort-only output_config, or Nova reasoningConfig emitted by the existing translator | any/tool => forced-tool; recognized structured output in additional fields => structured-output; other additionalModelRequestFields/unknown output controls => unknown. Inspect actual command, not raw config in place of it |

Known positive reasoning fields do not confer model capability or bypass final validation. Recognized reasoning-only control must remain eligible even when native/limit validation is partial. Unknown top-level or generation extensions remain explicitly unknown; schema interiors, metadata/cache values and input native payloads are not traversed for output mode. Ordinary declared fields unrelated to output format do not become unknown merely because the overall validator has `limit-unverified`, native or other unrelated gaps. Reuse local vocabulary lists where that avoids drift. Do not broaden validator acceptance or add catalog/model heuristics here.

Known incompatibility takes precedence over unrelated unknown fields for diagnostic classification; both refuse summary. Malformed final request still follows the existing final validator first. No raw options/body/signature/API key enters the observation or errors.

- [ ] **Step 4: Connect the actual summary preparation boundary.**

Keep current preparation, single derivative selection, exact final measurement, floor checks and explicit summary-binding choice. Immediately after validating the selected final candidate, call `readPreparedTextOutput(candidate)`: blocked throws `SummaryBlockedError('output-incompatible')`, unknown throws `SummaryBlockedError('output-unknown')`; only allowed can reach measurement notification, flush/pretransport and stream. These new errors carry only closed kind/message, never provider options.

Add a readonly `kind` to SummaryBlockedError with its existing closed reasons plus `output-incompatible`, `output-unknown`, `checkpoint-format`, `tool-output`. Keep existing safe messages for existing reasons; new messages describe the contract without exposing raw data. No new UI/raw diagnostic propagation in this unit. Main requests retain their own structured/forced-mode sending behavior; the observation only gates this text summary consumer.

Tests must distinguish zero sends/zero attempt increments for incompatible preparation, one explicit compatible summary client used when configured, and no opportunistic fallback. Preserve actual final cap assertions and raw body bytes through ordinary main prepared.stream controls.

- [ ] **Step 5: Extract prompt/parser and enforce the complete checkpoint.**

Move buildSummaryPrompt to `summary/prompt.ts`; update actual imports and test imports. Do not retain a test-only compatibility re-export in summarizer. Keep seven ordered sections and framing, with the same exact headings: Objective, Important Details, Work State, Next Move, Relevant Files, Sensitive Instructions, Tool Work Summary.

`inspectCheckpoint` trims only outside whitespace, requires exactly one opening and closing wrapper with no other non-whitespace outside, exactly those seven second-level headings on their own lines once and in order, and nonempty content in each section (or `(none)`). Reject duplicate/missing/out-of-order/unknown second-level sections, incomplete framing, JSON/code-fenced wrapping and empty sections. It checks structure only; do not claim factual or instruction-semantic correctness. CRLF is valid and retained; accepted content is not reformatted.

Remove the old keyword-based Sensitive Instructions prefill. Existing replayText has no reliable author/provenance, so it must not promote arbitrary tool/plugin quotations into user authority. Preserve replay text verbatim in its existing position; instructions explain that recorded text retains its original authority. Manual summary instructions may refine content/language, but cannot override the required checkpoint structure or authorize tools. Replace the contradictory 'take priority over the template' wording. Do not add a guessed human classifier or new provenance field. Connected F3 will supply exact typed source groups; this unit simply stops making unproven prefills.

```ts
// Illustrative caller shape: length acceptance and shape acceptance are distinct.
const parsed = result.overflow ? undefined : inspectCheckpoint(result.text);
if (result.chars < minSummaryChars || result.chars > maxTokens * 4) {
  lastFailure = 'retention-output';
  continue; // existing local quality round, same shared tracker
}
if (!parsed || parsed.kind !== 'complete') {
  lastFailure = 'checkpoint-format';
  continue;
}
// Only now may existing onPieceAccepted fire and running become parsed.text.
```

The retry directive must describe complete structure and retained bounds, not always request a shorter answer when the prior output was too short or malformed. Preserve two quality rounds per piece and the transaction-local maximum. The final rolling checkpoint must still satisfy the same parser/retained bounds. No lossy slicing to make malformed output pass; no intermediate publication.

- [ ] **Step 6: Extract bounded stream collection without losing observations.**

Move the real stream loop into `summary/stream.ts`; reuse summaryPieceCollector and the actual prepared.stream control. Preserve abort and validate-before-transport behavior, duplicate-identical-end handling, conflicting ends and content-after-end refusal. Any tool_call, including one before end, blocks the checkpoint without executing it. Continue collecting its terminal/usage observations until ordinary stream completion/cancellation; do not persist its text as a valid summary.

Keep at most the configured retained ceiling plus a one-code-unit overflow sentinel as local checkpoint text. Count trimmed JS code units independently with safe scalar saturation; do not confuse code units with UTF-8/provider tokens. A stream with arbitrarily large leading/trailing whitespace must not cause unbounded retained allocation or falsely overflow a short trimmed checkpoint. Preserve exact interior text for accepted output, including split whitespace/chunks and surrogate boundaries. After proven oversize, bounded discard/counting continues so usage/end are still observed; overflow can never be accepted as the retained prefix.

Always deliver observed usage once per attempted stream, including refusal, truncation, tool output, malformed checkpoint, provider error or cancellation. Absence stays absence; do not synthesize token totals. Flush the currently accumulated usage in finalization; if observation delivery itself fails, surface that failure while preserving an existing stream error as cause/AggregateError rather than losing it or accepting text. No extra attempt solely to conceal an observation callback failure. Close the piece collector in all outcomes. Its receipt is returned privately; accepted-piece notification happens only after complete text validation in the orchestrator.

Keep unchanged piece splitting and old source construction outside this task. Extract small local orchestrator helpers if needed to keep changed functions within120lines, but do not redesign source selection or add a second summary implementation.

- [ ] **Step 7: Migrate truthful fixtures and add boundary tests.**

Old custom mocks often return sectionless text or omit prepare capability. Positive summary fixtures must now explicitly implement a declared text prepare contract and return a complete literal checkpoint. A test helper may delegate neutral preparation and recursively decorate its own prepared derivatives with an explicit test-only ordinary-text fact; negative custom/malformed cases must keep the true absence. Never add a production bypass or global test mock that converts all unknown clients to allowed.

Do not fake a successful full checkpoint under a retained ceiling smaller than its literal text. Where an old fixture used maxTokens16 only to permit the old 'ok' summary, adjust that test's retained ceiling with an explicit rationale while retaining independent wire-output cap assertions, pressure/recovery intent, ordering and effect counts. Do not increase a real failing request limit or weaken an assertion to hide a product defect. Preserve all failures and list every such fixture contract update in the report.

Required controls: each missing/duplicate/reordered/empty section; whitespace/CRLF; framing/code fences/JSON; min and max exact code-unit boundaries; oversized chunks bounded even if later end/usage exists; valid small text surrounded by long whitespace; a pre-end tool_call followed by otherwise valid text/end; refused/truncated/missing/conflicting ends; cancellation and provider throw after usage; callback failure preserves the original failure; invalid first/valid second and two invalid rounds; shared tracker exhaustion; accepted-piece callback only for complete checkpoints. Prompt tests must show tool-like imperative replay appears once as replay and is not prefilled as human instruction. Manual instructions cannot waive structure. Real alternate summary binding and all-six actual prepared mode controls must remain covered.

- [ ] **Step 8: Qualify final source sequentially and report.**

Use existing pnpm scripts and `--maxWorkers=2 --minWorkers=1`, one suite at a time. During iteration run focused tests; after final source run each applicable suite once, repeating only for actual changes/failures:

1. Full llm-seam, all five adapter packages, and compaction. Six route kinds include public/subscription OpenAI within its package. Scope fixture transports to deny unmatched requests.
2. core-agent `test/compaction-binding.test.ts test/context-usage.test.ts test/execution-calibration.test.ts test/overflow.test.ts test/owned-budget.test.ts test/context-recovery.test.ts test/context-snapshot.test.ts test/protocol-recovery.test.ts test/final-validation-routes.test.ts test/native-final-validation-routes.test.ts`; retain exact BASE gap comparisons rather than blanket claiming green.
3. session-executor `test/todo-compaction.test.ts test/context-recovery.test.ts`; plus directly amended named consumer tests if discovered during fixture migration. No unrelated whole repository suite.
4. Existing quarantined root `pnpm exec vitest run --config e2e/vitest.config.ts e2e/context-corpus.e2e.ts --maxWorkers=2 --minWorkers=1`. Keep all native/body/roundtrip oracles; this observation must not rewrite wire data.
5. Actual package typechecks for seam, five adapters, compaction, core-agent, context-engine, session-executor, provider-runtime, sdk, desktop-gateway; CLI typecheck from apps/cli; root E2E types. `pnpm verify:reachability` without reseed/fake consumers/baseline changes.
6. Fresh distinct copies using `node packages/desktop/scripts/build-gateway.mjs --out .tmp/context-r3-f3c1-gateway-20261018a`, `node scripts/build-dist.mjs --out .tmp/context-r3-f3c1-cli-20261018a`, then CLI `scripts/verify-dist.mjs`. Adapt the existing isolated host/preloaded controlled-fetch methods in `.tmp/context-r3-f3a-validation/packaged-assessment.mts` for actual summary execution: positive complete checkpoint, malformed/tool-call refusal with no summary event, final-mode blocked zero summary transport, explicit separate compatible summary binding, and subsequent ordinary main read/run. Exercise the actual Gateway manual compact route `desktop/session/compact` and the bundled CLI `session-compact` command path where exposed; do not export a private test-only entry. If a shipping command cannot be reached with the existing harness, report its concrete boundary to root before substituting a package-only claim.

Record exact BASE/final HEAD, source hashes for every changed production/test file and copied runtime file, CLI bundle hash, actual argv/CWD/exit/log hashes, failed receipts and fixture migration notes. Hash final logs after they close; do not inventory a redirected command's own output before it is written (F3b review correction). Keep credentials synthetic and bodies out of durable diagnostics. Root owns plans/progress/research; explicitly stage and commit task product/tests only, with coherent extraction/behavior commits where useful. Return the report to the prescribed SDD workspace; root runs the independent full-range review.

## Root boundary rulings

This is a real current summary-consumer improvement, so a reviewer can reject or accept it independently of the later selector/publication transaction. It does not clear the old source/maxSeq/prune-first issues. Those callers remain explicitly temporary and cannot support a whole-F3/release claim.

Missing custom text eligibility now blocks summary while leaving ordinary custom main streaming compatible. This intentional cost is required to avoid certifying unknown structured-output clients. Positive fixtures declare their own capability; production does not infer it from test behavior.

The legacy keyword prefill is removed because its source text has no author proof. Recorded text is preserved; no authority is fabricated. If a future typed source prefill is added, it must use actual selected human provenance and derived summaries must remain derived.

Text eligibility is independently observable from partial final validation. Known reasoning controls may permit a text attempt without claiming model/native validity. Each adapter retains its own wire semantics, and invalid requests still fail at the existing final validator. Unknown extensions remain visible limitations, not silently stripped fields.

After this reviewed gate, continue connected F3 selection, finite summary/source coverage, exact candidate assessment and fenced publication. F4/E/R4/R5/R6 and all named earlier failure obligations still follow. No new user approval is required to continue the already approved redesign.
