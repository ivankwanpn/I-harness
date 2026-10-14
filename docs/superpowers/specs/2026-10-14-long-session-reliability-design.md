# Long-session reliability design — current version repair

Approved scope: user explicitly requests complete repair after the 2026-10-14 investigation, including the multi-protocol design, and asks to remain on the current version. Desktop version remains **0.1.12**. Work is on the existing development branch; the broad v0.1.13 decomposition and event/instruction plans remain paused. No live accounts, installed application/profile, release, version bump or external publication is part of this repair.

Evidence: [investigation](../../research/2026-10-14-model-http400-design-audit.md). Its four historical HTTP400 causes remain unverified because upstream bodies were discarded. This repair addresses proven defects with controlled provider/transport, persistence and actual request assertions; it must not claim to recover absent historical evidence.

## Binding constraints

- All delegated implementation/review/research uses GPT6.1Sol; one product writer at a time, no recursive agents. Fresh scoped reviews and one final repair-range review.
- Preserve five protocol families and the distinct Codex subscription route: Responses public/subscription, OpenAI-compatible Chat, Anthropic Messages, Gemini, Bedrock Converse. Cache, usage, signatures, role/block order, namespace, images and raw route-option precedence stay protocol-owned.
- Original Session history and executed tool outcomes remain intact. Recovery cannot replay tools, silently remove the current user input, grant a new scope, or cancel unrelated background work. Ordinary400 is a turn failure; explicit Stop/host close retains its existing authority.
- No request bodies, credentials, signatures, image bytes or per-message hash vectors enter logs. Diagnostic facts are validated scalar allowlists. Actual billing counters and cache semantics remain unchanged.
- Tests/tool scripts are not decomposition targets. Related new code uses cohesive modules/public package entries. No reachability reseed, exemptions or synthetic consumers; semantic finding changes must be explained.
- Meaningful RED/GREEN before behavior changes; controlled fixtures only; suites sequential with maxWorkers2/minWorkers1. Reuse unchanged evidence, repeat only after real changes/failures/gaps.

## 1. One prepared input, through every wrapper

Add an optional prepared capability to ModelClient; existing stream(request) stays source compatible. Every built-in adapter implements preparation, and its stream delegates through it. Custom clients use an explicitly neutral-only fallback with honest coverage; an unknown context window stays unavailable rather than inventing a model limit.

```ts
interface PreparedModelRequest {
  readonly measurement: PreparedRequestMeasurement
  withOutputCap(cap: number | undefined): PreparedModelRequest
  stream(control?: PreparedStreamControl): AsyncIterable<LLMStreamEvent>
}
interface ModelClient {
  stream(request: LLMRequest): AsyncIterable<LLMStreamEvent>
  prepare?(request: LLMRequest): Promise<PreparedModelRequest>
}
interface PreparedStreamControl {
  signal?: AbortSignal
  onStreamActivity?: LLMRequest['onStreamActivity']
  onTerminalResponse?: LLMRequest['onTerminalResponse']
}
```

Preparation captures input and input-affecting options once, projects images/continuation eligibility once, builds the actual final adapter input once, and retains an ephemeral immutable payload in its closure. Numeric cap derivatives alter only adapter-owned generation fields; they do not reread input/options/selection or remap images/reasoning. Omitted controls preserve captured controls. No raw send closure escapes the waiting/retry/capture layers.

token-meter owns ProjectedInputFacts and pure common pricing. Adapter-owned descriptors visit the **final** input after option spreads, cache metadata and subscription filtering. Facts include actual protocol/provider/model identity, shape/input hashes, ordered ephemeral unit hashes/roles/prices, component bytes/prices for system/schema/text/args/results/replayed reasoning/opaque continuation/images/other input, and explicit completeness/uncertainties. Four HTTP adapters record exact JSON UTF8 body bytes; Bedrock records SDK command estimates unless SDK serialization provides exact bytes. Body bytes are not provider tokens. Continuation backup JSON is not counted twice; dropped reasoning is not counted as replayed; image base64 transport is not priced as plain text.

Cap facts distinguish supported versus unsupported, effective/configured cap, source, minimum and managed reasoning budget. Public Responses and Codex subscription differ: the latter currently removes max_output_tokens, so a reserve must never be presented as an applied cap. Managed legacy Claude requires at least1025; raw reasoning options that need a larger floor are validated, not silently disabled. Conflicting Chat cap fields are diagnosed. Unknown external cached input cannot be labeled complete/fit; use a verified matching provider anchor or return an actionable incomplete/unavailable assessment when the fixed component cannot be priced.

Raw-option precedence stays intact. Actual wire model must match the explicitly resolved host binding; another options.model target fails before using the old model's window/cap/attribution. Input overrides are measured as actual input and flagged. Fixed overrides that prevent recovery from reducing input lead to a clear blocked recovery.

Wrapper coverage is mandatory: waiting guard, retry, usage capture/bind, provider-runtime live binding, assembly stable handle, gateway session/manual-compaction signal wrapper, and core-agent sessionId compactor wrapper. Each wraps prepared streams and derivatives; it cannot return a raw inner handle. Logical retries reuse frozen input; physical attempts retain fresh timeout/controller/auth headers/usage records. Authentication/affinity is execution-time, not cold measurement. Context overflow escapes unchanged-payload retry even in always mode; ordinary transport/capacity policy remains separate.

## 2. Single Session budget authority and durable checkpoints

One core-agent context owner composes token-meter, current binding/limits, assessment and recovery fold. It supplies admission, compaction pressure, output cap, Agent.contextBudget(), registered get_context_remaining and service/UI queries. Every main/child/resident agent owns its own reader; no parent reader or usage anchor is reused through copied tools. Role/model/window/effort precedence stays intact; child dynamic prompts count whether code mode is on or off.

Full fallback pricing counts all actually projected input components using a documented conservative multilingual heuristic, with source/confidence explicit. Valid provider usage calibrates matching prefixes under the same binding/shape/rewrite revision. Both cache-inclusive and cache-exclusive reports normalize only for context size, never alter raw counters. Newly generated assistant/reasoning and local suffixes cannot disappear from pricing. Where reported output is used to price a generated assistant suffix, apply it once and account for protocol replay eligibility; do not add reported output then reprice the same assistant again.

Persist compact, owned scalar budget/usage facts and an optional prefix checkpoint: input prefix hash/unit count, shape/binding hashes, normalized reported input/output and heuristic prefix charge. Ephemeral unit vectors/payloads are never persisted. Restore a checkpoint only after owner, binding and prepared-prefix validation. Anonymous memory-only clients remain nonrecoverable. Parent operational facts in fork seeds do not become child facts; seed remapping/filtering is explicit.

```ts
type BudgetRead =
  | { kind:'ready'; snapshot: RequestBudgetSnapshot }
  | { kind:'unavailable'; reason:string }
```

Snapshot contains window, complete estimated/admission input, source/confidence/coverage, role/system/schema/reasoning breakdown, reserve/cap support, margin/remaining input, binding/projection revisions and recovery-required/full-by-provider state. A provider-full signal is distinct from an invented100% estimate. Automatic pressure uses complete input and output reserve/headroom; the supported wire cap is finalized on the same prepared handle and rechecked for feasibility. A configured output ceiling is preserved as a ceiling, not promised usable output when input has filled the window.

Admission runs after claimed user/steer and pre-step context/catalogue changes. Recheck binding and model-visible history after awaits and immediately before transport. Control-only log events cannot manufacture stale-input failures. A stale candidate is rebuilt at most three times without rerunning hooks/claiming more inbox inputs; persistent instability fails explicitly. New budget facts are checkpointed before transport when persistence is configured; rejected checkpoint means no model sideeffect.

UI/tool reads are scalar, read-only and never prepare/stream/refresh auth or record usage. Live reads use the actual owner. Cold reads use validated saved facts; missing/mismatched/stale facts show unavailable/estimate status, not a healthy history-only percentage. Old logs remain readable. New budget metadata and operational recovery events have version1 validation; operational recovery evidence cannot silently disappear in a reader that does not support it. Explicit unsupported-reader behavior must be nondestructive.

## 3. Structured errors and safe diagnostics

One llm-seam ModelFailureFacts contract survives Error causes, agent wrapping, SDK RPC error data, desktop status, toast and diagnostic recorder. Preserve legacy message fields; add safe details rather than replace JSONRPC numeric codes.

Facts include canonical code, HTTP status, safe provider code/type/parameter/request ID, normalized reason category and parsed numeric limit facts where available. Reason text is derived/bounded/redacted through an explicit allowlist; raw bodies/prompt echoes/auth are not diagnostic data. HTTP error-body reading is bounded and cancelled after the limit; a body-read stall retains the existing terminal-response timeout semantics.

Specific semantic context codes/messages take precedence over generic invalid_request_error/ValidationException. AUTH/QUOTA/ABORT/TLS retain their authority. Recognize CONTEXT_TOO_LONG and validated provider formats. Bare400/413, schema errors or a context phrase merely quoted inside invalid tool data do not trigger context recovery. Request-too-large and output-limit remain distinct diagnoses. Bedrock SDK errors use the same safe classification without replacing SDK transport.

Physical prepared-request facts, binding/window/reserve, estimate source and compaction decisions/outcome are logged and retained as bounded numeric facts. Runtime close generation/reason is recorded at existing close owners; ordinary model failure does not close workspace/project scope. No new lifetime/daemon framework or broad scope-retirement work is included.

## 4. Correct bounded compaction and independent summary budget

Keep maxTokens as existing accepted-summary retention for compatibility. Add summaryMaxOutputTokens default4096 and optional summaryLimits for a separately configured summarizationModel. The main model cap/window is not borrowed for a distinct summary binding. Every summary goes through preparation/admission with the actual directive/system/tools/checkpoint/eligible reasoning, adapter floor and signal. Wire cap is independent from main384K; unknown distinct limits are represented honestly.

Use eight total summary calls per pass, including quality retry, pieces and overflow shrink; at most two shrink retries per rejected piece within that shared bound. On confirmed summary overflow, reslice pending balanced segments at a strictly smaller prepared-input budget, without losing unprocessed segments. An indivisible/fixed prefix that cannot fit returns a precise failure. Cancellation/persistence errors escape fail-soft catches; Stop reaches transport, and is rechecked before commits. Refused/truncated/incomplete/degenerate summaries never commit a replacement.

Prune planning examines active projection and existing substitutions, deduplicates call identities, and measures the candidate surface rather than subtracting raw savings from already-pruned text. Identical markers are not progress. A new anchored summary explicitly shadows incorporated prior active summaries; do not globally discard all legacy summaries. This prevents growing old summaries and preserves raw audit. Undefined tool outputs must be safely priced/stringified. Per-model compaction policy receives the actual provider/model binding on creation and rebind.

## 5. Bounded confirmed-overflow recovery

The model-attempt owner, before completed-response/tool execution, catches only confirmed typed context overflow. Audit/suppress its partial output and unexecuted calls, close the failed physical step, append/flush an owned recovery-required event containing rejected input/binding fingerprint and numeric facts. This state survives meter invalidation/reload. It does not cancel background work or admit another model lane.

Forced recovery bypasses inaccurate auto pressure/sticky/hysteresis, not authorization or bounds. Apply local active prune; if needed summarize balanced older material under the independent summary budget. Reset is permitted only with protected current user/task/authority and complete outcome/checkpoint preservation; a blind last20-event cut is not acceptable. If protected/fixed content cannot fit, retain history and explain the blocked reason.

Before a rebuilt main request, require a changed prepared input and strict measured reduction under the same binding/shape, durable projection flush, and preserved protected content. Cap changes, diagnostic markers or calibration loss alone are not progress. Consume the once-per-logical-step rebuild allowance durably before transport. At most one rebuilt main call; a second overflow keeps recovery-required and returns a blocked reason. On later explicit input, do not resend known rejected context without progress merely because another 'continue' changed its hash. An explicitly changed model is freshly assessed under its own binding, not charged against the old window. Resolve rejection only after an accepted successful main attempt, not merely summary success.

Transport retries remain their own policy; core recovery never replays tools, failed-attempt batches, unknown dispatched work or provider-committed sideeffects. Summary/flush/Stop failures do not become a false resolved marker. Crash/reload at required, projection flush or retry-started cannot grant another automatic attempt. Parent facts inherited by child/fork do not consume or force the child's budget.

## 6. Bounded repeated reports and durable retrieval

Keep the existing64K generic spill guard and its semantics. This repair additionally bounds shipping model-facing list/wait/task-output previews and completion notification text, while authoritative complete child/task results remain in the existing owned result store. A missing injected report policy preserves legacy package API behavior; production main/child registrations use the policy.

Default child preview2048UTF8 bytes; aggregate model report/notification16384bytes, including framing/metadata/ref notices. List pagination and digest cursors are stateless and additive. Page/full-result APIs remain authorized by existing task/job/session owner; a result digest mismatch prevents mixing pages from different followups. Explicit paged retrieval is bounded, and references grant no new authority. UI display may retain full text separately from model admission text.

Add putDocumentStrict on the existing persistence document chain/lease, preserving legacy putDocument semantics. The existing task/result owner uses a rejecting durability barrier before advertising durable full retrieval or waking a parent with a durable ref. Failed retention never reruns the child/tools or labels a completed sideeffect as never executed. Existing successful result remains inspectable; retention/delivery failure is visible and owned for cleanup/retry. Do not add a second registry/outbox/drain or implement the paused general work-completion framework.

## 7. Completion and verification

Eight cohesive implementation/review units follow the plan. Deterministic RED/GREEN covers thinking omission, all wrappers and five adapter variants, cache accounting, final wire versus snapshot, output-cap unsupported/floors/options, snapshots/fork/restore, classified versus ordinary400, one changed-context retry, prune/summary convergence, shared call limit, Stop/held persistence, active/background child survival, and paged report authority. A synthetic long-history fixture models the provided structure without committing private project transcripts.

Final fixed-tree checks include all affected tests/types, repository verification and reachability, plus isolated packaged CLI/SDK/Desktop gateway smoke with controlled Responses and Anthropic endpoints; adapter unit/integration contracts cover Gemini/Bedrock without live credentials. No native source changes are planned; do not invent new platform qualification. Version assertions stay0.1.12. No merge/release, remaining decomposition or further feature work starts after this repair. Save the checkpoint and stop.

## Contract appendix for independent tasks

The proposed fields below are the common vocabulary. Private helper names may change within a task; public producer/consumer contracts must be updated together and recorded, not guessed by the next worker.

```ts
type ModelFailureFacts = {
  code: string
  httpStatus?: number
  providerCode?: string
  providerType?: string
  parameter?: string
  requestId?: string
  reason?: 'context-limit'|'output-limit'|'request-size'|'schema'|'message-order'|'unsupported-parameter'|'unknown'
  inputTokens?: number
  contextLimit?: number
  outputLimit?: number
  message: string // derived safe explanation, never raw body or prompt echo
}
type ComponentFacts = {
  textUtf8Bytes:number; structuredBytes:number; binaryBytes:number
  imageCount:number; blockCount:number; heuristicTokens:number
}
type InputComponent = 'system'|'toolSchemas'|'visibleText'|'toolArguments'|'toolResults'|
  'replayedReasoning'|'opaqueContinuation'|'images'|'otherInput'|'framing'
type ProjectedInputFacts = {
  version:1; protocol:string; providerId?:string; modelId:string; expectedModelId?:string
  bindingFingerprint:string; shapeFingerprint:string; inputFingerprint:string
  units:readonly {fingerprint:string;role?:'user'|'assistant'|'tool';heuristicTokens:number}[]
  components:Readonly<Record<InputComponent,ComponentFacts>>
  coverage:'complete'|'neutral-only'|'incomplete'; uncertainties:readonly string[]
  overriddenInputFields:readonly ('model'|'system'|'messages'|'tools')[]
}
type PreparedRequestMeasurement = {
  projectionId:string; input:ProjectedInputFacts
  output:{capSupport:'supported'|'unsupported'|'unknown';configuredCap?:number;effectiveCap?:number;
    minimumCap:number;reasoningBudget?:number;source:'request'|'route'|'adapter-default'|'provider-default'}
  packet:{sizeKind:'http-json-body'|'sdk-command-estimate'|'neutral-envelope-estimate';
    bodyBytes?:number;sdkCommandBytesEstimate?:number;inlineBinaryBytes:number;cacheMetadataBytes:number;signatureBytes:number}
}
type ContextUsageCheckpoint = {
  version:1;ownerSessionId:string;bindingFingerprint:string;shapeFingerprint:string
  inputPrefixFingerprint:string;inputUnitCount:number;heuristicPrefixTokens:number
  reportedInputTokens:number;reportedOutputTokens?:number;projectionRevision:number
}
type RequestBudgetSnapshot = {
  version:1;ownerSessionId:string;providerId?:string;modelId:string;protocol:string
  bindingFingerprint:string;bindingRevision:number;projectionRevision:number;neutralFingerprint:string
  estimatedInputTokens:number;admissionInputTokens:number;contextWindow?:number
  estimateSource:'projected-heuristic'|'provider-anchor-plus-projection'|'neutral-only'
  coverage:ProjectedInputFacts['coverage'];confidence:'estimated'|'calibrated-mixed'|'unknown-components'
  roleTokens:{user:number;assistant:number;tool:number};systemTokens:number;schemaTokens:number;reasoningTokens:number
  outputReserve:number;effectiveOutputCap?:number;capSupport:'supported'|'unsupported'|'unknown'
  safetyMargin:number;remainingInputBudget?:number;admission:'fit'|'compact'|'unavailable'
  recoveryRequired:boolean;fullByProvider:boolean;reason?:string
}
```

Persistent budget/checkpoint/recovery shapes are data-only core-session types; token-meter imports/reexports the necessary checkpoint/snapshot types. llm-seam depends one-way on token-meter for prepared projection facts. No core-session dependency on adapters/seam/meter and no meter->seam cycle. Numeric values are finite nonnegative safe integers; source/category strings are closed validated enums in wire/persistence consumers. A scalar persisted event is bounded at4096UTF8 bytes. Input units are ephemeral, prefix validation uses one chain hash plus count, not repeated vectors in every event.

`prepareModelRequest(client,request)` is the llm-seam entry that chooses client.prepare or the explicit compatible neutral fallback. `wrapPreparedRequest(prepared,wrap)` composes derivatives/stream control without exposing raw execution. Protocol-specific descriptor functions own the mapping from actual input into shared token-meter counters; wrapper task tests define their own local collect/capture fixtures rather than adding a cross-package test framework.

`modelFailureFacts(error)` is the only safe error-facts extractor; cause traversal is bounded. Error facts preserve raw HTTP/RPC code fields separately. Authentication/known quota codes are not overridden by a quoted context phrase; generic invalid-request type may be refined only by reliable semantic code/message/parameter facts. Unknown body messages stay generic. Derived safe reason text, safe parameter/code/type/request ID and numeric limits provide useful diagnosis without raw response retention.

The production budget owner returns `BudgetRead`; context DTO retains existing estimatedTokens/window/roleTokens fields and adds the snapshot's explicit state. Fresh/cold reads without valid facts return unavailable. Direct legacy custom package consumers may obtain a marked neutral-only estimate; shipping UI/tools cannot secretly fall back to the old history-only counter. Incomplete fixed opaque input must not be labeled fit; absent reliable anchor/known cost returns a named unavailable reason. Supported caps finalize on the derivative; unsupported caps only reserve and explicitly state that no wire cap was applied.

Recovery events carry version1, ownerSessionId, recoveryId, logicalStepSeq, bindingFingerprint, rejectedInputFingerprint, state required/retry-started/resolved/blocked and bounded numeric/reason facts. The pure fold is `deriveContextRecovery(session,ownerSessionId)`; the budget owner consumes that same fold. Candidate progress compares noncalibrated prepared component cost/bytes, not a drop caused only by losing an anchor. Unchanged fixed overrides or protected input cause blocked recovery; earlier lawful tool results and raw source events are preserved.
