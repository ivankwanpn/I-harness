import { describeTransportError, projectImagesForTextModel, SSEParseError, type LLMContentPart, type LLMRequest, type LLMStreamEvent, type LLMUsage, type ModelClient, type ReasoningEffort } from "@i-harness/llm-seam"

/**
 * M72 Ⅲ: the wire's usage, under the seam's names.
 *
 * Returns `undefined` when the object carries no recognisable number, so the
 * caller emits NO event rather than an empty one. This wire delivers usage in
 * one place only — the trailing chunk the `stream_options` ask buys, whose
 * `choices` is empty and whose `usage` is the whole payload. A gateway reports
 * only the counters it counted (`prompt_cache_hit_tokens` is a cache extension
 * the others do not have), and a fabricated `0` for a counter nobody sent would
 * read as a measurement of zero rather than as "not reported". Fields are copied
 * verbatim and never derived.
 */
function mapUsage(raw: unknown): LLMUsage | undefined {
  if (raw === null || typeof raw !== "object") return undefined
  const src = raw as Record<string, unknown>
  const out: LLMUsage = {}
  const take = (from: string, to: keyof LLMUsage): void => {
    const v = src[from]
    if (typeof v === "number" && Number.isFinite(v)) out[to] = v
  }
  take("prompt_tokens", "inputTokens")
  take("completion_tokens", "outputTokens")
  take("prompt_cache_hit_tokens", "cacheReadTokens")
  return Object.keys(out).length > 0 ? out : undefined
}

export interface OpenAICompatibleConfig {
  apiKey: string
  baseUrl?: string
  model: string
  options?: Record<string, unknown>
  // M14: mirrors ProviderProfile.inputModalities — when the route lacks
  // "image", images are projected out before wire mapping. Forwarded by
  // buildModelClient (Task 6).
  inputModalities?: ("text" | "image")[]
  /** M72 Ⅱ: which wire field carries the cap on THIS route. Default
   * `max_tokens` (the compatible-gateway spelling). */
  maxTokensField?: "max_tokens" | "max_completion_tokens"
  /** M72 Ⅲ: whether this route's requests ASK for usage
   * (`stream_options.include_usage`). Default `true` — this is the one protocol
   * of the five that reports usage only on request, so no other wire needs the
   * ask. `false` sends NOTHING (not `include_usage: false`): the switch exists
   * for a gateway that rejects the KEY, and such a gateway rejects it whatever
   * its value. A route-level capability flag — Pi's `supportsUsageInStreaming`. */
  usageInStream?: boolean
  /** M59: literal extra request headers (gateway-required, e.g. OpenCode
   * Zen's x-opencode-session). The adapter's own headers win on collision. */
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

// Shape LLM content parts into the Chat Completions `content` array. String
// content stays the legacy string (byte-identical).
function toContent(content: string | LLMContentPart[]): unknown {
  if (typeof content === "string") return content
  return content.map((part) =>
    part.type === "text"
      ? { type: "text", text: part.text }
      : { type: "image_url", image_url: { url: `data:${part.image.mediaType};base64,${part.image.dataBase64}` } },
  )
}

/**
 * M32 openai-family translation table (Responses | Chat | DeepSeek — ONE
 * table, zero generation special-casing): the effort is passed through
 * verbatim and "off" maps to "none" (top-level Chat `reasoning_effort`).
 * DeepSeek uses the SAME table — its server maps medium→high itself.
 * Unset effort → undefined (don't send).
 */
export function translateReasoning(_model: string, effort: ReasoningEffort | undefined): { reasoning_effort: string } | undefined {
  if (effort === undefined) return undefined
  return { reasoning_effort: effort === "off" ? "none" : effort }
}

export function parseSSE(text: string): Record<string, unknown>[] {
  return text
    .split("\n\n")
    .filter((chunk) => chunk.includes("data:"))
    .map((chunk) => {
      const dataLine = chunk.split("\n").find((l) => l.startsWith("data:"))!
      const data = dataLine.slice(5).trim()
      if (data === "[DONE]") return { type: "[DONE]" }
      try {
        return JSON.parse(data) as Record<string, unknown>
      } catch (err) {
        throw new SSEParseError(data)
      }
    })
}

// Translate the neutral LLMMessage union into Chat Completions wire messages.
function toWireMessage(m: {
  role: "user" | "assistant" | "tool"
  content: string | LLMContentPart[]
  toolCalls?: { id: string; name: string; args: unknown }[]
  toolCallId?: string
}): Record<string, unknown> {
  if (m.role === "tool") return { role: "tool", tool_call_id: m.toolCallId!, content: toContent(m.content) }
  if (m.role === "assistant" && m.toolCalls && m.toolCalls.length > 0) {
    return {
      role: "assistant",
      content: toContent(m.content),
      tool_calls: m.toolCalls.map((c) => ({
        id: c.id,
        type: "function",
        function: { name: c.name, arguments: JSON.stringify(c.args) },
      })),
    }
  }
  return { role: m.role, content: toContent(m.content) }
}

export function createOpenAICompatibleClient(config: OpenAICompatibleConfig): ModelClient {
  const baseUrl = config.baseUrl ?? "https://api.openai.com"
  return {
    async *stream(request: LLMRequest): AsyncIterable<LLMStreamEvent> {
      // M14 negative capability: text-only routes never see image bytes.
      const messages = config.inputModalities?.includes("image") ?? false ? request.messages : projectImagesForTextModel(request.messages)
      const body = {
        model: config.model,
        // M72 Ⅰ: the system prompt is the first MESSAGE. The old code sent no
        // system content at all — chat/completions has no top-level `system`
        // FIELD, but the role IS the mapping, and dropping it meant every
        // request to a compatible gateway ran without its system prompt.
        // Blank → no message: same rule as llm-gemini/llm-bedrock, and an
        // empty system turn is pure overhead.
        messages: [
          ...(request.systemPrompt.trim() !== "" ? [{ role: "system", content: request.systemPrompt }] : []),
          ...messages.map(toWireMessage),
        ],
        tools: request.tools.map((t) => ({
          type: "function",
          function: { name: t.name, description: t.description, parameters: t.inputSchema },
        })),
        stream: true,
        // M72 Ⅲ: usage must be ASKED for on this wire (the other four report it
        // unasked). Default ON — a routing flag, not a guess about capability;
        // a gateway that rejects the key is switched off per route with
        // `usageInStream: false` (Pi's supportsUsageInStreaming, explicit).
        // Written BEFORE the route's raw `options` so the more specific
        // statement still wins: an `options` key that collides must override
        // this default, never be clobbered by it.
        ...((config.usageInStream ?? true) ? { stream_options: { include_usage: true } } : {}),
        ...(config.options ?? {}),
        // M32: request-level effort wins over config.options (explicit per-request intent).
        ...(translateReasoning(config.model, request.reasoningEffort) ?? {}),
        // M72 Ⅱ: the field NAME is a per-route choice — `max_tokens` is what
        // compatible gateways take, `max_completion_tokens` is what the newest
        // OpenAI models demand. Explicit config, not a guess (Pi's
        // maxTokensField solves the same problem by probing).
        ...(request.maxOutputTokens !== undefined
          ? { [config.maxTokensField ?? "max_tokens"]: request.maxOutputTokens }
          : {}),
      }
      // M62: a TRANSPORT failure (fetch rejects before any HTTP response) used
      // to escape as Node's bare "fetch failed", which cannot distinguish DNS /
      // TCP / TLS / proxy. Surface the cause chain instead.
      let response: Response
      try {
        response = await fetch(`${baseUrl}/v1/chat/completions`, {
          method: "POST",
          headers: mergeConfiguredHeaders(config.headers, { "Content-Type": "application/json", Authorization: `Bearer ${config.apiKey}` }),
          body: JSON.stringify(body),
          // M61: the caller's abort signal reaches the transport — cancel must
          // kill a parked request, not wait for the first event.
          ...(request.signal !== undefined ? { signal: request.signal } : {}),
        })
      } catch (error) {
        yield { type: "error", error: await describeTransportError("openai-compatible", `${baseUrl}/v1/chat/completions`, error) }
        return
      }
      if (!response.ok || !response.body) {
        yield { type: "error", error: new Error(`openai-compatible request failed: ${response.status} ${await response.text()}`) }
        return
      }
      const reader = response.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ""
      let receivedDone = false
      // M72 Ⅱ: the wire's own truncation literal (`finish_reason: "length"`) —
      // set in handleFrame below, read once at the ending. Absent stays
      // absent: only `true` writes the field.
      let truncated = false
      // tool call accumulation: index -> { id, name, argsBuffer }
      const pendingToolCalls = new Map<number, { id: string; name: string; argsBuffer: string }>()

      const emit = function* (events: LLMStreamEvent[]): Generator<LLMStreamEvent, boolean, unknown> {
        for (const ev of events) {
          if (ev.type === "error") {
            yield ev
            return true
          }
          yield ev
        }
        return false
      }

      // Emit any tool call whose accumulated function.arguments now form a
      // complete JSON document. Chat Completions streams the tool-call
      // arguments as one JSON string split across deltas, so a successful
      // parse means the arguments have fully arrived; emitting here keeps
      // tool_call events in stream order (before later text chunks).
      const flushParsedToolCalls = function* (): Generator<LLMStreamEvent, boolean, unknown> {
        for (const [index, pending] of pendingToolCalls) {
          try {
            const args = JSON.parse(pending.argsBuffer) as unknown
            pendingToolCalls.delete(index)
            if (yield* emit([{ type: "tool_call", call: { name: pending.name, args } }])) return true
          } catch {
            // arguments still incomplete; keep accumulating
          }
        }
        return false
      }

      // M72 Ⅲ: ONE frame handler for both the read loop and the residual
      // flush. R12 patched the second copy of a rule; the copies had already
      // drifted (the flush never accumulated tool-call fragments, so a tool
      // call arriving only in a boundary-less final frame was dropped). New
      // wire rules land HERE, once.
      const handleFrame = (event: Record<string, unknown>): { events: LLMStreamEvent[]; done: boolean } => {
        if (event.type === "[DONE]") return { events: [], done: true }
        const events: LLMStreamEvent[] = []
        const choices = (event as { choices?: { delta?: Record<string, unknown> }[] }).choices ?? []
        for (const choice of choices) {
          const delta = choice.delta ?? {}
          // R12: a final frame that lost its trailing "\n\n" is parsed here
          // too (via the residual flush), and the provider's failure channel
          // must not depend on where the frame boundary fell — one rule, both
          // callers.
          if ((choice as { finish_reason?: string }).finish_reason === "length") truncated = true
          // M72 Ⅲ: DeepSeek-family gateways stream the reasoning text on
          // `delta.reasoning_content` — a sibling of `content` that had ZERO
          // readers in this tree, so the whole trajectory was dropped. Pushed
          // BEFORE this frame's content: a model that both thinks and answers
          // does so in that order.
          const reasoningText = (delta as { reasoning_content?: unknown }).reasoning_content
          if (typeof reasoningText === "string" && reasoningText.length > 0) {
            events.push({ type: "reasoning", text: reasoningText })
          }
          if (typeof delta.content === "string" && delta.content.length > 0) {
            events.push({ type: "text/chunk", text: delta.content })
          }
          const toolCalls = (delta as { tool_calls?: { index?: number; id?: string; function?: { name?: string; arguments?: string } }[] }).tool_calls
          if (toolCalls) {
            for (const tc of toolCalls) {
              const idx = tc.index ?? 0
              let pending = pendingToolCalls.get(idx)
              if (!pending) {
                pending = { id: tc.id ?? `call_${idx}`, name: tc.function?.name ?? "", argsBuffer: "" }
                pendingToolCalls.set(idx, pending)
              }
              if (tc.id) pending.id = tc.id
              if (tc.function?.name) pending.name = tc.function.name
              if (tc.function?.arguments) pending.argsBuffer += tc.function.arguments
            }
          }
        }
        // M72 Ⅲ: the ask above buys a trailing usage-only chunk — `choices: []`
        // with the round-trip's counters. It is the ONE carrier of usage on this
        // wire, and it is handled here, at the single frame handler both loops
        // share (Task 4), so the residual flush reports it identically.
        const usage = mapUsage((event as { usage?: unknown }).usage)
        if (usage !== undefined) events.push({ type: "usage", usage })
        return { events, done: false }
      }

      try {
        while (true) {
          const { done, value } = await reader.read()
          if (done) break
          buffer += decoder.decode(value, { stream: true })
          const chunks = buffer.split("\n\n")
          buffer = chunks.pop() ?? ""
          for (const chunk of chunks) {
            if (receivedDone) break
            for (const event of parseSSE(chunk)) {
              if (receivedDone) break
              const frame = handleFrame(event)
              if (frame.done) {
                receivedDone = true
                break
              }
              if (yield* emit(frame.events)) return
              if (yield* flushParsedToolCalls()) return
            }
          }
          if (receivedDone) break
        }
        // flush residual buffer
        if (buffer.trim() !== "") {
          for (const event of parseSSE(buffer)) {
            if (receivedDone) break
            const frame = handleFrame(event)
            if (frame.done) {
              receivedDone = true
              break
            }
            if (yield* emit(frame.events)) return
            if (yield* flushParsedToolCalls()) return
          }
        }
        // flush completed tool calls (fallback for streams that never produced
        // a parseable fragment until the very end)
        for (const [, pending] of pendingToolCalls) {
          try {
            const args = JSON.parse(pending.argsBuffer) as unknown
            if (yield* emit([{ type: "tool_call", call: { name: pending.name, args } }])) return
          } catch {
            if (yield* emit([{ type: "error", error: new Error(`openai-compatible malformed tool args: ${pending.argsBuffer}`) }])) return
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
      yield truncated ? { type: "end", truncated: true } : { type: "end" }
    },
  }
}
