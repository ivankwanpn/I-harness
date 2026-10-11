import { afterEach, describe, expect, it, vi } from "vitest"
import { createOpenAIClient } from "../src/index.ts"
import type { LLMRequest, LLMStreamEvent } from "@i-harness/llm-seam"

afterEach(() => vi.unstubAllGlobals())
const request: LLMRequest = { systemPrompt: "Help", messages: [{ role: "user", content: "Read the file" }], tools: [{ name: "read", description: "Read", inputSchema: { type: "object" } }] }
const added = { type: "response.output_item.added", output_index: 0, item: { type: "function_call", id: "fc_1", call_id: "call_1", name: "read", arguments: "" } }
const completed = { type: "response.completed", response: { status: "completed" } }
async function collect(codexSubscription: boolean, events: unknown[]) {
  vi.stubGlobal("fetch", vi.fn(async () => new Response(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join(""))))
  const client = createOpenAIClient({ apiKey: "fixture", model: "gpt-6.1-sol", ...(codexSubscription ? { codexSubscription: true, resolveCodexAuth: async () => ({ accessToken: "fixture", accountId: "fixture" }) } : { baseUrl: "https://api.test" }) })
  const result: LLMStreamEvent[] = []
  for await (const event of client.stream(request)) result.push(event)
  return result
}

describe.each([false, true])("Responses complete tool arguments (subscription: %s)", subscription => {
  it.each([
    ["no deltas", undefined],
    ["unfinished delta", '{"path":"READ'],
    ["different complete delta", '{"path":"old.md"}'],
  ])("uses final arguments when receiving %s", async (_name, delta) => {
    const result = await collect(subscription, [added,
      ...(delta === undefined ? [] : [{ type: "response.function_call_arguments.delta", item_id: "fc_1", output_index: 0, delta }]),
      { type: "response.function_call_arguments.done", item_id: "fc_1", output_index: 0, arguments: '{"path":"README.md"}' },
      { type: "response.output_item.done", output_index: 0, item: { ...added.item, arguments: '{"path":"README.md"}', status: "completed" } }, completed,
    ])
    expect(result).toEqual([{ type: "tool_call", call: { id: "call_1", name: "read", args: { path: "README.md" } } }, { type: "end" }])
  })

  it("retains delta-only compatibility when the completion omits arguments", async () => {
    const result = await collect(subscription, [added,
      { type: "response.function_call_arguments.delta", item_id: "fc_1", delta: '{"path":' },
      { type: "response.function_call_arguments.delta", item_id: "fc_1", delta: '"README.md"}' },
      { type: "response.function_call_arguments.done", item_id: "fc_1" }, completed,
    ])
    expect(result).toEqual([{ type: "tool_call", call: { id: "call_1", name: "read", args: { path: "README.md" } } }, { type: "end" }])
  })

  it.each(["", '{"path":', 'not JSON', null, 42, {}])("does not execute a stale delta when final arguments are invalid: %j", async args => {
    const result = await collect(subscription, [added,
      { type: "response.function_call_arguments.delta", item_id: "fc_1", delta: '{"path":"stale.md"}' },
      { type: "response.function_call_arguments.done", item_id: "fc_1", arguments: args }, completed,
    ])
    expect(result).toHaveLength(1)
    expect(result[0]).toMatchObject({ type: "error", error: expect.objectContaining({ message: "openai malformed function_call arguments" }) })
  })

  it("keeps interleaved final arguments attached to their own call identities", async () => {
    const result = await collect(subscription, [added,
      { ...added, output_index: 1, item: { ...added.item, id: "fc_2", call_id: "call_2" } },
      { type: "response.function_call_arguments.delta", item_id: "fc_1", delta: '{"path":' },
      { type: "response.function_call_arguments.delta", item_id: "fc_2", delta: '{"path":' },
      { type: "response.function_call_arguments.done", item_id: "fc_2", arguments: '{"path":"second.md"}' },
      { type: "response.function_call_arguments.done", item_id: "fc_1", arguments: '{"path":"first.md"}' }, completed,
    ])
    expect(result).toEqual([
      { type: "tool_call", call: { id: "call_2", name: "read", args: { path: "second.md" } } },
      { type: "tool_call", call: { id: "call_1", name: "read", args: { path: "first.md" } } }, { type: "end" },
    ])
  })
})
