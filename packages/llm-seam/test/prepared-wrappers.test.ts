import { expect, it } from "vitest"
import { preparedControls } from '../src/index.ts'
it('intersects original caller cancellation with an override through prepared control composition', () => {
  const caller = new AbortController(), override = new AbortController()
  const controls = preparedControls({ signal: caller.signal }, { signal: override.signal })
  caller.abort()
  expect(controls.signal?.aborted).toBe(true)
})
it('the final retry composition and its cap derivatives expose the effective finite retry descriptor', async () => {
  const base: ModelClient = { async *stream() { yield { type: 'end' } } }
  const plain = await prepareModelRequest(base, request())
  expect((plain as unknown as { retryPolicy: unknown }).retryPolicy).toEqual({ mode: 'off', maxRetries: 0 })
  const retry = createRetryingClient(base, resolveRetryPolicy({ mode: 'normal', maxRetries: 3 }))
  const actual = await prepareModelRequest(createWaitingGuard(retry, { firstResponseMs: 1000, progressMs: 1000 }), request())
  expect((actual.withOutputCap(2000) as unknown as { retryPolicy: unknown }).retryPolicy).toEqual({ mode: 'normal', maxRetries: 3 })
})
it("cap derivatives preserve the waiting policy captured by their owner",async()=>{
  const policy={firstResponseMs:1000,progressMs:1000}
  const client=createWaitingGuard({async *stream(){yield {type:"end"}}},policy)
  const prepared=await prepareModelRequest(client,request())
  policy.firstResponseMs=-1
  const events=await collect(prepared.withOutputCap(4096).stream())
  expect(events.at(-1)).toEqual({type:"end"})
})
import { createRetryingClient, createWaitingGuard, resolveRetryPolicy, prepareModelRequest, type LLMRequest, type ModelClient, type LLMStreamEvent } from "../src/index.ts"
const request = (): LLMRequest => ({ systemPrompt: "stable", messages: [], tools: [], retryOutput: "discard" })
async function collect(stream: AsyncIterable<LLMStreamEvent>) {
  const events: LLMStreamEvent[] = []
  for await (const event of stream)
    events.push(event)
  return events
}
it("logical retries freeze the input when a failed attempt mutates the caller request", async () => {
  const original = request(), seen: string[] = []
  const physical: ModelClient = {
    async *stream(sent) {
      seen.push(sent.systemPrompt)
      if (seen.length === 1) {
        original.systemPrompt = "changed"
        yield { type: "error", error: Object.assign(new Error("busy"), { code: "SERVER" }) }
      }
      else {
        yield { type: "text/chunk", text: sent.systemPrompt }
        yield { type: "end" }
      }
    }
  }
  const retry = createRetryingClient(physical, resolveRetryPolicy({ mode: "normal", maxRetries: 1, backoff: { initialDelayMs: 1, maxDelayMs: 1, jitterRatio: 0 } }))
  const events = await collect(retry.stream(original))
  expect(seen).toEqual(["stable", "stable"])
  expect(events.find(event => event.type === "text/chunk")).toEqual({ type: "text/chunk", text: "stable" })
})
it("prepared cap derivatives retain physical waiting activity and override signal hooks", async () => {
  const controller = new AbortController(), activities: string[] = []
  const physical: ModelClient = {
    async *stream(sent) {
      expect(sent.signal).not.toBe(controller.signal)
      expect(sent.signal?.aborted).toBe(false)
      sent.onStreamActivity?.("response-start")
      yield { type: "text/chunk", text: String(sent.maxOutputTokens) }
      yield { type: "end" }
    }
  }
  const waiting = createWaitingGuard(physical, { firstResponseMs: 1000, progressMs: 1000 })
  const prepared = await prepareModelRequest(waiting, request())
  expect(prepared.measurement.input.coverage).toBe("neutral-only")
  const events = await collect(prepared.withOutputCap(4096).stream({ signal: controller.signal, onStreamActivity: kind => activities.push(kind) }))
  expect(events.filter(event => event.type === "activity").map(event => event.activity.phase)).toEqual(["connecting", "streaming", "streaming", "settled"])
  expect(activities).toEqual(["response-start"])
  expect(events.find(event => event.type === "text/chunk")).toEqual({ type: "text/chunk", text: "4096" })
})
it("custom fallback reports unknown cap support and does no transport on inspection", async () => {
  let sends = 0
  const custom: ModelClient = { async *stream() { sends++; yield { type: "end" } } }
  const prepared = await prepareModelRequest(custom, request())
  expect(prepared.measurement.input.coverage).toBe("neutral-only")
  expect(prepared.withOutputCap(10).measurement.output).toMatchObject({ capSupport: "unknown", configuredCap: 10 })
  expect(prepared.measurement.output.effectiveCap).toBeUndefined()
  expect(sends).toBe(0)
})
