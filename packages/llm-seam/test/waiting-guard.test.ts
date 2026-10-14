import { setTimeout as realDelay } from "node:timers/promises"
import { afterEach, expect, it, vi } from "vitest"
import { createWaitingGuard, createRetryingClient, resolveRetryPolicy, describeHttpError, type LLMRequest, type LLMStreamEvent, type ModelClient } from "../src/index.ts"

const request: LLMRequest = { messages: [], tools: [], systemPrompt: "" }
it("a stalled HTTP error body retains its terminal hint and explicit Stop still wins", async () => {
  vi.useFakeTimers()
  const client: ModelClient = { async *stream(req) {
    const response = new Response(new ReadableStream<Uint8Array>({}), { status: 400 })
    yield { type: "error", error: await describeHttpError("fixture", response, req) }
  } }
  const guard = createWaitingGuard(client, { firstResponseMs: 100, progressMs: 100 })
  const run = collect(guard)
  await vi.advanceTimersByTimeAsync(100)
  expect(await run.done).toMatchObject({ code: "INVALID_ARGUMENT", httpStatus: 400 })
  const controller = new AbortController()
  const stopped = collect(guard, { ...request, signal: controller.signal })
  await vi.advanceTimersByTimeAsync(1)
  controller.abort()
  expect(await stopped.done).toMatchObject({ code: "ABORTED" })
})
afterEach(() => vi.useRealTimers())
function fixture() {
  let req!: LLMRequest
  let resolve!: (value: IteratorResult<LLMStreamEvent>) => void
  let reject!: (error: Error) => void
  let nextCalls = 0, returned = 0
  const client: ModelClient = { stream(r) { req = r; return { [Symbol.asyncIterator]() { return {
    next() { nextCalls++; return new Promise<IteratorResult<LLMStreamEvent>>((a, b) => { resolve = a; reject = b }) },
    return() { returned++; return new Promise<IteratorResult<LLMStreamEvent>>(() => {}) },
  } } } } }
  return { client, get req() { return req }, get nextCalls() { return nextCalls }, get returned() { return returned }, emit: (value: LLMStreamEvent) => resolve({ done: false, value }), reject: () => reject(new Error("late")) }
}
function collect(client: ModelClient, req = request) {
  const events: LLMStreamEvent[] = []
  const done = (async () => { try { for await (const ev of client.stream(req)) events.push(ev); return undefined } catch (e) { return e } })()
  return { events, done }
}
it("times out no response, aborts physical transport, ignores late tools and never awaits parked cleanup", async () => {
  vi.useFakeTimers(); const f = fixture()
  const run = collect(createWaitingGuard(f.client, { firstResponseMs: 100, progressMs: 100 }))
  await vi.advanceTimersByTimeAsync(100)
  expect(await run.done).toMatchObject({ code: "TIMEOUT", phase: "first-response", message: "Model request timed out waiting for first response" })
  expect(f.req.signal?.aborted).toBe(true); expect(f.returned).toBe(1)
  const eventCount = run.events.length
  f.req.onStreamActivity?.("tool-arguments")
  f.emit({ type: "tool_call", call: { name: "danger", args: {} } }); await Promise.resolve()
  expect(run.events).toHaveLength(eventCount)
  expect(run.events.some(e => e.type === "tool_call")).toBe(false)
  expect(vi.getTimerCount()).toBe(0)
})
it("accepted headers begin progress deadline; usage and empty status cannot keep it alive", async () => {
  vi.useFakeTimers(); const f = fixture(); const run = collect(createWaitingGuard(f.client, { firstResponseMs: 100, progressMs: 200 }))
  await vi.advanceTimersByTimeAsync(90); f.req.onStreamActivity?.("response-start")
  await vi.advanceTimersByTimeAsync(150); f.emit({ type: "usage", usage: { inputTokens: 4 } })
  await vi.advanceTimersByTimeAsync(20); f.emit({ type: "reasoning", text: "" })
  await vi.advanceTimersByTimeAsync(30)
  expect(await run.done).toMatchObject({ code: "TIMEOUT", phase: "progress" })
})
it("partial tool arguments and reasoning extend progress, with a single pending read and bounded activity", async () => {
  vi.useFakeTimers(); const f = fixture(); const run = collect(createWaitingGuard(f.client, { firstResponseMs: 30_000, progressMs: 20_000 }))
  await vi.advanceTimersByTimeAsync(1); f.req.onStreamActivity?.("response-start")
  for (let i = 0; i < 5; i++) { await vi.advanceTimersByTimeAsync(10_000); f.req.onStreamActivity?.("tool-arguments") }
  expect(f.nextCalls).toBe(1)
  expect(run.events.filter(e => e.type === "activity")).toHaveLength(3)
  const received = run.events.filter(e => e.type === "activity")[1]
  expect(received).toMatchObject({ activity: { phase: "streaming", waitingFor: "progress" } })
  expect(received?.type === "activity" && received.activity.lastProgressAt).toBeUndefined()
  f.emit({ type: "reasoning", text: "thinking" }); await vi.advanceTimersByTimeAsync(15_000)
  expect(run.events.at(-1)).toMatchObject({ type: "activity", activity: { phase: "quiet", waitingFor: "progress", lastProgressAt: Date.now() - 15_000 } })
  f.req.onStreamActivity?.("tool-arguments"); await vi.advanceTimersByTimeAsync(1)
  expect(run.events.at(-1)).toMatchObject({ type: "activity", activity: { phase: "streaming" } })
  f.emit({ type: "end" }); expect(await run.done).toBeUndefined()
  expect(run.events.filter(e => e.type === "activity")).toHaveLength(6)
})
it("zero disables both deadlines but Stop settles parked reads and observes late rejection", async () => {
  vi.useFakeTimers(); const f = fixture(), abort = new AbortController()
  const run = collect(createWaitingGuard(f.client, { firstResponseMs: 0, progressMs: 0 }), { ...request, signal: abort.signal })
  await vi.advanceTimersByTimeAsync(500_000); expect(f.nextCalls).toBe(1)
  abort.abort(); await vi.advanceTimersByTimeAsync(0)
  expect(await run.done).toMatchObject({ code: "ABORTED" })
  expect(run.events.at(-1)).toMatchObject({ activity: { phase: "settled", outcome: "cancelled" } })
  f.reject(); await Promise.resolve(); expect(vi.getTimerCount()).toBe(0)
})
it("one retry layer gives each timeout a new attempt and exhausts exactly its budget", async () => {
  vi.useFakeTimers(); const f = fixture()
  const run = collect(createRetryingClient(createWaitingGuard(f.client, { firstResponseMs: 100, progressMs: 100 }), resolveRetryPolicy({ mode: "normal", maxRetries: 1, backoff: { initialDelayMs: 1, maxDelayMs: 1, jitterRatio: 0 } })))
  await vi.advanceTimersByTimeAsync(100)
  await realDelay(5)
  await vi.advanceTimersByTimeAsync(100)
  expect(await run.done).toMatchObject({ code: "TIMEOUT" })
  expect(f.nextCalls).toBe(2)
  const starts = run.events.filter(e => e.type === "activity" && e.activity.phase === "connecting")
  expect(starts).toHaveLength(2)
  expect(new Set(starts.map(e => e.type === "activity" && e.activity.requestId)).size).toBe(2)
})

it.each(["end", "error"] as const)("settles activity before %s consumers close the iterator", async type => {
  const base: ModelClient = { async *stream() { yield type === "end" ? { type: "end" } : { type: "error", error: Object.assign(new Error("denied"), { code: "AUTH" }) } } }
  const run = collect(createRetryingClient(createWaitingGuard(base, { firstResponseMs: 100, progressMs: 100 }), resolveRetryPolicy({ mode: "normal", maxRetries: 0 })))
  await run.done
  expect(run.events.filter(e => e.type === "activity").at(-1)).toMatchObject({ activity: { phase: "settled", outcome: type === "end" ? "completed" : "failed" } })
})

it.each(["first-response", "progress"] as const)("disables only the configured %s deadline", async disabled => {
  vi.useFakeTimers(); const f = fixture(), abort = new AbortController()
  const run = collect(createWaitingGuard(f.client, { firstResponseMs: disabled === "first-response" ? 0 : 100, progressMs: disabled === "progress" ? 0 : 100 }), { ...request, signal: abort.signal })
  await vi.advanceTimersByTimeAsync(1)
  if (disabled === "progress") f.req.onStreamActivity?.("response-start")
  await vi.advanceTimersByTimeAsync(1_000)
  expect(f.req.signal?.aborted).toBe(false)
  if (disabled === "first-response") {
    f.req.onStreamActivity?.("response-start"); await vi.advanceTimersByTimeAsync(100)
    expect(await run.done).toMatchObject({ code: "TIMEOUT", phase: "progress" })
  } else { abort.abort(); expect(await run.done).toMatchObject({ name: "AbortError", code: "ABORTED" }) }
})

it("does not open a transport for an already cancelled request", async () => {
  const f = fixture(); const run = collect(createWaitingGuard(f.client, { firstResponseMs: 100, progressMs: 100 }), { ...request, signal: AbortSignal.abort() })
  expect(await run.done).toMatchObject({ code: "ABORTED" })
  expect(f.req).toBeUndefined()
})

it("genuinely progressing reasoning survives longer than either deadline without quiet notifications", async () => {
  vi.useFakeTimers(); const f = fixture()
  const run = collect(createWaitingGuard(f.client, { firstResponseMs: 15_000, progressMs: 15_000 }))
  for (let i = 0; i < 5; i++) {
    await vi.advanceTimersByTimeAsync(10_000)
    f.emit({ type: "reasoning", text: "still thinking" })
    await vi.advanceTimersByTimeAsync(0)
  }
  expect(f.req.signal?.aborted).toBe(false)
  expect(run.events.filter(e => e.type === "activity").map(e => e.type === "activity" && e.activity.phase)).toEqual(["connecting", "streaming"])
  f.emit({ type: "end" }); expect(await run.done).toBeUndefined()
})

it("Stop wins over a terminal response hint and the next attempt cannot inherit that hint", async () => {
  vi.useFakeTimers(); const f = fixture(), abort = new AbortController()
  const guarded = createWaitingGuard(f.client, { firstResponseMs: 100, progressMs: 100 })
  const first = collect(guarded, { ...request, signal: abort.signal, onTerminalResponse: () => { throw new Error("observer") } })
  await vi.advanceTimersByTimeAsync(1)
  f.req.onTerminalResponse?.({ code: "AUTH", httpStatus: 401 })
  abort.abort()
  expect(await first.done).toMatchObject({ name: "AbortError", code: "ABORTED" })
  const second = collect(guarded)
  await vi.advanceTimersByTimeAsync(100)
  expect(await second.done).toMatchObject({ code: "TIMEOUT", phase: "first-response" })
})
