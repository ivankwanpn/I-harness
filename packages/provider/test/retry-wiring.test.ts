import { afterEach, describe, expect, it, vi } from "vitest"
import type { LLMRequest } from "@i-harness/llm-seam"
import { buildModelClient, createProviderRegistry, type ProviderProfile } from "../src/index.ts"

// Honest wiring probe: buildModelClient creates real protocol clients, so we
// cannot inject a fake underlying client. Instead we drive the real
// openai-compatible client against a fetch mock that fails once (500) then
// succeeds. With retryPolicy the wrapper must recover (2 fetches, output
// produced); without, the error event surfaces and no retry happens.
const profile: ProviderProfile = {
  name: "test",
  displayName: "Test",
  protocol: "openai-compatible",
  baseUrl: "https://retry.test",
  apiKey: "k",
  defaultModel: "gpt-4o",
}

// Note: the brief's sketch used `initialDelayMs: 0`, which resolveRetryPolicy
// correctly REJECTS (must be positive) — the wiring test needs a valid policy.
const retryPolicy = { mode: "normal", maxRetries: 1, backoff: { initialDelayMs: 1 } } as const

const REQ: LLMRequest = { messages: [{ role: "user", content: "hi" }], tools: [], systemPrompt: "" }

async function collect(stream: AsyncIterable<unknown>): Promise<unknown[]> {
  const events: unknown[] = []
  for await (const ev of stream) events.push(ev)
  return events
}

afterEach(() => vi.unstubAllGlobals())

describe("buildModelClient retry wiring", () => {
  it("wraps the client with retry when retryPolicy is set: a 500 then a 200 yields output", async () => {
    const okBody = `data: {"choices":[{"delta":{"content":"hello"}}]}\n\n`
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response("not a 200", { status: 500 }))
      .mockResolvedValueOnce(new Response(okBody, { status: 200 }))
    vi.stubGlobal("fetch", fetchMock)

    const client = buildModelClient({ ...profile, retryPolicy })
    const events = await collect(client.stream(REQ))

    // First attempt surfaced only an error event to the wrapper → retried →
    // output was produced and no error leaked.
    expect(events).toEqual([{ type: "text/chunk", text: "hello" }, { type: "end" }])
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it("leaves the client unwrapped when no retryPolicy: the 500 surfaces and there is no retry", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response("not a 200", { status: 500 }))
    vi.stubGlobal("fetch", fetchMock)

    const plain = buildModelClient({ ...profile, retryPolicy: undefined })
    const events = await collect(plain.stream(REQ))

    expect(events).toHaveLength(1)
    expect((events[0] as { type: string }).type).toBe("error")
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it("registry accepts a valid retryPolicy and rejects an invalid one at registration", () => {
    const reg = createProviderRegistry()
    reg.register({ ...profile, retryPolicy }) // valid: must not throw
    expect(() =>
      reg.register({ ...profile, name: "bad", retryPolicy: { mode: "bad" as never } }),
    ).toThrow(/retryPolicy/)
  })
})

// M72 Ⅱ: the route-level field-name switch only earns its six files if it
// actually arrives at the wire. This drives the REAL compatible client through
// buildModelClient, so the assertion is about the shipped plumbing (profile →
// factory config → body), not about a config object handed straight to the
// adapter (which the adapter's own suite already covers).
describe("M72 Ⅱ: the route's cap field name reaches the wire", () => {
  afterEach(() => vi.unstubAllGlobals())

  it("M72 Ⅱ: a route's own field name reaches the wire", async () => {
    const fetchMock = vi.fn(async (_url: string, _init: RequestInit) => new Response("", { status: 200 }))
    vi.stubGlobal("fetch", fetchMock)
    const client = buildModelClient({
      name: "gw", displayName: "GW", protocol: "openai-compatible",
      apiKey: "k", baseUrl: "https://gw.test", maxTokensField: "max_completion_tokens",
    }, "m")
    const it = client.stream({ messages: [{ role: "user", content: "hi" }], tools: [], systemPrompt: "s", maxOutputTokens: 7 } as LLMRequest)[Symbol.asyncIterator]()
    await it.next()
    const body = JSON.parse(fetchMock.mock.calls[0]![1].body as string)
    expect(body.max_completion_tokens).toBe(7)
    await it.return?.()
  })
})

// M72 Ⅲ: same wiring probe for the usage ask — the adapter's own suite hands
// the factory a config directly, so only this drives the shipped profile →
// factory → body chain. The route is switched OFF here because that is the
// direction a broken chain would hide: a dropped `usageInStream: false` falls
// back to the adapter's default, which SENDS.
describe("M72 Ⅲ: the route's usage ask reaches the wire", () => {
  afterEach(() => vi.unstubAllGlobals())

  it("M72 Ⅲ: a route whose gateway rejects the key does not send it", async () => {
    const fetchMock = vi.fn(async (_url: string, _init: RequestInit) => new Response("", { status: 200 }))
    vi.stubGlobal("fetch", fetchMock)
    const client = buildModelClient({
      name: "gw", displayName: "GW", protocol: "openai-compatible",
      apiKey: "k", baseUrl: "https://gw.test", usageInStream: false,
    }, "m")
    const it = client.stream({ messages: [{ role: "user", content: "hi" }], tools: [], systemPrompt: "s" } as LLMRequest)[Symbol.asyncIterator]()
    await it.next()
    const body = JSON.parse(fetchMock.mock.calls[0]![1].body as string)
    expect("stream_options" in body).toBe(false)
    await it.return?.()
  })
})
