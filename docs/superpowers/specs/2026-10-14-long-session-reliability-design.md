# Long-session reliability design — current version repair

Approved scope: the original complete multi-protocol repair kept Desktop/gateway **0.1.12** through Tasks1–7. Human steering on 2026-10-15 adds Official Playwright compatibility/DSH comparison (7a), existing-IH ContextUsage styling (7u), and an explicit **v0.1.13-rc.1** candidate (7b). Root alone is authorized to report progress, push the reviewed branch and prepare a draft/prerelease candidate; formal publication is not implied. Broad v0.1.13 decomposition and event/instruction plans remain paused and are reported separately. No new live accounts/model APIs, installed application/profile changes or merge are authorized.

Evidence: [investigation](../../research/2026-10-14-model-http400-design-audit.md). Its four historical HTTP400 causes remain unverified because upstream bodies were discarded. This repair addresses proven defects with controlled provider/transport, persistence and actual request assertions; it must not claim to recover absent historical evidence.

Additional user-requested evidence: [provider-input comparison](../../research/2026-10-14-provider-input-comparison.md) covers Codex, DSH, ZCode, OpenCode private fork and cc-custom. Visible/disk history, serialized request bytes, provider tokens and server-referenced context are distinct. The comparison confirms a path-only unbounded file read and oversized synthetic failure partials; the narrow additions below address these within Task7.

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

Cap facts distinguish supported versus unsupported, effective/configured cap, source, minimum and managed reasoning budget. Public Responses and Codex subscription differ: the latter currently removes max_output_tokens, so a reserve must never be presented as an applied cap. Managed legacy Claude requires at least1025; raw reasoning options that need a larger floor are validated, not silently disabled. Conflicting Chat cap fields are diagnosed. Unknown external cached or server-referenced input cannot be labeled complete/fit; use a verified matching provider anchor or return an actionable incomplete/unavailable assessment when the fixed component cannot be priced. This includes public Responses previous_response_id/conversation options and Gemini cachedContent; small reference bytes are not the total server context.

The official public OpenAI endpoint has a verified max_output_tokens minimum16 ([API schema](https://developers.openai.com/api/reference/python/resources/responses/methods/create)); represent it in prepared cap facts and validate derivatives. Other Responses-compatible endpoints must not blindly inherit this floor; unverified route constraints stay explicit. Codex subscription still reports its unsupported/removed cap. Server-linked saved prompt templates and remote input-file references are also opaque input, not merely local reference-string tokens.

Raw-option precedence stays intact. Actual wire model must match the explicitly resolved host binding; another options.model target fails before using the old model's window/cap/attribution. Input overrides are measured as actual input and flagged. Fixed overrides that prevent recovery from reducing input lead to a clear blocked recovery.

Wrapper coverage is mandatory: waiting guard, retry, usage capture/bind, provider-runtime live binding, assembly stable handle, gateway session/manual-compaction signal wrapper, and core-agent sessionId compactor wrapper. Each wraps prepared streams and derivatives; it cannot return a raw inner handle. Logical retries reuse frozen input; physical attempts retain fresh timeout/controller/auth headers/usage records. Authentication/affinity is execution-time, not cold measurement. Context overflow escapes unchanged-payload retry even in always mode; ordinary transport/capacity policy remains separate.

## 2. Single Session budget authority and durable checkpoints

One core-agent context owner composes token-meter, current binding/limits, assessment and recovery fold. It supplies admission, compaction pressure, output cap, Agent.contextBudget(), registered get_context_remaining and service/UI queries. Every main/child/resident agent owns its own reader; no parent reader or usage anchor is reused through copied tools. Role/model/window/effort precedence stays intact; child dynamic prompts count whether code mode is on or off.

Full fallback pricing counts all actually projected input components using a documented conservative multilingual heuristic, with source/confidence explicit. Valid provider usage calibrates matching prefixes under the same binding/shape/rewrite revision. Both cache-inclusive and cache-exclusive reports normalize only for context size, never alter raw counters. Newly generated assistant/reasoning and local suffixes cannot disappear from pricing. Where reported output is used to price a generated assistant suffix, apply it once and account for protocol replay eligibility; do not add reported output then reprice the same assistant again.

The current LLMUsage has no replay-eligible output breakdown. Retain reported total output as billing/checkpoint evidence, but price generated suffixes from their actual prepared projection rather than applying that total to one assistant unit. A Responses generation can occupy several reasoning/function-call/message units; each projected component is charged once, while omitted native reasoning is not invented as input. The normalized accepted input prefix remains calibrated; the generated suffix remains heuristic until a later accepted input calibrates it. Opaque/image costs remain explicit estimates, not provider upper bounds or exact token counts.

Persist compact, owned scalar budget/usage facts and an optional prefix checkpoint: input prefix hash/unit count, shape/binding hashes, normalized reported input/output and heuristic prefix charge. Ephemeral unit vectors/payloads are never persisted. Restore a checkpoint only after owner, binding and prepared-prefix validation. Anonymous memory-only clients remain nonrecoverable. Parent operational facts in fork seeds do not become child facts; seed remapping/filtering is explicit.

The prepared bindingFingerprint certifies only its protocol/provider/model tuple. Add owned bindingConfigFingerprint and identityCoverage from a pure ContextBindingMetadata producer shared by executable binding resolution and metadata inspection. It hashes effective non-secret endpoint/request-affecting configuration, selected capabilities/limits and relevant settings content/revision; a revision counter alone is insufficient for manual/template changes. Secrets and sensitive opaque configuration are not persisted or hashed as equality evidence. Partial identity cannot restore calibration, and it cannot erase recovery-required facts. Every child and explicit summary binding uses its own metadata. SessionService modelMetadataFor reads loaded data without authentication or client creation; an absent metadata inspector returns unavailable for cold inspection.

New writable sessions use Session format2, with identity migration/backward cold import of format1; Desktop/package versions remain unchanged. Unsupported complete event types and operational payload versions are preflighted before any mutating repair, then reread/rechecked under ownership. Owned v1 acquisition upgrades its header durably before exposing a writable session. Add optional backend upgradeSessionFormat(id, expected, target) capability; JSONL uses synced atomic replacement preserving raw body bytes/metadata. Unsupported upgrade capability permits old read-only snapshots and refuses writable upgrade before repair. Fence create/meta downgrade, direct append and write-behind against operational-v1 writes. Flush outside the non-reentrant operation gate, call backend upgrade directly inside it, and preserve failed batch retention. Old v1 coordinator readers refuse a v2 header before their repair; arbitrary old direct-backend callers are outside that guarantee. Windows directory sync retains its actual best-effort limit.

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

Keep maxTokens as existing accepted-summary retention for compatibility. Add summaryMaxOutputTokens with preferred default4096 and optional summaryLimits for a separately configured summarizationModel. An explicitly configured summaryMaxOutputTokens is a hard ceiling. When absent, if the prepared minimumCap declares a reasoning floor that conflicts with4096, choose max(4096, minimumCap, reasoningBudget + accepted-retention token allowance), bounded by the summary binding's own max output and available input/window headroom. Otherwise keep the preferred4096; a positive reasoning budget without that declared floor conflict is not evidence for raising it or transplanting another protocol's semantics. For example8192 thinking plus1024 retention requires a default9216 ceiling where minimumCap is8193; an explicit4096 conflicts with that minimum and must fail before transport. Preserve reasoning effort/raw-option precedence, publish safe numeric effective-cap/default-adjustment facts, and never silently lower reasoning. Unsupported/unknown cap support remains honest. The main model cap/window is not borrowed for a distinct summary binding. Every summary goes through preparation/admission with the actual directive/system/tools/checkpoint/eligible reasoning, adapter floor and signal. Wire cap is independent from main384K; unknown distinct limits are represented honestly.

Retained summaries are not blindly sliced. Reject statically incoherent maxTokens/minSummaryChars before transport, e.g. a200-character retention ceiling with a500-character minimum. For a coherent policy, oversize output may receive one shorter-checkpoint request within the shared call bound; if still invalid, preserve history and fail soft. Validate the final retained checkpoint and complete response before committing. This preserves valid legacy retention ceilings while refusing lossy stumps.

Use eight total summary calls per pass, including quality retry, pieces and overflow shrink; at most two shrink retries per rejected piece within that shared bound. On confirmed summary overflow, reslice pending balanced segments at a strictly smaller prepared-input budget, without losing unprocessed segments. An indivisible/fixed prefix that cannot fit returns a precise failure. Cancellation/persistence errors escape fail-soft catches; Stop reaches transport, and is rechecked before commits. Refused/truncated/incomplete/degenerate summaries never commit a replacement.

Prune planning examines active projection and existing substitutions, deduplicates call identities, and measures the candidate surface rather than subtracting raw savings from already-pruned text. Identical markers are not progress. A new anchored summary explicitly shadows incorporated prior active summaries; do not globally discard all legacy summaries. This prevents growing old summaries and preserves raw audit. Undefined tool outputs must be safely priced/stringified. Per-model compaction policy receives the actual provider/model binding on creation and rebind.

## 5. Bounded confirmed-overflow recovery

The model-attempt owner, before completed-response/tool execution, catches only confirmed typed context overflow. Audit/suppress its partial output and unexecuted calls, close the failed physical step, append/flush an owned recovery-required event containing rejected input/binding fingerprint and numeric facts. This state survives meter invalidation/reload. It does not cancel background work or admit another model lane.

Forced recovery bypasses inaccurate auto pressure/sticky/hysteresis, not authorization or bounds. Apply local active prune; if needed summarize balanced older material under the independent summary budget. Reset is permitted only with protected current user/task/authority and complete outcome/checkpoint preservation; a blind last20-event cut is not acceptable. If protected/fixed content cannot fit, retain history and explain the blocked reason.

Before a rebuilt main request, require a changed prepared input and strict measured reduction under the same binding/shape, durable projection flush, and preserved protected content. Cap changes, diagnostic markers or calibration loss alone are not progress. Consume the once-per-logical-step rebuild allowance durably before transport. At most one rebuilt main call; a second overflow keeps recovery-required and returns a blocked reason. On later explicit input, do not resend known rejected context without progress merely because another 'continue' changed its hash. An explicitly changed model is freshly assessed under its own binding, not charged against the old window. Resolve rejection only after an accepted successful main attempt, not merely summary success.

Explicitly truncated or refused main responses cannot dispatch their tool batch, even when individual arguments look complete. Preserve audit and lawful not-dispatched result pairs, close the failed turn with its output/refusal diagnosis, and do not enter context recovery solely for truncation/refusal. They are not accepted main responses for calibration/checkpoint success or recovery resolution. This boundary matters when admission reduces the main output cap; it does not rewrite tool scheduling or replay earlier work.

Transport retries remain their own policy; core recovery never replays tools, failed-attempt batches, unknown dispatched work or provider-committed sideeffects. Summary/flush/Stop failures do not become a false resolved marker. Crash/reload at required, projection flush or retry-started cannot grant another automatic attempt. Parent facts inherited by child/fork do not consume or force the child's budget.

## 6. Bounded repeated reports and durable retrieval

Keep the existing64K ordinary-result spill policy and retention semantics. This repair additionally bounds shipping model-facing list/wait/task-output previews and completion notification text, while authoritative complete child/task results remain in the existing owned result store. A missing injected report policy preserves legacy package API behavior; production main/child registrations use the policy.

Production file read gains an injected model-facing range policy, with64,000UTF8 bytes as the default final JSON text budget including framing/metadata. Add offset_bytes/max_output_bytes and a digest guard; paged content and next_offset_bytes are UTF8-safe and monotonic, and a changed source rejects an old digest. Preserve existing path authorization/read-only ownership, small-file content behavior, and legacy path-only full read when the policy is absent. The source file remains the retrieval authority; do not promise immutable retained full content where none exists, or add a second store. Large reads must advertise the next page instead of creating a repeat-read/truncate loop.

Production synthetic failure projection preserves top-level canonical code/outcome and a meaningful bounded reason while retaining large partial/data text through the existing owned retention seam. Bound final model-facing text at the existing64,000 budget, preserve real image handling, and keep original audit/retention evidence where owned. A huge error reason needs an explicit retained reference and bounded preview, never a changed verdict or tool replay. Do not turn an arbitrary partial field or code-string collision into a universal spill exemption. Missing injected policy preserves legacy package behavior. Temporary spill retrieval must retain its actual expiry/GC limits, not claim durable full-result guarantees.

Default child preview2048UTF8 bytes; aggregate model report/notification16384bytes, including framing/metadata/ref notices. List pagination and digest cursors are stateless and additive. Page/full-result APIs remain authorized by existing task/job/session owner; a result digest mismatch prevents mixing pages from different followups. Explicit paged retrieval is bounded, and references grant no new authority. UI display may retain full text separately from model admission text.

Add putDocumentStrict on the existing persistence document chain/lease, preserving legacy putDocument semantics. The existing task/result owner uses a rejecting durability barrier before advertising durable full retrieval or waking a parent with a durable ref. Failed retention never reruns the child/tools or labels a completed sideeffect as never executed. Existing successful result remains inspectable; retention/delivery failure is visible and owned for cleanup/retry. Do not add a second registry/outbox/drain or implement the paused general work-completion framework.

## 7. Completion and verification

Eight cohesive implementation/review units follow the plan. Deterministic RED/GREEN covers thinking omission, all wrappers and five adapter variants, cache accounting, final wire versus snapshot, output-cap unsupported/floors/options, snapshots/fork/restore, classified versus ordinary400, one changed-context retry, prune/summary convergence, shared call limit, Stop/held persistence, active/background child survival, and paged report authority. A synthetic long-history fixture models the provided structure without committing private project transcripts.

Final fixed-tree checks include all affected tests/types, repository verification and reachability, plus isolated packaged CLI/SDK/Desktop gateway smoke with controlled Responses and Anthropic endpoints; adapter unit/integration contracts cover Gemini/Bedrock without live credentials. Do not invent platform qualification: historical native S14 evidence is39pass/4unsupported, not a fresh result;7b separately tests installer version/packaging compatibility. Final Desktop/gateway assertions use0.1.13-rc.1 and Windows numeric0.1.13.0, preserving other package rules. Root-only reviewed push/draft preparation and actual candidate builds are authorized, without formal publication/merge or resuming paused E/I/S work. The final review distinguishes detailed1332a465..HEAD repair/supplement inspection from the460a2aee9395dafe196eb31425dcc2c3fcdc259e..HEAD combined candidate manifest/prior-review/coupling assessment. Preserve evidence and report all original and added units before stopping.

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
  bindingConfigFingerprint?:string;identityCoverage:'complete'|'partial'
  inputPrefixFingerprint:string;inputUnitCount:number;heuristicPrefixTokens:number
  reportedInputTokens:number;reportedOutputTokens?:number;projectionRevision:number
}
type RequestBudgetSnapshot = {
  version:1;ownerSessionId:string;providerId?:string;modelId:string;protocol:string
  bindingFingerprint:string;bindingRevision:number;projectionRevision:number;neutralFingerprint:string
  bindingConfigFingerprint?:string;identityCoverage:'complete'|'partial'
  estimatedInputTokens:number;admissionInputTokens:number;contextWindow?:number
  estimateSource:'projected-heuristic'|'provider-anchor-plus-projection'|'neutral-only'
  coverage:ProjectedInputFacts['coverage'];confidence:'estimated'|'calibrated-mixed'|'unknown-components'
  roleTokens:{user:number;assistant:number;tool:number};systemTokens:number;schemaTokens:number;reasoningTokens:number
  outputReserve:number;effectiveOutputCap?:number;capSupport:'supported'|'unsupported'|'unknown'
  safetyMargin:number;remainingInputBudget?:number;admission:'fit'|'compact'|'unavailable'
  recoveryRequired:boolean;fullByProvider:boolean;reason?:string
}
type ContextBindingMetadata = {
  version:1;providerId?:string;modelId:string;protocol:string
  contextWindow?:number;maxOutputTokens?:number;reasoningEffort?:string
  bindingConfigFingerprint?:string;identityCoverage:'complete'|'partial'
}
```

Persistent budget/checkpoint/recovery shapes are data-only core-session types; token-meter imports/reexports the necessary checkpoint/snapshot types. llm-seam depends one-way on token-meter for prepared projection facts. No core-session dependency on adapters/seam/meter and no meter->seam cycle. Numeric values are finite nonnegative safe integers; source/category strings are closed validated enums in wire/persistence consumers. A scalar persisted event is bounded at4096UTF8 bytes. Input units are ephemeral, prefix validation uses one chain hash plus count, not repeated vectors in every event.

`prepareModelRequest(client,request)` is the llm-seam entry that chooses client.prepare or the explicit compatible neutral fallback. `wrapPreparedRequest(prepared,wrap)` composes derivatives/stream control without exposing raw execution. Protocol-specific descriptor functions own the mapping from actual input into shared token-meter counters; wrapper task tests define their own local collect/capture fixtures rather than adding a cross-package test framework.

`modelFailureFacts(error)` is the only safe error-facts extractor; cause traversal is bounded. Error facts preserve raw HTTP/RPC code fields separately. Authentication/known quota codes are not overridden by a quoted context phrase; generic invalid-request type may be refined only by reliable semantic code/message/parameter facts. Unknown body messages stay generic. Derived safe reason text, safe parameter/code/type/request ID and numeric limits provide useful diagnosis without raw response retention.

The production budget owner returns `BudgetRead`; context DTO retains existing estimatedTokens/window/roleTokens fields and adds the snapshot's explicit state. Fresh/cold reads without valid facts return unavailable. Direct legacy custom package consumers may obtain a marked neutral-only estimate; shipping UI/tools cannot secretly fall back to the old history-only counter. Incomplete fixed opaque input must not be labeled fit; absent reliable anchor/known cost returns a named unavailable reason. Supported caps finalize on the derivative; unsupported caps only reserve and explicitly state that no wire cap was applied.

Recovery events carry version1, ownerSessionId, recoveryId, logicalStepSeq, bindingFingerprint, rejectedInputFingerprint, state required/retry-started/resolved/blocked and bounded numeric/reason facts. The pure fold is `deriveContextRecovery(session,ownerSessionId)`; the budget owner consumes that same fold. Candidate progress compares noncalibrated prepared component cost/bytes, not a drop caused only by losing an anchor. Unchanged fixed overrides or protected input cause blocked recovery; earlier lawful tool results and raw source events are preserved.

## Supplemental user scope: Official plugin compatibility

The user added the Playwright marketplace installation failure and requested comparison with `D:/agent-complete/deepseek-harness-dsh-v0.2.1-alpha.2`. Complete this independent unit after Task 7's review gate and before Task 8's final qualification. Original units are not restarted.

The inspected official Playwright `.mcp.json` is a direct map `{playwright:{command:'npx',args:['@playwright/mcp@latest']}}`; existing IH common parsing requires a `mcpServers` wrapper. Normalize both accepted root dialects at their common parser so actual staged install/rekey and async/sync/runtime reads agree.

If the root has an own `mcpServers` property, wrapped precedence is mandatory and that field must pass existing object validation. An invalid wrapper never falls back to the direct dialect. Only absent wrappers treat the root as the server map. Preserve existing wrapped extra-field behavior, per-server fields/types, unsupported SSE skip, key namespacing/64-character handling, atomic staging/rollback and external source immutability. Never merge mixed wrapped/direct entries. The literal direct server name `mcpServers` remains ambiguous/reserved under this documented rule.

Use the exact official six-line fixture in controlled local tests: actual public install → rekey → async read → sync/runtime read, and invalid/array/malformed-wrapper atomic rollback with previous install intact and candidate cleanup. Preserve strict existing controls and unsupported SSE behavior. Research-only evidence or missing API/setup is not behavioral RED. No live clone/npm/plugin installation, `npx` execution, account/profile or source-tree mutation; use isolated synthetic fixtures/injected runners.

Save the bounded DSH comparison and future source/version/status/loader/diagnostic suggestions in a tracked research document, distinguishing DSH Cordis/NPM runtime providers from IH Claude-market files/skills/hooks/MCP. Do not add DSH bundles, native providers, MCP bundles or new manifest features in 0.1.12. No claims about uninspected README/full installer bodies or screenshot features.

Fresh GPT6.1Sol implementer and scoped spec/quality reviewer, one product writer, meaningful RED/GREEN and affected contracts/types apply unchanged. Task 8's final repair range and report include this supplement. Tasks preceding7b retain historical Desktop/gateway0.1.12;7b implements the explicitly selected0.1.13-rc.1 candidate. Latest human steering authorizes Root-only reviewed branch push and draft/candidate preparation after this unit; no formal publication is implied. Implementers do not write remotes, create PRs, merge, install or use live APIs; paused decomposition stays paused. Task8 evidence is still required for release-ready claims.

## Supplemental user scope: ContextUsage in the existing IH style

The user explicitly requested that the previously demonstrated context interface follow IH's original style. Root has explained the bounded existing-style contract; routine permission is not requested again. Implement independent 7u after plugin 7a and before release 7b/final8, using a fresh Sol implementer and fresh scoped review.

Preserve Task6's actual owner DTO/data and all available facts, unavailable/postaccepted/provider-full semantics, no invented healthy percentage, scalar-only refresh/zero inspection preparation, natural zh/en copy, grants, response epochs and focus/hover/Escape interactions. This is a local presentation change, not a new architecture or data-flow task.

Root inspected current ContextUsage.tsx and ContextUsage.css completely, relevant Desktop tokens and the original 460a component render/partial lifecycle. Existing IH popover metrics are `width:min(310px,calc(100vw - 32px))`, padding14, `--ih-divider` border, radius10, `--ih-panel` background, shadow `0 12px 36px #0005`, body font12/title13. Role rows use gap7, muted labels, `--ih-text` values and tabular numerals; preserve existing blue/purple/yellow role markers.

Use consistent label/value rows for the currently bare diagnostic facts, modest grouping and muted readable source/confidence explanation. Give primary capacity/remaining facts a clear hierarchy without hiding facts or introducing a details interaction. Use the existing `packages/desktop/src/renderer/vendor/opencode/Button.tsx` (secondary or ghost, small, existing loadingLabel support) for Refresh status; do not copy a button implementation or edit vendor code. Add no palette/design system/package.

Reuse meaningful existing DTO/interaction tests rather than asserting CSS implementation strings. Capture the actual production component and Desktop styles for en/zh at390/900, plus a necessary short-viewport scroll/access check. A direct popover element screenshot or representative IH composer-adjacent fixture is appropriate; remove large Controlled/test headings from the presented artifact so they cannot be mistaken for product UI. State explicitly that captures are component fixtures, not installed/native qualification. Preserve prior original/localized screenshot evidence.

Root only inspected sources and does not modify product. The original full event-driven/decomposition work stays paused. Current repair/plugin/style/release preparation and Task8 verification continue; Root exclusively handles authorized GitHub writes and actual candidate packaging.

## Supplemental user scope: v0.1.13-rc.1 candidate compatibility

The user selected v0.1.13-rc.1 after authorizing reviewed GitHub branch push and release preparation. Implement this independent 7b unit after the plugin supplement gate and before Task 8 qualification. Original event-driven and decomposition plans remain paused; preparation is a draft/prerelease candidate, not formal publication.

Desktop and gateway release package versions change together to `0.1.13-rc.1`. Other private monorepo, CLI and SDK versions follow existing ownership rules rather than being blanket-bumped. Keep Session format2, context events1 and task documents1 unchanged. Preserve full validated application/display semver in version identity, payload/gateway consistency, ownership markers, Uninstall DisplayVersion and uninstaller equality.

The inspected installer currently rejects prereleases in `packages/desktop/scripts/build-installer.mjs` and uses `VIProductVersion "${APP_VERSION}.0"` at `packages/desktop/installer/desktop.nsi:41`. Separate validated application/display version `0.1.13-rc.1` from validated Windows four-part numeric PE version `0.1.13.0`. Never truncate rc identifiers for markers/equality. Stable versions remain supported; malformed versions, unsafe characters and values not representable in Windows numeric version fields are rejected before packaging. Do not bypass payload/gateway consistency or path-safety validation.

Existing ProductVersion/FileVersion string fields at NSI lines43/45, markerVersion510, Uninstall DisplayVersion536 and equality561 retain the full application semver. The root inspection was source evidence only, not a new executed installer test. Fresh meaningful RED/GREEN uses the existing installer-builder test and installer fixture/lifecycle/destination/safety controls; it does not run a real installation or uninstall the current app.

`package-app.mjs` gains optional `IH_DESKTOP_GATEWAY_DIR` to consume the same fresh qualified runtime produced by Task8. Absence preserves the existing `packages/desktop/.gateway-dist` source. Explicit input resolves to an existing canonical repository-contained runtime directory, retains existing payload/version validation and is copied read-only. Reject input/output overlap before cleanup, so a qualified runtime cannot be removed or recursively copied into itself. Existing `IH_DESKTOP_RELEASE_LABEL` and default output behavior remain; no release framework is added.

Root exclusively owns GitHub writes and actual portable/installer packaging. Root validates final output's absolute path, intended directory ownership and nonexistence before invoking the existing packager. Task8 and Root share a single runner reservation so tests and builds do not overlap. Reuse Task8's qualified candidate rather than rebuild or overwrite the default bundle. Existing local makensis/NSIS resources are available; no installed app lifecycle or profile is changed.

Fresh GPT6.1Sol implementation and independent spec/quality review, one product writer, meaningful RED/GREEN, affected tests/types and local commits apply. Final Task8 asserts the candidate version and qualifies actual packaged runtime; the final repair+plugin+release preparation range includes this metadata/support unit. Reports separate current repair/plugin/release status from the still-paused original event-driven and decomposition progress. No live model API/account, installed app changes, automatic formal publication or paused-plan implementation.
