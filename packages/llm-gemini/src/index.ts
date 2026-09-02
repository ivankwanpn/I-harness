import { projectImagesForTextModel, type LLMContentPart, type LLMRequest, type LLMStreamEvent, type ModelClient } from "@i-harness/llm-seam"

export interface GeminiConfig {
  apiKey: string
  baseUrl?: string
  model: string
  options?: Record<string, unknown>
  // M14: mirrors ProviderProfile.inputModalities — when the route lacks
  // "image", images are projected out before wire mapping.
  inputModalities?: ("text" | "image")[]
}

// One data: line's payloads (anthropic/llm-openai-compatible shape).
export function parseSSE(text: string): Record<string, unknown>[] {
  return text
    .split("\n\n")
    .filter((chunk) => chunk.includes("data:"))
    .map((chunk) => {
      const dataLine = chunk.split("\n").find((l) => l.startsWith("data:"))!
      return JSON.parse(dataLine.slice(5).trim()) as Record<string, unknown>
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
      if (typeof parsed === "object" && parsed !== null) return parsed
    } catch {
      // not JSON — wrap below
    }
  }
  return { output: content }
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
      const body = {
        contents: messages.map((m) => {
          if (m.role === "tool") {
            return {
              role: "user",
              parts: [{
                functionResponse: {
                  name: namesByCallId.get(m.toolCallId) ?? "",
                  response: toFunctionResponse(m.content),
                },
              }],
            }
          }
          if (m.role === "assistant" && m.toolCalls && m.toolCalls.length > 0) {
            const parts: unknown[] = m.content.trim() !== "" ? [{ text: m.content }] : []
            for (const c of m.toolCalls) parts.push({ functionCall: { name: c.name, args: c.args } })
            return { role: "model", parts }
          }
          return { role: m.role === "assistant" ? "model" : "user", parts: toGeminiParts(m.content) }
        }),
        ...(request.systemPrompt.trim() !== "" ? { systemInstruction: { parts: [{ text: request.systemPrompt }] } } : {}),
        ...(request.tools.length > 0
          ? { tools: [{ functionDeclarations: request.tools.map((t) => ({ name: t.name, description: t.description, parameters: t.inputSchema })) }] }
          : {}),
        ...(config.options ?? {}),
      }
      const response = await fetch(`${baseUrl}/v1beta/models/${encodeURIComponent(config.model)}:streamGenerateContent?alt=sse`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-goog-api-key": config.apiKey },
        body: JSON.stringify(body),
      })
      if (!response.ok || !response.body) {
        yield { type: "error", error: new Error(`gemini request failed: ${response.status} ${await response.text()}`) }
        return
      }
      const reader = response.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ""
      // Function-call accumulation (Gemini streams a functionCall as several
      // chunks: the first carries the name, the rest carry args objects that
      // may be partial — the docs' canonical accumulation is to store the
      // name and accumulate the args pieces). Emitted just before `end`.
      // Delimiters: consecutive args-only chunks with the SAME function are
      // one call; a chunk carrying a NEW name starts the next pending call.
      interface PendingCall {
        name: string
        argsJson: string
        rawArgs: Record<string, unknown>[]
      }
      const pendingCalls: PendingCall[] = []
      const accumulateArgs = (call: PendingCall, args: unknown): void => {
        if (typeof args === "object" && args !== null) {
          call.rawArgs.push(args as Record<string, unknown>)
          call.argsJson += JSON.stringify(args)
        }
      }
      const handleFunctionCall = (fc: { name?: string; args?: unknown }): void => {
        if (fc.name !== undefined) {
          let call = pendingCalls.find((c) => c.name === fc.name)
          if (call === undefined) {
            call = { name: fc.name, argsJson: "", rawArgs: [] }
            pendingCalls.push(call)
          }
          if (fc.args !== undefined) accumulateArgs(call, fc.args)
        } else if (fc.args !== undefined) {
          const call = pendingCalls[pendingCalls.length - 1]
          if (call !== undefined) accumulateArgs(call, fc.args)
        }
      }
      const finalizeCalls = function* (): Generator<LLMStreamEvent, boolean, unknown> {
        for (const call of pendingCalls) {
          let args: unknown = {}
          try {
            args = JSON.parse(call.argsJson === "" ? "{}" : call.argsJson) as unknown
          } catch {
            // The chunks are separate JSON objects (not fragments of one
            // document), so a concat parse fails for partial-args pieces —
            // merge the pieces (docs' spread accumulation).
            args = call.rawArgs.length > 0 ? Object.assign({}, ...call.rawArgs) : {}
          }
          if (yield { type: "tool_call", call: { name: call.name, args } }) return true
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
        const candidates = event.candidates as { content?: { parts?: { text?: string; functionCall?: { name?: string; args?: unknown } }[] } }[] | undefined
        const parts = candidates?.[0]?.content?.parts ?? []
        for (const part of parts) {
          if (part.functionCall !== undefined) {
            handleFunctionCall(part.functionCall)
          } else if (typeof part.text === "string" && part.text.length > 0) {
            events.push({ type: "text/chunk", text: part.text })
          }
        }
        // usageMetadata (promptTokenCount / candidatesTokenCount /
        // totalTokenCount) arrives on the LAST chunk — before `end`. The
        // LLMStreamEvent vocabulary carries NO usage event (same gap as
        // llm-anthropic's message_usage), so the wire position is documented
        // here and not surfaced (a future usage seam slot).
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
      } finally {
        reader.releaseLock()
      }
      yield { type: "end" }
    },
  }
}
