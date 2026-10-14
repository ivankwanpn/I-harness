import { expect, it, vi } from "vitest"
import { append, createSession, deriveMessages } from "@i-harness/core-session"
import type { LLMRequest, ModelClient } from "@i-harness/llm-seam"
import type { Telemetry } from "@i-harness/telemetry"
import { createCompactionEngine, type CompactionConfig } from "../src/index.ts"

const text = "retained work ".repeat(60)
const config: CompactionConfig = { contextWindow: 10000, thresholdRatio: .005, retainTokens: 0, minTurnsBeforeRecompact: 0 }

it("shares the until-success breaker across engines without resetting the count on fresh content", async () => {
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
  try {
    let calls = 0, fail = true
    const model: ModelClient = { async *stream() {
      calls++
      if (fail) yield { type: "error", error: new Error("shared breaker fixture") }
      else { yield { type: "text/chunk", text }; yield { type: "end" } }
    } }
    const session = createSession()
    append(session, { type: "user/message", text: "old context ".repeat(100) })
    const first = createCompactionEngine({ model, config })
    const second = createCompactionEngine({ model, config })
    await first.maybeCompact(session)
    await second.maybeCompact(session)
    await first.maybeCompact(session)
    expect(await second.maybeCompact(session)).toEqual({ compacted: false, shadowedSeqs: [] })
    expect(calls).toBe(3)
    append(session, { type: "user/message", text: "new content" })
    await second.maybeCompact(session)
    await first.maybeCompact(session)
    expect(calls).toBe(4)
    fail = false
    expect((await first.compact(session)).compacted).toBe(true)
    fail = true
    append(session, { type: "user/message", text: "after manual success" })
    await second.maybeCompact(session)
    await first.maybeCompact(session)
    expect(calls).toBe(7) // manual success resets the shared count, so both auto failures run
    expect(warn).toHaveBeenCalledTimes(6)
    expect(warn).toHaveBeenLastCalledWith("[i-harness] compaction summarizer failed (fail-soft, retrying next step): Summary request failed.")
  } finally { warn.mockRestore() }
})

it("shares prune-only sticky state across engines even without an end marker", async () => {
  let calls = 0
  const model: ModelClient = { async *stream() { calls++; yield { type: "text/chunk", text }; yield { type: "end" } } }
  const session = createSession()
  append(session, { type: "tool/call", callId: "c", name: "read", args: {} })
  append(session, { type: "tool/result", callId: "c", name: "read", output: "x".repeat(100_000) })
  let overheadReads = 0
  const options = { model, config: { contextWindow: 20_000, thresholdRatio: .5 }, overheadTokens: () => ++overheadReads >= 3 ? 10_000 : 0 }
  const first = createCompactionEngine(options), second = createCompactionEngine(options)
  expect(await first.maybeCompact(session)).toEqual({ compacted: true, shadowedSeqs: [], pruned: true })
  expect(session.events.at(-1)?.type).toBe("compaction/prune")
  const count = session.events.length
  expect(await second.maybeCompact(session)).toEqual({ compacted: false, shadowedSeqs: [] })
  expect(session.events).toHaveLength(count)
  expect(calls).toBe(0)
  append(session, { type: "user/message", text: "fresh content" })
  expect((await second.maybeCompact(session)).compacted).toBe(true)
  expect(session.events.filter(event => event.type === "compaction/prune")).toHaveLength(1)
  expect(calls).toBe(1)
})

it("captures config and method receivers but refuses an owned model change across the held summary await", async () => {
  const trace: string[] = []
  const session = createSession(event => { if (event.type.startsWith("compaction/")) trace.push(event.type) })
  append(session, { type: "tool/call", callId: "c", name: "read", args: {} })
  append(session, { type: "tool/result", callId: "c", name: "read", output: "x".repeat(12_000) })
  let release!: () => void
  const pending = new Promise<void>(resolve => { release = resolve })
  let markEntered!: () => void
  const entered = new Promise<void>(resolve => { markEntered = resolve })
  let request: LLMRequest | undefined
  const model: ModelClient = { async *stream(input) {
    expect(this).toBe(model)
    request = input
    trace.push("model:stream")
    expect(input.messages.slice(0, -1)).toEqual(deriveMessages(session))
    markEntered()
    await pending
    yield { type: "text/chunk", text }
    yield { type: "usage", usage: { outputTokens: 12 } }
    yield { type: "end" }
  } }
  let liveModel = model, overhead = 0, cap = 2048
  const earlier: Telemetry = { emit(event) { trace.push(event.type) }, close() {} }
  const later: Telemetry = { emit(event) { expect(this).toBe(later); trace.push(event.type) }, close() {} }
  let liveTelemetry = earlier
  const deps = {
    config: { contextWindow: 100_000, thresholdRatio: .01, maxTokens: 256 },
    get model() { trace.push("model:get"); return liveModel },
    get contextTokens() { trace.push("context:get"); return function(this: unknown) { expect(this).toBe(deps); trace.push("context:call"); return 100_000 } },
    get requestShape() { trace.push("shape:get"); return function(this: unknown) { expect(this).toBe(deps); trace.push("shape:call"); return { systemPrompt: "system", tools: [] } } },
    get maxOutputTokens() { trace.push("cap:get"); return cap },
    get overheadTokens() { trace.push("overhead:get"); return function(this: unknown) { expect(this).toBe(deps); trace.push("overhead:call"); return overhead } },
    get telemetry() { trace.push("telemetry:get"); return liveTelemetry },
  }
  const engine = createCompactionEngine(deps)
  expect(trace).toEqual([])
  deps.config = { contextWindow: 1, thresholdRatio: .5, maxTokens: 1 }
  const pass = engine.maybeCompact(session)
  try {
  await Promise.race([entered, pass.then(() => { throw new Error("pass ended before model entry") })])
  expect(trace).toEqual(["context:get", "context:call", "overhead:get", "overhead:call", "compaction/prune", "model:get", "shape:get", "shape:call", "cap:get", "cap:get", "model:get", "shape:get", "shape:call", "cap:get", "model:get", "shape:get", "shape:call", "cap:get", "telemetry:get", "provider/context", "model:get", "shape:get", "shape:call", "cap:get", "model:get", "shape:get", "shape:call", "cap:get", "model:stream"])
  expect(request?.maxOutputTokens).toBe(2048)
  expect(request?.systemPrompt).toBe("system")
  liveModel = { async *stream() { throw new Error("model re-read across await") } }
  liveTelemetry = later
  overhead = 100_000
  cap = 1
  release()
  await expect(pass).rejects.toMatchObject({ code: "CONTEXT_INPUT_STALE" })
  expect(trace.slice(29)).toEqual(["telemetry:get", "compaction/usage", "model:get"])
  expect(session.events.filter(event => event.type.startsWith("compaction/")).map(event => event.type)).toEqual(["compaction/prune"])
  expect(session.events.find(event => event.type === "tool/result")).toMatchObject({ output: "x".repeat(12_000) })
  } finally { release(); await pass.catch(() => undefined) }
})

it("keeps shape failures outside the summary catch and does not charge legacy overhead to summary input", async () => {
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
  try {
    const model: ModelClient = { async *stream() { throw new Error("must not call model") } }
    const session = createSession()
    append(session, { type: "user/message", text: "context" })
    const outside = createCompactionEngine({ model, config, requestShape() { throw new Error("shape fixture") } })
    await expect(outside.compact(session)).rejects.toThrow("shape fixture")
    expect(warn).not.toHaveBeenCalled()
    const inside = createCompactionEngine({ model, config, overheadTokens() { throw new Error("overhead fixture") } })
    expect(await inside.compact(session)).toEqual({ compacted: false, shadowedSeqs: [], reason: "summarizer-failed" })
    expect(warn).toHaveBeenCalledExactlyOnceWith("[i-harness] compaction summarizer failed (fail-soft, retrying next step): Summary request failed.")
    expect(session.events).toHaveLength(1)
  } finally { warn.mockRestore() }
})

it("resolves config before context-window lookup and retains their captured values", async () => {
  const trace: string[] = []
  const captured: CompactionConfig = { contextWindow: 100_000, thresholdRatio: .5 }
  const deps = {
    get config() { trace.push("config"); return captured },
    get provider() { trace.push("provider"); return undefined },
    get modelId() { trace.push("modelId"); return undefined },
    get profile() { trace.push("profile"); return undefined },
    get model(): ModelClient { throw new Error("below pressure must not read model") },
    get contextTokens() { trace.push("contextTokens"); return undefined },
    get overheadTokens() { trace.push("overheadTokens"); return function(this: unknown) { expect(this).toBe(deps); trace.push("overhead call"); return 0 } },
  }
  const engine = createCompactionEngine(deps)
  expect(trace).toEqual(["config", "provider", "modelId", "profile", "modelId"])
  captured.contextWindow = 1
  const session = createSession()
  append(session, { type: "user/message", text: "context" })
  expect(await engine.maybeCompact(session)).toEqual({ compacted: false, shadowedSeqs: [] })
  expect(trace.slice(5)).toEqual(["contextTokens", "overheadTokens", "overhead call"])
})
