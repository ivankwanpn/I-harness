import { afterEach, expect, it, vi } from "vitest"
import { createOpenAIClient } from "../src/index.ts"
import { createRetryingClient, resolveRetryPolicy, type LLMStreamEvent } from "@i-harness/llm-seam"

// Drive the external timer dependency with Vitest's clock; production still uses
// Node's abortable timer. Omitting the signal at the call site breaks cancellation.
vi.mock("node:timers/promises", () => ({ setTimeout: (ms: number, value?: unknown, options?: { signal?: AbortSignal }) => new Promise((resolve, reject) => {
  const signal = options?.signal
  signal?.throwIfAborted()
  const abort = () => { clearTimeout(timer); reject(new DOMException("Aborted", "AbortError")) }
  const timer = setTimeout(() => { signal?.removeEventListener("abort", abort); resolve(value) }, ms)
  signal?.addEventListener("abort", abort, { once: true })
}) }))

const capacity = "Selected model is at capacity. Please try a different model."
const request = { messages: [], tools: [], systemPrompt: "" }
const sse = (event: unknown) => `data: ${JSON.stringify(event)}\n\n`
const success = () => new Response(sse({ type: "response.output_text.delta", delta: "ok" }) + sse({ type: "response.completed" }))
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals() })
async function collect(model: ReturnType<typeof createRetryingClient>, signal?: AbortSignal) {
  const events: LLMStreamEvent[] = []
  for await (const event of model.stream({ ...request, ...(signal ? { signal } : {}) })) events.push(event)
  return events
}
function model(maxRetries = 1) {
  return createRetryingClient(createOpenAIClient({ apiKey: "fixture", model: "gpt-6.1-sol", baseUrl: "https://api.test" }), resolveRetryPolicy({ mode: "normal", maxRetries, backoff: { initialDelayMs: 100, maxDelayMs: 1000, jitterRatio: 0 } }))
}

it.each([
  ["HTTP 503", () => new Response(JSON.stringify({ error: { code: "server_is_overloaded", message: capacity } }), { status: 503, headers: { "retry-after": "2" } })],
  ["HTTP 429 with capacity code", () => new Response(JSON.stringify({ error: { code: "server_is_overloaded", message: capacity } }), { status: 429 })],
  ["stream code", () => new Response(sse({ type: "error", code: "server_is_overloaded", message: capacity }))],
  ["failed response", () => new Response(sse({ type: "response.failed", response: { error: { code: "server_is_overloaded", message: capacity } } }))],
  ["message only", () => new Response(sse({ type: "error", message: capacity }))],
] as const)("waits ten seconds for %s and retains the selected model", async (_label, failed) => {
  vi.useFakeTimers()
  const fetch = vi.fn().mockImplementationOnce(failed).mockImplementation(success)
  vi.stubGlobal("fetch", fetch)
  const result = collect(model())
  await vi.advanceTimersByTimeAsync(9_999)
  expect(fetch).toHaveBeenCalledTimes(1)
  await vi.advanceTimersByTimeAsync(1)
  const events = await result
  expect(fetch).toHaveBeenCalledTimes(2)
  expect(events.filter(e => e.type === "retry").map(e => e.retry.phase)).toEqual(["waiting", "attempting", "recovered"])
  expect(events.find(e => e.type === "retry" && e.retry.phase === "waiting")).toMatchObject({ retry: { code: "CAPACITY", delayMs: 10_000, attempt: 1, maxRetries: 1 } })
  expect(fetch.mock.calls.map(([, init]) => JSON.parse(init.body as string).model)).toEqual(["gpt-6.1-sol", "gpt-6.1-sol"])
})

it("uses the same ten-second minimum on each capacity retry", async () => {
  vi.useFakeTimers(); vi.setSystemTime(0)
  const times: number[] = []
  vi.stubGlobal("fetch", () => { times.push(Date.now()); return Promise.resolve(times.length <= 2 ? new Response(sse({ type: "error", code: "server_is_overloaded", message: capacity })) : success()) })
  const result = collect(model(2))
  await vi.runAllTimersAsync(); await result
  expect(times).toEqual([0, 10_000, 20_000])
})

it("honors a longer server deadline and cancels the capacity wait immediately", async () => {
  vi.useFakeTimers()
  const fetch = vi.fn(async () => new Response(JSON.stringify({ error: { code: "server_is_overloaded" } }), { status: 503, headers: { "retry-after": "20" } }))
  vi.stubGlobal("fetch", fetch)
  const controller = new AbortController()
  const result = collect(model(), controller.signal)
  const rejection = expect(result).rejects.toMatchObject({ name: "AbortError" })
  await vi.advanceTimersByTimeAsync(10_001)
  expect(fetch).toHaveBeenCalledTimes(1)
  controller.abort(); await rejection
  await vi.runAllTimersAsync()
  expect(fetch).toHaveBeenCalledTimes(1)
})

it("keeps quota exhaustion terminal even if its message mentions capacity", async () => {
  const fetch = vi.fn(async () => new Response(JSON.stringify({ error: { code: "insufficient_quota", message: capacity } }), { status: 429 }))
  vi.stubGlobal("fetch", fetch)
  const events = await collect(model())
  expect(events.map(e => e.type)).toEqual(["error"])
  expect(fetch).toHaveBeenCalledTimes(1)
})

it.each([400, 404, 413, 422].flatMap(status => ["normal", "always"].map(mode => ({ status, mode }))))("keeps HTTP $status terminal under $mode despite the capacity phrase", async ({ status, mode }) => {
  vi.useFakeTimers()
  const fetch = vi.fn().mockImplementationOnce(() => new Response(capacity, { status })).mockImplementation(success)
  vi.stubGlobal("fetch", fetch)
  const client = createOpenAIClient({ apiKey: "fixture", model: "gpt-6.1-sol", baseUrl: "https://api.test" })
  const policy = resolveRetryPolicy(mode === "always" ? { mode: "always" } : { mode: "normal", maxRetries: 1 })
  const result = collect(createRetryingClient(client, policy))
  await vi.runAllTimersAsync()
  expect((await result).map(event => event.type)).toEqual(["error"])
  expect(fetch).toHaveBeenCalledTimes(1)
})
