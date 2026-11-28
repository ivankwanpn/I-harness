import { afterEach, expect, it, vi } from "vitest"
import { createOpenAIClient } from "@i-harness/llm-openai"
import { createOpenAICompatibleClient } from "@i-harness/llm-openai-compatible"
import type { LLMMessage, LLMRequest, LLMStreamEvent, ModelClient } from "@i-harness/llm-seam"

const config = { model: "deepseek-flash", providerId: "deepseek", apiKey: "fixture", baseUrl: "https://api.deepseek.com" }
const request: LLMRequest = {
  systemPrompt: "", messages: [{ role: "user", content: "Read the file" }],
  tools: [{ name: "read", description: "", inputSchema: { type: "object" } }],
}
const item = { type: "reasoning", id: "rs_1", summary: [], encrypted_content: "opaque-companion", content: [{ type: "reasoning_text", text: "one" }, { type: "reasoning_text", text: " two" }] }
const call = { type: "function_call", id: "fc_1", call_id: "call_1", name: "read", arguments: '{"path":"file.txt"}' }

async function collect(client: ModelClient, input: LLMRequest) {
  const events: LLMStreamEvent[] = []
  for await (const event of client.stream(input)) events.push(event)
  expect(events.filter(event => event.type === "error")).toEqual([])
  return events
}

async function switchFixture(sourceUrl = config.baseUrl, providerId = config.providerId) {
  const fetch = vi.fn(async (_url: string, _init: RequestInit) => new Response("data: [DONE]\n\n"))
  vi.stubGlobal("fetch", fetch)
  const frames = [
    { type: "response.output_item.done", output_index: 0, item },
    { type: "response.output_text.delta", delta: "Reading." },
    { type: "response.output_item.done", output_index: 1, item: { type: "message", role: "assistant", content: [{ type: "output_text", text: "Reading." }] } },
    { type: "response.output_item.added", output_index: 2, item: call },
    { type: "response.output_item.done", output_index: 2, item: call },
    { type: "response.completed", response: { status: "completed" } },
  ]
  fetch.mockResolvedValueOnce(new Response(frames.map(frame => "data: " + JSON.stringify(frame) + "\n\n").join("")))
  const events = await collect(createOpenAIClient({ ...config, baseUrl: sourceUrl, providerId }), request)
  const continuation = events.find(event => event.type === "end")?.providerContinuation
  if (continuation?.kind !== "openai-responses") throw new Error("Missing source continuation")
  const emittedCall = events.find(event => event.type === "tool_call")?.call
  if (!emittedCall?.id) throw new Error("Missing source tool call")
  const assistant: Extract<LLMMessage, { role: "assistant" }> = {
    role: "assistant", content: events.filter(event => event.type === "text/chunk").map(event => event.text).join(""),
    toolCalls: [{ ...emittedCall, id: emittedCall.id }],
    providerContinuation: JSON.parse(JSON.stringify(continuation)),
  }
  return { assistant, continuation, fetch, async post(client: ModelClient, message = assistant) {
    await collect(client, { ...request, messages: [...request.messages, message, { role: "tool", toolCallId: call.call_id, content: "contents" }] })
    const [url, init] = fetch.mock.calls.at(-1)!
    return { url, body: JSON.parse(String(init.body)), redirect: init.redirect }
  } }
}
afterEach(() => vi.unstubAllGlobals())

it.each([[config.providerId, config.baseUrl], ["my-account", config.baseUrl + "/v1/"]])("replays a saved Responses thinking/tool round via official Chat for profile %s", async (providerId, baseUrl) => {
  const { post, fetch } = await switchFixture(baseUrl, providerId)
  expect(fetch.mock.calls[0]![0]).toBe("https://api.deepseek.com/v1/responses")
  const { url, body, redirect } = await post(createOpenAICompatibleClient({ ...config, providerId, baseUrl }))
  expect(url).toBe("https://api.deepseek.com/v1/chat/completions")
  expect(redirect).toBe("error")
  expect(body.messages.slice(1)).toEqual([
    { role: "assistant", content: "Reading.", reasoning_content: "one two", tool_calls: [{ id: call.call_id, type: "function", function: { name: call.name, arguments: call.arguments } }] },
    { role: "tool", tool_call_id: call.call_id, content: "contents" },
  ])
  expect(JSON.stringify(body)).not.toContain(item.encrypted_content)
})

it("retains the original Responses replay and fences subsequent Chat/Responses destination changes", async () => {
  const { post } = await switchFixture()
  expect((await post(createOpenAIClient(config))).body.input).toContainEqual(item)
  const mutable = { ...config, baseUrl: "https://proxy.example" }
  for (const client of [createOpenAIClient(mutable), createOpenAICompatibleClient(mutable)]) {
    mutable.baseUrl = config.baseUrl
    const { url, body } = await post(client)
    expect(new URL(url).hostname).toBe("proxy.example")
    expect(JSON.stringify(body)).not.toContain('"one"')
    expect(JSON.stringify(body)).not.toContain("one two")
  }
  for (const target of [{ ...config, model: "other" }, { ...config, providerId: "other" }]) {
    expect((await post(createOpenAICompatibleClient(target))).body.messages[1]).not.toHaveProperty("reasoning_content")
  }
})

it("cannot translate a proxy's unmarked continuation with the same provider and model names", async () => {
  const { post, continuation } = await switchFixture("https://proxy.example")
  expect(continuation).not.toHaveProperty("deepSeekReplayFingerprint")
  expect((await post(createOpenAICompatibleClient(config))).body.messages[1]).not.toHaveProperty("reasoning_content")
})

it("rejects edited text, replaced arguments and non-plain reasoning from the cross-protocol conversion", async () => {
  const { post, assistant, continuation } = await switchFixture()
  const modified = [
    { ...assistant, content: "Edited." },
    { ...assistant, toolCalls: [{ id: call.call_id, name: call.name, args: { path: "other.txt" } }] },
    ...[{ content: undefined }, { encrypted_content: 12 }, { summary: [{ type: "summary_text", text: "summary" }] },
      { content: [...item.content, { type: "summary_text", text: "summary" }] }].map(changes => ({
        ...assistant, providerContinuation: { ...continuation, reasoningItems: [{ ...item, ...changes }] },
      })),
  ]
  for (const message of modified) {
    const { body } = await post(createOpenAICompatibleClient(config), message)
    expect(body.messages[1]).not.toHaveProperty("reasoning_content")
    expect(body.messages[1].content).toBe(message.content)
    expect(body.messages[1].tool_calls[0].id).toBe(call.call_id)
  }
})
