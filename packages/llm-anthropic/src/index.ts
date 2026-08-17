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
        messages: request.messages.map((m) => ({ role: m.role, content: m.content })),
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
      try {
        while (true) {
          const { done, value } = await reader.read()
          if (done) break
          buffer += decoder.decode(value, { stream: true })
          const chunks = buffer.split("\n\n")
          buffer = chunks.pop() ?? ""
          for (const chunk of chunks) {
            for (const event of parseSSE(chunk)) {
              const t = event.type as string
              if (t === "content_block_delta") {
                const delta = event.delta as { type: string; text?: string }
                if (delta?.type === "text_delta") yield { type: "text/chunk", text: delta.text ?? "" }
              } else if (t === "content_block_start") {
                const block = event.content_block as { type: string; name?: string; input?: unknown }
                if (block?.type === "tool_use") yield { type: "tool_call", call: { name: block.name!, args: block.input ?? {} } }
              } else if (t === "message_stop") { /* end is emitted after loop */ }
            }
          }
        }
      } finally {
        reader.releaseLock()
      }
      yield { type: "end" }
    },
  }
}
