import { afterEach, describe, expect, it, vi } from "vitest"
import type { LLMRequest, LLMStreamEvent, ModelClient } from "@i-harness/llm-seam"
import { modelFailureFacts, retryErrorCode } from "@i-harness/llm-seam"
import { createOpenAIClient } from "../src/index.ts"

const request: LLMRequest = { messages: [{ role: "user", content: "hi" }], systemPrompt: "Help", tools: [{ name: "read", description: "Read a file", inputSchema: { type: "object" } }] }
const completed = { type: "response.completed", response: { status: "completed" } }
const sse = (...events: unknown[]) => events.map(event => `data: ${typeof event === "string" ? event : JSON.stringify(event)}\n\n`).join("")
const collect = async (client: ModelClient, input = request) => {
  const events: LLMStreamEvent[] = []
  for await (const event of client.stream(input)) events.push(event)
  return events
}
const plan = (extra = {}) => createOpenAIClient({ apiKey: "unused-key", model: "account-model", codexSubscription: true, resolveCodexAuth: async () => ({ accessToken: "fixture-token", accountId: "fixture-account" }), ...extra })
afterEach(() => vi.unstubAllGlobals())

describe("Codex subscription Responses contract", () => {
  it("uses the shared safe context classifier on the distinct subscription HTTP route", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ error: { type: "invalid_request_error", code: "CONTEXT_TOO_LONG", message: "private subscription prompt" } }), { status: 400, headers: { "x-request-id": "req-subscription-123" } }))
    vi.stubGlobal("fetch", fetchMock)
    const events = await collect(plan())
    expect(fetchMock.mock.calls).toHaveLength(1)
    const error = events[0]
    if (error?.type !== "error") throw new Error("missing error")
    expect(retryErrorCode(error.error)).toBe("CONTEXT_WINDOW_EXCEEDED")
    expect(modelFailureFacts(error.error)).toMatchObject({ code: "CONTEXT_WINDOW_EXCEEDED", providerCode: "CONTEXT_TOO_LONG", providerType: "invalid_request_error", requestId: "req-subscription-123" })
    expect(JSON.stringify(modelFailureFacts(error.error))).not.toContain("private subscription prompt")
  })
  it("resolves the account token on every stream with the current abort signal", async () => {
    let rotation = 0
    const signals: (AbortSignal | undefined)[] = []
    const fetchMock = vi.fn(async (_url: string, _init: RequestInit) => new Response(sse(completed)))
    vi.stubGlobal("fetch", fetchMock)
    const client = plan({ resolveCodexAuth: async (signal?: AbortSignal) => { signals.push(signal); return { accessToken: `fixture-${++rotation}`, accountId: `account-${rotation}` } } })
    expect(rotation).toBe(0)
    const signal = new AbortController().signal
    await collect(client, { ...request, signal })
    await collect(client)
    expect(signals).toEqual([signal, undefined])
    expect(fetchMock.mock.calls.map(([url, init]) => [url, new Headers(init.headers).get("authorization"), new Headers(init.headers).get("ChatGPT-Account-Id"), init.redirect])).toEqual([
      ["https://chatgpt.com/backend-api/codex/responses", "Bearer fixture-1", "account-1", "error"],
      ["https://chatgpt.com/backend-api/codex/responses", "Bearer fixture-2", "account-2", "error"],
    ])
    const headers = new Headers(fetchMock.mock.calls[0]![1].headers)
    expect(headers.get("originator")).toBe("i-harness")
    expect(headers.get("user-agent")).toBe("I-harness")
    expect(headers.get("accept")).toBe("text/event-stream")
  })

  it.each(["https://evil.example", "https://api.openai.com", "https://chatgpt.com.evil.example/backend-api/codex", "http://chatgpt.com/backend-api/codex", "https://chatgpt.com/backend-api"])("rejects a plan endpoint override %s", baseUrl => {
    expect(() => plan({ baseUrl })).toThrow(/official|endpoint/i)
  })

  it("does not fall back to an API key when account resolution fails or is missing", async () => {
    const fetchMock = vi.fn(async () => new Response(sse(completed)))
    vi.stubGlobal("fetch", fetchMock)
    for (const resolveCodexAuth of [undefined, async () => { throw new Error("Account signed out") }, async () => ({ accessToken: "", accountId: "account" }), async () => ({ accessToken: "fixture-token", accountId: "" })]) {
      const events = await collect(plan({ resolveCodexAuth }))
      expect(events.map(event => event.type)).toEqual(["error"])
    }
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it("rejects configurable headers for plan credentials", () => {
    expect(() => plan({ headers: { authorization: "Bearer override" } })).toThrow(/headers/i)
  })

  it("does not send credentials when cancellation occurs during token resolution", async () => {
    const controller = new AbortController()
    const fetchMock = vi.fn(async () => new Response(sse(completed)))
    vi.stubGlobal("fetch", fetchMock)
    const client = plan({ resolveCodexAuth: async () => { controller.abort(); return { accessToken: "fixture-token", accountId: "fixture-account" } } })
    await expect(collect(client, { ...request, signal: controller.signal })).rejects.toMatchObject({ name: "AbortError" })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it("uses the Codex Responses request fields after merging and namespaces local tools", async () => {
    const unsupported = ["background", "conversation", "max_output_tokens", "max_tool_calls", "metadata", "moderation", "multi_agent", "prompt", "prompt_cache_retention", "safety_identifier", "temperature", "top_logprobs", "top_p", "truncation", "user", "previous_response_id", "unknown_option"]
    const fetchMock = vi.fn(async (_url: string, _init: RequestInit) => new Response(sse(completed)))
    vi.stubGlobal("fetch", fetchMock)
    await collect(plan({ options: { ...Object.fromEntries(unsupported.map(key => [key, "unsupported"])), store: true, stream: false, tools: [{ type: "tool_search" }] } }), { ...request, maxOutputTokens: 100, reasoningEffort: "high" })
    const body = JSON.parse(fetchMock.mock.calls[0]![1].body as string)
    for (const key of unsupported) expect(body).not.toHaveProperty(key)
    expect(body).toMatchObject({ store: false, stream: true, reasoning: { effort: "high" }, include: ["reasoning.encrypted_content"], tool_choice: "auto", parallel_tool_calls: true })
    expect(body.tools).toEqual([{ type: "namespace", name: "ih", description: expect.any(String), tools: [{ type: "function", name: "read", description: "Read a file", parameters: { type: "object" } }] }])
  })

  it("keeps the selected Codex model and complete input when options attempt to replace them", async () => {
    const fetchMock = vi.fn(async (_url: string, _init: RequestInit) => new Response(sse(completed)))
    vi.stubGlobal("fetch", fetchMock)
    await collect(plan({ options: { model: "wrong", instructions: "wrong", input: "wrong" } }))
    expect(JSON.parse(fetchMock.mock.calls[0]![1].body as string)).toMatchObject({ model: "account-model", instructions: "Help", input: [{ role: "user", content: "hi" }] })
  })

  it("replays a namespaced streamed tool call with its call id and namespace", async () => {
    const fetchMock = vi.fn(async (_url: string, _init: RequestInit) => new Response(sse(
      { type: "response.output_item.added", output_index: 0, item: { type: "function_call", id: "fc_1", call_id: "call_1", namespace: "ih", name: "read", arguments: "" } },
      { type: "response.function_call_arguments.delta", item_id: "fc_1", delta: '{"path":"README.md"}' },
      { type: "response.function_call_arguments.done", item_id: "fc_1" }, completed,
    )))
    vi.stubGlobal("fetch", fetchMock)
    const client = plan()
    const events = await collect(client)
    const call = events.find(event => event.type === "tool_call")
    expect(call).toEqual({ type: "tool_call", call: { id: "call_1", name: "read", args: { path: "README.md" } } })
    await collect(client, { ...request, messages: [
      { role: "assistant", content: "", toolCalls: [{ id: "call_1", name: "read", args: { path: "README.md" } }] },
      { role: "tool", toolCallId: "call_1", content: "file contents" },
    ] })
    const body = JSON.parse(fetchMock.mock.calls[1]![1].body as string)
    expect(body.input).toEqual([
      { type: "function_call", call_id: "call_1", namespace: "ih", name: "read", arguments: '{"path":"README.md"}' },
      { type: "function_call_output", call_id: "call_1", output: "file contents" },
    ])
  })

  it.each([
    ["premature EOF", sse({ type: "response.output_text.delta", delta: "partial" })],
    ["DONE without completion", sse("[DONE]")],
    ["incomplete", sse({ type: "response.incomplete", response: { incomplete_details: { reason: "max_output_tokens" } } }, completed)],
    ["failed", sse({ type: "response.failed", response: { error: { code: "usage_limit_reached", message: "Limit reached" } } }, completed)],
  ])("never succeeds after %s", async (_name, wire) => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(wire)))
    const events = await collect(plan())
    expect(events.at(-1)?.type).toBe("error")
    expect(events.some(event => event.type === "end")).toBe(false)
  })

  it("completes on response.completed without requiring a DONE sentinel", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(sse(completed))))
    expect(await collect(plan())).toEqual([{ type: "end" }])
  })

  it("releases a connection that stays open after the terminal completion event", async () => {
    let cancelled = false
    const stream = new ReadableStream({
      start(controller) { controller.enqueue(new TextEncoder().encode(sse(completed))) },
      cancel() { cancelled = true },
    })
    vi.stubGlobal("fetch", vi.fn(async () => new Response(stream)))
    expect(await collect(plan())).toEqual([{ type: "end" }])
    expect(cancelled).toBe(true)
  })

  it("rejects returned tools from a namespace this adapter did not declare", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(sse({ type: "response.output_item.added", item: { type: "function_call", namespace: "foreign", name: "read", arguments: "{}" } }, completed))))
    const events = await collect(plan())
    expect(events.map(event => event.type)).toEqual(["error"])
  })
})
