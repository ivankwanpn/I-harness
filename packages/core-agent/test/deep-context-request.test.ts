import { afterEach, expect, it, vi } from "vitest"
import { createContext } from "@i-harness/core-plugin"
import { append, createSession } from "@i-harness/core-session"
import { createToolRegistry } from "@i-harness/core-tools"
import type { LLMRequest } from "@i-harness/llm-seam"
import { createAgent } from "../src/index.ts"
import { createAnthropicClient } from "../../llm-anthropic/src/index.ts"

afterEach(() => vi.unstubAllGlobals())

it.each([2000, 6000].flatMap(depth => [false, true].map(schema => ({ depth, schema }))))("runs and finishes actual neutral depth-$depth args (deep schema=$schema)", async ({ depth, schema: deepSchema }) => {
  let deep: unknown = { leaf: "retained" }
  for (let i = 0; i < depth; i++) deep = { child: deep }
  const ctx = createContext(), session = createSession(), tools = createToolRegistry(ctx), abort = new AbortController()
  append(session, { type: "step/start" }); append(session, { type: "tool/call", callId: "historical", name: "probe", args: deep })
  append(session, { type: "assistant/message", text: "old" }); append(session, { type: "tool/result", callId: "historical", name: "probe", output: deepSchema ? deep : "ok" }); append(session, { type: "step/end" })
  const sent: LLMRequest[] = [], observations: object[] = []
  const agent = createAgent(ctx, { session, sessionId: "deep-owner", tools, signal: abort.signal, systemPrompt: "s", maxOutputTokens: 100,
    budget: { contextWindow: 1000000 }, modelToolSchemas: () => [{ name: "probe", description: "probe", inputSchema: deepSchema ? deep : { type: "object" } }],
    telemetry: { close() {}, emit(event) { observations.push(event) } },
    model: { async *stream(request) {
      sent.push(request)
      expect(request.signal).toBe(abort.signal)
      let args = (request.messages.find(message => message.role === "assistant") as Extract<LLMRequest["messages"][number], { role: "assistant" }>).toolCalls![0]!.args
      let schema = request.tools[0]!.inputSchema
      for (let i = 0; i < depth; i++) { args = (args as { child: unknown }).child; if (deepSchema) schema = (schema as { child: unknown }).child }
      expect(args).toEqual({ leaf: "retained" }); expect(schema).toEqual(deepSchema ? { leaf: "retained" } : { type: "object" })
      if (deepSchema) {
        const tool = request.messages.find(message => message.role === "tool")!
        let result = JSON.parse(tool.content as string) as unknown
        for (let i = 0; i < depth; i++) result = (result as { child: unknown }).child
        expect(result).toEqual({ leaf: "retained" })
      }
      expect(agent.contextBudget!()).toMatchObject({ kind: "ready", snapshot: { coverage: "neutral-only", admission: "fit" } })
      yield { type: "text/chunk", text: "done" }; yield { type: "end" }
    } } })
  await expect(agent.run("anchor")).resolves.toMatchObject({ finalText: "done" })
  await expect(agent.followup("next")).resolves.toMatchObject({ finalText: "done" })
  expect(sent).toHaveLength(2)
  expect(sent[0]!.requestScope!.sessionId).toBe("deep-owner")
  expect(sent[1]!.requestScope).not.toBe(sent[0]!.requestScope)
  expect(observations).toContainEqual(expect.objectContaining({ type: "provider/call", data: expect.objectContaining({ prefixBroke: false }) }))
  expect(agent.contextBudget!()).toMatchObject({ kind: "ready", snapshot: { admission: "unavailable", coverage: "neutral-only" } })
})

it("prepares, measures, derives a cap and physically sends depth-6000 JSON on a controlled actual HTTP route", async () => {
  const depth = 6000
  let deep: unknown = { leaf: "retained" }
  for (let i = 0; i < depth; i++) deep = { child: deep }
  const ctx = createContext(), session = createSession(), tools = createToolRegistry(ctx), abort = new AbortController()
  append(session, { type: "step/start" }); append(session, { type: "tool/call", callId: "historical", name: "probe", args: deep })
  append(session, { type: "assistant/message", text: "old" }); append(session, { type: "tool/result", callId: "historical", name: "probe", output: "ok" }); append(session, { type: "step/end" })
  let sends = 0
  vi.stubGlobal("fetch", async (_url: unknown, init: RequestInit) => {
    sends++
    expect(init.signal).toBe(abort.signal)
    const body = JSON.parse(init.body as string) as { max_tokens: number; messages: { role: string; content: { type: string; input?: unknown }[] }[] }
    const assistant = body.messages.find(message => message.role === "assistant")!
    let input = assistant.content.find(block => block.type === "tool_use")!.input
    for (let i = 0; i < depth; i++) input = (input as { child: unknown }).child
    expect(input).toEqual({ leaf: "retained" }); expect(body.max_tokens).toBe(2048)
    const events = [{ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
      { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "done" } }, { type: "content_block_stop", index: 0 },
      { type: "message_delta", delta: { stop_reason: "end_turn" } }, { type: "message_stop" }]
    return new Response(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join(""), { headers: { "content-type": "text/event-stream" } })
  })
  const agent = createAgent(ctx, { session, tools, systemPrompt: "s", signal: abort.signal, budget: { contextWindow: 1000000 }, maxOutputTokens: 2048,
    model: createAnthropicClient({ model: "m", apiKey: "controlled" }), modelToolSchemas: () => [{ name: "probe", description: "probe", inputSchema: { type: "object" } }] })
  await expect(agent.run("anchor")).resolves.toMatchObject({ finalText: "done" })
  expect(sends).toBe(1)
})
