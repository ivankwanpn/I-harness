import { confirmFixtureExecution, fixtureExecutionIdentity } from "./fixtures/execution.ts"
import { expect, it } from "vitest"
import { createSession } from "@i-harness/core-session"
import { ProjectionCounter } from "@i-harness/token-meter"
import type { PreparedModelRequest } from "@i-harness/llm-seam"
import { createOwnedBudget } from "../src/agent/budget.ts"
import { captureRequestCandidate } from "../src/agent/request-snapshot.ts"
import { createContext } from "@i-harness/core-plugin"
import { createToolRegistry } from "@i-harness/core-tools"
import { createAgentWithSummary } from './fixtures/agent.ts'
import { validationCollector } from '@i-harness/llm-seam'

it('rejects an invalid selected derivative before budget compaction or stream', async () => {
  const ctx = createContext(), session = createSession(), tools = createToolRegistry(ctx)
  const counter = new ProjectionCounter(), input = counter.finish({ protocol: 'openai-compatible', modelId: 'm' }, [], {})
  const check = validationCollector('openai-compatible'); check.issue('tool-group', 'messages', 'message-order')
  const invalid = check.finish().report
  let sends = 0, compacts = 0
  const selected: PreparedModelRequest = { validation: invalid, measurement: { projectionId: input.inputFingerprint, input, output: { capSupport: 'supported', minimumCap: 1, effectiveCap: 10, source: 'request' }, packet: { sizeKind: 'http-json-body', inlineBinaryBytes: 0, cacheMetadataBytes: 0, signatureBytes: 0 } }, withOutputCap() { return this }, async *stream() { sends++; yield { type: 'end' } } }
  const initial: PreparedModelRequest = { ...selected, measurement:{...selected.measurement,output:{...selected.measurement.output,effectiveCap:128000}}, validation: undefined, withOutputCap() { return selected } }
  const agent = createAgentWithSummary(ctx, { session, tools, systemPrompt: '', budget: { contextWindow: 10000 }, maxOutputTokens: 10, model: { async prepare() { return initial }, async *stream() { throw Error('raw') } }, compact: { contextWindow: 10000, auto: true, summarizationModel: { async *stream() { compacts++; yield { type: 'text/chunk', text: 'checkpoint' }; yield { type: 'end' } } } } })
  await expect(agent.run('preserve human steer')).rejects.toMatchObject({ code: 'INVALID_ARGUMENT', modelFailure: { reason: 'message-order' } })
  expect(sends).toBe(0); expect(compacts).toBe(0)
})

it.each(["repriced", "incomplete"] as const)("rejects the selected %s derivative and publishes its final facts", async mode => {
  const session = createSession(), model = { async *stream() { yield { type: "end" as const } } }
  const evidence = captureRequestCandidate(session, "owner", { model }, { systemPrompt: "", tools: [] }, 0)
  const budget = createOwnedBudget(session, "owner", () => evidence, "lifetime", () => ({ kind: "unclassified" }))
  const counter = new ProjectionCounter()
  counter.text("visibleText", "x")
  const input = counter.finish({ protocol: "fixture", modelId: "m" }, [], {})
  input.components.visibleText.heuristicTokens = 90
  const final = { ...input, inputFingerprint: "b".repeat(64), shapeFingerprint: "c".repeat(64), coverage: mode === "incomplete" ? "incomplete" as const : "complete" as const,
    components: { ...input.components, visibleText: { ...input.components.visibleText, heuristicTokens: 105 } } }
  const packet = { sizeKind: "http-json-body" as const, bodyBytes: 11, inlineBinaryBytes: 0, cacheMetadataBytes: 0, signatureBytes: 0 }
  const output = { capSupport: "supported" as const, effectiveCap: 10, minimumCap: 1, source: "request" as const }
  const selected: PreparedModelRequest = { measurement: { projectionId: final.inputFingerprint, input: final, output, packet }, withOutputCap() { throw new Error("must select only once") }, async *stream() { throw new Error("must not send") } }
  const prepared: PreparedModelRequest = { measurement: { projectionId: input.inputFingerprint, input, output: {...output,effectiveCap:128000}, packet }, withOutputCap: () => selected, async *stream() { throw new Error("initial must not send") } }
  // A neutral request has no attributable accepted receipt. Its initial price is 90.
  budget.assess({ ...prepared, withOutputCap: () => prepared }, evidence, 100, 10, 1)
  await budget.record(prepared.measurement, { inputTokens: 90, inputTokenSemantics: "includes-cache" }, undefined)
  const result = budget.assess(prepared, evidence, 100, 10, 1)
  expect(result.prepared).toBe(selected)
  expect(result.snapshot).toMatchObject({ admissionInputTokens: 105, estimatedInputTokens: 105, coverage: final.coverage, admission: mode === "incomplete" ? "unavailable" : "compact" })
  expect(budget.pressure()).toMatchObject(mode === 'incomplete' ? { kind: 'unavailable', reason: 'remote-input-unavailable' } : { kind: 'known', input: 105, inputBudget: 90, hardFits: false })
  if(mode==='incomplete')expect(result.snapshot).not.toHaveProperty('remainingInputBudget')
  else expect(result.snapshot.remainingInputBudget).toBe(0)
})
it("the main admission never sends a derivative that became too large", async () => {
  const ctx = createContext(), session = createSession(), tools = createToolRegistry(ctx)
  let sends = 0, selections = 0
  const observations: unknown[] = []
  const counter = new ProjectionCounter()
  counter.text("system", "s")
  const input = counter.finish({ protocol: "fixture", modelId: "m" }, [], {})
  input.components.system.heuristicTokens = 90
  const output = { capSupport: "supported" as const, effectiveCap: 10, minimumCap: 1, source: "request" as const }
  const packet = { sizeKind: "http-json-body" as const, inlineBinaryBytes: 0, cacheMetadataBytes: 0, signatureBytes: 0 }
  const selected: PreparedModelRequest = { measurement: { projectionId: "selected", input: { ...input, components: { ...input.components, system: { ...input.components.system, heuristicTokens: 105, textUtf8Bytes: 52 } } }, output, packet }, withOutputCap() { throw Error("only one selection") }, async *stream() { sends++; yield { type: "end" } } }
  const initial: PreparedModelRequest = { ...selected, measurement: { projectionId: "initial", input, output: {...output,effectiveCap:128000}, packet }, withOutputCap() { selections++; return selected } }
  const agent = createAgentWithSummary(ctx, { session, tools, systemPrompt: "s", budget: { contextWindow: 100, reserveRatio: 1 }, maxOutputTokens: 10,
    model: { async *stream() { throw Error("unprepared") }, async prepare() { return initial } }, telemetry: { close() {}, emit(event) { observations.push(event) } } })
  await expect(agent.run("literal")).rejects.toThrow(/105 input tokens/)
  expect(sends).toBe(0); expect(selections).toBe(1)
  expect(observations).toContainEqual(expect.objectContaining({ type: "provider/context", data: expect.objectContaining({ systemBytes: 52, estimatedInputTokens: 105 }) }))
})
it("accepted usage is calibrated against the selected measurement", async () => {
  const ctx = createContext(), session = createSession(), tools = createToolRegistry(ctx)
  const counter = new ProjectionCounter("projected-pricing-v2")
  counter.text("system", "s")
  const input = counter.finish({ protocol: "fixture", modelId: "m" }, [], {})
  input.components.system.heuristicTokens = 90
  const finalInput = { ...input, semanticIdentity: { ...input.semanticIdentity!, shapeId: "c".repeat(64) }, shapeFingerprint: "c".repeat(64), components: { ...input.components, system: { ...input.components.system, heuristicTokens: 105 } } }
  const output = { capSupport: "supported" as const, effectiveCap: 10, minimumCap: 1, source: "request" as const }
  const packet = { sizeKind: "http-json-body" as const, inlineBinaryBytes: 0, cacheMetadataBytes: 0, signatureBytes: 0 }
  let sends = 0, selections = 0
  const selected: PreparedModelRequest = { measurement: { projectionId: "selected", payloadIdentity: { version: 2, kind: "http-json-body", id: "f".repeat(64) }, input: finalInput, output, packet }, withOutputCap() { throw Error("only one selection") }, async *stream(control) { confirmFixtureExecution(selected, control); sends++; yield { type: "usage", usage: { inputTokens: 110, inputTokenSemantics: "includes-cache" } }; yield { type: "text/chunk", text: "done" }; yield { type: "end" } } }
  const initial: PreparedModelRequest = { ...selected, measurement: { projectionId: "initial", input, output:{...output,effectiveCap:128000}, packet }, withOutputCap() { selections++; return selected } }
  const agent = createAgentWithSummary(ctx, { session, tools, systemPrompt: "s", budget: { contextWindow: 1000, reserveRatio: 1 }, maxOutputTokens: 10,
    model: { executionIdentity: fixtureExecutionIdentity, async *stream() { throw Error("unprepared") }, async prepare() { return initial } } })
  await expect(agent.run("literal")).resolves.toMatchObject({ finalText: "done" })
  expect(sends).toBe(1); expect(selections).toBe(1)
  const usage = session.events.find(event => event.type === "context/usage")
  expect(usage).toMatchObject({ version: 2, checkpoint: { shapeId: "c".repeat(64), heuristicPrefixTokens: 105, reportedInputTokens: 110 } })
  expect(agent.contextBudget!()).toMatchObject({ kind: "ready", snapshot: { admissionInputTokens: 105 } })
})
