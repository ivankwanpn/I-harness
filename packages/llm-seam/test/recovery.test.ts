import { describe, expect, it } from "vitest"
import { createRetryingClient, describeTransportError, resolveRetryPolicy, retryErrorCode, SSEParseError, type LLMRequest, type LLMStreamEvent, type ModelClient } from "../src/index.ts"

const request: LLMRequest = { messages: [], tools: [], systemPrompt: "" }
const policy = resolveRetryPolicy({ mode: "normal", maxRetries: 1, backoff: { initialDelayMs: 1, jitterRatio: 0 } })
const collect = async (client: ModelClient, req = request) => { const events: LLMStreamEvent[] = []; for await (const event of client.stream(req)) events.push(event); return events }
const failure = (code: string, extra = {}) => Object.assign(new Error("fixture failure"), { code, ...extra })

describe("observable model recovery", () => {
  it("bounds retry diagnostics even when an unknown error code contains a payload", async () => {
    let calls = 0
    const client: ModelClient = { async *stream() { if (++calls === 1) throw failure("private " + "x".repeat(1000)); yield { type: "end" } } }
    const events = await collect(createRetryingClient(client, resolveRetryPolicy({ mode: "always", backoff: { initialDelayMs: 1 } })))
    expect(events.filter(event => event.type === "retry").map(event => event.retry.code)).toEqual(["UNKNOWN", "UNKNOWN", "UNKNOWN"])
  })
  it("classifies fetch failures without treating remediation text as a TLS failure", async () => {
    expect(retryErrorCode(await describeTransportError("test", "https://fixture.test", new TypeError("fetch failed")))).toBe("TRANSPORT")
  })
  it("does not expose malformed stream contents in error details", () => {
    expect(new SSEParseError("private prompt and credentials").message).not.toContain("private")
  })
  it("emits waiting, attempting and recovered around real progress with stable request metadata", async () => {
    let calls = 0
    const client: ModelClient = { async *stream() { if (++calls === 1) throw failure("SERVER", { httpStatus: 503 }); yield { type: "usage", usage: { inputTokens: 2 } }; yield { type: "text/chunk", text: "ok" }; yield { type: "end" } } }
    const events = await collect(createRetryingClient(client, policy, { providerId: "p", modelId: "m" }))
    const retries = events.filter(event => event.type === "retry").map(event => event.retry)
    expect(retries.map(event => event.phase)).toEqual(["waiting", "attempting", "recovered"])
    expect(retries[0]).toMatchObject({ attempt: 1, maxRetries: 1, code: "SERVER", httpStatus: 503, providerId: "p", modelId: "m" })
    expect(new Set(retries.map(event => event.requestId)).size).toBe(1)
    expect(events.map(event => event.type)).toEqual(["retry", "retry", "retry", "text/chunk", "usage", "end"])
  })
  it.each(["normal", "always"] as const)("never retries auth, quota, malformed or TLS errors in %s mode", async mode => {
    for (const code of ["INVALID_API_KEY", "QUOTA", "INVALID_ARGUMENT", "CERT_HAS_EXPIRED", "context_length_exceeded", "insufficient_quota", "ABORT_ERR"]) {
      let calls = 0
      const client: ModelClient = { async *stream() { if (++calls === 1) throw failure(code); yield { type: "end" } } }
      await expect(collect(createRetryingClient(client, resolveRetryPolicy({ mode, backoff: { initialDelayMs: 1 } })))).rejects.toThrow("fixture failure")
      expect(calls).toBe(1)
    }
  })
  it("normalizes network failures through a cause chain", () => {
    expect(retryErrorCode(new Error("fetch failed", { cause: failure("ECONNRESET") }))).toBe("TRANSPORT")
    expect(retryErrorCode(failure("ETIMEDOUT"))).toBe("TIMEOUT")
    expect(retryErrorCode(failure("rate_limit_exceeded"))).toBe("RATE_LIMIT")
  })
  it("zero retries means exactly one request", async () => {
    let calls = 0
    const client: ModelClient = { async *stream() { calls++; throw failure("SERVER") } }
    await expect(collect(createRetryingClient(client, resolveRetryPolicy({ mode: "normal", maxRetries: 0 })))).rejects.toThrow()
    expect(calls).toBe(1)
  })
  it("cancels a parked backoff immediately without recovered or another attempt", async () => {
    const controller = new AbortController(); let calls = 0
    const client: ModelClient = { async *stream() { calls++; throw failure("SERVER") } }
    const stream = createRetryingClient(client, resolveRetryPolicy({ mode: "normal", backoff: { initialDelayMs: 10_000 } })).stream({ ...request, signal: controller.signal })[Symbol.asyncIterator]()
    expect((await stream.next()).value?.type).toBe("retry")
    const next = stream.next(); controller.abort()
    await expect(next).rejects.toMatchObject({ name: "AbortError" })
    expect(calls).toBe(1)
  })
  it("honors a two-second server deadline and refuses advice beyond 60 seconds", async () => {
    for (const wait of [2000, 61_000]) {
      let calls = 0; const start = Date.now()
      const client: ModelClient = { async *stream() { if (++calls === 1) throw failure("RATE_LIMIT", { retryAfterAt: start + wait }); yield { type: "end" } } }
      if (wait > 60_000) { await expect(collect(createRetryingClient(client, policy))).rejects.toThrow(); expect(calls).toBe(1) }
      else { await collect(createRetryingClient(client, policy)); expect(Date.now() - start).toBeGreaterThanOrEqual(2000); expect(calls).toBe(2) }
    }
  })
})
