import { projectImagesForTextModel, type LLMContentPart, type LLMRequest, type LLMStreamEvent, type ModelClient, type ReasoningEffort } from "@i-harness/llm-seam"

export interface OpenAIConfig {
  apiKey: string
  baseUrl?: string
  model: string
  options?: Record<string, unknown>
  // M14: mirrors ProviderProfile.inputModalities — when the route lacks
  // "image", images are projected out before wire mapping. Forwarded by
  // buildModelClient (Task 6).
  inputModalities?: ("text" | "image")[]
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
      return JSON.parse(data) as Record<string, unknown>
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
              return m.toolCalls.map((c) => ({
                type: "function_call",
                call_id: c.id,
                name: c.name,
                arguments: JSON.stringify(c.args),
              }))
            }
            return { role: "assistant", content: m.content }
          })
          .flat(),
        tools: request.tools.map((t) => ({ type: "function", name: t.name, description: t.description, parameters: t.inputSchema })),
        stream: true,
        ...(config.options ?? {}),
        // M32: request-level effort wins over config.options (explicit per-request intent).
        ...(translateReasoning(config.model, request.reasoningEffort) ?? {}),
      }
      const response = await fetch(`${baseUrl}/v1/responses`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${config.apiKey}` },
        body: JSON.stringify(body),
      })
      if (!response.ok || !response.body) {
        yield { type: "error", error: new Error(`openai request failed: ${response.status} ${await response.text()}`) }
        return
      }
      const reader = response.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ""
      let receivedDone = false
      const pendingCalls = new Map<string, { name: string; argsBuffer: string }>()
      const yieldedInline = new Set<string>()
      const handleEvent = (event: Record<string, unknown>): LLMStreamEvent[] => {
        const t = event.type as string
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
        if (t === "response.completed") return []
        if (t === "[DONE]") {
          receivedDone = true
          return []
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
      } finally {
        reader.releaseLock()
      }
      yield { type: "end" }
    },
  }
}
