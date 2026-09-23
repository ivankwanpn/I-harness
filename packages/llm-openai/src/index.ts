import { describeTransportError, projectImagesForTextModel, SSEParseError, type LLMContentPart, type LLMRequest, type LLMStreamEvent, type LLMUsage, type ModelClient, type ReasoningEffort } from "@i-harness/llm-seam"

export interface OpenAIConfig {
  apiKey: string
  baseUrl?: string
  model: string
  options?: Record<string, unknown>
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

function toInputContent(content: string | LLMContentPart[]): unknown {
  if (typeof content === "string") return content
  return content.map((part) =>
    part.type === "text"
      ? { type: "input_text", text: part.text }
      : { type: "input_image", image_url: `data:${part.image.mediaType};base64,${part.image.dataBase64}` },
  )
}

// M14 direct-path collapse: a host hand-built tool message with image parts
// becomes a function_call_output carrying only the text, followed by a user
// item carrying the images (matching what deriveMessages emits for the agent
// path). Returns undefined when there is nothing to split.
function splitToolContent(content: string | LLMContentPart[]): { text: string; images: Extract<LLMContentPart, { type: "image" }>[] } {
  if (typeof content === "string") return { text: content, images: [] }
  let text = ""
  const images: Extract<LLMContentPart, { type: "image" }>[] = []
  for (const part of content) {
    if (part.type === "text") text += part.text
    else images.push(part)
  }
  return { text, images }
}

/**
 * M32 openai-family translation table (Responses | Chat | DeepSeek — ONE
 * table, zero generation special-casing): the effort is passed through
 * verbatim and "off" maps to "none". DeepSeek uses the SAME table — its
 * server maps medium→high itself. Unset effort → undefined (don't send).
 */
export function translateReasoning(_model: string, effort: ReasoningEffort | undefined): { reasoning: { effort: string } } | undefined {
  if (effort === undefined) return undefined
  return { reasoning: { effort: effort === "off" ? "none" : effort } }
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

export function createOpenAIClient(config: OpenAIConfig): ModelClient {
  const baseUrl = config.baseUrl ?? "https://api.openai.com"
  return {
    async *stream(request: LLMRequest): AsyncIterable<LLMStreamEvent> {
      // M14 negative capability: text-only routes never see image bytes.
      const vision = config.inputModalities?.includes("image") ?? false
      const messages = vision ? request.messages : projectImagesForTextModel(request.messages)
      const body = {
        model: config.model,
        instructions: request.systemPrompt,
        input: messages
          .map((m) => {
            if (m.role === "user") return { role: "user", content: toInputContent(m.content) }
            if (m.role === "tool") {
              const { text, images } = splitToolContent(m.content)
              const output = { type: "function_call_output", call_id: m.toolCallId, output: text }
              if (images.length === 0) return output
              return [output, { role: "user", content: images.map((part) => ({ type: "input_image", image_url: `data:${part.image.mediaType};base64,${part.image.dataBase64}` })) }]
            }
            // assistant
            if (m.toolCalls && m.toolCalls.length > 0) {
              const calls = m.toolCalls.map((c) => ({
                type: "function_call",
                call_id: c.id,
                name: c.name,
                arguments: JSON.stringify(c.args),
              }))
              // M51/B2: a folded step message carries the step's text AND its
              // tool calls — emit the assistant text item before the
              // function_call items (dropping it lost the narration).
              return m.content.trim() !== "" ? [{ role: "assistant", content: m.content }, ...calls] : calls
            }
            return { role: "assistant", content: m.content }
          })
          .flat(),
        tools: request.tools.map((t) => ({ type: "function", name: t.name, description: t.description, parameters: t.inputSchema })),
        stream: true,
        ...(config.options ?? {}),
        // M32: request-level effort wins over config.options (explicit per-request intent).
        ...(translateReasoning(config.model, request.reasoningEffort) ?? {}),
        // M72 Ⅱ: a request-level cap, so it lands after config.options (the
        // same precedence rule the reasoning line above documents).
        ...(request.maxOutputTokens !== undefined ? { max_output_tokens: request.maxOutputTokens } : {}),
      }
      // M62: a TRANSPORT failure (fetch rejects before any HTTP response) used
      // to escape as Node's bare "fetch failed", which cannot distinguish DNS /
      // TCP / TLS / proxy. Surface the cause chain instead.
      let response: Response
      try {
        response = await fetch(`${baseUrl}/v1/responses`, {
          method: "POST",
          headers: mergeConfiguredHeaders(config.headers, { "Content-Type": "application/json", Authorization: `Bearer ${config.apiKey}` }),
          body: JSON.stringify(body),
          // M61: the caller's abort signal reaches the transport — cancel must
          // kill a parked request, not wait for the first event.
          ...(request.signal !== undefined ? { signal: request.signal } : {}),
        })
      } catch (error) {
        yield { type: "error", error: await describeTransportError("openai", `${baseUrl}/v1/responses`, error) }
        return
      }
      if (!response.ok || !response.body) {
        yield { type: "error", error: new Error(`openai request failed: ${response.status} ${await response.text()}`) }
        return
      }
      const reader = response.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ""
      let receivedDone = false
      // M72 Ⅱ: the Responses wire's own truncation literal lives in
      // `response.incomplete.incomplete_details.reason` — set in `handleEvent`
      // below, read once at the ending. Absent stays absent: only `true` writes
      // the field.
      let truncated = false
      // M77: the SAME field carries this wire's refusal literal,
      // `content_filter`. Before M77 that reason was recognised by nothing: the
      // stream ended HTTP 200 with no content, the seam reported an empty
      // SUCCESS, and core-agent logged an empty assistant message for a turn
      // the model had actually refused. Two variables rather than one: a
      // response can be both truncated and refused, so neither bit may be
      // produced as the other's `else`. Only `true` is ever written.
      let refused = false
      const pendingCalls = new Map<string, { name: string; argsBuffer: string }>()
      const yieldedInline = new Set<string>()
      // M77 (fix wave): the Responses wire's OTHER refusal shape — a refusal
      // CONTENT PART (`ResponseOutputRefusal`, `{ type: "refusal", refusal:
      // string }`) rather than a stop reason, so `response.incomplete` never
      // fires and the stream ends `response.completed` with no text at all.
      // Three carriers are read, because at this layer none implies another:
      // the part's own events (`response.refusal.delta`/`.done`), the part
      // under `part` (`response.content_part.added`/`.done`) and the part in a
      // finished item's `content` (`response.output_item.added`/`.done` — the
      // same inline-item shape the function-call arm below already guards for).
      // The check keys on the part's `type`, never on a part being present:
      // EVERY streamed part arrives through these events, `output_text`
      // included, so "a part is here" would mark every ordinary turn refused.
      // The refusal's TEXT is deliberately NOT promoted into assistant text (a
      // parked product decision); only the bit is set.
      const refusalParts = (parts: unknown): boolean =>
        Array.isArray(parts) && parts.some((p) => (p as { type?: string } | undefined)?.type === "refusal")
      const handleEvent = (event: Record<string, unknown>): LLMStreamEvent[] => {
        const t = event.type as string
        if (
          t === "response.refusal.delta" ||
          t === "response.refusal.done" ||
          (event.part as { type?: string } | undefined)?.type === "refusal" ||
          refusalParts((event.item as { content?: unknown } | undefined)?.content)
        ) {
          refused = true
        }
        if (t === "response.output_text.delta") {
          return [{ type: "text/chunk", text: (event as { delta: string }).delta }]
        }
        if (t === "response.output_item.added") {
          const item = event.item as { type: string; id?: string; name?: string; arguments?: string }
          if (item?.type === "function_call") {
            // Some Responses streams send the full arguments inline on the item.
            if (item.arguments && item.arguments.trim() !== "") {
              try {
                const args = JSON.parse(item.arguments) as unknown
                if (item.id) yieldedInline.add(item.id)
                return [{ type: "tool_call", call: { name: item.name!, args } }]
              } catch {
                return [{ type: "error", error: new Error("openai malformed inline function_call arguments") }]
              }
            }
            if (item.id) pendingCalls.set(item.id, { name: item.name ?? "", argsBuffer: "" })
          }
          return []
        }
        if (t === "response.function_call_arguments.delta") {
          const ev = event as { item_id: string; delta: string }
          const pending = pendingCalls.get(ev.item_id)
          if (pending) pending.argsBuffer += ev.delta
          return []
        }
        if (t === "response.function_call_arguments.done") {
          const ev = event as { item_id: string }
          const pending = pendingCalls.get(ev.item_id)
          if (pending) {
            pendingCalls.delete(ev.item_id)
            if (!yieldedInline.has(ev.item_id)) {
              try {
                const args = JSON.parse(pending.argsBuffer) as unknown
                return [{ type: "tool_call", call: { name: pending.name, args } }]
              } catch {
                return [{ type: "error", error: new Error("openai malformed function_call arguments") }]
              }
            }
          }
          return []
        }
        if (t === "response.reasoning_summary_text.delta") {
          return [{ type: "reasoning", text: (event as { text: string }).text }]
        }
        // M72 Ⅱ: the Responses stream's truncation ending. `response.incomplete`
        // also fires for `content_filter` — a REFUSAL, not a truncation — so the
        // bit keys on the REASON, never on the event name. M77: the refusal
        // reason now sets its own bit, the sibling of the truncation above.
        if (t === "response.incomplete") {
          const reason = (event.response as { incomplete_details?: { reason?: string } } | undefined)?.incomplete_details?.reason
          if (reason === "max_output_tokens") truncated = true
          if (reason === "content_filter") refused = true
          return []
        }
        if (t === "response.completed") {
          // M72 Ⅲ: the Responses API reports this round-trip's usage HERE and
          // nowhere else — the arm used to drop the payload on the floor. The
          // rules are llm-anthropic's `mapUsage`: finite numbers only, and no
          // recognisable number at all means NO event (a fabricated 0 would read
          // as a measurement nobody made).
          const usage = mapUsage((event.response as { usage?: unknown } | undefined)?.usage)
          return usage !== undefined ? [{ type: "usage", usage }] : []
        }
        if (t === "[DONE]") {
          receivedDone = true
          return []
        }
        // M72 Ⅰ: the Responses API signals failure on the stream (`response.failed`)
        // and can also send a bare `error` event. Both used to fall through to the
        // empty default, so a failed response was indistinguishable from an empty
        // one. `response.incomplete` is NOT handled here and is NOT a failure:
        // it has its own arm above, which now carries BOTH bits (M72 Ⅱ's
        // truncation bit and M77's refusal bit), and M77's content-part refusal
        // is read at the top of this handler — so no refusal shape lands in this
        // arm.
        //
        // The two shapes carry their fields differently, so this arm reads both:
        // `response.failed` nests them under `response.error.{code,message}`,
        // while the canonical bare `error` event is FLAT on the wire —
        // `{type:"error",code,message,param,sequence_number}` — with an older
        // nested `error.message` still seen in the wild (tracked as a fallback).
        // Reading only `event.error?.message` sent the flat shape to the generic
        // fallback and dropped `code`, which the seam's retry classifier reads
        // off the message (rate_limit_exceeded → RATE_LIMIT), so the code is
        // composed into the message (`${code}: ${text}`), mirroring the
        // anthropic arm's `${type}: ${message}`.
        if (t === "response.failed" || t === "error") {
          const r = event.response as { error?: { message?: string; code?: string } } | undefined
          const flat = event as { code?: unknown; message?: unknown }
          const nested = event.error as { message?: string } | undefined
          const code = r?.error?.code ?? flat.code
          const text = r?.error?.message ?? (typeof flat.message === "string" ? flat.message : undefined) ?? nested?.message ?? "the provider reported a failed response"
          return [{ type: "error", error: new Error(typeof code === "string" ? `${code}: ${text}` : text) }]
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
            if (receivedDone) break
            for (const event of parseSSE(chunk)) {
              if (receivedDone) break
              if (yield* emitEvents(handleEvent(event))) return
            }
          }
          if (receivedDone) break
        }
        // flush any residual partial chunk left in the buffer
        if (buffer.trim() !== "") {
          for (const event of parseSSE(buffer)) {
            if (receivedDone) break
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
      // M77: the two bits are independent — each is written on its own, so a
      // response that was both truncated and refused carries both. Both absent
      // ⇒ the byte-exact `{ type: "end" }` every clean ending returned before.
      yield { type: "end", ...(truncated ? { truncated: true } : {}), ...(refused ? { refused: true } : {}) }
    },
  }
}

/** M72 Ⅲ: the Responses shape → the seam's `LLMUsage`. Field names differ from
 * message-start's, so the mapper lives per wire (the seam owns the vocabulary,
 * each adapter owns its spelling). */
function mapUsage(raw: unknown): LLMUsage | undefined {
  if (raw === null || typeof raw !== "object") return undefined
  const r = raw as Record<string, unknown>
  const details = (r.input_tokens_details ?? {}) as Record<string, unknown>
  const out: LLMUsage = {}
  const take = (from: unknown, to: keyof LLMUsage): void => {
    if (typeof from === "number" && Number.isFinite(from)) out[to] = from
  }
  take(r.input_tokens, "inputTokens")
  take(r.output_tokens, "outputTokens")
  take(details.cached_tokens, "cacheReadTokens")
  return Object.keys(out).length > 0 ? out : undefined
}
