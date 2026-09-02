import { projectImagesForTextModel, type LLMContentPart, type LLMRequest, type LLMStreamEvent, type ModelClient, type ReasoningEffort } from "@i-harness/llm-seam"

export interface OpenAICompatibleConfig {
  apiKey: string
  baseUrl?: string
  model: string
  options?: Record<string, unknown>
  // M14: mirrors ProviderProfile.inputModalities — when the route lacks
  // "image", images are projected out before wire mapping. Forwarded by
  // buildModelClient (Task 6).
  inputModalities?: ("text" | "image")[]
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
      return JSON.parse(data) as Record<string, unknown>
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
        messages: messages.map(toWireMessage),
        tools: request.tools.map((t) => ({
          type: "function",
          function: { name: t.name, description: t.description, parameters: t.inputSchema },
        })),
        stream: true,
        ...(config.options ?? {}),
        // M32: request-level effort wins over config.options (explicit per-request intent).
        ...(translateReasoning(config.model, request.reasoningEffort) ?? {}),
      }
      const response = await fetch(`${baseUrl}/v1/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${config.apiKey}` },
        body: JSON.stringify(body),
      })
      if (!response.ok || !response.body) {
        yield { type: "error", error: new Error(`openai-compatible request failed: ${response.status} ${await response.text()}`) }
        return
      }
      const reader = response.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ""
      let receivedDone = false
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
              if (event.type === "[DONE]") {
                receivedDone = true
                break
              }
              const events: LLMStreamEvent[] = []
              const choices = (event as { choices?: { delta?: Record<string, unknown> }[] }).choices ?? []
              for (const choice of choices) {
                const delta = choice.delta ?? {}
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
              if (yield* emit(events)) return
              if (yield* flushParsedToolCalls()) return
            }
          }
          if (receivedDone) break
        }
        // flush residual buffer
        if (buffer.trim() !== "") {
          for (const event of parseSSE(buffer)) {
            if (receivedDone) break
            if (event.type === "[DONE]") {
              receivedDone = true
              break
            }
            const events: LLMStreamEvent[] = []
            const choices = (event as { choices?: { delta?: Record<string, unknown> }[] }).choices ?? []
            for (const choice of choices) {
              const delta = choice.delta ?? {}
              if (typeof delta.content === "string" && delta.content.length > 0) events.push({ type: "text/chunk", text: delta.content })
            }
            if (yield* emit(events)) return
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
      } finally {
        reader.releaseLock()
      }
      yield { type: "end" }
    },
  }
}
