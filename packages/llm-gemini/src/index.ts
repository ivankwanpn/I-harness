import { canReplayContinuation, describeTransportError, projectImagesForTextModel, replayBlockOrder, resolvePromptCacheMode, SSEParseError, type LLMContentPart, type LLMRequest, type LLMStreamEvent, type LLMUsage, type ModelClient, type PromptCacheConfig, type ProviderBlockOrderEntry, type ProviderContinuation, type ReasoningEffort } from "@i-harness/llm-seam"

export interface GeminiConfig {
  apiKey: string
  baseUrl?: string
  model: string
  providerId?: string
  options?: Record<string, unknown>
  /** Only explicit off removes a manual cachedContent reference. */
  promptCache?: PromptCacheConfig
  // M14: mirrors ProviderProfile.inputModalities — when the route lacks
  // "image", images are projected out before wire mapping.
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

// One data: line's payloads (anthropic/llm-openai-compatible shape).
/**
 * M32 gemini translation table with generation rules — ONLY these two:
 * - gemini-3 (and unknown generations default to the current thinkingLevel
 *   wire) → `thinkingConfig:{thinkingLevel}`: off→minimal, low/medium/high
 *   verbatim, xhigh/max use the highest supported level.
 * - gemini-2.5 → `thinkingConfig:{thinkingBudget}`: off 0 / low 4096 /
 *   medium 8192 / high 16384; upper levels stay within each model's budget range.
 * Unset effort → undefined (don't send — provider default).
 */
export function translateReasoning(model: string, effort: ReasoningEffort | undefined):
  | { thinkingConfig: { thinkingLevel: string } }
  | { thinkingConfig: { thinkingBudget: number } }
  | undefined {
  if (effort === undefined) return undefined
  if (effort === "off" && (model.includes("gemini-2.5-pro") || /gemini-3(?:\.\d+)?-pro/.test(model))) throw new Error(`${model} cannot disable thinking`)
  if (model.includes("gemini-2.5")) {
    const cap = model.includes("pro") ? 32768 : 24576
    const thinkingBudget = effort === "off" ? 0 : effort === "low" ? 4096 : effort === "medium" ? 8192 : effort === "high" ? 16384 : effort === "xhigh" ? Math.min(24576, cap) : cap
    return { thinkingConfig: { thinkingBudget } }
  }
  const pro = /gemini-3(?:\.\d+)?-pro/.test(model)
  return { thinkingConfig: { thinkingLevel: effort === "xhigh" || effort === "max" || (pro && effort === "medium") ? "high" : effort === "off" ? pro ? "low" : "minimal" : effort } }
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

// Shape LLM content parts into GenAI content part objects. String content
// stays a single text part (byte-identical). Images are inlineData (base64).
function toGeminiParts(content: string | LLMContentPart[]): unknown[] {
  if (typeof content === "string") return [{ text: content }]
  return content.map((part) =>
    part.type === "text"
      ? { text: part.text }
      : { inlineData: { mimeType: part.image.mediaType, data: part.image.dataBase64 } },
  )
}

// A tool RESULT reaches Gemini as functionResponse — its `response` field is
// an OBJECT, so the neutral tool content (JSON string or plain text) is
// wrapped: valid-JSON object content is passed through verbatim, anything
// else becomes { output: <text> }.
function toFunctionResponse(content: string | LLMContentPart[]): unknown {
  if (typeof content !== "string") {
    content = content.map((p) => (p.type === "text" ? p.text : "[image]")).join("\n")
  }
  if (content.trim() !== "") {
    try {
      const parsed = JSON.parse(content) as unknown
      if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) return parsed
      return { output: parsed }
    } catch {
      // not JSON — wrap below
    }
  }
  return { output: content }
}

/**
 * M77 (fix wave): the candidate-side FinishReason values whose documented
 * meaning is "generation stopped because the content was blocked". The vendor's
 * enum (ai.google.dev/api/generate-content, FinishReason) says, verbatim:
 * `SAFETY` "The response candidate content was flagged for safety reasons.",
 * `RECITATION` "…flagged for recitation reasons.", `BLOCKLIST` "Token
 * generation stopped because the content contains forbidden terms.",
 * `PROHIBITED_CONTENT` "Token generation stopped for potentially containing
 * prohibited content.", `SPII` "Token generation stopped because the content
 * potentially contains Sensitive Personally Identifiable Information (SPII).",
 * `IMAGE_SAFETY` "Token generation stopped because generated images contain
 * safety violations.", `IMAGE_PROHIBITED_CONTENT` "Image generation stopped
 * because generated images has other prohibited content.", `IMAGE_RECITATION`
 * "Image generation stopped due to recitation."
 *
 * Every one of them reaches the client the same way — HTTP 200 with no content —
 * so each reads as an empty SUCCESS without this set. The REST of the enum is
 * deliberately absent: `STOP`/`MAX_TOKENS` are the clean ending and the cap,
 * and `LANGUAGE`, `OTHER`, `NO_IMAGE`, `IMAGE_OTHER`, `MALFORMED_RESPONSE`,
 * `UNEXPECTED_TOOL_CALL`, `TOO_MANY_TOOL_CALLS`, `MISSING_THOUGHT_SIGNATURE`,
 * `ESCALATION` and `PUP_LIMITED_DISABLED` do not say the content was blocked
 * (the last two are request/account-level), so claiming a refusal for them
 * would be a false statement about what the model did.
 */
const CONTENT_BLOCK_FINISH_REASONS: ReadonlySet<string> = new Set([
  "SAFETY",
  "RECITATION",
  "BLOCKLIST",
  "PROHIBITED_CONTENT",
  "SPII",
  "IMAGE_SAFETY",
  "IMAGE_PROHIBITED_CONTENT",
  "IMAGE_RECITATION",
])

/** Keep Gemini's signed parts in the positions where the provider issued them.
 * The neutral transcript remains authoritative for visible text and tool args;
 * stale or incomplete native order falls back to an unsigned projection. */
function replayGeminiParts(
  continuation: Extract<ProviderContinuation, { kind: "gemini" }> | undefined,
  content: string,
  calls: readonly { id: string; name: string; args: unknown }[],
): unknown[] | undefined {
  if (!continuation?.partOrder) return undefined
  if (!geminiCallsMatch(continuation, calls)) return undefined
  const thoughts = (continuation.thoughtParts ?? []).map((part) => ({ text: part.text, thought: true, ...(part.thoughtSignature ? { thoughtSignature: part.thoughtSignature } : {}) }))
  const tools = calls.map((call, index) => ({ functionCall: { id: call.id, name: call.name, args: call.args }, ...(continuation.callSignatures[index] ? { thoughtSignature: continuation.callSignatures[index] } : {}) }))
  return replayBlockOrder<unknown>(continuation.partOrder, content, thoughts, tools,
    (text, _phase, thoughtSignature) => ({ text, ...(thoughtSignature ? { thoughtSignature } : {}) }))
}

function geminiCallsMatch(
  continuation: Extract<ProviderContinuation, { kind: "gemini" }> | undefined,
  calls: readonly { id: string; name: string; args: unknown }[],
): boolean {
  if (!continuation) return false
  if (!continuation.callBindings) return calls.length === 0 || continuation.partOrder === undefined
  return continuation.callBindings.length === calls.length && continuation.callBindings.every((binding, index) => {
    const call = calls[index]
    return call !== undefined && binding.name === call.name && binding.argsJson === JSON.stringify(call.args)
      && (binding.id === undefined || binding.id === call.id)
  })
}

export function createGeminiClient(config: GeminiConfig): ModelClient {
  const baseUrl = config.baseUrl ?? "https://generativelanguage.googleapis.com"
  return {
    async *stream(request: LLMRequest): AsyncIterable<LLMStreamEvent> {
      // M14 negative capability: text-only routes never see image bytes.
      const vision = config.inputModalities?.includes("image") ?? false
      const messages = vision ? request.messages : projectImagesForTextModel(request.messages)
      // Gemini's functionResponse requires the function NAME, but the neutral
      // tool message carries only the call id — the name is recovered from the
      // assistant toolCalls the session log derived (they always precede the
      // tool results in model-visible order).
      const namesByCallId = new Map<string, string>()
      for (const m of messages) {
        if (m.role === "assistant" && m.toolCalls !== undefined) {
          for (const c of m.toolCalls) namesByCallId.set(c.id, c.name)
        }
      }
      const contents: { role: "user" | "model"; parts: unknown[] }[] = []
      let functionResponses: unknown[] | undefined
      for (const m of messages) {
          if (m.role === "tool") {
            if (functionResponses === undefined) {
              functionResponses = []
              contents.push({ role: "user", parts: functionResponses })
            }
            functionResponses.push({ functionResponse: {
              id: m.toolCallId,
              name: namesByCallId.get(m.toolCallId) ?? "",
              response: toFunctionResponse(m.content),
            } })
            continue
          }
          functionResponses = undefined
          if (m.role === "assistant" && m.toolCalls && m.toolCalls.length > 0) {
            const continuation = m.providerContinuation?.kind === "gemini" && canReplayContinuation(m.providerContinuation, config)
              ? m.providerContinuation : undefined
            const matchingContinuation = geminiCallsMatch(continuation, m.toolCalls) ? continuation : undefined
            const ordered = replayGeminiParts(matchingContinuation, m.content, m.toolCalls)
            if (ordered !== undefined) { contents.push({ role: "model", parts: ordered }); continue }
            const safeContinuation = matchingContinuation?.partOrder ? undefined : matchingContinuation
            const parts: unknown[] = [
              ...(safeContinuation?.thoughtParts ?? []).map((part) => ({ text: part.text, thought: true, ...(part.thoughtSignature ? { thoughtSignature: part.thoughtSignature } : {}) })),
              ...(m.content !== "" ? [{ text: m.content, ...(safeContinuation?.textSignature ? { thoughtSignature: safeContinuation.textSignature } : {}) }] : []),
              ...(safeContinuation?.emptyTextSignatures ?? []).map((thoughtSignature) => ({ text: "", thoughtSignature })),
            ]
            for (const [index, c] of m.toolCalls.entries()) {
              const signature = safeContinuation?.callSignatures[index]
              parts.push({ functionCall: { id: c.id, name: c.name, args: c.args }, ...(signature ? { thoughtSignature: signature } : {}) })
            }
            contents.push({ role: "model", parts })
            continue
          }
          if (m.role === "assistant" && m.providerContinuation?.kind === "gemini" && canReplayContinuation(m.providerContinuation, config)) {
            const continuation = m.providerContinuation
            const ordered = replayGeminiParts(continuation, m.content, [])
            if (ordered !== undefined) { contents.push({ role: "model", parts: ordered }); continue }
            if (continuation.partOrder) { contents.push({ role: "model", parts: [{ text: m.content }] }); continue }
            contents.push({ role: "model", parts: [
              ...(continuation.thoughtParts ?? []).map((part) => ({ text: part.text, thought: true, ...(part.thoughtSignature ? { thoughtSignature: part.thoughtSignature } : {}) })),
              ...(m.content !== "" ? [{ text: m.content, ...(continuation.textSignature ? { thoughtSignature: continuation.textSignature } : {}) }] : []),
              ...(continuation.emptyTextSignatures ?? []).map((thoughtSignature) => ({ text: "", thoughtSignature })),
            ] })
            continue
          }
          contents.push({ role: m.role === "assistant" ? "model" : "user", parts: toGeminiParts(m.content) })
      }
      const { thinkingConfig: legacyThinkingConfig, generationConfig: rawGenerationConfig, ...configuredOptions } = config.options ?? {}
      const configuredGeneration = typeof rawGenerationConfig === "object" && rawGenerationConfig !== null && !Array.isArray(rawGenerationConfig)
        ? rawGenerationConfig as Record<string, unknown> : {}
      const configuredThinking = typeof configuredGeneration.thinkingConfig === "object" && configuredGeneration.thinkingConfig !== null && !Array.isArray(configuredGeneration.thinkingConfig)
        ? configuredGeneration.thinkingConfig as Record<string, unknown>
        : typeof legacyThinkingConfig === "object" && legacyThinkingConfig !== null && !Array.isArray(legacyThinkingConfig)
          ? legacyThinkingConfig as Record<string, unknown> : undefined
      const requestedThinking = translateReasoning(config.model, request.reasoningEffort)?.thinkingConfig
      const generationConfig = {
        ...configuredGeneration,
        ...(configuredThinking || requestedThinking ? { thinkingConfig: {
          ...(configuredThinking ?? {}),
          ...(requestedThinking ?? {}),
          ...(requestedThinking ? { includeThoughts: request.reasoningEffort !== "off" } : {}),
        } } : {}),
        ...(request.maxOutputTokens !== undefined ? { maxOutputTokens: request.maxOutputTokens } : {}),
      }
      const body: Record<string, unknown> = {
        contents,
        ...(request.systemPrompt.trim() !== "" ? { systemInstruction: { parts: [{ text: request.systemPrompt }] } } : {}),
        ...(request.tools.length > 0
          ? { tools: [{ functionDeclarations: request.tools.map((t) => ({ name: t.name, description: t.description, parameters: t.inputSchema })) }] }
          : {}),
        ...configuredOptions,
        // GenerateContentRequest carries thinkingConfig inside generationConfig.
        // Preserve configured generation fields while request-level choices win.
        ...(Object.keys(generationConfig).length ? { generationConfig } : {}),
        // Both thinkingConfig and maxOutputTokens belong to generationConfig.
        // The parent stays absent when neither the route nor the request needs
        // generation settings.
      }
      if (resolvePromptCacheMode(config.promptCache, request.promptCache) === "off") delete body.cachedContent
      // M62: a TRANSPORT failure (fetch rejects before any HTTP response) used
      // to escape as Node's bare "fetch failed", which cannot distinguish DNS /
      // TCP / TLS / proxy. Surface the cause chain instead.
      const geminiUrl = `${baseUrl}/v1beta/models/${encodeURIComponent(config.model)}:streamGenerateContent?alt=sse`
      let response: Response
      try {
        response = await fetch(geminiUrl, {
          method: "POST",
          headers: mergeConfiguredHeaders(config.headers, { "Content-Type": "application/json", "x-goog-api-key": config.apiKey }),
          body: JSON.stringify(body),
          // M61: the caller's abort signal reaches the transport — cancel must
          // kill a parked request, not wait for the first event.
          ...(request.signal !== undefined ? { signal: request.signal } : {}),
        })
      } catch (error) {
        yield { type: "error", error: await describeTransportError("gemini", geminiUrl, error) }
        return
      }
      if (!response.ok || !response.body) {
        yield { type: "error", error: new Error(`gemini request failed: ${response.status} ${await response.text()}`) }
        return
      }
      const reader = response.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ""
      // M72 Ⅱ: the wire's own truncation literal (`finishReason: "MAX_TOKENS"`)
      // — set in `handleChunk` below, read once at the ending. Absent stays
      // absent: only `true` writes the field.
      let truncated = false
      // M77: this wire has TWO refusal carriers and neither was read: a
      // candidate's `finishReason` of `SAFETY` or `RECITATION` (the model's
      // own answer was blocked), and `promptFeedback.blockReason` on the chunk
      // (the REQUEST was blocked — there `candidates` may be absent entirely,
      // so the candidate read below cannot see it at all). A separate variable
      // from `truncated`: the two are independent and neither is the other's
      // `else`. Only `true` is ever written.
      let refused = false
      // Function-call accumulation (Gemini streams a functionCall as several
      // chunks: the first carries the name, the rest carry args objects that
      // may be partial — the docs' canonical accumulation is to store the
      // name and accumulate the args pieces). Emitted just before `end`.
      // Delimiters: a chunk carrying a name ALWAYS starts a new pending call
      // (two parallel calls of the same function are distinct calls); args-only
      // chunks continue the LAST pending call.
      interface PendingCall {
        id?: string
        name: string
        argsJson: string
        rawArgs: Record<string, unknown>[]
        signature?: string
      }
      const pendingCalls: PendingCall[] = []
      const callSignatures: (string | null)[] = []
      const callBindings: { id?: string; name: string; argsJson: string }[] = []
      const thoughtParts: { text: string; thoughtSignature?: string }[] = []
      let activeThought: { index: number; part: { text: string; thoughtSignature?: string } } | undefined
      const partOrder: ProviderBlockOrderEntry[] = []
      let activeText: { index: number; part: Extract<ProviderBlockOrderEntry, { kind: "text" }> } | undefined
      let textSignature: string | undefined
      const emptyTextSignatures: string[] = []
      const accumulateArgs = (call: PendingCall, args: unknown): void => {
        if (typeof args === "object" && args !== null) {
          call.rawArgs.push(args as Record<string, unknown>)
          call.argsJson += JSON.stringify(args)
        }
      }
      const handleFunctionCall = (fc: { id?: string; name?: string; args?: unknown }, signature?: string): void => {
        if (fc.name !== undefined) {
          // A name always opens a new call — never fold into an existing
          // same-name pending call (parallel calls would lose their args).
          const call: PendingCall = { name: fc.name, argsJson: "", rawArgs: [], ...(fc.id ? { id: fc.id } : {}), ...(signature ? { signature } : {}) }
          pendingCalls.push(call)
          if (fc.args !== undefined) accumulateArgs(call, fc.args)
        } else if (fc.args !== undefined) {
          const call = pendingCalls[pendingCalls.length - 1]
          if (call !== undefined) { accumulateArgs(call, fc.args); if (fc.id) call.id = fc.id; if (signature) call.signature = signature }
        }
      }
      const finalizeCalls = function* (): Generator<LLMStreamEvent, boolean, unknown> {
        for (const call of pendingCalls) {
          callSignatures.push(call.signature ?? null)
          let args: unknown = {}
          try {
            args = JSON.parse(call.argsJson === "" ? "{}" : call.argsJson) as unknown
          } catch {
            // The chunks are separate JSON objects (not fragments of one
            // document), so a concat parse fails for partial-args pieces —
            // merge the pieces (docs' spread accumulation).
            args = call.rawArgs.length > 0 ? Object.assign({}, ...call.rawArgs) : {}
          }
          callBindings.push({ ...(call.id ? { id: call.id } : {}), name: call.name, argsJson: JSON.stringify(args) })
          if (yield { type: "tool_call", call: { ...(call.id ? { id: call.id } : {}), name: call.name, args } }) return true
        }
        pendingCalls.length = 0
        return false
      }
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
      const handleChunk = (event: Record<string, unknown>): LLMStreamEvent[] => {
        const events: LLMStreamEvent[] = []
        const candidates = event.candidates as { content?: { parts?: { text?: string; thought?: boolean; thoughtSignature?: string; functionCall?: { id?: string; name?: string; args?: unknown } }[] } }[] | undefined
        const finishReason = (candidates?.[0] as { finishReason?: string } | undefined)?.finishReason
        if (finishReason === "MAX_TOKENS") truncated = true
        // M77 (fix wave): the candidate-side carrier, over the WHOLE set of
        // content-block reasons the vendor's enum documents (see
        // CONTENT_BLOCK_FINISH_REASONS above). The comment this replaces said
        // "the two content refusals … every other reason writes nothing", which
        // the enum contradicts: PROHIBITED_CONTENT, BLOCKLIST, SPII,
        // IMAGE_SAFETY, IMAGE_PROHIBITED_CONTENT and IMAGE_RECITATION are the
        // same kind of stop, with the same HTTP 200 and the same empty content.
        // `MAX_TOKENS` above is the truncation bit, and `STOP` is pinned as a
        // clean ending by the M72 Ⅱ control test in this package; a reason not
        // in the set writes NOTHING at all — absent stays absent, never `false`.
        if (finishReason !== undefined && CONTENT_BLOCK_FINISH_REASONS.has(finishReason)) refused = true
        // M77: the INPUT-side block. It rides `promptFeedback.blockReason`, and
        // on that chunk `candidates` is absent entirely — a chunk that may be
        // the whole stream — so the candidate read above sees nothing and this
        // is the only place the refusal is visible. The recognised literal is
        // "the field arrived carrying a string"; no allow-list of values is
        // invented here, and the vendor's own enum is why that rule is safe:
        // its `BlockReason` values are BLOCK_REASON_UNSPECIFIED ("Default value.
        // This value is unused."), SAFETY, OTHER, BLOCKLIST, PROHIBITED_CONTENT
        // and IMAGE_SAFETY — every value means the prompt WAS blocked, and the
        // one "nothing here" marker is documented as unused, so an allow-list
        // would add nothing to the presence rule. (The enum is read from the
        // published REST doc ai.google.dev/api/generate-content; no vendor SDK
        // is installed in this tree to type against, so the residual is the DOC
        // being right, not a measurement here.)
        const blockReason = (event.promptFeedback as { blockReason?: unknown } | undefined)?.blockReason
        if (typeof blockReason === "string") refused = true
        const parts = candidates?.[0]?.content?.parts ?? []
        for (const [index, part] of parts.entries()) {
          if (part.thought === true) {
            activeText = undefined
            if (activeThought?.index !== index) {
              const entry: { text: string; thoughtSignature?: string } = { text: "" }
              partOrder.push({ kind: "reasoning", index: thoughtParts.length })
              thoughtParts.push(entry)
              activeThought = { index, part: entry }
            }
            activeThought.part.text += part.text ?? ""
            if (part.thoughtSignature) {
              activeThought.part.thoughtSignature = part.thoughtSignature
              activeThought = undefined
            }
          } else {
            activeThought = undefined
            if (part.functionCall === undefined && part.thoughtSignature) {
              if (part.text === "") emptyTextSignatures.push(part.thoughtSignature)
              else textSignature = part.thoughtSignature
            }
            if (part.functionCall !== undefined) {
              activeText = undefined
              if (part.functionCall.name !== undefined) partOrder.push({ kind: "tool", index: pendingCalls.length })
            } else if (part.text === "" && part.thoughtSignature) {
              activeText = undefined
              partOrder.push({ kind: "text", text: "", thoughtSignature: part.thoughtSignature })
            } else if (typeof part.text === "string" && part.text.length > 0) {
              if (activeText?.index !== index) {
                const entry: Extract<ProviderBlockOrderEntry, { kind: "text" }> = { kind: "text", text: "" }
                partOrder.push(entry)
                activeText = { index, part: entry }
              }
              activeText.part.text += part.text
              if (part.thoughtSignature) { activeText.part.thoughtSignature = part.thoughtSignature; activeText = undefined }
            }
          }
          if (part.functionCall !== undefined) {
            handleFunctionCall(part.functionCall, part.thoughtSignature)
          } else if (typeof part.text === "string" && part.text.length > 0) {
            events.push(part.thought === true
              ? { type: "reasoning", blockId: String(thoughtParts.length - 1), text: part.text }
              : { type: "text/chunk", text: part.text })
          }
        }
        // M72 Ⅲ: `usageMetadata` rides the LAST chunk — mapped here instead of
        // only documented. (The sentence this replaces said THIS adapter does not
        // map `usageMetadata` onto the seam's `usage` event; this maps it.) The
        // wire's spelling is promptTokenCount → inputTokens, candidatesTokenCount
        // → outputTokens, cachedContentTokenCount → cacheReadTokens; anything
        // else the wire sends has no seam name and is not invented one.
        const usage = mapUsage(event.usageMetadata)
        if (usage !== undefined) events.push({ type: "usage", usage })
        return events
      }
      try {
        while (true) {
          const { done, value } = await reader.read()
          if (done) break
          buffer += decoder.decode(value, { stream: true })
          const chunks = buffer.split("\n\n")
          buffer = chunks.pop() ?? ""
          for (const chunk of chunks) {
            for (const event of parseSSE(chunk)) {
              if (yield* emit(handleChunk(event))) return
            }
          }
        }
        if (buffer.trim() !== "") {
          for (const event of parseSSE(buffer)) {
            if (yield* emit(handleChunk(event))) return
          }
        }
        if (yield* finalizeCalls()) return
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
      const visibleText = partOrder.filter((part): part is Extract<ProviderBlockOrderEntry, { kind: "text" }> => part.kind === "text").map((part) => part.text).join("")
      const canonicalOrder: ProviderBlockOrderEntry[] = [
        ...thoughtParts.map((_, index) => ({ kind: "reasoning" as const, index })),
        ...(visibleText ? [{ kind: "text" as const, text: visibleText, ...(textSignature ? { thoughtSignature: textSignature } : {}) }] : []),
        ...emptyTextSignatures.map((thoughtSignature) => ({ kind: "text" as const, text: "", thoughtSignature })),
        ...callSignatures.map((_, index) => ({ kind: "tool" as const, index })),
      ]
      const needsPartOrder = JSON.stringify(partOrder) !== JSON.stringify(canonicalOrder)
      yield { type: "end", ...(truncated ? { truncated: true } : {}), ...(refused ? { refused: true } : {}), ...(callSignatures.some(Boolean) || thoughtParts.length || textSignature || emptyTextSignatures.length || needsPartOrder ? { providerContinuation: {
        kind: "gemini", model: config.model, ...(config.providerId ? { providerId: config.providerId } : {}), callSignatures,
        ...(thoughtParts.length ? { thoughtParts } : {}),
        ...(textSignature ? { textSignature } : {}),
        ...(emptyTextSignatures.length ? { emptyTextSignatures } : {}),
        ...(needsPartOrder ? { partOrder } : {}),
        ...(callBindings.length ? { callBindings } : {}),
      } as const } : {}) }
    },
  }
}

/** M72 Ⅲ: Gemini's `usageMetadata` → the seam's `LLMUsage` (finite numbers
 * only; nothing recognisable ⇒ no event, never a fabricated zero). The seam
 * owns the vocabulary, each wire owns its spelling — hence a mapper per
 * adapter, next to the fields it spells. */
function mapUsage(raw: unknown): LLMUsage | undefined {
  if (raw === null || typeof raw !== "object") return undefined
  const r = raw as Record<string, unknown>
  const out: LLMUsage = {}
  const take = (from: unknown, to: Exclude<keyof LLMUsage, "inputTokenSemantics">): void => {
    if (typeof from === "number" && Number.isFinite(from)) out[to] = from
  }
  take(r.promptTokenCount, "inputTokens")
  take(r.candidatesTokenCount, "outputTokens")
  take(r.cachedContentTokenCount, "cacheReadTokens")
  if (out.inputTokens !== undefined && Number.isSafeInteger(out.inputTokens) && out.inputTokens >= 0) out.inputTokenSemantics = "includes-cache"
  return Object.keys(out).length > 0 ? out : undefined
}
