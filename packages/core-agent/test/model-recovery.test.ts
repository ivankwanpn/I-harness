import { expect, it } from "vitest"
import { createContext } from "@i-harness/core-plugin"
import { createSession, deriveMessages, deriveSearchText, subscribe, toJSONL, fromJSONL } from "@i-harness/core-session"
import { createToolRegistry } from "@i-harness/core-tools"
import { createWaitingGuard, createRetryingClient, resolveRetryPolicy, type LLMRequest, type ModelClient } from "@i-harness/llm-seam"
import { createAgent } from "../src/index.ts"
import type { TelemetryEvent } from "@i-harness/telemetry"

it("timeout recovery discards pending tool effects without repeating accepted steps", async () => {
  const ctx = createContext(), session = createSession(), tools = createToolRegistry(ctx), effects: string[] = []
  tools.register({ name: "write", description: "in-memory", inputSchema: {}, execute: async ({ value }: { value: string }) => { effects.push(value); return value } })
  let attempt = 0
  const base: ModelClient = { async *stream() {
    const n = ++attempt
    if (n < 4) yield { type: "tool_call", call: { id: `call-${n}`, name: "write", args: { value: n === 2 ? "discard" : `accepted-${n}` } } }
    if (n === 2) { await new Promise(() => {}) }
    else { if (n === 4) yield { type: "text/chunk", text: "done" }; yield { type: "end" } }
  } }
  const model = createRetryingClient(createWaitingGuard(base, { firstResponseMs: 50, progressMs: 10 }), resolveRetryPolicy({ mode: "normal", maxRetries: 1, backoff: { initialDelayMs: 1 } }))
  const result = await createAgent(ctx, { session, tools, model, systemPrompt: "" }).run("start")
  expect(result.finalText).toBe("done")
  expect(effects).toEqual(["accepted-1", "accepted-3"])
  expect(attempt).toBe(4)
  expect(session.events.filter(e => e.type === "step/failed")).toHaveLength(1)
  expect(JSON.stringify(deriveMessages(session))).not.toContain("discard")
})

it("discards only the failed attempt, preserves audit and earlier effects, and retries the safe history", async () => {
  const ctx = createContext(), session = createSession(), tools = createToolRegistry(ctx)
  const effects: string[] = [], requests: LLMRequest[] = [], emitted: TelemetryEvent[] = []
  tools.register({ name: "write", description: "in-memory effect", inputSchema: { type: "object", properties: { value: { type: "string" } } }, execute: async ({ value }: { value: string }) => { effects.push(value); return value } })
  const base: ModelClient = { async *stream(request) {
    requests.push(structuredClone({ ...request, signal: undefined }))
    if (requests.length === 1) { yield { type: "tool_call", call: { id: "earlier", name: "write", args: { value: "earlier" } } }; yield { type: "end" }; return }
    if (requests.length === 2) {
      yield { type: "text/chunk", text: "discard me" }; yield { type: "reasoning", text: "discard thought" }
      yield { type: "tool_call", call: { id: "failed", name: "write", args: { value: "failed" } } }
      yield { type: "usage", usage: { inputTokens: 100 } }
      throw Object.assign(new Error("connection reset"), { code: "ECONNRESET" })
    }
    if (requests.length === 3) { yield { type: "tool_call", call: { id: "success", name: "write", args: { value: "success" } } }; yield { type: "usage", usage: { inputTokens: 7 } }; yield { type: "end" }; return }
    yield { type: "text/chunk", text: "done" }; yield { type: "end" }
  } }
  const model = createRetryingClient(base, resolveRetryPolicy({ mode: "normal", maxRetries: 1, backoff: { initialDelayMs: 1 } }))
  const result = await createAgent(ctx, { session, tools, model, systemPrompt: "", telemetry: { emit: event => { emitted.push(event) }, close() {} } }).run("start")
  expect(result.finalText).toBe("done"); expect(result.reasoning).toEqual([])
  expect(effects).toEqual(["earlier", "success"])
  expect(requests[1]!.retryOutput).toBe("discard"); expect(requests[2]!.messages).toEqual(requests[1]!.messages)
  expect(JSON.stringify(deriveMessages(session))).not.toContain("discard")
  expect(JSON.stringify(deriveMessages(session))).not.toContain('"failed"')
  expect(session.events.some(event => event.type === "assistant/message" && event.text === "discard me")).toBe(true)
  expect(session.events.some(event => event.type === "tool/call" && event.callId === "failed")).toBe(true)
  expect(session.events.filter(event => event.type === "step/failed")).toHaveLength(1)
  const retries = session.events.filter(event => event.type === "model/retry")
  expect(retries.map(event => event.retry.phase)).toEqual(["waiting", "attempting", "recovered"])
  expect(retries.map(deriveSearchText)).toEqual(["", "", ""])
  expect(fromJSONL(toJSONL(session)).events.filter(event => event.type === "model/retry")).toEqual(retries)
  expect(emitted.filter(event => event.type === "provider/usage").map(event => event.data)).toEqual([{ inputTokens: 7 }])
})

it("retains fail-closed duplicate call IDs even across discarded attempts", async () => {
  const ctx = createContext(), session = createSession(), tools = createToolRegistry(ctx)
  let calls = 0, effects = 0
  tools.register({ name: "write", description: "effect", inputSchema: {}, execute: async () => { effects++; return "done" } })
  const base: ModelClient = { async *stream() { calls++; yield { type: "tool_call", call: { id: "duplicate", name: "write", args: {} } }; if (calls === 1) throw Object.assign(new Error("503"), { code: "SERVER" }); yield { type: "end" } } }
  const model = createRetryingClient(base, resolveRetryPolicy({ mode: "normal", maxRetries: 1, backoff: { initialDelayMs: 1 } }))
  await expect(createAgent(ctx, { session, tools, model, systemPrompt: "" }).run("start")).rejects.toThrow("duplicate provider tool call id")
  expect(effects).toBe(0); expect(calls).toBe(2)
  expect(deriveMessages(session)).toEqual([{ role: "user", content: "start" }])
})

it.each(["cancel", "exhaust"] as const)("closes %s recovery without a successful assistant or dispatched tool", async mode => {
  const ctx = createContext(), session = createSession(), tools = createToolRegistry(ctx), controller = new AbortController()
  let calls = 0
  if (mode === "cancel") subscribe(session, event => { if (event.type === "model/retry" && event.retry.phase === "waiting") controller.abort() })
  const base: ModelClient = { async *stream() { calls++; yield { type: "text/chunk", text: "uncommitted" }; throw Object.assign(new Error("503"), { code: "SERVER" }) } }
  const model = createRetryingClient(base, resolveRetryPolicy({ mode: "normal", maxRetries: 1, backoff: { initialDelayMs: 1 } }))
  await expect(createAgent(ctx, { session, tools, model, systemPrompt: "" }).run("start", controller.signal)).rejects.toThrow()
  expect(calls).toBe(mode === "cancel" ? 1 : 2)
  expect(session.events.at(-1)?.type).toBe("turn/end")
  expect(session.events.filter(event => event.type === "tool/dispatch")).toHaveLength(0)
  expect(session.events.filter(event => event.type === "model/retry").map(event => event.retry.phase)).toEqual(mode === "cancel" ? ["waiting"] : ["waiting", "attempting", "recovered"])
  expect(deriveMessages(session)).toEqual([{ role: "user", content: "start" }])
})

it.each(["zero-retries", "exhaustion", "cancel-first", "cancel-retry"] as const)("journals terminal partial text for %s without model replay or tool side effects", async mode => {
  const ctx = createContext(), session = createSession(), tools = createToolRegistry(ctx), controller = new AbortController()
  let calls = 0, effects = 0
  tools.register({ name: "write", description: "in-memory effect", inputSchema: {}, execute: async () => { effects++; return "done" } })
  const expectedCalls = mode === "exhaustion" || mode === "cancel-retry" ? 2 : 1
  const base: ModelClient = { async *stream() {
    calls++
    yield { type: "text/chunk", text: `partial-${calls}` }
    yield { type: "reasoning", text: `thought-${calls}` }
    yield { type: "tool_call", call: { id: `uncommitted-${calls}`, name: "write", args: {} } }
    if ((mode === "cancel-first" || mode === "cancel-retry") && calls === expectedCalls) controller.abort()
    throw Object.assign(new Error("fixture failure"), { code: "SERVER" })
  } }
  const model = createRetryingClient(base, resolveRetryPolicy({ mode: "normal", maxRetries: mode === "zero-retries" ? 0 : 1, backoff: { initialDelayMs: 1 } }))
  await expect(createAgent(ctx, { session, tools, model, systemPrompt: "" }).run("start", controller.signal)).rejects.toThrow()
  expect(calls).toBe(expectedCalls)
  expect(session.events.filter(event => event.type === "assistant/message").map(event => event.text)).toEqual(expectedCalls === 1 ? ["partial-1"] : ["partial-1", "partial-2"])
  expect(session.events.filter(event => event.type === "step/failed")).toHaveLength(expectedCalls)
  expect(session.events.filter(event => event.type === "tool/call")).toHaveLength(expectedCalls)
  expect(effects).toBe(0)
  expect(session.events.some(event => event.type === "tool/dispatch" || event.type === "tool/result")).toBe(false)
  expect(deriveMessages(session)).toEqual([{ role: "user", content: "start" }])
  expect(session.events.at(-1)?.type).toBe("turn/end")
})
