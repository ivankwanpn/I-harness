import { afterEach, expect, it, vi } from "vitest"
import { append, createSession, deriveMessages, fromJSONL, toJSONL } from "../../core-session/src/index.ts"
import { createAnthropicClient } from "../src/index.ts"
import type { LLMStreamEvent } from "@i-harness/llm-seam"

afterEach(() => vi.unstubAllGlobals())

it.each([false, true])("replays the provider's thinking and tool response together after in-step compaction (reload=%s)", async reload => {
  const bodies: Record<string, unknown>[] = []
  const firstResponse = [
    { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "Inspect the fixture.", signature: "fixture-signature" } },
    { type: "content_block_stop", index: 0 },
    { type: "content_block_start", index: 1, content_block: { type: "text", text: "Checking." } },
    { type: "content_block_stop", index: 1 },
    { type: "content_block_start", index: 2, content_block: { type: "tool_use", id: "fixture-call", name: "read_fixture", input: {} } },
    { type: "content_block_stop", index: 2 },
    { type: "message_delta", delta: { stop_reason: "tool_use" } },
    { type: "message_stop" },
  ]
  vi.stubGlobal("fetch", async (_url: string, init: RequestInit) => {
    bodies.push(JSON.parse(String(init.body)))
    const events = bodies.length === 1 ? firstResponse : [
      { type: "content_block_start", index: 0, content_block: { type: "text", text: "Done." } },
      { type: "content_block_stop", index: 0 },
      { type: "message_stop" },
    ]
    return new Response(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join(""))
  })
  const client = createAnthropicClient({ apiKey: "fixture", model: "model", providerId: "route", baseUrl: "https://fixture.invalid" })
  const session = createSession()
  append(session, { type: "step/start" })
  append(session, { type: "compaction/summary", text: "Inspect the fixture.", shadowedSeqs: [0] })
  const request = { systemPrompt: "Stable authority.", tools: [{ name: "read_fixture", description: "Read fixture.", inputSchema: { type: "object", properties: {} } }], reasoningEffort: "high" as const, maxOutputTokens: 4096 }
  const events: LLMStreamEvent[] = []
  for await (const event of client.stream({ ...request, messages: deriveMessages(session) })) events.push(event)
  const end = events.findLast(event => event.type === "end")
  expect(end?.thinkingBlocks).toEqual([{ type: "thinking", thinking: "Inspect the fixture.", signature: "fixture-signature" }])
  for (const event of events) if (event.type === "tool_call") append(session, { type: "tool/call", callId: event.call.id!, name: event.call.name, args: event.call.args })
  append(session, { type: "assistant/message", text: events.filter(event => event.type === "text/chunk").map(event => event.text).join(""), thinkingBlocks: end!.thinkingBlocks, providerContinuation: end!.providerContinuation })
  append(session, { type: "tool/result", callId: "fixture-call", name: "read_fixture", output: "ready" })
  append(session, { type: "step/end" })
  const completed: LLMStreamEvent[] = []
  for await (const event of client.stream({ ...request, messages: deriveMessages(reload ? fromJSONL(toJSONL(session)) : session) })) completed.push(event)
  expect(bodies[1]!.messages).toEqual([
    { role: "user", content: "Inspect the fixture." },
    { role: "assistant", content: [
      { type: "thinking", thinking: "Inspect the fixture.", signature: "fixture-signature" },
      { type: "text", text: "Checking." },
      { type: "tool_use", id: "fixture-call", name: "read_fixture", input: {} },
    ] },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "fixture-call", content: '"ready"' }] },
  ])
  expect(completed).toContainEqual({ type: "text/chunk", text: "Done." })
  expect(completed.some(event => event.type === "error")).toBe(false)
})
