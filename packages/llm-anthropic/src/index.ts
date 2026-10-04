import { createHash } from "node:crypto"
import { ANTHROPIC_MAX_TOKENS_FALLBACK, canReplayContinuation, describeTransportError, projectImagesForTextModel, replayBlockOrder, resolvePromptCacheMode, SSEParseError, type LLMContentPart, type LLMRequest, type LLMStreamEvent, type LLMUsage, type ModelClient, type PromptCacheConfig, type ProviderBlockOrderEntry, type ProviderThinkingBlock, type ReasoningEffort, type RetryableErrorCode } from "@i-harness/llm-seam"

function fingerprintPrefix(system: unknown, tools: unknown, messages: unknown): string {
  return createHash("sha256").update(JSON.stringify({ system, tools, messages })).digest("hex")
}

/**
 * M5 T2: the wire's usage, under the seam's names.
 *
 * Returns `undefined` when the object carries no recognisable number, so the
 * caller emits NO event rather than an empty one. That distinction is the whole
 * point: the cache fields are optional on the wire, and a fabricated
 * `cacheReadTokens: 0` would read as a measurement of zero rather than as
 * "not reported". Fields are copied verbatim and never derived — the
 * API's `input_tokens` does NOT include the cache counts, so summing them here
 * would invent a number the provider never stated.
 */
function mapUsage(raw: unknown): LLMUsage | undefined {
  if (raw === null || typeof raw !== "object") return undefined
  const src = raw as Record<string, unknown>
  const out: LLMUsage = {}
  const take = (from: string, to: Exclude<keyof LLMUsage, "inputTokenSemantics">): void => {
    const v = src[from]
    if (typeof v === "number" && Number.isFinite(v)) out[to] = v
  }
  take("input_tokens", "inputTokens")
  take("output_tokens", "outputTokens")
  take("cache_read_input_tokens", "cacheReadTokens")
  take("cache_creation_input_tokens", "cacheCreationTokens")
  if (out.inputTokens !== undefined && Number.isSafeInteger(out.inputTokens) && out.inputTokens >= 0) out.inputTokenSemantics = "excludes-cache"
  return Object.keys(out).length > 0 ? out : undefined
}

export interface AnthropicConfig {
  apiKey: string
  baseUrl?: string
  model: string
  providerId?: string
  options?: Record<string, unknown>
  promptCache?: PromptCacheConfig
  // M14: mirrors ProviderProfile.inputModalities — when the route lacks
  // "image", images are projected out before wire mapping. Forwarded by
  // buildModelClient (Task 6).
  inputModalities?: ("text" | "image")[]
  /** M59: literal extra request headers (gateway-required). The adapter's own
   * headers win on collision. */
  headers?: Record<string, string>
}

/** M60 G: configured headers merged UNDER the adapter's own request headers.
 * Configured names are lower-cased and any that collide (case-insensitively)
 * with an adapter-owned name are DROPPED — Fetch combines `Authorization` and
 * `authorization` into one comma-joined value, so a case-variant duplicate
 * would corrupt the auth header. */
function mergeConfiguredHeaders(
  configured: Record<string, string> | undefined,
  owned: Record<string, string>,
): Record<string, string> {
  const taken = new Set(Object.keys(owned).map((key) => key.toLowerCase()))
  const out: Record<string, string> = {}
  for (const [key, value] of Object.entries(configured ?? {})) {
    const lower = key.toLowerCase()
    if (!taken.has(lower)) out[lower] = value
  }
  return { ...out, ...owned }
}

// Shape LLM content parts into Anthropic Messages content blocks. String
// content stays the legacy string (byte-identical). Tool results are NOT
// passed through here (Anthropic does not accept image blocks inside
// tool_result; the synthetic user message carries them).
function toAnthropicContent(content: string | LLMContentPart[]): unknown {
  if (typeof content === "string") return content
  return content.map((part) =>
    part.type === "text"
      ? { type: "text", text: part.text }
      : { type: "image", source: { type: "base64", media_type: part.image.mediaType, data: part.image.dataBase64 } },
  )
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

/** Work on the final wire copy so cache markers never enter signed-continuation
 * fingerprints or mutate the neutral transcript. Only cache-control locations
 * are visited: a tool schema or tool argument named cache_control is data. */
function applyPromptCache(body: Record<string, unknown>, config: PromptCacheConfig | undefined, intent: LLMRequest["promptCache"]): Record<string, unknown> {
  const mode = resolvePromptCacheMode(config, intent)
  if (mode === undefined) return body
  const tools = Array.isArray(body.tools) ? body.tools : []
  const messages = Array.isArray(body.messages) ? body.messages : []
  const blocks = (content: unknown): Record<string, unknown>[] => Array.isArray(content) ? content.filter(isRecord) : []
  const cleanBlock = (block: unknown): unknown => {
    if (!isRecord(block)) return block
    const clean = { ...block }
    delete clean.cache_control
    if (block.type === "tool_result" && Array.isArray(block.content)) clean.content = block.content.map(cleanBlock)
    return clean
  }
  if (mode === "off") {
    const clean = { ...body }
    delete clean.cache_control
    return {
      ...clean,
      system: Array.isArray(body.system) ? body.system.map(cleanBlock) : body.system,
      tools: tools.map(cleanBlock),
      messages: messages.map((message) => isRecord(message) && Array.isArray(message.content) ? { ...message, content: message.content.map(cleanBlock) } : message),
    }
  }
  // A caller's existing automatic wire option also occupies one slot. Its TTL
  // wins so the final explicit block cannot disagree with that moving marker.
  const manual = isRecord(body.cache_control) ? body.cache_control : undefined
  const retention = manual?.type === "ephemeral" ? manual.ttl : config?.retention
  const marker = { type: "ephemeral", ...(retention !== undefined ? { ttl: retention } : {}) }
  let used = Object.hasOwn(body, "cache_control") ? 1 : 0
  const countBlock = (block: Record<string, unknown>): void => {
    if (Object.hasOwn(block, "cache_control")) used++
    if (block.type === "tool_result") for (const inner of blocks(block.content)) countBlock(inner)
  }
  for (const block of [...blocks(body.system), ...tools.filter(isRecord), ...messages.flatMap((message) => isRecord(message) ? blocks(message.content) : [])]) countBlock(block)
  const mark = (block: Record<string, unknown>): Record<string, unknown> => {
    if (used >= 4 || Object.hasOwn(block, "cache_control")) return block
    used++
    return { ...block, cache_control: { ...marker } }
  }
  let system = body.system
  if (typeof system === "string" && system.length > 0 && used < 4) system = [mark({ type: "text", text: system })]
  const cachedTools = tools.map((tool, index) => index === tools.length - 1 && isRecord(tool) ? mark(tool) : tool)
  const cachedMessages = [...messages]
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index]
    if (!isRecord(message) || message.role !== "user") continue
    if (typeof message.content === "string") {
      if (message.content.length === 0 || used >= 4) continue
      cachedMessages[index] = { ...message, content: [mark({ type: "text", text: message.content })] }
      break
    }
    if (!Array.isArray(message.content)) continue
    const content = [...message.content]
    const last = content.findLastIndex((block) => isRecord(block) && (block.type === "tool_result" || block.type === "image" || block.type === "text" && typeof block.text === "string" && block.text.length > 0))
    if (last === -1) continue
    content[last] = mark(content[last] as Record<string, unknown>)
    cachedMessages[index] = { ...message, content }
    break
  }
  return { ...body, system, tools: cachedTools, messages: cachedMessages }
}

/**
 * M32 generation rule (cc-custom style, adapter-internal): model names
 * carrying a 4.x minor ≥ 6 (e.g. claude-sonnet-4-6, claude-opus-4-7/-4-8,
 * also the -4.6 dotted style, and anything later) use the ADAPTIVE thinking
 * protocol; every older generation uses the legacy budget protocol.
 */
const ADAPTIVE_THINKING_RE = /claude-(?:opus|sonnet|haiku|fable|mythos)-(?:4[-.](?:6|7|8|9|[1-9][0-9]+)|[5-9](?:[-.]|$))/

/** Legacy budgets are numeric; the UI's upper effort levels map to larger budgets. */
function legacyBudgetTokens(effort: "low" | "medium" | "high" | "xhigh" | "max"): number {
  return effort === "low" ? 2048 : effort === "medium" ? 8192 : effort === "high" ? 16384 : effort === "xhigh" ? 32768 : 65536
}

/**
 * M32 anthropic translation table with generation rules:
 * - 4.6+ → `thinking:{type:"adaptive"}` + `output_config:{effort}` (effort
 *   verbatim — xhigh/max included, the provider rejects what it cannot do).
 * - legacy → numeric `thinking:{type:"enabled", budget_tokens:N}`; effort is
 *   never sent to legacy (its translation is a token budget).
 * - "off" → return undefined: NO thinking block in either generation.
 * - unset → undefined (don't send — provider default).
 */
export function translateReasoning(model: string, effort: ReasoningEffort | undefined):
  | { thinking: { type: "adaptive" }; output_config: { effort: string } }
  | { thinking: { type: "enabled"; budget_tokens: number } }
  | undefined {
  if (effort === undefined || effort === "off") return undefined
  if (ADAPTIVE_THINKING_RE.test(model)) {
    return { thinking: { type: "adaptive" }, output_config: { effort } }
  }
  return { thinking: { type: "enabled", budget_tokens: legacyBudgetTokens(effort) } }
}

export function parseSSE(text: string): Record<string, unknown>[] {
  return text
    .split("\n\n")
    .filter((chunk) => chunk.includes("data:"))
    .map((chunk) => {
      const dataLine = chunk.split("\n").find((l) => l.startsWith("data:"))!
      const data = dataLine.slice(5).trim()
      try {
        return JSON.parse(data) as Record<string, unknown>
      } catch (err) {
        throw new SSEParseError(data)
      }
    })
}

export function createAnthropicClient(config: AnthropicConfig): ModelClient {
  const baseUrl = config.baseUrl ?? "https://api.anthropic.com"
  return {
    async *stream(request: LLMRequest): AsyncIterable<LLMStreamEvent> {
      // M14 negative capability: text-only routes never see image bytes.
      const vision = config.inputModalities?.includes("image") ?? false
      const messages = vision ? request.messages : projectImagesForTextModel(request.messages)
      const maxTokens = request.maxOutputTokens ??
        (typeof config.options?.max_tokens === "number" ? config.options.max_tokens : ANTHROPIC_MAX_TOKENS_FALLBACK)
      const reasoning = translateReasoning(config.model, request.reasoningEffort)
      if (reasoning && reasoning.thinking.type === "enabled" && maxTokens <= 1024) {
        yield { type: "error", error: new Error("anthropic thinking requires max_tokens above 1024") }
        return
      }
      const boundedReasoning = reasoning?.thinking.type === "enabled"
        ? { thinking: { type: "enabled" as const, budget_tokens: Math.min(reasoning.thinking.budget_tokens, maxTokens - 1) } }
        : reasoning
      const wireTools = request.tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.inputSchema }))
      const wireMessages: { role: "user" | "assistant"; content: unknown }[] = []
      let toolResults: unknown[] | undefined
      let invalidThinkingChain = false
      for (const m of messages) {
        if (m.role === "tool") {
          if (toolResults === undefined) {
            toolResults = []
            wireMessages.push({ role: "user", content: toolResults })
          }
          toolResults.push({ type: "tool_result", tool_use_id: m.toolCallId, content: m.content, ...(m.isError === true ? { is_error: true } : {}) })
          continue
        }
        toolResults = undefined
        if (m.role === "assistant" && m.toolCalls && m.toolCalls.length > 0) {
          // New streams keep the provider's interleaved block order. Older
          // sessions without that metadata retain the canonical fallback.
          const continuation = m.providerContinuation?.kind === "anthropic" ? m.providerContinuation : undefined
          const sourceMatches = m.providerContinuation?.kind === undefined || continuation !== undefined && canReplayContinuation(continuation, config)
          const prefixMatches = continuation?.prefixFingerprint === undefined || continuation.prefixFingerprint === fingerprintPrefix(request.systemPrompt, wireTools, wireMessages)
          const toolsMatch = continuation?.prefixFingerprint === undefined || continuation.toolBindings?.length === m.toolCalls.length && continuation.toolBindings.every((binding, index) => {
            const call = m.toolCalls![index]
            return call !== undefined && binding.name === call.name && binding.inputJson === JSON.stringify(call.args) && (binding.id === undefined || binding.id === call.id)
          })
          if (m.thinkingBlocks?.length) {
            // A later response produced after earlier blocks were dropped has
            // its own valid prefix. Its fingerprint starts a new chain.
            if (continuation?.prefixFingerprint !== undefined) invalidThinkingChain = !sourceMatches || !prefixMatches || !toolsMatch
            else if (!sourceMatches) invalidThinkingChain = true
          }
          let replayThinking = invalidThinkingChain ? [] : m.thinkingBlocks ?? []
          const toolBlocks = m.toolCalls.map((c) => ({ type: "tool_use", id: c.id, name: c.name, input: c.args }))
          const order = continuation && sourceMatches ? continuation.contentOrder : undefined
          let orderedContent = replayBlockOrder<unknown>(invalidThinkingChain ? order?.filter((entry) => entry.kind !== "reasoning") : order, m.content, replayThinking, toolBlocks, (text) => ({ type: "text", text }))
          if (order && orderedContent === undefined && replayThinking.length) {
            invalidThinkingChain = true
            replayThinking = []
            orderedContent = replayBlockOrder<unknown>(order.filter((entry) => entry.kind !== "reasoning"), m.content, [], toolBlocks, (text) => ({ type: "text", text }))
          }
          const content: unknown[] = orderedContent ?? [...replayThinking, ...(m.content.trim() !== "" ? [{ type: "text", text: m.content }] : []), ...toolBlocks]
          wireMessages.push({ role: "assistant", content })
          continue
        }
        wireMessages.push({ role: m.role, content: toAnthropicContent(m.content) })
      }
      const body = {
        ...(config.options ?? {}),
        // Extra route options must not replace the selected model or the
        // neutral transcript that provenance and signature checks describe.
        model: config.model,
        system: request.systemPrompt,
        messages: wireMessages,
        tools: wireTools,
        stream: true,
        // M32: request-level effort wins over config.options (explicit per-request intent).
        ...(boundedReasoning ?? {}),
        // M72 Ⅱ: `max_tokens` is REQUIRED by the Messages API — the one wire
        // where "send nothing" is not an option. The chain is request → route
        // options → the named constant, so a route that already configured
        // `options.max_tokens` keeps working and the constant is the last resort.
        max_tokens: maxTokens,
      }
      const payload = applyPromptCache(body, config.promptCache, request.promptCache)
      // M62: a TRANSPORT failure (fetch rejects before any HTTP response) used
      // to escape as Node's bare "fetch failed", which cannot distinguish DNS /
      // TCP / TLS / proxy. Surface the cause chain instead.
      let response: Response
      try {
        response = await fetch(`${baseUrl}/v1/messages`, {
          method: "POST",
          headers: mergeConfiguredHeaders(config.headers, { "Content-Type": "application/json", "x-api-key": config.apiKey, "anthropic-version": "2023-06-01" }),
          body: JSON.stringify(payload),
          // M61: the caller's abort signal reaches the transport — cancel must
          // kill a parked request, not wait for the first event.
          ...(request.signal !== undefined ? { signal: request.signal } : {}),
        })
      } catch (error) {
        yield { type: "error", error: await describeTransportError("anthropic", `${baseUrl}/v1/messages`, error) }
        return
      }
      if (!response.ok || !response.body) {
        yield { type: "error", error: new Error(`anthropic request failed: ${response.status} ${await response.text()}`) }
        return
      }
      const reader = response.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ""
      // M72 Ⅱ: the wire's own truncation literal (`stop_reason: "max_tokens"`)
      // — set in `handleEvent` below, read once at the ending. Absent stays
      // absent: only `true` writes the field.
      let truncated = false
      // M77: `stop_reason: "refusal"` — the model declined to produce content.
      // Its sibling `stop_reason: "model_context_window_exceeded"` is NOT a
      // refusal (it is an input-side signal) and does not set this: that arm
      // yields the seam's existing `CONTEXT_WINDOW_EXCEEDED` error code
      // instead. A separate variable from `truncated` because the two are
      // independent — neither is the other's `else`. Only `true` is written.
      let refused = false
      const thinkingBlocks: ProviderThinkingBlock[] = []
      const blockOrder = new Map<number, ProviderBlockOrderEntry>()
      let toolOrdinal = 0
      const toolBindings: { id?: string; name: string; inputJson: string }[] = []
      const pendingThinking = new Map<number, { thinking: string; signature: string }>()
      const pendingToolUses = new Map<number, { id?: string; name: string; argsBuffer: string; ordinal: number }>()
      const handleEvent = (event: Record<string, unknown>): LLMStreamEvent[] => {
        const t = event.type as string
        const index = event.index as number
        // M5 T2: the two events that carry usage, until now falling through to
        // `return []` with their numbers unread. They arrive on DIFFERENT ends
        // of the same round-trip — message_start holds the input side (including
        // both cache counts), message_delta the final output count — so the
        // consumer merges them rather than this adapter buffering.
        if (t === "message_start") {
          const usage = mapUsage((event.message as { usage?: unknown } | undefined)?.usage)
          return usage ? [{ type: "usage", usage }] : []
        }
        if (t === "message_delta") {
          const stop = (event.delta as { stop_reason?: string } | undefined)?.stop_reason
          if (stop === "max_tokens") truncated = true
          // M77: the model refused. HTTP 200 with no content, so before M77
          // the seam reported an empty SUCCESS for a turn the model declined.
          if (stop === "refusal") refused = true
          // M77: and this one is deliberately NOT the bit. The Messages API
          // states the INPUT did not fit, and the seam already owns that
          // vocabulary — `RetryableErrorCode`'s `CONTEXT_WINDOW_EXCEEDED`,
          // classified by the seam's retry classifier off an error's `code`
          // field and deliberately absent from the default retryable set (a
          // retry cannot shrink an over-window request). So the code goes on
          // that same field, in this adapter's existing `${label}: ${detail}`
          // error shape, and the event is terminal — no `end`, no bit, and the
          // consumer learns "the provider said the window is too small"
          // instead of seeing a silent empty success.
          // M77 (fix wave): mapped BEFORE the context arm's early return. That
          // arm used to return first, and this same `message_delta` is the one
          // that carries the round-trip's output count — so the number was
          // dropped for a round-trip the provider had already priced. The
          // retry wrapper hides it (a held-aside `usage` is discarded when the
          // attempt settles on an error); an unwrapped client saw nil. The
          // error is still terminal, and the report rides AHEAD of it: `emit`
          // stops at the first error event, so anything after it is never seen.
          const usage = mapUsage(event.usage)
          if (stop === "model_context_window_exceeded") {
            const error = new Error(`stop_reason: ${stop}`) as Error & { code?: RetryableErrorCode }
            error.code = "CONTEXT_WINDOW_EXCEEDED"
            return usage ? [{ type: "usage", usage }, { type: "error", error }] : [{ type: "error", error }]
          }
          return usage ? [{ type: "usage", usage }] : []
        }
        if (t === "content_block_start") {
          const block = event.content_block as { type: string; id?: string; name?: string; input?: unknown; text?: string; thinking?: string; signature?: string; data?: string }
          if (block?.type === "tool_use") {
            const ordinal = toolOrdinal++
            blockOrder.set(index, { kind: "tool", index: ordinal })
            const input = block.input as Record<string, unknown> | undefined
            // Some streams send the full input inline on the start event; if
            // present (and non-empty) seed the args buffer with it.
            const hasInlineInput = !!input && Object.keys(input).length > 0
            pendingToolUses.set(index, {
              ...(block.id ? { id: block.id } : {}),
              name: block.name ?? "",
              argsBuffer: hasInlineInput ? JSON.stringify(input) : "",
              ordinal,
            })
          } else if (block?.type === "thinking") {
            pendingThinking.set(index, { thinking: block.thinking ?? "", signature: block.signature ?? "" })
            return [{ type: "reasoning", blockId: String(index), text: block.thinking ?? "" }]
          } else if (block?.type === "redacted_thinking" && typeof block.data === "string") {
            thinkingBlocks.push({ type: "redacted_thinking", data: block.data })
            blockOrder.set(index, { kind: "reasoning", index: thinkingBlocks.length - 1 })
          } else if (block?.type === "text") {
            blockOrder.set(index, { kind: "text", text: block.text ?? "" })
            return block.text ? [{ type: "text/chunk", text: block.text }] : []
          }
          return []
        }
        if (t === "content_block_delta") {
          const delta = event.delta as { type: string; text?: string; partial_json?: string; thinking?: string; signature?: string }
          if (delta?.type === "text_delta") {
            const block = blockOrder.get(index)
            if (block?.kind === "text") block.text += delta.text ?? ""
            return [{ type: "text/chunk", text: delta.text ?? "" }]
          }
          if (delta?.type === "input_json_delta") {
            const pending = pendingToolUses.get(index)
            if (pending) pending.argsBuffer += delta.partial_json ?? ""
            return []
          }
          if (delta?.type === "thinking_delta") {
            const pending = pendingThinking.get(index)
            if (pending) pending.thinking += delta.thinking ?? ""
            return [{ type: "reasoning", blockId: String(index), text: delta.thinking ?? "" }]
          }
          if (delta?.type === "signature_delta") {
            const pending = pendingThinking.get(index)
            if (pending) pending.signature += delta.signature ?? ""
          }
          return []
        }
        if (t === "content_block_stop") {
          const thinking = pendingThinking.get(index)
          if (thinking) {
            pendingThinking.delete(index)
            if (thinking.signature) {
              thinkingBlocks.push({ type: "thinking", thinking: thinking.thinking, signature: thinking.signature })
              blockOrder.set(index, { kind: "reasoning", index: thinkingBlocks.length - 1 })
            }
          }
          const pending = pendingToolUses.get(index)
          if (pending) {
            pendingToolUses.delete(index)
            if (pending.argsBuffer.trim() === "") {
              // Empty inline input ({}) with no deltas → no-arg tool call.
              toolBindings[pending.ordinal] = { ...(pending.id ? { id: pending.id } : {}), name: pending.name, inputJson: "{}" }
              return [{ type: "tool_call", call: { ...(pending.id ? { id: pending.id } : {}), name: pending.name, args: {} } }]
            }
            try {
              const args = JSON.parse(pending.argsBuffer) as unknown
              toolBindings[pending.ordinal] = { ...(pending.id ? { id: pending.id } : {}), name: pending.name, inputJson: JSON.stringify(args) }
              return [{ type: "tool_call", call: { ...(pending.id ? { id: pending.id } : {}), name: pending.name, args } }]
            } catch {
              return [{ type: "error", error: new Error("anthropic malformed tool_use input") }]
            }
          }
          return []
        }
        // M72 Ⅰ: Anthropic reports mid-stream failures as an SSE `error` event on
        // an HTTP 200 stream. Without this arm the event fell into `return []`,
        // the loop finished, and the caller got a clean `end` for a failed
        // round-trip — the seam's own words: a failure must not read as success.
        if (t === "error") {
          const err = event.error as { type?: string; message?: string } | undefined
          return [{ type: "error", error: new Error(`${err?.type ?? "error"}: ${err?.message ?? "provider reported an error"}`) }]
        }
        return []
      }
      const emitEvents = function* (events: LLMStreamEvent[]): Generator<LLMStreamEvent, boolean, unknown> {
        for (const ev of events) {
          if (ev.type === "error") {
            yield ev
            return true
          }
          yield ev
        }
        return false
      }
      try {
        while (true) {
          const { done, value } = await reader.read()
          if (done) break
          buffer += decoder.decode(value, { stream: true })
          // split on SSE boundaries; each data: line is one event
          const chunks = buffer.split("\n\n")
          buffer = chunks.pop() ?? ""
          for (const chunk of chunks) {
            for (const event of parseSSE(chunk)) {
              if (yield* emitEvents(handleEvent(event))) return
            }
          }
        }
        // flush any residual partial chunk left in the buffer before `end`
        if (buffer.trim() !== "") {
          for (const event of parseSSE(buffer)) {
            if (yield* emitEvents(handleEvent(event))) return
          }
        }
      } catch (err) {
        // M72 Ⅰ: a corrupt chunk is a provider failure → the seam's error channel.
        // Abort is NOT: an aborted signal keeps today's behaviour (a throw).
        if (request.signal?.aborted === true) throw err
        yield { type: "error", error: err instanceof Error ? err : new Error(String(err)) }
        return
      } finally {
        reader.releaseLock()
      }
      // M77: each bit is written on its own (a response can be both), and both
      // absent ⇒ the byte-exact `{ type: "end" }` every clean ending returned.
      const contentOrder = [...blockOrder.entries()].sort(([left], [right]) => left - right).map(([, entry]) => entry)
      const rank = { reasoning: 0, text: 1, tool: 2 } as const
      let previousRank = -1
      const interleaved = contentOrder.some((entry) => {
        const current = rank[entry.kind]
        const outOfOrder = current < previousRank
        previousRank = Math.max(previousRank, current)
        return outOfOrder
      })
      yield { type: "end", ...(truncated ? { truncated: true } : {}), ...(refused ? { refused: true } : {}), ...(thinkingBlocks.length ? { thinkingBlocks } : {}), ...(thinkingBlocks.length || interleaved ? { providerContinuation: { kind: "anthropic", model: config.model, ...(config.providerId ? { providerId: config.providerId } : {}), ...(interleaved ? { contentOrder } : {}), ...(thinkingBlocks.length ? { prefixFingerprint: fingerprintPrefix(body.system, body.tools, body.messages) } : {}), ...(toolBindings.length ? { toolBindings } : {}) } as const } : {}) }
    },
  }
}
