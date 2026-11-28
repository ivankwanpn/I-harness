import { afterEach, expect, it, vi } from "vitest"
import { createOpenAIClient } from "@i-harness/llm-openai"
import { createOpenAICompatibleClient } from "@i-harness/llm-openai-compatible"
import type { LLMMessage, LLMRequest } from "@i-harness/llm-seam"

afterEach(() => vi.unstubAllGlobals())

it.each(["chat", "responses"] as const)("preserves the status of a tool result on the %s wire", async protocol => {
  const bodies: string[] = []
  vi.stubGlobal("fetch", async (_url: unknown, init: RequestInit) => {
    bodies.push(String(init.body))
    return new Response(protocol === "chat" ? "data: [DONE]\n\n" : 'data: {"type":"response.completed","response":{}}\n\n')
  })
  const client = (protocol === "chat" ? createOpenAICompatibleClient : createOpenAIClient)({ model: "fixture", apiKey: "fixture" })
  const assistant: LLMMessage = { role: "assistant", content: "", toolCalls: [{ id: "r1", name: "read", args: {} }] }
  const tools = [{ name: "read", description: "Read a file", inputSchema: { type: "object" } }]
  for (const content of ["檔案.txt", [{ type: "text" as const, text: "檔案.txt" }], ""]) {
    for (const failed of [false, true]) {
      const result: LLMMessage = { role: "tool", toolCallId: "r1", content, ...(failed ? { isError: true } : {}) }
      const request: LLMRequest = { systemPrompt: "", tools, messages: [{ role: "user", content: "Read the file." }, assistant, result] }
      for await (const event of client.stream(request)) expect(event.type).not.toBe("error")
      const body = JSON.parse(bodies.at(-1)!)
      const reply = protocol === "chat" ? body.messages.find((m: { role?: string }) => m.role === "tool") : body.input.find((m: { type?: string }) => m.type === "function_call_output")
      expect(reply.tool_call_id ?? reply.call_id).toBe("r1")
      const wire = reply.content ?? reply.output
      const text = typeof wire === "string" ? wire : wire.map((part: { text: string }) => part.text).join("")
      const original = typeof content === "string" ? content : content[0]!.text
      expect(text).toBe((failed ? "Tool returned an error.\n" : "") + original)
      expect(result.content).toEqual(content)
    }
  }
})
