import type { LLMRequest, LLMStreamEvent, ModelClient } from "@i-harness/llm-seam"

export interface OpenAIConfig {
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
      const data = dataLine.slice(5).trim()
      if (data === "[DONE]") return { type: "[DONE]" }
      return JSON.parse(data) as Record<string, unknown>
    })
}

export function createOpenAIClient(config: OpenAIConfig): ModelClient {
  const baseUrl = config.baseUrl ?? "https://api.openai.com"
  return {
    async *stream(request: LLMRequest): AsyncIterable<LLMStreamEvent> {
      const body = {
        model: config.model,
        instructions: request.systemPrompt,
        input: request.messages.map((m) => ({ role: m.role, content: m.content })),
        tools: request.tools.map((t) => ({ type: "function", name: t.name, description: t.description, parameters: t.inputSchema })),
        stream: true,
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
              const t = event.type as string
              if (t === "response.output_text.delta") yield { type: "text/chunk", text: (event as { delta: string }).delta }
              else if (t === "response.output_item.added") {
                const item = event.item as { type: string; name?: string; arguments?: string }
                if (item?.type === "function_call") yield { type: "tool_call", call: { name: item.name!, args: JSON.parse(item.arguments ?? "{}") } }
              } else if (t === "response.completed") { /* end is emitted after loop */ }
              else if (t === "[DONE]") break
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
