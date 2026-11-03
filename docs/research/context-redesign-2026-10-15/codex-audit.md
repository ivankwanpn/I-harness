# Codex Rust 0.162.1 context architecture audit

Audit date: 2026-10-15. Reference: `D:/ih_reference_project/codex-rust-v0.162.1`. Read-only source audit for IH redesign (IH baseline supplied by coordinator: `81bca938`, branch `codex/v0.1.13-development`). No reference/product files changed, dependency installation, account/profile inspection, live provider calls, builds, or test suites. No agents spawned. No applicable AGENTS.md found at reference root, parent directories, IH root, or audited subtrees; the reference contains one TUI bottom-pane AGENTS.md outside this audit's scope.

Version is proven by `D:/ih_reference_project/codex-rust-v0.162.1/codex-rs/Cargo.toml:163` (`version = "0.162.1"`). `git rev-parse HEAD` fails because the supplied reference has no `.git`; its precise upstream commit and unmodified provenance cannot be established. Findings below describe this source snapshot, not an unverified current hosted backend or every installed Codex release.

## Executive findings

1. A 100+ MB rollout is an archive, not a model request. Codex separates durable rollout records, reconstructed active model history, retained host facts, normalized prompt input, and physical transport payload. Complete compaction checkpoints let new paginated storage read only a suffix; legacy loading still parses the full archive. Neither loader claims the model consumes the entire archive.
2. The most transferable design is **checkpoint + newer suffix + stable provenance + explicit protocol projection**, not a larger token limit. Tool-output history truncation happens on a clone while prepared original output is persisted; replay restores the originating truncation budget. Checkpoints persist the actual replacement history, model compatibility identity, world state, and resume metadata.
3. Codex's accounting is practical, not exact. It uses last provider usage plus locally added item estimates, distinguishes cumulative billing usage from active-window usage, reserves percentage headroom, and refreshes estimates after compaction. A four-UTF-8-bytes/token heuristic and model-specific image/reasoning approximations remain.
4. Codex is not proof that all payload/HTTP400 failures self-heal. Raw HTTP400 context error bodies are not generally mapped to ContextWindowExceeded; normal sampling does not universally compact-and-retry on an overflow. The explicit recovery branch is once per Guardian model step. Remote compaction can also fail from an oversized prompt.
5. The apparent 15 MiB wire budget is a **soft budget for optional executed-tool metadata only**. It does not guarantee total request size. Ordinary content alone may exceed it. Images and encrypted tool output also bypass ordinary text-output truncation.
6. Public API-key and Codex subscription routes share a Responses-oriented core but have different endpoints, auth, compression eligibility, and backend metadata. Opaque compaction and encrypted reasoning are protocol objects, not portable text summaries. Do not copy private-server behavior into IH's generic provider contract.

## 1. Data planes and end-to-end call chains

### Durable archive versus model window

`Session::record_conversation_items` prepares media and assigns durable identity, then `record_prepared_conversation_items` saves per-output history budgets, records active history, and persists the envelopes as RolloutItem::ResponseItem. The active-history recorder clones each input before truncation, so the persisted prepared envelope retains the fuller output. Sources:

- `D:/ih_reference_project/codex-rust-v0.162.1/codex-rs/core/src/session/mod.rs:3344` (media preparation), `:3467` (entry point), `:3497` (persist originating budget), `:3581` (active-history record), `:3593` (persist originals).
- `D:/ih_reference_project/codex-rust-v0.162.1/codex-rs/core/src/context_manager/history.rs:515` explicitly documents live-history-only truncation; `:552` clones the item, `:565` truncates FunctionCallOutput/CustomToolCallOutput, `:593` pushes processed clone.
- `D:/ih_reference_project/codex-rust-v0.162.1/codex-rs/rollout/src/recorder.rs:1049` queues canonical rollout records, `:2089` wraps timestamp and ordinal, `:2108` JSON-serializes each record, appends newline, writes and flushes.

“Original” here means **prepared and stamped output at the durable boundary**, not necessarily the raw subprocess byte stream or original unresized image. Tools can already truncate their emitted result, and media preparation can resize/reencode/store it before recording (`core/src/session/mod.rs:3344`). This distinction matters for IH artifact retention promises.

`ContextManager` is the active ordered history (`Arc<Vec<ResponseItemEnvelope>>`) plus separate retained context, optional Guardian review history, history/reset/user revisions, token info, and context/world-state baselines. Read snapshots share allocations until mutation. Source: `D:/ih_reference_project/codex-rust-v0.162.1/codex-rs/core/src/context_manager/history.rs:93`, `:129`, `:254`.

### Resume/replay

Legacy path:

`RolloutRecorder::get_rollout_history -> load_rollout_items -> read_rollout_lines -> parse each JSON line -> Vec<RolloutItem> -> InitialHistory::Resumed -> Session::reconstruct_history_from_rollout -> install reconstructed history`.

The legacy parser streams lines but retains every parsed item; it does not impose a 100 MB model window. Malformed JSON/unsupported decoded lines are counted and skipped. The first SessionMeta is canonical. Sources: `D:/ih_reference_project/codex-rust-v0.162.1/codex-rs/rollout/src/recorder.rs:1105`, `:1120`, `:1139`, `:1149`, `:1173`.

Paginated path:

`LocalThreadStore::load_latest_model_context -> load_from_rollout_path -> resolve_rollout_lineage -> ReverseJsonlScanner over newest lineage segments -> ModelContextScan -> latest complete checkpoint + suffix`.

The scanner stops at the newest checkpoint carrying **both replacement history and window number**. A newer legacy/incomplete checkpoint forces full replay; it cannot stop at an older complete checkpoint. Fork lineage contributes local deltas and frozen byte-offset bounds. Sources:

- `D:/ih_reference_project/codex-rust-v0.162.1/codex-rs/thread-store/src/local/model_context.rs:36`, `:55`, `:77`, `:94`, `:177`.
- `D:/ih_reference_project/codex-rust-v0.162.1/codex-rs/rollout/src/model_context.rs:18`, `:30`, `:35`.

This is a storage optimization contingent on history mode; legacy mode still uses full history (`thread-store/src/local/model_context.rs:82`). Do not claim every launch/fork uses bounded disk reads.

Replay first scans surviving turn segments backward to respect rollback and select the newest applicable checkpoint. It installs replacement history and then replays only its newer suffix; response outputs go through replay truncation, interagent communications become model input, irrelevant event/token records do not become prompt text. Sources: `D:/ih_reference_project/codex-rust-v0.162.1/codex-rs/core/src/session/rollout_reconstruction.rs:188`, `:254`, `:266`, `:287`, `:471`, `:489`, `:497`, `:502`, `:536`.

Replay prepares surviving media without upload/migration; existing file references bypass preparation. It restores world state, window IDs, previous settings and review context. Sources: `D:/ih_reference_project/codex-rust-v0.162.1/codex-rs/core/src/session/mod.rs:1763`, `:1779`, `:1788`, `:1814`, `:1831`.

### Model request construction

`run_sampling_request -> clone_history().for_prompt(modalities) -> attach executed-tool metadata -> build_prompt(input + tool specs + base instructions + schema) -> try_run_sampling_request -> ModelClientSession::stream -> Responses WS or HTTP -> build_responses_request -> final protocol serialization`.

Sources: `D:/ih_reference_project/codex-rust-v0.162.1/codex-rs/core/src/session/turn.rs:1603`, `:1641`, `:1648`, `:1652`, `:1671`; `D:/ih_reference_project/codex-rust-v0.162.1/codex-rs/core/src/client.rs:2237`, `:1719`, `:1752`, `:1769`, `:1782`; `D:/ih_reference_project/codex-rust-v0.162.1/codex-rs/codex-api/src/endpoint/responses.rs:70`, `:83`, `:123`.

The final request adds material absent from plain conversation text: tools or AdditionalTools, base instructions as a developer fragment, reasoning settings, output schema/text controls, client metadata, service tier, cache key and access programs. Models using Responses Lite move tool definitions into input history. Source: `D:/ih_reference_project/codex-rust-v0.162.1/codex-rs/core/src/client.rs:905`, `:915`, `:931`, `:973`, `:995`.

## 2. Tokens, bytes, usage calibration, reserves

Four different quantities must remain distinct:

| Quantity | Codex meaning | Consequence for IH |
|---|---|---|
| Rollout file bytes | Durable events, original prepared tool results, checkpoints, metadata, repeated state | Can grow far beyond model context; never use file size as active-token count |
| Active model-visible content estimate | Selected items' content, media/opaque estimates, some base instructions | Useful scheduling estimate, not wire-size proof |
| Provider-reported usage | Input/output/cached/reasoning tokens from completed response | Ground truth for a completed sample, needs scope/model attribution |
| Physical serialized request bytes | Full JSON or WS delta including metadata/escaping/base64/tools | Independent gateway/proxy/body limit; transport compression changes bytes, not semantic context |

`TokenUsageInfo` separately stores cumulative `total_token_usage` and `last_token_usage`. Every usage sample adds to lifetime totals and replaces the last sample. Compaction decisions use active usage derived from the **last sample**, not cumulative spend. Sources: `D:/ih_reference_project/codex-rust-v0.162.1/codex-rs/protocol/src/protocol.rs:2270`, `:2305`, `:2340`; `D:/ih_reference_project/codex-rust-v0.162.1/codex-rs/core/src/context_manager/history.rs:934`.

Active usage = last provider `total_tokens` + estimates for local items after the last model-generated item, plus prior encrypted reasoning estimates if the server has not already included them. The server signals reasoning accounting through a response header; double counting is avoided. Sources: `D:/ih_reference_project/codex-rust-v0.162.1/codex-rs/core/src/context_manager/history.rs:893`, `:919`, `:934`; `D:/ih_reference_project/codex-rust-v0.162.1/codex-rs/codex-api/src/sse/responses.rs:54`, `:84`; `D:/ih_reference_project/codex-rust-v0.162.1/codex-rs/core/src/session/turn.rs:2931`.

This is **sample replacement plus estimated deltas**, not a learned calibration ratio/error bound. The normal full-history estimator explicitly calls itself a coarse lower bound (`core/src/context_manager/history.rs:647`). Text counts ceil(UTF-8 byte length/4), not a tokenizer (`D:/ih_reference_project/codex-rust-v0.162.1/codex-rs/utils/string/src/truncate.rs:101`). The estimator excludes outer JSON escaping, IDs and transport metadata; tool definitions as content are counted when represented by AdditionalTools. Source: `D:/ih_reference_project/codex-rust-v0.162.1/codex-rs/core/src/context_manager/history.rs:1065`, `:1097`, `:1175`.

Opaque reasoning/compaction cost is inferred from base64 length (`encoded_len*3/4 - 650`, then bytes/token); encrypted tool-result cost uses `encoded_len*9/16`; ordinary images use about 1,844 tokens, original-detail image dimensions use 32px patches capped at 10,000, original-detail file references use the maximum patch count. These are deliberately approximate and should not become universal IH formulas. Sources: `D:/ih_reference_project/codex-rust-v0.162.1/codex-rs/core/src/context_manager/history.rs:1053`, `:1061`, `:1074`, `:1082`, `:1286`, `:1296`.

Limits have separate meanings:

- `context_window` is selected model context; `max_context_window` is the allowed override ceiling. Override is clamped to max. Sources: `D:/ih_reference_project/codex-rust-v0.162.1/codex-rs/protocol/src/openai_models.rs:454`; `D:/ih_reference_project/codex-rust-v0.162.1/codex-rs/models-manager/src/model_info.rs:20`.
- Usable context = resolved context × effective percent, default 95%; comments describe headroom for system prompts, tools and model output. Auto compaction defaults to 90% and configured thresholds are clamped to 90% when context is known. Sources: `D:/ih_reference_project/codex-rust-v0.162.1/codex-rs/protocol/src/openai_models.rs:391`, `:466`, `:516`, `:527`.
- Standard ResponsesApiRequest has no `max_output_tokens` field, so this path does not calculate a guaranteed request-specific output reserve from an actual configured generation cap. Its reserve is percentage headroom. Source: `D:/ih_reference_project/codex-rust-v0.162.1/codex-rs/codex-api/src/common.rs:278`.
- Auto-compaction scope can count total active context or only body growth after initial prefix. The full usable window remains an independent cap in either mode. Remaining budget is the minimum of scoped and full-window remaining. An optional fallback-prompt buffer extends the scoped threshold but does not bypass full context. Source: `D:/ih_reference_project/codex-rust-v0.162.1/codex-rs/core/src/session/context_window.rs:58`, `:62`, `:83`, `:89`, `:98`, `:106`.
- Body-after-prefix starts with an estimated baseline; the first provider input-token sample replaces the estimate and sampled output remains counted as growth. Source: `D:/ih_reference_project/codex-rust-v0.162.1/codex-rs/core/src/state/auto_compact_window.rs:39`, `:122`, `:137`.

After compaction/reset, `recompute_token_usage` estimates the replacement window, updates last usage (preserving lifetime totals), records new model context and estimated prefill, and emits token counts. The next provider sample becomes authoritative again. Source: `D:/ih_reference_project/codex-rust-v0.162.1/codex-rs/core/src/session/mod.rs:4802`.

## 3. Automatic, manual, and error-recovery compaction

### Trigger and selection

Pre-sampling checks run previous-model compatibility/downshift logic and current budget status (`core/src/session/turn.rs:1303`). A changed nonempty `comp_hash` triggers old-model compaction; switching to a smaller context can also trigger it. Previous model/access-program pairing is restored to avoid server rejection. Sources: `D:/ih_reference_project/codex-rust-v0.162.1/codex-rs/core/src/session/turn.rs:1333`, `:1345`, `:1365`, `:1375`.

After each sample/tool continuation, budget is recomputed. When follow-up is needed and threshold or new-window request is reached, inline mid-turn compaction runs; optional post-turn compaction runs after a completed answer and preserves the answer if it fails. Incoming user input is preserved if pre-turn compaction fails. Sources: `D:/ih_reference_project/codex-rust-v0.162.1/codex-rs/core/src/session/turn.rs:191`, `:573`, `:608`, `:619`, `:716`, `:755`.

Both automatic and manual compact select a strategy by feature/provider capability: token-budget reset, remote V2, or local summarizing Responses call. Sources: `D:/ih_reference_project/codex-rust-v0.162.1/codex-rs/core/src/session/turn.rs:1434`, `:1460`, `:1472`; `D:/ih_reference_project/codex-rust-v0.162.1/codex-rs/core/src/tasks/compact.rs:29`, `:51`, `:63`.

### Local summarizing compaction

The client clones active history, adds summarization prompt, sends a normal Responses generation, and on success builds a new history from retained user messages (20,000 token text budget) plus a summary and current canonical context. The summarizer has no ordinary task tools via its default Prompt. Sources: `D:/ih_reference_project/codex-rust-v0.162.1/codex-rs/core/src/compact.rs:63`, `:259`, `:272`, `:304`, `:383`, `:386`, `:673`.

If this compact request gets a classified ContextWindowExceeded and more than one prompt item remains, it removes the oldest history item and corresponding tool pair, resets stream retry counter and retries. It eventually fails once no further useful shrink is possible. This has a monotonic item-count termination bound but **no small fixed total attempt cap**; many items can mean many network calls, and general retries reset per deletion. Sources: `D:/ih_reference_project/codex-rust-v0.162.1/codex-rs/core/src/compact.rs:279`, `:338`, `:351`; `D:/ih_reference_project/codex-rust-v0.162.1/codex-rs/core/src/context_manager/history.rs:680`.

### Remote V2 compaction

This version sends a `CompactionTrigger` in the ordinary Responses stream, with tool declarations if needed. It expects exactly one opaque Compaction output plus completed response ID; this is not a generic text summary and is not the older `/responses/compact` request shape. Sources: `D:/ih_reference_project/codex-rust-v0.162.1/codex-rs/core/src/compact_remote_v2_attempt.rs:88`, `:93`, `:94`, `:125`; `D:/ih_reference_project/codex-rust-v0.162.1/codex-rs/core/src/compact_remote_v2.rs:376`, `:440`, `:472`, `:478`.

Before remote compaction, it estimates base+history and replaces **consecutive newest tool-output groups** with a truncation marker until fitting the usable window. It stops when reaching a nonrewritable group. This is targeted tail-output protection, not arbitrary oldest-history removal or guaranteed total-request fitting. It excludes out-of-band tool schema/JSON overhead from this particular estimate. Sources: `D:/ih_reference_project/codex-rust-v0.162.1/codex-rs/core/src/compact_remote_history.rs:68`, `:78`, `:88`, `:100`, `:126`, `:181`.

The remote result retains selected recent real user/hook messages, selected agent messages, and optionally client-authored developer messages under a 64,000 token retained-message budget, then appends opaque Compaction output. Child progress and FINAL_ANSWER messages are not retained as originals; their meaning must be represented in the compaction. Images can be budgeted only when the image-budget feature is enabled. Sources: `D:/ih_reference_project/codex-rust-v0.162.1/codex-rs/core/src/compact_remote_v2.rs:73`, `:494`, `:545`, `:557`, `:566`, `:610`, `:626`.

Remote stream retry max is min(provider retry budget, 2), with shared transport fallback handling. A previous-model failure may get one attempt using the current model/access-program pair when eligible; failure then returns the original error. Source: `D:/ih_reference_project/codex-rust-v0.162.1/codex-rs/core/src/compact_remote_v2.rs:75`, `:248`, `:262`, `:281`, `:384`; `D:/ih_reference_project/codex-rust-v0.162.1/codex-rs/core/src/compact_model_fallback.rs:10`.

### Durable replacement and concurrency

Both summarizing strategies build canonical initial world state/context into replacement history, assign IDs, acquire the settings persistence lock, preserve goal edits accepted after the compact input snapshot, install the actual replacement vector, and persist a checkpoint plus world state/current turn context/settings. This supports repeatable resume; the full old archive is not destructively rewritten by compaction. Sources: `D:/ih_reference_project/codex-rust-v0.162.1/codex-rs/core/src/compact.rs:80`, `:97`; `D:/ih_reference_project/codex-rust-v0.162.1/codex-rs/core/src/session/mod.rs:4017`, `:4048`, `:4054`, `:4073`, `:4083`, `:4107`.

Important limitation: live history installs before `persist_rollout_items` reports success (`session/mod.rs:4074`, `:4114`). This is a coordinated replacement/checkpoint implementation, not proof of a fully transactional disk+memory commit across crash or persistence failure. IH should make its failure semantics explicit.

### Token-budget reset is not summarization

With TokenBudget enabled, “compaction” skips model/server summarization and installs a fresh window. It rebuilds current initial context/world state and optionally retained client developer messages; it does not inherently preserve ordinary old task history as a summary. This is a separate operating mode requiring durable external state and proper prompts. Sources: `D:/ih_reference_project/codex-rust-v0.162.1/codex-rs/core/src/compact_token_budget.rs:16`, `:34`, `:46`; `D:/ih_reference_project/codex-rust-v0.162.1/codex-rs/core/src/session/mod.rs:4550`, `:4558`, `:4579`.

## 4. Tool output, pairing, media, and physical payload

Active history truncates FunctionCallOutput and CustomToolCallOutput using per-envelope originating token budget or model truncation policy + 20% serialization allowance. This is an allowance *added to tool content retention*, not a global request reserve. Sources: `D:/ih_reference_project/codex-rust-v0.162.1/codex-rs/core/src/context_manager/history.rs:565`; `D:/ih_reference_project/codex-rust-v0.162.1/codex-rs/utils/output-truncation/src/lib.rs:17`, `:90`.

Text items share remaining output budget; audio is charged and omitted when insufficient. Images and encrypted content are unconditionally retained in this helper, so text-output limits do not cap base64/opaque payload size or image count. Source: `D:/ih_reference_project/codex-rust-v0.162.1/codex-rs/utils/output-truncation/src/lib.rs:164`, `:177`, `:211`, `:217`, `:232`.

Prompt normalization synthesizes missing outputs (`aborted` for function/custom/local shell, empty tool-search output), removes orphan outputs, preserves named external outputs and server-side tool-search outputs, and strips unsupported image/audio modalities. Synthetic IDs are stable UUIDv5 hashes of source call identity for cache stability. Oldest removal also removes a counterpart instead of splitting the pair. Sources: `D:/ih_reference_project/codex-rust-v0.162.1/codex-rs/core/src/context_manager/normalize.rs:23`, `:59`, `:164`, `:179`, `:218`, `:258`; `D:/ih_reference_project/codex-rust-v0.162.1/codex-rs/core/src/context_manager/history.rs:597`, `:680`, `:959`.

This is typed normalization with distinct call kinds, not blind “drop unmatched role messages.” Metadata envelopes/provenance are retained internally but projected away into wire ResponseItems.

Media preparation can resize/reencode inline images and use an injected AttachmentStore that returns inline bytes or file IDs; upload failure falls back inline. Plain core has an InlineAttachmentStore helper. File IDs are protocol-specific, server-resolvable references; their tiny JSON size does not imply zero visual context tokens. Sources: `D:/ih_reference_project/codex-rust-v0.162.1/codex-rs/core/src/image_preparation.rs:350`, `:358`, `:372`; `D:/ih_reference_project/codex-rust-v0.162.1/codex-rs/attachment-store/src/lib.rs:23`, `:133`, `:163`; `D:/ih_reference_project/codex-rust-v0.162.1/codex-rs/protocol/src/models.rs:901`; `D:/ih_reference_project/codex-rust-v0.162.1/codex-rs/core/src/thread_manager.rs:519`.

The final serialization helper measures the actual HTTP request or WS message against 15 MiB, but only if optional executed-tool metadata exists, and only sheds that metadata. It explicitly preserves ordinary content exceeding the soft limit. Logical history and WS continuation baseline remain intact; metadata loss invalidates the corresponding inventory attribution. Sources: `D:/ih_reference_project/codex-rust-v0.162.1/codex-rs/core/src/client_tool_metadata.rs:10`, `:12`, `:26`, `:35`; `D:/ih_reference_project/codex-rust-v0.162.1/codex-rs/core/src/client.rs:1769`, `:2060`.

Therefore: no observed general final serialized-payload hard gate, no guaranteed all-modality input fit, and no guarantee a single giant new user/agent message can be healed. These are source-scope findings, not claims that every deployed request fails under such conditions.

## 5. Subagent inheritance and results

V2 `fork_turns` defaults to all, accepts none/all and also positive integer legacy compatibility as FullHistory. It is not a last-N-turn slicing implementation in this path. Source: `D:/ih_reference_project/codex-rust-v0.162.1/codex-rs/core/src/tools/handlers/multi_agents_v2/spawn.rs:279`, `:286`, `:293`, `:297`.

Full fork flushes parent rollout before snapshotting, then loads latest model context in paginated mode or full stored history in legacy mode. This is durable snapshot inheritance, not every child's provider request containing the parent's entire raw archive. Sources: `D:/ih_reference_project/codex-rust-v0.162.1/codex-rs/core/src/agent/control/spawn.rs:167`, `:1036`, `:1067`, `:1075`.

Fork projection keeps system/developer/user messages, assistant PartialAnswer/FinalAnswer phases, tool declarations and external unpaired outputs; top-level tool calls/results, reasoning, agent communications, generated images and transient markers are filtered. A Compacted record survives; replacement-history sanitization preserves its model context while removing inherited agent messages and rewriting instructions/authorization. Source: `D:/ih_reference_project/codex-rust-v0.162.1/codex-rs/core/src/agent/control/spawn.rs:88`, `:125`, `:1123`, `:1150`, `:1225`.

Inherited conversational messages are marked inherited so they cannot be recaptured as local authorization. Parent cumulative token records are removed; checkpoint resume metadata/retained authorization are rewritten for child ownership. Parent developer fragment/usage hints are replaced while compatible context baselines survive. Source: `D:/ih_reference_project/codex-rust-v0.162.1/codex-rs/core/src/agent/control/spawn.rs:1127`, `:1189`, `:1229`, `:1240`, `:1276`.

Fresh/no-fork children start a new thread and inherit environments/execution policy according to the spawn contract. Source: `D:/ih_reference_project/codex-rust-v0.162.1/codex-rs/core/src/agent/control/spawn.rs:800`.

Parent receives attributed interagent communications, not child rollout replay. Completion watcher packages final status/result and queues it without starting a new turn. Crucial limitation: Completed(Some(message)) is cloned unchanged; only error text gets a 900-token payload cap (1,000 minus envelope reserve). Therefore child result fan-in still needs budgeting in IH. Sources: `D:/ih_reference_project/codex-rust-v0.162.1/codex-rs/core/src/agent/control.rs:469`, `:512`, `:523`, `:530`; `D:/ih_reference_project/codex-rust-v0.162.1/codex-rs/core/src/session_prefix.rs:9`, `:20`, `:26`; `D:/ih_reference_project/codex-rust-v0.162.1/codex-rs/core/src/agent/control/delivery.rs:11`.

## 6. Public API key versus subscription/backend protocol

Default base URL is `https://api.openai.com/v1` for API-key style auth and `https://chatgpt.com/backend-api/codex` for ChatGPT/token/header/identity/PAT modes; configured base_url overrides defaults. Source: `D:/ih_reference_project/codex-rust-v0.162.1/codex-rs/model-provider-info/src/lib.rs:80`, `:427`.

Provider API keys become bearer-only auth; first-party ChatGPT auth builds a bearer provider carrying the account ID, emitted as ChatGPT-Account-ID when present. The auth snapshot/manager is scoped to expected identity so account-scoped state cannot be reused across a later switch. This is implementation evidence only; no account state was read. Sources: `D:/ih_reference_project/codex-rust-v0.162.1/codex-rs/model-provider/src/auth.rs:292`, `:306`, `:327`; `D:/ih_reference_project/codex-rust-v0.162.1/codex-rs/model-provider/src/bearer_auth_provider.rs:13`, `:31`.

Provider remote-compaction defaults are capability-driven: OpenAI and Azure Responses are V2, custom providers otherwise Unsupported unless overridden. This is not simply “subscription can compact; API key cannot.” Source: `D:/ih_reference_project/codex-rust-v0.162.1/codex-rs/model-provider/src/capabilities.rs:31`, `:33`, `:44`.

Core WireApi is Responses only in this snapshot; it is not a generic Chat Completions/Anthropic/Gemini adapter model. Source: `D:/ih_reference_project/codex-rust-v0.162.1/codex-rs/model-provider-info/src/lib.rs:107`.

Requests set store=false, stream=true, include reasoning.encrypted_content, model reasoning settings and typed input. Non-OpenAI providers lose internal passthrough metadata and encrypted function arguments; protocol-specific items remain a compatibility responsibility. Sources: `D:/ih_reference_project/codex-rust-v0.162.1/codex-rs/core/src/client.rs:942`, `:961`, `:996`.

HTTP sends the complete logical request, optionally zstd-compressed only for enabled OpenAI Codex-backend auth. WS can send previous_response_id + only newly appended items **only** when noninput properties and prior input/output prefix match; otherwise it sends the full request. Source: `D:/ih_reference_project/codex-rust-v0.162.1/codex-rs/core/src/client.rs:1398`, `:1446`, `:1634`, `:2013`, `:2031`; `D:/ih_reference_project/codex-rust-v0.162.1/codex-rs/codex-api/src/endpoint/responses.rs:83`, `:130`.

Transport deltas, compression, prompt caching and opaque checkpoints solve different problems. A tiny WS delta still refers to a full model context. On resume/rewrite/fallback the client must be able to reconstruct and send a legal full request. Server references need provider/credential/model compatibility ownership; do not treat them as generic artifacts transferable across routes.

## 7. Provider errors and bounded recovery: actual behavior

| Failure | Classification/recovery in inspected code |
|---|---|
| SSE response.failed error.code=context_length_exceeded | ApiError::ContextWindowExceeded -> CodexErr::ContextWindowExceeded |
| Raw HTTP400 policy/image errors | Specific policy/image classification |
| Raw HTTP400 ordinary/context body | InvalidRequest(body); no generic context_length_exceeded branch here |
| Other HTTP status such as 413 | Falls through generic status handling; no specialized payload-too-large recovery found in audited API bridge |
| Normal sampling ContextWindowExceeded | Marks active tokens full and returns error; no generic shrink-and-retry branch |
| Guardian exhausted review budget ContextWindowExceeded | Compact + retry once per model step; ineffective compaction cannot loop there |
| Local compact ContextWindowExceeded | Remove oldest item/pair and retry until minimal history; count-decreasing but potentially many requests |
| Remote compact ContextWindowExceeded | No same-strategy shrink loop; preflight tail-output rewrite only; optional previous-to-current model fallback |
| Retryable stream/transport failures | Retry budget plus optional one-way WS->HTTPS fallback; server advice changes delay, not retry budget |

Evidence: `D:/ih_reference_project/codex-rust-v0.162.1/codex-rs/codex-api/src/sse/responses_error.rs:47`; `D:/ih_reference_project/codex-rust-v0.162.1/codex-rs/codex-api/src/api_bridge.rs:52`, `:143`, `:176`; `D:/ih_reference_project/codex-rust-v0.162.1/codex-rs/protocol/src/error.rs:397`, `:407`, `:414`, `:432`; `D:/ih_reference_project/codex-rust-v0.162.1/codex-rs/core/src/session/turn.rs:761`, `:774`, `:1688`; `D:/ih_reference_project/codex-rust-v0.162.1/codex-rs/core/src/compact.rs:338`; `D:/ih_reference_project/codex-rust-v0.162.1/codex-rs/core/src/responses_retry.rs:64`, `:101`, `:137`, `:166`.

There is an optional UnboundedConnectionRetries feature restricted to external sampling connection failures, excluding Bedrock; it can wait indefinitely with backoff capped at 60 sec. This is not context-error recovery and means “all retries are bounded” would be false. Source: `D:/ih_reference_project/codex-rust-v0.162.1/codex-rs/core/src/responses_retry.rs:102`.

Normal provider defaults are 5 stream retries and 4 request retries, each configurable up to 100; nested layers and a transport fallback can therefore mean more physical requests than one visible retry counter suggests. Sources: `D:/ih_reference_project/codex-rust-v0.162.1/codex-rs/model-provider-info/src/lib.rs:66`, `:499`. Aggregate limits are preferable for IH.

The general post-sampling auto-compact loop contains the assumption that compaction gets well below the limit (`core/src/session/turn.rs:619`); it does not itself prove an effectiveness/attempt cap for all rollover cycles. IH should enforce progress rather than inherit that assumption.

## 8. Prioritized transferable lessons for IH

These are recommendations/inferences from the proven code, not existing IH behavior claims.

**P0 — make archive, active context, logical request and physical request different types.** Persist append-only full/fuller evidence and bounded model projections with artifact handles. A complete versioned checkpoint plus ordered suffix should reproduce the same prompt after resume. Keep summaries, user instruction sources, authorization and state baselines distinct. Inspect final provider projection before sending, including tool schemas, instructions, image/base64 and escaping.

**P0 — budget each physical request at its actual boundary.** Maintain model-token capacity and serialized byte capacity independently; include the new input/tool result/subagent fan-in plus output reserve and safety uncertainty. Use provider-native counting when available and conservative estimates otherwise; do not equate raw JSON bytes with tokens. A pre-turn-only threshold cannot protect a single giant new input. Transport compression/caching must not alter semantic accounting.

**P0 — normalize typed tool transactions and provider objects before admission.** Pair calls/results, preserve stable IDs, handle aborted calls explicitly, and ensure pruning cannot create orphan results. Keep encrypted reasoning/compaction/file IDs in typed protocol-specific fields with compatibility constraints. Generic text flattening destroys that structure.

**P0 — centralize typed errors with bounded recovery.** Parse both HTTP bodies and stream errors into context overflow, payload overflow, invalid tool pairing/schema, unsupported feature, invalid image/reference, auth and transient errors. Retry identical requests only for transient errors. A recovery attempt must change the relevant pressure measure, preserve pending user input and avoid replaying completed tools. Cap compaction/recovery by request generation, attempt count and elapsed budget; expose terminal evidence if no progress.

**P1 — compaction is a state transition with provenance and explicit concurrency.** Snapshot input generation; keep accepted later messages/settings/goals; validate replacement; install/persist checkpoint with well-defined crash semantics; update generation IDs, estimates, server-reference state and UI from one result. Keep original archive evidence retrievable.

**P1 — split billing usage from active-window usage.** Provider observations are scoped to the actual model/route/logical request generation. Add only unsampled local deltas, invalidate stale baselines after replacement/model change, and refresh to actual next usage. Preserve cumulative spend independently. Treat reported cached input as still occupying context, not free capacity.

**P1 — bound fan-in and forks explicitly.** Inherit selected active context or task handoff, not archive; mark source/authorization; do not inherit lifetime usage. Budget child results before injecting into parent; store complete result as artifact and insert bounded structured findings with retrieval handles.

**P1 — put media and tool evidence on retention policies.** Per-tool text truncation alone does not cap images/opaque blocks. Define semantic media budget, payload byte budget and retained-artifact lifetime; make omitted material explicit and retrievable. Preserve exact head/tail or selected evidence rather than silently replacing all meaning.

**P2 — storage performance is separate from inference reliability.** Paginated reverse-scans and frozen lineage offsets help 100 MB archives load quickly, but do not increase the model window. Verify resumed prompt equivalence and work proportional to checkpoint suffix; legacy migration needs deliberate full-read limits and diagnostics.

## 9. What not to copy / unresolved verification

Do not copy: four-byte token estimates as a hard fit guarantee; fixed image and encrypted-content ratios across providers; raw HTTP400 classification gaps; optional-metadata soft cap as a complete byte gate; reliance on compaction always shrinking; unbounded success-result fan-in; generic text flattening of opaque checkpoints; unconditional TokenBudget reset without external memory; OpenAI private metadata/Responses Lite/compaction triggers into every provider; or claims that loading a 100 MB archive proves handling a 100 MB HTTP body.

Unanswered from offline source alone:

- Exact backend/proxy context and body limits, acceptance of V2 compaction/Responses Lite by every account/model/route, encrypted checkpoint compatibility/expiry, server tokenization and per-model hidden overhead.
- Whether the user's installed upstream agent actually uses this version and paginated history mode; whether the observed 100 MB files contain repeated images, tool output, events, or checkpoints. No user archives/profiles were inspected.
- Runtime request/compaction efficacy and latency under adversarial gigantic new messages or fan-in. Existing tests provide useful offline mock scenarios but were not executed here.
- Actual IH 400 root causes require inspection of IH adapters and redacted request/error telemetry; upstream source does not establish whether IH has token overflow, body overflow, schema/pairing error or stale server-reference failure.

Useful existing test evidence for a future focused offline verification pass: `D:/ih_reference_project/codex-rust-v0.162.1/codex-rs/core/src/client_tool_metadata_tests.rs:265` tests WS delta versus full-message metadata budgeting; `D:/ih_reference_project/codex-rust-v0.162.1/codex-rs/core/src/context_manager/history_tests.rs:2850` tests file-image estimates; `D:/ih_reference_project/codex-rust-v0.162.1/codex-rs/core/src/session/tests.rs:2424` checks replacement history verbatim reconstruction; `D:/ih_reference_project/codex-rust-v0.162.1/codex-rs/core/src/agent/control_tests.rs:2311` covers no-fork parent-context exclusion; `D:/ih_reference_project/codex-rust-v0.162.1/codex-rs/thread-store/src/local/model_context_tests.rs:62` begins paginated model-context loading tests. These are inspected source tests, not test-pass claims.
