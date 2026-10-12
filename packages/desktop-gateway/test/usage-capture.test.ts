import { describe, expect, it } from "vitest"
import type { LLMRequest, ModelClient } from "@i-harness/llm-seam"
import type { UsageRecord } from "../../usage-stats/src/types.ts"
import { createUsageCapture } from "../src/usage-capture.ts"

const request: LLMRequest = { messages: [{ role: "user", content: "private prompt" }], systemPrompt: "private system", tools: [] }
const profile = { name: "route-a", displayName: "Route", protocol: "openai-responses" as const, apiKey: "secret-key" }
function fixture() {
  const records: UsageRecord[] = []
  let now = 1000
  const capture = createUsageCapture({ workspace: "D:/workspace", record: async value => { records.push(value) }, now: () => now })
  return { records, capture, tick: (value: number) => { now = value } }
}
async function consume(client: ModelClient, input = request) { for await (const _event of client.stream(input)) { /* consume */ } }

describe("usage capture", () => {
  it("records one request with last-known counters and no request, response, credentials or error content", async () => {
    const f = fixture()
    const client = f.capture.buildClient(() => ({ async *stream() {
      yield { type: "usage", usage: { inputTokens: 100, outputTokens: 1, cacheReadTokens: 80, inputTokenSemantics: "includes-cache" } }
      f.tick(1020)
      yield { type: "text/chunk", text: "private response" }
      yield { type: "usage", usage: { inputTokens: 100, outputTokens: 20 } }
      f.tick(1060)
      yield { type: "end" }
    } }))(profile, "model-a")
    await consume(f.capture.bind(client, "session-a"))
    expect(f.records).toEqual([{ id: expect.any(String), workspace: "D:/workspace", sessionId: "session-a", providerId: "route-a", modelId: "model-a", billing: "api", status: "completed", startedAt: 1000, durationMs: 60, firstTokenMs: 20, inputTokens: 100, outputTokens: 20, cacheReadTokens: 80, cacheCreationTokens: 0, inputTokenSemantics: "includes-cache" }])
    expect(JSON.stringify(f.records)).not.toMatch(/private|secret/)
  })

  it("records every retry attempt separately without merging failed usage into the completed attempt", async () => {
    const f = fixture()
    let attempts = 0
    const client = f.capture.buildClient(() => ({ async *stream() {
      if (++attempts === 1) {
        yield { type: "usage", usage: { inputTokens: 7 } }
        yield { type: "text/chunk", text: "uncommitted response" }
        yield { type: "error", error: Object.assign(new Error("private error"), { code: "SERVER" }) }
      } else { yield { type: "usage", usage: { inputTokens: 10, outputTokens: 2 } }; yield { type: "text/chunk", text: "ok" }; yield { type: "end" } }
    } }))({ ...profile, retryPolicy: { mode: "normal", maxRetries: 1, backoff: { initialDelayMs: 1, maxDelayMs: 1, jitterRatio: 0 } } }, "model-a")
    const retries = []
    for await (const event of client.stream({ ...request, retryOutput: "discard" })) if (event.type === "retry") retries.push(event.retry)
    expect(retries.map(event => [event.phase, event.providerId, event.modelId])).toEqual([["waiting", "route-a", "model-a"], ["attempting", "route-a", "model-a"], ["recovered", "route-a", "model-a"]])
    expect(f.records.map(row => [row.status, row.inputTokens, row.outputTokens])).toEqual([["failed", 7, undefined], ["completed", 10, 2]])
    expect(new Set(f.records.map(row => row.id)).size).toBe(2)
  })

  it("retains partial usage when aborted and preserves the original thrown error", async () => {
    const f = fixture()
    const abort = new AbortController()
    const failure = new Error("private failure")
    const client = f.capture.buildClient(() => ({ async *stream() {
      yield { type: "usage", usage: { outputTokens: 4 } }
      abort.abort()
      throw failure
    } }))(profile, "model-a")
    await expect(consume(client, { ...request, signal: abort.signal })).rejects.toBe(failure)
    expect(f.records).toMatchObject([{ status: "cancelled", outputTokens: 4 }])
    expect(f.records[0]).not.toHaveProperty("inputTokens")
    expect(f.records[0]).not.toHaveProperty("firstTokenMs")
  })

  it("records an early consumer stop as cancellation and does not record an already-aborted request", async () => {
    const f = fixture()
    const client = f.capture.buildClient(() => ({ async *stream() { yield { type: "text/chunk", text: "ok" }; yield { type: "end" } } }))(profile, "model-a")
    for await (const _event of client.stream(request)) break
    expect(f.records).toMatchObject([{ status: "cancelled" }])
    await expect(consume(client, { ...request, signal: AbortSignal.abort() })).rejects.toThrow()
    expect(f.records).toHaveLength(1)
  })

  it("keeps child identity over the inherited binding and records subscription provenance without pricing assumptions", async () => {
    const f = fixture()
    const client = f.capture.buildClient(() => ({ async *stream() { yield { type: "end" } } }))({ ...profile, codexSubscription: true }, "model-a")
    await consume(f.capture.bind(client, "parent"), { ...request, sessionId: "child" })
    expect(f.records).toMatchObject([{ sessionId: "child", billing: "subscription" }])
  })

  it("keeps successful inference successful when persistence fails, exposing a content-free warning", async () => {
    const capture = createUsageCapture({ workspace: "workspace", record: async () => { throw new Error("secret storage path") } })
    const client = capture.buildClient(() => ({ async *stream() { yield { type: "end" } } }))(profile, "model-a")
    await expect(consume(client)).resolves.toBeUndefined()
    expect(capture.warnings()).toEqual(["Usage recording failed for 1 request(s); statistics may be incomplete."])
  })

  it("snapshots project ownership before the request and strips internal identity at the adapter boundary", async () => {
    const records: UsageRecord[] = []
    let projectId = "project-a"
    const requestScope = Object.freeze({ sessionId: "child", turnId: "turn" })
    const onStreamActivity = () => {}
    const onTerminalResponse = () => {}
    const capture = createUsageCapture({ workspace: "workspace", projectFor: async id => id === "child" ? projectId : undefined, record: async value => { records.push(value) } })
    const client = capture.buildClient(() => ({ async *stream(input) {
      expect(input).not.toHaveProperty("sessionId")
      expect(input.requestScope).toBe(requestScope)
      expect(input.onStreamActivity).toBe(onStreamActivity)
      expect(input.onTerminalResponse).toBe(onTerminalResponse)
      projectId = "project-b"
      yield { type: "end" }
    } }))(profile, "model-a")
    await consume(client, { ...request, sessionId: "child", requestScope, onStreamActivity, onTerminalResponse })
    expect(records).toMatchObject([{ projectId: "project-a", sessionId: "child" }])
    expect(records[0]).not.toHaveProperty("requestScope")
  })

  it("keeps inference available and attribution visibly incomplete when project lookup fails", async () => {
    const records: UsageRecord[] = []
    const capture = createUsageCapture({ workspace: "workspace", projectFor: async () => { throw new Error("private binding") }, record: async value => { records.push(value) } })
    const client = capture.buildClient(() => ({ async *stream() { yield { type: "end" } } }))(profile, "model-a")
    await consume(client, { ...request, sessionId: "child" })
    expect(records).toMatchObject([{ status: "completed" }])
    expect(records[0]).not.toHaveProperty("projectId")
    expect(capture.warnings()).toEqual(["Project attribution failed for 1 request(s); project statistics may be incomplete."])
  })

  it("notifies the owning host of storage failures without exposing errors or affecting inference", async () => {
    const notifications: string[][] = []
    const capture = createUsageCapture({ workspace: "workspace", record: async () => { throw new Error("private disk error") }, onWarning: warnings => { notifications.push(warnings); throw new Error("notification sink unavailable") } })
    const client = capture.buildClient(() => ({ async *stream() { yield { type: "end" } } }))(profile, "model-a")
    await expect(consume(client)).resolves.toBeUndefined()
    expect(notifications).toEqual([["Usage recording failed for 1 request(s); statistics may be incomplete."]])
  })

  it("preserves request history when merged provider counters are contradictory", async () => {
    const f = fixture()
    const client = f.capture.buildClient(() => ({ async *stream() {
      yield { type: "usage", usage: { inputTokens: 100, cacheReadTokens: 80, inputTokenSemantics: "includes-cache" } }
      yield { type: "usage", usage: { inputTokens: 50, outputTokens: 10 } }
      yield { type: "end" }
    } }))(profile, "model-a")
    await consume(client)
    expect(f.records).toMatchObject([{ status: "completed", modelId: "model-a" }])
    expect(f.records[0]).not.toHaveProperty("inputTokens")
    expect(f.records[0]).not.toHaveProperty("cacheReadTokens")
    expect(f.capture.warnings()).toEqual(["Invalid provider usage was omitted for 1 request(s); token statistics may be incomplete."])
  })
})

it("guard timeout records one failed attempt inside recovery, discards its usage and retains cancellation status", async () => {
 const { createWaitingGuard } = await import("@i-harness/llm-seam")
 const f = fixture(); let attempts = 0
 const base: ModelClient = { async *stream() { attempts++; yield { type: "usage", usage: { inputTokens: attempts } }; if (attempts === 1) { await new Promise(() => {}) } else { yield { type: "text/chunk", text: "ok" }; yield { type: "end" } } } }
 const client = f.capture.buildClient(() => createWaitingGuard(base, { firstResponseMs: 5, progressMs: 5 }))({ ...profile, retryPolicy: { mode: "normal", maxRetries: 1, backoff: { initialDelayMs: 1 } } })
 const visible: unknown[] = []
 for await (const e of client.stream(request)) if (e.type === "usage") visible.push(e.usage)
 expect(attempts).toBe(2)
 expect(f.records.map(r => [r.status, r.inputTokens])).toEqual([["failed", 1], ["completed", 2]])
 expect(visible).toEqual([{ inputTokens: 2 }])
 const controller = new AbortController()
 const cancelled = f.capture.buildClient(() => createWaitingGuard({ async *stream() { controller.abort(); await new Promise(() => {}) } }, { firstResponseMs: 0, progressMs: 0 }))(profile)
 await expect(consume(cancelled, { ...request, signal: controller.signal })).rejects.toThrow()
 expect(f.records.at(-1)?.status).toBe("cancelled")
})
