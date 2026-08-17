import type { LLMRequest, LLMStreamEvent, ModelClient } from "@i-harness/llm-seam"

export interface AnthropicConfig {
  apiKey: string
  baseUrl?: string
  model: string
}

export function parseSSE(text: string): Record<string, unknown>[] {
  return text
    .split("\n\n")
    .filter((chunk) => chunk.includes("data:"))
    .map((chunk) => {
      const dataLine = chunk.split("\n").find((l) => l.startsWith("data:"))!
      return JSON.parse(dataLine.slice(5).trim()) as Record<string, unknown>
    })
}

export function createAnthropicClient(config: AnthropicConfig): ModelClient {
  const baseUrl = config.baseUrl ?? "https://api.anthropic.com"
  return {
    async *stream(request: LLMRequest): AsyncIterable<LLMStreamEvent> {
      const body = {
        model: config.model,
        system: request.systemPrompt,
        messages: request.messages.map((m) => {
          if (m.role === "tool") {
            return { role: "user", content: [{ type: "tool_result", tool_use_id: m.toolCallId, content: m.content }] }
          }
          if (m.role === "assistant" && m.toolCalls && m.toolCalls.length > 0) {
            return {
              role: "assistant",
              content: m.toolCalls.map((c) => ({ type: "tool_use", id: c.id, name: c.name, input: c.args })),
            }
          }
          return { role: m.role, content: m.content }
        }),
        tools: request.tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.inputSchema })),
        stream: true,
      }
      const response = await fetch(`${baseUrl}/v1/messages`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-api-key": config.apiKey, "anthropic-version": "2023-06-01" },
        body: JSON.stringify(body),
      })
      if (!response.ok || !response.body) {
        yield { type: "error", error: new Error(`anthropic request failed: ${response.status} ${await response.text()}`) }
        return
      }
      const reader = response.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ""
      const pendingToolUses = new Map<number, { name: string; argsBuffer: string }>()
      const handleEvent = (event: Record<string, unknown>): LLMStreamEvent[] => {
        const t = event.type as string
        const index = event.index as number
        if (t === "content_block_start") {
          const block = event.content_block as { type: string; name?: string; input?: unknown; thinking?: string }
          if (block?.type === "tool_use") {
            const input = block.input as Record<string, unknown> | undefined
            // Some streams send the full input inline on the start event; if
            // present (and non-empty) seed the args buffer with it.
            const hasInlineInput = !!input && Object.keys(input).length > 0
            pendingToolUses.set(index, {
              name: block.name ?? "",
              argsBuffer: hasInlineInput ? JSON.stringify(input) : "",
            })
          } else if (block?.type === "thinking") {
            return [{ type: "reasoning", text: block.thinking ?? "" }]
          }
          return []
        }
        if (t === "content_block_delta") {
          const delta = event.delta as { type: string; text?: string; partial_json?: string; thinking?: string }
          if (delta?.type === "text_delta") return [{ type: "text/chunk", text: delta.text ?? "" }]
          if (delta?.type === "input_json_delta") {
            const pending = pendingToolUses.get(index)
            if (pending) pending.argsBuffer += delta.partial_json ?? ""
            return []
          }
          if (delta?.type === "thinking_delta") return [{ type: "reasoning", text: delta.thinking ?? "" }]
          return []
        }
        if (t === "content_block_stop") {
          const pending = pendingToolUses.get(index)
          if (pending) {
            pendingToolUses.delete(index)
            if (pending.argsBuffer.trim() === "") {
              // Empty inline input ({}) with no deltas → no-arg tool call.
              return [{ type: "tool_call", call: { name: pending.name, args: {} } }]
            }
            try {
              const args = JSON.parse(pending.argsBuffer) as unknown
              return [{ type: "tool_call", call: { name: pending.name, args } }]
            } catch {
              return [{ type: "error", error: new Error("anthropic malformed tool_use input") }]
            }
          }
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
      } finally {
        reader.releaseLock()
      }
      yield { type: "end" }
    },
  }
}
