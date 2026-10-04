import { expect, it } from "vitest"
import { createContext } from "@i-harness/core-plugin"
import { append, createSession } from "@i-harness/core-session"
import { createToolRegistry } from "@i-harness/core-tools"
import type { LLMRequest, ModelClient } from "@i-harness/llm-seam"
import { createAgent } from "../src/index.ts"
import type { TelemetryEvent } from "@i-harness/telemetry"

it("enforces the next step budget using completed cache-inclusive usage instead of a short-text guess", async () => {
  const ctx = createContext(), session = createSession(), tools = createToolRegistry(ctx)
  tools.register({ name: "probe", description: "probe", isReadOnly: true, inputSchema: { type: "object" }, async execute() { return "observed" } })
  const requests: LLMRequest[] = []
  const model: ModelClient = { async *stream(request) {
    requests.push(request)
    if (requests.length === 1) {
      yield { type: "usage", usage: { inputTokens: 899, cacheReadTokens: 850, inputTokenSemantics: "includes-cache" } } as never
      yield { type: "tool_call", call: { name: "probe", args: {} } }
    } else yield { type: "text/chunk", text: "done" }
    yield { type: "end" }
  } }
  const agent = createAgent(ctx, { session, tools, model, systemPrompt: "p", budget: { contextWindow: 1000, resetWindow: false }, maxTurns: 2 })
  await expect(agent.run("檢查")).rejects.toThrow(/prompt_too_long/)
  expect(requests).toHaveLength(1)
})

it("clears a previous usage anchor when the model binding context is updated", async () => {
  const ctx = createContext(), session = createSession(), tools = createToolRegistry(ctx)
  let calls = 0
  const model: ModelClient = { async *stream() {
    calls++
    if (calls === 1) yield { type: "usage", usage: { inputTokens: 899, inputTokenSemantics: "includes-cache" } } as never
    yield { type: "text/chunk", text: "done" }; yield { type: "end" }
  } }
  const agent = createAgent(ctx, { session, tools, model, systemPrompt: "p", budget: { contextWindow: 1000, resetWindow: false } })
  await agent.run("first")
  agent.updateContext!({ budget: { contextWindow: 1000, resetWindow: false } })
  await agent.followup!("new model")
  expect(calls).toBe(2)
})

it("reports component bytes and a measured cache ratio separately from raw provider counters", async () => {
  const ctx = createContext(), session = createSession(), tools = createToolRegistry(ctx), events: TelemetryEvent[] = []
  const model: ModelClient = { async *stream() {
    yield { type: "usage", usage: { inputTokens: 20, cacheReadTokens: 900, cacheCreationTokens: 80, inputTokenSemantics: "excludes-cache" } } as never
    yield { type: "text/chunk", text: "done" }; yield { type: "end" }
  } }
  await createAgent(ctx, { session, tools, model, systemPrompt: "中文", telemetry: { emit: event => { events.push(event) }, close() {} } }).run("inspect")
  expect(events.find(event => event.type as string === "provider/context")?.data).toMatchObject({ systemBytes: 6, schemaBytes: 2, estimateSource: "estimate" })
  expect(events.find(event => event.type as string === "provider/cache")?.data).toEqual({ cacheReadReported: true, totalInputTokens: 1000, cacheReadTokens: 900, cacheReadRatio: .9 })
  expect(events.find(event => event.type === "provider/usage")?.data).toMatchObject({ inputTokens: 20, cacheReadTokens: 900, cacheCreationTokens: 80 })
})

it("leaves cache measurements absent when the provider only reports ordinary input", async () => {
  const ctx = createContext(), session = createSession(), tools = createToolRegistry(ctx), events: TelemetryEvent[] = []
  const model: ModelClient = { async *stream() {
    yield { type: "usage", usage: { inputTokens: 100, inputTokenSemantics: "includes-cache" } } as never
    yield { type: "text/chunk", text: "done" }; yield { type: "end" }
  } }
  await createAgent(ctx, { session, tools, model, systemPrompt: "p", telemetry: { emit: event => { events.push(event) }, close() {} } }).run("inspect")
  expect(events.find(event => event.type as string === "provider/cache")?.data).toEqual({ cacheReadReported: false, totalInputTokens: 100 })
})

it("invalidates the usage anchor after an append-only reset even if the input prefix still matches", async () => {
  const ctx = createContext(), session = createSession(), tools = createToolRegistry(ctx)
  let calls = 0
  const model: ModelClient = { async *stream() {
    calls++
    if (calls === 1) yield { type: "usage", usage: { inputTokens: 899, inputTokenSemantics: "includes-cache" } } as never
    yield { type: "text/chunk", text: "done" }; yield { type: "end" }
  } }
  const agent = createAgent(ctx, { session, tools, model, systemPrompt: "p", budget: { contextWindow: 1000, resetWindow: false } })
  await agent.run("first")
  append(session, { type: "compaction/reset", removedSeqs: [] })
  await agent.followup("continue")
  expect(calls).toBe(2)
})

it("starts auto compaction from calibrated usage and returns to a fresh estimate after summary", async () => {
  const ctx = createContext(), session = createSession(), tools = createToolRegistry(ctx), requests: LLMRequest[] = [], events: TelemetryEvent[] = []
  const model: ModelClient = { async *stream(request) {
    requests.push(request)
    if (requests.length === 1) {
      yield { type: "usage", usage: { inputTokens: 850, inputTokenSemantics: "includes-cache" } } as never
      yield { type: "text/chunk", text: "done" }
    } else if (requests.length === 2) {
      yield { type: "usage", usage: { inputTokens: 23, outputTokens: 7, inputTokenSemantics: "includes-cache" } }
      yield { type: "text/chunk", text: "Summary retains the current objective and the completed work." }
    }
    else yield { type: "text/chunk", text: "continued" }
    yield { type: "end" }
  } }
  const agent = createAgent(ctx, { session, tools, model, systemPrompt: "p", telemetry: { emit: event => { events.push(event) }, close() {} }, compact: { contextWindow: 1000, thresholdRatio: .8, retainTokens: 0, minSummaryChars: 1, prune: false, minTurnsBeforeRecompact: 0 } })
  await agent.run("first")
  await agent.followup("continue")
  expect(session.events.some(event => event.type === "compaction/summary")).toBe(true)
  expect(requests).toHaveLength(3)
  expect(events.filter(event => event.type === "compaction/usage").map(event => event.data)).toEqual([{ inputTokens: 23, outputTokens: 7, inputTokenSemantics: "includes-cache" }])
  expect(events.filter(event => event.type === "provider/usage")).toHaveLength(1)
})
