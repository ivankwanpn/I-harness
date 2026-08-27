import { describe, expect, it } from "vitest"
import { backoffDelay, createRetryingClient, resolveRetryPolicy } from "../src/index.ts"
import type { LLMRequest, LLMStreamEvent, ModelClient } from "../src/index.ts"

const REQ: LLMRequest = { messages: [], tools: [], systemPrompt: "" }

function streamOf(events: LLMStreamEvent[]): AsyncIterable<LLMStreamEvent> {
  return (async function* () {
    for (const e of events) yield e
  })()
}

function errWithCode(code: string, message: string): Error {
  const e = new Error(message)
  ;(e as Error & { code?: string }).code = code
  return e
}

function errorEvent(code: string | undefined, message: string): LLMStreamEvent {
  const e = new Error(message)
  if (code !== undefined) (e as Error & { code?: string }).code = code
  return { type: "error", error: e }
}

// Base client whose stream is an ASYNC GENERATOR (the repo's ModelClient
// convention — stream() returns an AsyncIterable directly, not a Promise).
// Each attempt is built by its own function so a builder may throw or yield
// then throw mid-stream. The last attempt builder is reused once exhausted.
function steppedModel(...attempts: Array<() => AsyncIterable<LLMStreamEvent>>): { client: ModelClient; calls: () => number } {
  const state = { calls: 0 }
  const client: ModelClient = {
    async *stream(): AsyncIterable<LLMStreamEvent> {
      const build = attempts[Math.min(state.calls, attempts.length - 1)]!
      state.calls++
      yield* build()
    },
  }
  return { client, calls: () => state.calls }
}

async function collect(client: ModelClient): Promise<{ text: string[]; errors: Error[] }> {
  const text: string[] = []
  const errors: Error[] = []
  for await (const ev of client.stream(REQ)) {
    if (ev.type === "text/chunk") text.push(ev.text)
    else if (ev.type === "error") errors.push(ev.error)
  }
  return { text, errors }
}

describe("backoffDelay", () => {
  it("doubles per attempt up to the max delay (jitter disabled)", () => {
    const p = resolveRetryPolicy({ mode: "normal", maxRetries: 0, backoff: { initialDelayMs: 100, maxDelayMs: 1000, jitterRatio: 0 } })
    expect(backoffDelay(p, 1)).toBe(100)
    expect(backoffDelay(p, 2)).toBe(200)
    expect(backoffDelay(p, 4)).toBe(800)
    expect(backoffDelay(p, 5)).toBe(1000)
    expect(backoffDelay(p, 100)).toBe(1000)
  })

  it("applies symmetric jitter within bounds and never negative", () => {
    const p = resolveRetryPolicy({ mode: "normal", maxRetries: 0, backoff: { initialDelayMs: 100, maxDelayMs: 1000, jitterRatio: 0.5 } })
    // attempt 2 → base 200 ms; jitter is ±50% of the capped base.
    for (let i = 0; i < 50; i++) {
      const d = backoffDelay(p, 2)
      expect(d).toBeGreaterThanOrEqual(100)
      expect(d).toBeLessThanOrEqual(300)
    }
  })
})

describe("createRetryingClient", () => {
  it("retries on a retryable error event before any output (event is not leaked)", async () => {
    const { client, calls } = steppedModel(
      () => streamOf([errorEvent("RATE_LIMIT", "rate limited")]),
      () => streamOf([{ type: "text/chunk", text: "ok" }, { type: "end" }]),
    )
    const out = await collect(createRetryingClient(client, resolveRetryPolicy({ mode: "normal", maxRetries: 1, backoff: { initialDelayMs: 1 } })))
    expect(calls()).toBe(2)
    expect(out.text.join("")).toBe("ok")
    expect(out.errors).toEqual([])
  })

  it("retries on a retryable thrown error before any output", async () => {
    let calls = 0
    const base: ModelClient = {
      async *stream(): AsyncIterable<LLMStreamEvent> {
        calls++
        if (calls === 1) throw errWithCode("RATE_LIMIT", "rate limited")
        yield { type: "text/chunk", text: "ok" }
        yield { type: "end" }
      },
    }
    const out = await collect(createRetryingClient(base, resolveRetryPolicy({ mode: "normal", maxRetries: 1, backoff: { initialDelayMs: 1 } })))
    expect(calls).toBe(2)
    expect(out.text.join("")).toBe("ok")
  })

  it("does not retry after output has been produced — error event surfaces", async () => {
    const { client, calls } = steppedModel(
      () => streamOf([{ type: "text/chunk", text: "partial" }, errorEvent("RATE_LIMIT", "boom"), { type: "text/chunk", text: "tail" }]),
      () => streamOf([{ type: "text/chunk", text: "never" }, { type: "end" }]),
    )
    const out = await collect(createRetryingClient(client, resolveRetryPolicy({ mode: "normal", maxRetries: 3, backoff: { initialDelayMs: 1 } })))
    expect(calls()).toBe(1) // output began → no retry
    expect(out.text).toEqual(["partial"]) // events after the terminal error event are not consumed
    expect(out.errors).toHaveLength(1)
    expect(out.errors[0]!.message).toBe("boom")
  })

  it("does not retry after a tool_call has been produced — error event surfaces", async () => {
    const { client, calls } = steppedModel(
      () => streamOf([{ type: "tool_call", call: { name: "t", args: {} } }, errorEvent("RATE_LIMIT", "boom")]),
      () => streamOf([{ type: "end" }]),
    )
    const out = await collect(createRetryingClient(client, resolveRetryPolicy({ mode: "normal", maxRetries: 3, backoff: { initialDelayMs: 1 } })))
    expect(calls()).toBe(1)
    expect(out.errors).toHaveLength(1)
  })

  it("does not retry after a reasoning event has been produced — error event surfaces", async () => {
    const { client, calls } = steppedModel(
      () => streamOf([{ type: "reasoning", text: "thinking..." }, errorEvent("RATE_LIMIT", "boom")]),
      () => streamOf([{ type: "end" }]),
    )
    const out = await collect(createRetryingClient(client, resolveRetryPolicy({ mode: "normal", maxRetries: 3, backoff: { initialDelayMs: 1 } })))
    expect(calls()).toBe(1)
    expect(out.errors).toHaveLength(1)
  })

  it("does not retry a thrown error after output has been produced", async () => {
    let calls = 0
    const base: ModelClient = {
      async *stream(): AsyncIterable<LLMStreamEvent> {
        calls++
        yield { type: "text/chunk", text: "partial" }
        throw errWithCode("RATE_LIMIT", "mid-stream boom")
      },
    }
    await expect(collect(createRetryingClient(base, resolveRetryPolicy({ mode: "normal", maxRetries: 3, backoff: { initialDelayMs: 1 } })))).rejects.toThrow(/mid-stream boom/)
    expect(calls).toBe(1)
  })

  it("does not retry a non-retryable thrown error", async () => {
    let calls = 0
    const base: ModelClient = {
      async *stream(): AsyncIterable<LLMStreamEvent> {
        calls++
        throw errWithCode("INVALID_API_KEY", "auth failed")
      },
    }
    const client = createRetryingClient(base, resolveRetryPolicy({ mode: "normal", maxRetries: 3, backoff: { initialDelayMs: 1 } }))
    await expect(collect(client)).rejects.toThrow(/auth failed/)
    expect(calls).toBe(1)
  })

  it("a non-retryable error event surfaces as an event (no retry, no throw)", async () => {
    const { client, calls } = steppedModel(
      () => streamOf([errorEvent("INVALID_API_KEY", "auth failed"), { type: "text/chunk", text: "after" }]),
    )
    const out = await collect(createRetryingClient(client, resolveRetryPolicy({ mode: "normal", maxRetries: 5, backoff: { initialDelayMs: 1 } })))
    expect(calls()).toBe(1)
    expect(out.errors.map((e) => e.message)).toEqual(["auth failed"])
    expect(out.text).toEqual([]) // terminal error event ends the stream
  })

  it("throws after exhausting retries (error event becomes a hard failure)", async () => {
    const { client, calls } = steppedModel(
      () => streamOf([errorEvent("SERVER", "server error")]),
      () => streamOf([errorEvent("SERVER", "server error")]),
      () => streamOf([errorEvent("SERVER", "server error")]),
    )
    const retrying = createRetryingClient(client, resolveRetryPolicy({ mode: "normal", maxRetries: 2, backoff: { initialDelayMs: 1 } }))
    let err: unknown
    try {
      for await (const ev of retrying.stream(REQ)) {
        void ev
      }
    } catch (e) {
      err = e
    }
    expect(calls()).toBe(3)
    expect(err).toBeInstanceOf(Error)
    expect((err as Error).message).toBe("server error")
  })

  it("always mode retries any error without code matching", async () => {
    const { client, calls } = steppedModel(
      () => streamOf([errorEvent(undefined, "weird provider hiccup")]),
      () => streamOf([{ type: "text/chunk", text: "ok" }, { type: "end" }]),
    )
    const out = await collect(createRetryingClient(client, resolveRetryPolicy({ mode: "always", backoff: { initialDelayMs: 1 } })))
    expect(calls()).toBe(2)
    expect(out.text.join("")).toBe("ok")
  })
})
