# Unified message format: Pi/OpenCode evidence and IH comparison

2026-10-15; local source only. IH HEAD rechecked as `81bca938`. Pi executable/AI manifests say 1.2.0; OpenCode executable manifest 1.19.0. Reference folders have no .git, so no upstream commit can be certified. No source edited, dependencies installed, account data inspected or provider called. This addendum supplements `pi-opencode-audit.md` and is about representation/replay, not a new full IH defect audit.

Citation prefixes: `P/` = `D:/ih_reference_project/pi-1.2.0/`; `O/` = `D:/ih_reference_project/opencode-1.19.0/`; `I/` = `D:/I-harness-main/`. A prefix + relative path + line is an exact local source citation.

## Direct answer

**Pi and OpenCode also use shared intermediate message formats. IH is not unique in doing this, and a unified format is not intrinsically the cause of provider400 or large-request failures.** Pi explicitly defines `Message = SystemMessage | UserMessage | AssistantMessage | ToolResultMessage`, normalizes one transcript before dispatch, then lowers it per API (`P/packages/ai/src/types.ts:639`, `:766`, `:780`; `P/packages/ai/src/compat.ts:252`). OpenCode native defines one `Message`/`ContentPart` schema with provider metadata and lowers through native protocol modules (`O/packages/llm/src/schema/messages.ts:178`, `:183`; `O/packages/llm/src/route/client.ts:344`). Legacy OpenCode additionally normalizes UI/session parts to AI SDK `ModelMessage[]` (`O/packages/opencode/src/session/message-v2.ts:131`, `:419`).

The useful comparison is **what each shared representation preserves, when native replay metadata remains valid, how invalid histories are repaired or rejected, and what the final serializer actually sends**. IH's `LLMMessage + ProviderContinuation` is already a deliberate shared semantic representation with protocol-specific replay state, not a simplistic “everything becomes plain text” design (`I/packages/core-session/src/projection/types.ts:3`, `:15`, `:26`).

## Pi shared types and escape hatches

Pi's API-facing semantic union is explicit (`P/packages/ai/src/types.ts`):

| Shared type | Actual fields / semantics | Exact source |
|---|---|---|
| `TextContent` | `type:text`, text, optional opaque `textSignature` (Responses message ID/phase JSON or Google part signature) | `:408`, `:414` |
| `ThinkingContent` | thinking string, optional opaque/serialized `thinkingSignature`, redacted flag; opaque encrypted payload can live in signature | `:420` |
| `ImageContent` | base64 `data` + `mimeType` | `:430` |
| `ToolCall` | id, name, JSON-object args, optional Google thoughtSignature, optional Responses namespace | `:436` |
| `SystemMessage` | content plus named section patches and tool add/remove deltas; timestamp | `:541` |
| `UserMessage` | string or ordered text/image blocks | `:559` |
| `AssistantMessage` | **ordered** Text/Thinking/ToolCall block array; original API/provider/model; responseModel/responseId; effort; usage; stop/error state | `:565` |
| `ToolResultMessage` | call ID + tool name, ordered text/images; isError; details/nested calls/own usage retained separately | `:620` |

`AgentMessage` extends this same Message union with host custom message types, not a separate per-provider transcript (`P/packages/agent/src/types.ts:358`, `:374`). Coding-agent adds bashExecution/custom/branchSummary/compactionSummary then converts them into ordinary user messages; native assistant/tool content passes through (`P/packages/coding-agent/src/core/messages.ts:27`, `:153`). UI-only details are not automatically concatenated into the model request.

`Context` optionally supplies systemPrompt/tools beside messages, but `normalizeContext` folds these into a leading system message. Only branded `TranscriptContext` should reach API implementations (`P/packages/ai/src/types.ts:760`; `P/packages/ai/src/utils/transcript.ts:9`, `:28`). System state replays ordered section/tool deltas. If a provider cannot support mid-history system updates, `collapseSystemMessages` builds current system state at the front (`P/packages/ai/src/utils/transcript.ts:74`, `:111`, `:122`). Shared representation therefore captures a richer application contract than the least common provider wire schema.

Pi carries provider-specific meaning inside fields rather than a single large discriminated `ProviderContinuation`: same-model signatures can contain complete Responses reasoning items; redacted thinking stores opaque data; text signatures preserve IDs/phases; tool signatures retain Google state. This is still an escape hatch for native state. The ordered assistant content array itself preserves interleaving, whereas IH stores visible assistant text/toolCalls separately and reconstructs order from its explicit envelope.

## Pi protocol list: API IDs are not provider brands

The **exact 10 built-in KnownApi IDs** are listed at `P/packages/ai/src/types.ts:61` and registered at `P/packages/ai/src/compat.ts:180`. `Api` remains extensible (`types.ts:73`; `compat.ts:128`). They are:

| Pi API ID | What the local implementation sends / distinction |
|---|---|
| `openai-completions` | Chat Completions message/tool_calls format; not Responses (`P/packages/ai/src/api/openai-completions.ts:1193`) |
| `openai-responses` | Responses input items, reasoning items, function_call/output (`P/packages/ai/src/api/openai-responses.ts:311`) |
| `azure-openai-responses` | Azure-specific route/deployment/options using shared Responses message converter (`P/packages/ai/src/api/azure-openai-responses.ts:174`, `:187`) |
| `openai-codex-responses` | Codex route/auth/transport using shared Responses converter; cached WebSocket can send previous_response_id + input delta (`P/packages/ai/src/api/openai-codex-responses.ts:543`, `:1439`) |
| `anthropic-messages` | Anthropic Messages block format (`P/packages/ai/src/api/anthropic-messages.ts:1157`, `:1344`) |
| `bedrock-converse-stream` | Bedrock ConverseStream toolUse/toolResult/reasoning format (`P/packages/ai/src/api/bedrock-converse-stream.ts:268`, `:983`) |
| `google-generative-ai` | Gemini content/parts API (`P/packages/ai/src/api/google-shared.ts:191`) |
| `google-vertex` | Vertex route/auth API identity; shares Google content conversion (`P/packages/ai/src/api/google-vertex.ts:35`, `:467`) |
| `mistral-conversations` | **Despite ID name, this snapshot actually builds Chat payload and POSTs `v1/chat/completions`**, not inferred Conversations wire (`P/packages/ai/src/api/mistral-conversations.ts:147`, `:298`, `:306`, `:527`) |
| `pi-messages` | Pi's own normalized `{model,context,options}` POST to `/messages`; backend emits serialized shared assistant events; Radius is a consumer (`P/packages/ai/src/api/pi-messages.ts:1`) |

`KnownProvider` is a separate brand/routing list (`P/packages/ai/src/types.ts:87`), and Model stores both `api` and `provider` (`:820`). It includes amazon-bedrock, ant-ling, anthropic, google, google-vertex, openai, azure, openai-codex, radius, typesafe, nvidia, deepseek, github-copilot, xai, groq, cerebras, openrouter, vercel-ai-gateway, zai, zai-coding-cn, mistral, minimax, minimax-cn, moonshotai, moonshotai-cn, huggingface, fireworks, together, baseten, opencode, opencode-go, kimi-coding, meta, cloudflare-workers-ai, cloudflare-ai-gateway, qwen-token-plan, qwen-token-plan-cn, qwen-token-plan-individual, xiaomi, xiaomi-token-plan-cn, xiaomi-token-plan-ams and xiaomi-token-plan-sgp. `ProviderId` also permits arbitrary strings (`:130`). This list is not 42 distinct wire protocols. For example OpenAI provider factory selects Responses, DeepSeek selects Chat Completions, Anthropic selects Messages (`P/packages/ai/src/providers/openai.ts:30`, `deepseek.ts:13`, `anthropic.ts:88`). Image/classifier APIs have separate type lists and should not be counted as chat protocols (`types.ts:75`, `:79`).

## Pi conversion strategy: shared data, protocol-aware replay

Common `transformMessages` is a two-pass compatibility transform (`P/packages/ai/src/api/transform-messages.ts:64`):

1. Normalize null content and replace unsupported images with placeholders (`:35`, `:72`). For assistant state, “same model” means **provider+API+model all match** (`:95`). Keep signed same-model thinking even if visible text empty; drop foreign redacted thinking; convert ordinary foreign thinking to plain text; remove foreign text/thought signatures (`:101`, `:109`, `:120`, `:131`). This is policy, not arbitrary preservation of all native blocks across providers.
2. On cross-model calls use target-specific ID normalization callback and maintain an old->new ID map for results (`:81`, `:136`). The callback is target-specific: Responses handles pipe-separated call/item IDs; Chat may hash combined IDs; Anthropic sanitizes IDs; Mistral normalizer produces its required IDs (`P/packages/ai/src/api/openai-responses-shared.ts:154`, `openai-completions.ts:1202`, `anthropic-messages.ts:1326`, `mistral-conversations.ts:238`).
3. Preserve structure by synthesizing missing results before next assistant/user/end, hold system updates until tool results finish, and omit aborted/error assistant partials (`transform-messages.ts:159`, `:167`, `:193`, `:201`, `:224`). It does **not** universally drop unmatched tool result messages. Pi durable context's stronger `orderToolResults` does drop unmatched results and order known results (`P/packages/durable/src/harness/context.ts:259`).

Protocol converters then impose further rules:

* **Responses:** decode thinkingSignature JSON into a full native reasoning item, use output_text with ID/phase, separate function call/result items. Tool-call item IDs may be removed when switching models to avoid native reasoning pairing validation (`P/packages/ai/src/api/openai-responses-shared.ts:255`, `:264`, `:296`, `:332`). Ordinary Responses sets store:false and asks for encrypted reasoning (`P/packages/ai/src/api/openai-responses.ts:337`, `:363`). It sends selected client history, not archive bytes.
* **Codex cached WebSocket exception:** exact equality of request fields except input and exact current-input prefix against last request+response permits `previous_response_id` plus new delta; otherwise clear continuation and use full body (`P/packages/ai/src/api/openai-codex-responses.ts:1426`, `:1439`, `:1461`). A claim “Pi always sends full history” would be false.
* **Anthropic:** ordered thinking/redacted data/tool_use; unsigned thinking becomes text except marked empty-signature-compatible endpoints; group consecutive tool_result into user turn, defer system changes so they cannot split use/result (`P/packages/ai/src/api/anthropic-messages.ts:1344`, `:1440`, `:1498`).
* **Gemini:** signed text/thought/tool-call parts kept only for same provider/model with base64 validation, including signed empty blocks; tool results become functionResponse, with explicit IDs on models that need them; Gemini3+ result images nested in functionResponse.parts while older Gemini uses another user image turn (`P/packages/ai/src/api/google-shared.ts:149`, `:165`, `:191`, `:228`, `:284`).

These are examples of why a correct shared abstraction needs protocol adapters and native metadata. They do not demonstrate that each adapter is perfect or all metadata can safely cross model/endpoint boundaries.

## Compaction and durable replay are separate from wire format

Pi JSONL stores full shared messages, usage and native opaque signatures. It also records compaction summary/firstKeptEntryId/system checkpoint and context-edit entries (`P/packages/coding-agent/src/core/session-manager.ts:91`, `:175`). Latest branch compaction selects checkpoint + retained tail; projection applies durable omission/replacement edits, ignores older retained checkpoint messages (`:476`, `:519`, `:543`). CompactionSummary becomes a user summary message during `convertToLlm` (`P/packages/coding-agent/src/core/messages.ts:153`). Retained tail keeps structured native messages, so signatures survive only where future converter judges them valid.

Summarizer deliberately uses text-only transcript: omit thinking/system/media, cap each tool result 2,000 chars, preserve visible text/tool args; reject incomplete/error/tool-calling summaries (`P/packages/coding-agent/src/core/compaction/utils.ts:94`, `:120`; `compaction.ts:585`, `:696`). This is intentional lossy transformation at a defined checkpoint, not proof the entire archive is text-only. Failed attempts remain archived while context edits omit them from next request (`P/packages/coding-agent/src/core/agent-session.ts:3066`, `:3811`).

Pi durable uses immutable head/tail context ranges, latest edit per entry, excludes failed/aborted/deferred assistants and balances tool results; its compaction places a new head marker through safe admission (`P/packages/durable/src/harness/context.ts:23`, `:138`, `:183`, `:259`; `P/packages/durable/src/harness/compaction.ts:417`). This is a second shared-model implementation with a different storage engine, not a direct alternative to normalization.

## IH comparison: already the same architectural family

| Concern | Pi | IH at 81bca938 |
|---|---|---|
| Semantic assistant | Ordered Text/Thinking/ToolCall array + API/provider/model | `content:string`, `toolCalls[]`, thinkingBlocks + discriminated ProviderContinuation |
| Native replay | Opaque per-block signatures and IDs | Anthropic prefix fingerprint/toolBindings/contentOrder; Responses reasoningItems/outputOrder; Gemini signatures/thoughtParts/partOrder/callBindings; Bedrock reasoning blocks |
| Replay provenance | Same provider+API+model gating | Kind-specific adapter plus `canReplayContinuation` matching optional model/providerId |
| Edited visible data | Canonical context-edit projection; converter drops foreign metadata | `replayBlockOrder` checks exact concatenated text and complete unique reasoning/tool indexes, rejects stale envelope |
| Compaction | User summary + retained native tail | compaction/summary becomes user message; event projection chooses what remains |

IH citations: `I/packages/core-session/src/projection/types.ts:5`, `:10`, `:15`, `:26`; `I/packages/llm-seam/src/index.ts:88`, `:99`; `I/packages/core-session/src/projection/messages.ts:190`, `:218`, `:271`. IH stream fold already records native continuation for Responses/Anthropic/Gemini (`I/packages/llm-openai/src/stream/fold.ts:199`; `I/packages/llm-anthropic/src/stream/fold.ts:167`; `I/packages/llm-gemini/src/stream/fold.ts:213`).

IH Anthropic adapter additionally verifies prefix hash and original tool bindings before replaying signed thinking, preserves original contentOrder, and drops invalid reasoning chain (`I/packages/llm-anthropic/src/request/messages.ts:5`, `:23`, `:40`). Responses adapter validates order and discards reasoning if envelope no longer matches visible text (`I/packages/llm-openai/src/request/messages.ts:50`, `:61`, `:70`). Gemini checks original call args/IDs and replays partOrder with signatures, falling back unsigned (`I/packages/llm-gemini/src/request/messages.ts:38`, `:51`, `:92`). These are substantive protocol protections; they should be evaluated against fixtures rather than described as absent because IH has one LLMMessage union.

Differences worth considering: Pi has ordered native content intrinsically; IH's side envelope requires maintaining exact association through edits/compaction. Pi assistant source includes API identity unconditionally; IH's provenance fields are optional for old logs, and protocol kind plus config dispatch performs part of that work. Pi tool results carry toolName directly; IH Gemini recovers it from earlier calls (`I/packages/llm-gemini/src/request/messages.ts:65`). Neither choice alone proves a defect. IH image projection explicitly removes real image base64 from tool JSON text and emits actual image parts, preventing duplicate token-heavy base64 as text (`I/packages/core-session/src/projection/messages.ts:225`, `:293`).

## OpenCode corroboration and design implication

OpenCode native `ContentPart` = Text/Media/ToolCall/ToolResult/Reasoning; Message has role/content plus `metadata` and `native`; parts have providerMetadata; reasoning has encrypted; tools distinguish providerExecuted (`O/packages/llm/src/schema/messages.ts:25`, `:122`, `:138`, `:169`, `:178`, `:183`). Session conversion strips provider metadata on model switch and converts foreign reasoning into text (`O/packages/core/src/session/runner/to-llm-message.ts:70`). Responses serializer store:false replays encrypted reasoning and store:true uses item_reference (`O/packages/llm/src/protocols/openai-responses.ts:346`, `:389`, `:446`). This is another shared format with escape hatches, not per-provider archives all the way down. Legacy OpenCode uses AI SDK shared format too; native/default SDK paths differ and absent external dependencies limit exact default-wire audit.

Recommendation: retain IH's semantic model and explicit continuation envelope unless concrete missing fields/invalid replay prove a redesign necessary. Strengthen versioned provenance/epoch binding, preserve protocol order atomically, specify cross-model downgrade rules, validate call/result balance and final payload per adapter, and measure **final serialized bytes independently of tokens**. Unified semantic representation, native fidelity and provider-specific admission are complementary. A 100 MB session archive works when only selected valid bounded context reaches the provider; changing the name or number of intermediate formats cannot by itself fix oversized request bodies or token overflow.
