# ContextEngine R2C — final Responses and Chat validation

> **For agentic workers:** REQUIRED SUB-SKILL: Use subagent-driven-development or executing-plans. Steps use checkbox syntax for tracking.

**Status:** Complete through2ee26aa4d18f01f443d01fad43387682b0efac95 after fresh full-range review and original-reviewer fix1 approval. BASE385cf09444212537b1f999450d2af12a8c0d5b75. Verification: docs/research/2026-10-16-context-engine-r2c-verification.md. D/native/policy and whole-program qualification remain separate gates.

**Goal:** Reject malformed final public Responses, subscription Responses and Chat requests before measurement/transport, with protocol-specific call-group rules and precise safe errors rather than treating every400 as capacity overflow.

**Architecture:** Each adapter owns a pure final-body validator. llm-seam owns the bounded report/error contract and per-handle composition; core-agent/summary consume that selected handle's validity. Source projection, effect ownership, budget policy and retry/attempt ownership retain their existing owners. R2D supplies the other three route validators; R2E supplies the policy cutover.

**Tech Stack:** Existing TypeScript/pnpm/Vitest and immutable prepared payload. No third-party/package dependency changes expected.

**Sources:** approved redesign/framework; `.tmp/context-redesign-20261015/r2cd-validator-contracts.md` including its corrective appendix, `r2cd-root-rulings.md`, `r2c-final-preflight.md`. Current exact source observations are72a98ef5. The final preflight confirmed official public output minimum16 from the [official create schema](https://developers.openai.com/api/reference/python/resources/responses/methods/create), fetched2026-10-16; it is not a universal custom/subscription limit. See the report for web-reader limitations and actual HTML verification.

**B2 API rebase at0024423d:** `createPreparedPayload.derive` lowers HTTP once, describes and prices the actual body, then its stream passes a fourth `PreparedExecutionContext` argument to the adapter. `preparedExecution(measurement, control)` currently confirms once, emits the frozen execution facts and invokes the existing freshness callback. `preparedControls` lives in `prepared/wrappers.ts` (there is no separate controls.ts) and deduplicates nested callbacks. Add report validation to this existing composition before execution confirmation, not a second physical-send counter. `wrapPreparedRequest` must preserve the exact current derivative report. Actual main owner is `core-agent/agent/budget.ts:assess`; summary owner is `compaction/prepared-summary.ts:prepareSummary`. Both recheck their selected derivatives and keep their existing formulas until E.

## Global Constraints

- One GPT6.1Sol product writer, fresh review, no recursive delegates. User approved continuous R0–R6 work. Existing development branch/version0.1.13-rc.1; no installed profile, account/provider/count requests, remote/merge/release or unrelated decomposition.
- Preserve R1 source/acceptance/protection, B1 lower-once/final-candidate identity and B2 exact execution attribution/format rules. No new authority ledger, tool dispatch/repair, attempt allowance, input claim or compaction owner.
- Validate the final JSON-equivalent body after raw options/cache/cap, before descriptor code assumes object/array shape. A derivative revalidates itself. Do not certify a later body by comparing only to the original mapper.
- Observable wire closure is independent of unknown historical authority. Ordinary visible client calls require their protocol outputs. Unknown provenance never waives a malformed wire; genuine remote/native/nonblocking exceptions are separately typed/scoped.
- Preserve actual supported raw precedence and existing model-mismatch rejection. Do not infer accepted override from builder merge order alone. No model-catalog membership gate or provider-brand guess.
- Protocol structure, native preservation/authenticity, local token completeness and limit applicability stay distinct. Local validation cannot prove signature authenticity, account permission, actual backend acceptance or remote input size.
- Reports/errors contain bounded allowlisted enums/counts only,≤4096bytes; no prompt/args/signature/arbitrary field paths/call IDs/hash vectors. New leaves normally150–400lines/functions<=120, no monolith or fake audit consumer. Tests/scripts not decomposition targets.
- Preserve previous whole verify:all FAILED/incomplete and27/43 count. No audit reseed, skipped tests, weaker timeouts/assertions or permanent duplicate checks. Transitional D/custom coverage is explicit, not secretly disabled.

## File map and ownership

- llm-seam `prepared/validation.ts` (contract/bounded constructor/sanitizer/assertion), `prepared/{types,payload,wrappers,fallback}.ts`, public index; existing B2 PreparedExecutionContext.confirm is the one final execution composition point.
- llm-openai `request/validate.ts`, private Responses/subscription rule leaves if needed, `client.ts`, `context.ts`; llm-openai-compatible equivalent. Validators inspect literal final wire values, not call the mapper to generate expected legality.
- seam `provider-error/{types,classify,facts}.ts`; precise local INVALID_ARGUMENT mapping and safe report propagation. Existing transport/native mapper preconditions stay, with final model/cap checks moved out of descriptor extraction.
- core-agent `agent/{admission,budget}.ts` and the reviewed prepared-summary leaf consume selected-handle validation before reduction/capacity decisions. Source review turn/recovery without inventing a new recovery branch.
- core-session `conversation/project.ts` only for the independently reproduced parallel-result/image companion ordering defect: an early assistant flush currently emits the user-role image before remaining sibling tool results. Preserve the existing semantic/source owner and all input/image references; do not create adapter history repair. Actual invocation-result closure is independent of any background job's later settlement.
- SDK `server/client/protocol` and gateway/Desktop diagnostic boundaries only as needed to preserve the same sanitized modelFailure facts. Their role remains observation; no UI budget engine or new context/session format.
- Tests: private validator literals, actual prepared/codex-subscription, seam wrappers/provider-errors/retrying-client, main protocol-recovery/owned-budget, compaction summarizer, SDK server/protocol and Desktop runtime-diagnostics; six-route corpus. Recheck exact filenames after B2.

### Task 1: Validate final C-route payloads and carry precise failures

**Consumes:** reviewed B1 lower-once prepared body/identities/derivatives, reviewed B2 per-handle execution confirmation and exact selected candidate; existing route builders/replay preconditions and scalar error taxonomy.

**Produces:** real final validators for three C routes, immutable per-derivative reports, no-send malformed requests and safe schema/order/binding/output errors across actual consumers; honest transitional unvalidated coverage for other routes/custom clients.

- [x] **Step 1: Baseline real routes and add mapper-independent RED cases.**

Reuse B2's exact applicable receipts as the unchanged baseline where they cover the final reviewed source; run only missing targeted baselines before source edits. Literal validators and actual raw override/cap callback cases must fail for missing validation, not merely for an invalid fixture or missing file. Include valid parallel/hosted/remote-prefix controls so a blanket rejection cannot satisfy the tests. Preserve the six independently reproduced BASE core-agent failures as whole-program concerns; a C selected gate is not a replacement for their R6 qualification.

- [x] **Step 2: Define one bounded report and precise rejection contract.**

```ts
type ValidationRule = 'shape' | 'binding' | 'tool-id' | 'tool-group' |
  'native-replay' | 'parameter-type' | 'parameter-conflict' |
  'unsupported-parameter' | 'output-range' | 'body-limit' | 'media-limit';
type ValidationSite = 'request' | 'model' | 'messages' | 'input' |
  'tools' | 'native' | 'generation' | 'media';
type CoverageGap = 'legacy-tool-ownership' | 'native-origin-unknown' |
  'native-contract-unavailable' | 'protocol-contract-unavailable' |
  'extension-unchecked' | 'limit-unverified' | 'remote-input-unavailable' |
  'custom-client';
interface PreparedValidation {
  version: 1;
  route: RouteKind | 'custom';
  contract: 'responses-v1' | 'subscription-v1' | 'chat-v1' |
    'anthropic-v1' | 'gemini-v1' | 'bedrock-v1' | 'neutral-only-v1';
  status: 'checked' | 'partial' | 'invalid';
  coverage: 'final-protocol' | 'neutral-only' | 'unvalidated-protocol';
  native: 'absent' | 'preserved' | 'unverified' | 'incompatible';
  issues: readonly { rule: ValidationRule; site: ValidationSite }[];
  gaps: readonly CoverageGap[];
  omittedIssueCount: number;
}
type FinalRejectionReason = 'schema' | 'message-order' |
  'unsupported-parameter' | 'binding' | 'native-replay' | 'output-limit';
type FinalValidation =
  | { kind: 'accepted'; report: PreparedValidation }
  | { kind: 'rejected'; reason: FinalRejectionReason; report: PreparedValidation };
type FinalValidationPacket =
  | { readonly kind: 'http-json-body'; readonly bodyBytes: number }
  | { readonly kind: 'sdk-command-estimate'; readonly sdkCommandBytesEstimate: number };
type FinalValidator<T> = (actualBody: T, packet: FinalValidationPacket) => FinalValidation;
```

Use at most12 deduplicated rule/site pairs, closed/deduplicated gaps and a safe saturated omitted count. Constructor/sanitizer reconstructs explicit fields and rejects incoherent status/coverage/issues/route combinations. Rejected status must be invalid; accepted reports cannot smuggle rejecting issues. Native preserved means retained captured bytes/order, not cryptographic validity. Unknown native alternatives/extensions retain partial coverage and cannot claim final full checking.

Keep report construction/validation data-only so provider-error classification can inspect a well-formed attached report without a facts↔classify or public-index cycle. Error creation/assertion may live in a separate leaf. Typed local rejection requires an invalid report, canonical INVALID_ARGUMENT and a coherent reason; a malformed or accepted report cannot acquire local-rejection precedence. Validate request structure iteratively/boundedly; opaque tool schemas and argument JSON remain data, preserving existing2000/6000-depth preparation controls without inventing schema-validator semantics or recursively traversing arbitrary extensions.

Add optional createPreparedPayload.validate and PreparedModelRequest.validation for public custom compatibility; built-in C clients always supply the real validator/report. A seam reader produces explicit unvalidated/neutral-only evidence when a custom report is absent; do not mutate frozen custom handles or infer validation from a prepare method. D clients temporarily expose unvalidated-protocol/protocol-contract-unavailable with their existing local checks; R2D removes this built-in transitional fallback. No fabricated checked report or new send prohibition solely from missing C-stage coverage.

The packet context is calculated once from the already-created exact HTTP serialized string or typed SDK representation in derive, before describe, and the same byte length feeds the measurement. It is not a second serializer. The discriminated union prevents an SDK estimate from certifying an HTTP size gate. C adds this actual preparation callback input for the same validator boundary used by D; it introduces no guessed body/media ceiling. Native D preflight identified this required seam because a body-only callback cannot validate an evidenced HTTP byte limit without reserialization.

- [x] **Step 3: Implement final Responses/public and subscription rules.**

Validate root/model/input/tools and known item/content alternatives with noncoercing type guards. Enforce documented field bounds only where evidenced; do not guess a universal regex/ceiling for arbitrary custom extensions. Function arguments are a string containing valid JSON for the supported client-function contract; historical argument-schema/tool permission validation is not moved here. Do not require every historical function name to remain in the current tool registry.

Preindex visible local function_call call_id values and reject malformed/duplicate IDs. Walk in order with pending/completed sets. A normal call opens pending; one later function_call_output closes it. Reversed parallel sibling results are legal. Duplicate results, local output-before-call and unclosed ordinary visible calls fail. Reasoning, assistant narration and supported hosted items may remain interspersed; do not invent a new turn from assistant text or require each call immediately adjacent to its result.

An output with no call anywhere locally may refer to a supported **preceding** remote prefix (previous_response_id, conversation or earlier item_reference); it remains incomplete/unverified. A later reference cannot retroactively justify it. File/image/saved-prompt references alone are not proof of a remote call. Remote uncertainty never excuses an ordinary visible unclosed call.

Retained hosted types use their own alternatives and do not create local function obligations. Enumerate the actual current supported native discriminants from the mapper/continuation types, retaining their positions and fields. Unknown alternatives are not silently dropped. An unsupported unresolved async:true function call fails with unsupported-parameter/native-contract-unavailable; a complete retained async group may pass pairing with native coverage unverified. This repair adds no async execution lifecycle or inferred subscription feature.

Subscription uses a separately selected route contract: current final allowlist, store=false, stream=true, encrypted-reasoning include and IH namespace mapping; output cap remains absent/unsupported. Preserve existing endpoint/header construction guards and public string-input support. Do not transplant subscription rules into the public route.

Move the existing body.model!==config.model rejection from describeContext into final validation with binding reason. Preserve equal-model/other supported raw overrides and all request-cap precedence. Public official minimum16 is scoped by the existing explicit official-route recognition; custom minimum1 remains a syntactic/local rule with unverified backend floor, subscription unsupported. An applied cap remains a wire fact, not proof of vendor enforcement.

- [x] **Step 4: Implement final Chat group rules.**

Validate known role/content/tool shapes without global provider-name inference. Idle assistant tool_calls opens a sibling ID set; subsequent tool messages each close one in any sibling order. Unknown/duplicate tool_call_id fails; end or a non-tool message while pending fails. The initiating assistant's own content alongside calls is legal. Chat has no Responses remote-prefix exemption. Preserve explicitly supported reasoning_content and native data; portability/authenticity remain separate.

Fix1 ruling from independent review: known name/audio/tool_choice envelopes require value checks even when their field names are recognized. A valid non-null assistant.audio ID references earlier remote audio: preserve it with native-unverified/remote-input-unavailable and mark the existing descriptor input incomplete/server-referenced-context-unavailable. audio:null is absence and creates no remote gap; top-level generation audio options do not imply remote input. The main/summary consumers retain their existing incomplete-input protection; no lookup, new policy or second price owner. Nonstandard reasoning/thinking/enable_thinking raw fields retain explicit partial extension coverage.

Reject simultaneous max_tokens/max_completion_tokens and invalid configured cap-field values; preserve actual existing maxTokensField/raw/request precedence. Move the existing model mismatch check as above. Unknown model IDs remain usable; no catalog lookup or new current-tool membership requirement.

Fix1 nullable-cap ruling: each individually documented null cap remains accepted as no effective numeric cap, with original/derived/restored and matching request-cap precedence controls. This does not broaden the previously rejected simultaneous-field combinations. Known Responses reasoning.content is an optional array, not a generic string-content site; malformed known native containers retain native-replay attribution.

If an existing mapper produces an independently proven invalid group (for example a user image companion inserted before remaining sibling results), correct that encoder within its own route while preserving exchange/source associations and valid native order. Record the counterexample and semantic change. Do not make the validator repair history, synthesize results, rerun effects or delay user steering as a workaround.

Implementation ruling: the concrete image counterexample originates in the shared `conversation/project.ts:flushToolBlock`, which emits pendingToolImages before awaitingItemResults is clear. Root authorizes a narrow source-owner correction after actual-projector→Chat RED. Keep image companions and deferred input attached to their real owners until a legal whole group is assembled, but preserve them on end-of-projection/interrupted/unresolved/block-switch paths. deferredUser includes actual human text; it cannot be silently dropped or withheld from input admission. A completed invocation returning a background job handle is already a tool result and must permit new steering while the job continues. Cover both shapes; do not equate provider wire closure with waiting for a background job to finish.

- [x] **Step 5: Compose validation at preparation/confirmation and safe error boundaries.**

derive validates each actual final JSON-equivalent body before describe/output, freezes its report with its own handle and rejects malformed input immediately. Cap/restored-cap/repeated derivatives rerun the validator. Compose the immutable report assertion into B2's existing per-handle confirm sequence before a confirmation is emitted; do not add another guard owner, overwrite receipt/snapshot callbacks, rehash the body or duplicate the physical-send guard. C adapter direct stream, main and summary all reach the same path. Keep validation outside transport catches.

Main budget/admission and prepared-summary assert the selected report before capacity/reduction. The main owner's independent input/model/protocol binding check remains, but its plain MODEL_BINDING_MISMATCH string becomes the same canonical binding rejection. Summary's existing binding/opaque protection remains independently necessary. A schema/order/binding/native rejection cannot trigger shrinking or tools. Map errors to canonical INVALID_ARGUMENT plus the precise reason and bounded report; replace blanket output-limit for moved checks. Keep output-limit as its own reason. No field in this task may label these failures CONTEXT_WINDOW_EXCEEDED.

Extend safeModelFailureFacts and its actual SDK/gateway/Desktop consumers with the same sanitized validation report and canonical explanations. Classification honors a well-formed attached local validation report before message-based context inference, while preserving auth/abort/quota/TLS precedence and real remote context-limit parsing. INVALID_ARGUMENT remains terminal even retry mode:always. Hostile error text resembling context overflow cannot defeat the typed local reason. No raw provider message or validation value appears in diagnostics. No context/budget event or session-format widening is needed.

- [x] **Step 6: Prove independent positives/negatives and actual no-send behavior.**

Literal Responses FC(a)/FC(b)/OUT(b)/OUT(a) passes; missing output, output before a visible local call and duplicate output fail even with unknown legacy ownership. Define items directly with function_call/call_id/name/arguments and function_call_output/call_id/output, not through the mapper. Remote-prefix+output-only passes incomplete; remote-prefix+visible unclosed call fails. Earlier/later item-reference ordering, hosted/reasoning interleaving and complete versus unsupported unresolved async are distinct controls.

Literal Chat assistant calls a/b then tool b/a passes; a user/assistant message before both results, missing b, orphan/duplicate ID and conflicting cap fields fail. Actual main steering/background result and parallel result/image regression must preserve valid wire closure without duplicate tool effects or dropping new human input. A valid old tool name absent from today's registry remains replayable.

Use raw messages:null/input:[null], malformed argument text, wrong model, invalid cap and hostile diagnostics through actual adapter preparation. In a seam fixture, cap callback deliberately replaces messages with null: deriving it rejects before describe/confirm/execute. Count real validation calls for original/cap/restored/repeated derivatives. Mutation of caller data after prepare cannot change the report/body.

Positive direct/main/summary requests reach only fake transports; all negative cases prove zero sends, zero automatic compact and zero tool effect. Held-auth/confirmation paths retain snapshot/receipt checks. D/custom compatibility controls still execute with honest unvalidated coverage. Reports reject extra keys/types, including Object.prototype names and prototype-only required fields, stay≤4096bytes and contain none of the sentinel prompt/arg/signature/ID text. Explicitly test constructor/toString/__proto__ at nested report/issue levels and roundtrip consistency; B2's independent review found this exact class of allowlist bypass. Retain exact official15/16/custom1/subscription cap controls.

- [x] **Step 7: Run scoped gates, review and continue.**

Run sequential maxWorkers2/minWorkers1: full Responses and Chat suites, seam full, relevant main protocol-recovery/owned-budget/final-candidate/accepted-calibration, compaction summary, SDK server/protocol, Desktop runtime-diagnostics and six-route corpus; retain D-route prepared controls as staging regressions. Typecheck all changed packages and actual consumers/e2e. Verify exact reachability and reachable acyclic graph; no baseline edits or fake readers. Refresh a phase-owned copied Gateway probe showing typed malformed-request refusal and valid direct/main route behavior, plus relevant CLI/sanitizer compatibility when changed. Do not claim an old packaged artifact exercises newly added validators.

Retain meaningful RED/GREEN, corrections and all actual exit receipts. Report exact public contracts, per-route positive/negative matrix, old checks retired, classification/privacy behavior and remaining partial coverage. Fresh spec/quality review before R2D; no whole-program/release/native-authenticity or decomposition-completion claim.
