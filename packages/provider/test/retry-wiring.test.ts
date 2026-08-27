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
