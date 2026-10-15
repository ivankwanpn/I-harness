import { expect, it } from "vitest"
import { ProjectionCounter } from "../src/index.ts"
import { createProjectionCalibration, prefixChain, projectedTokens } from "../src/checkpoint.ts"
import type { ContextBindingMetadata } from "@i-harness/core-session"
import { createOpenAIClient } from "../../llm-openai/src/index.ts"
const metadata: ContextBindingMetadata = { version: 1, modelId: "m", protocol: "test", identityCoverage: "complete", bindingConfigFingerprint: "a".repeat(64) }
function input(tail = false, prefix = "prefix", shape = "shape") {
  const counter = new ProjectionCounter()
  counter.text("system", "system")
  counter.unit(prefix, "user", () => counter.text("visibleText", prefix))
  if (tail) counter.unit("tail", "assistant", () => { counter.text("replayedReasoning", "思".repeat(40000)); counter.text("visibleText", "answer") })
  return counter.finish({ protocol: "test", modelId: "m" }, { prefix, tail }, shape)
}
it("normalizes original incident scalars without claiming original request parity and prices a synthetic replay suffix once", () => {
  const first = input(), next = input(true), source = createProjectionCalibration("synthetic-owner")
  const checkpoint = source.record(first, metadata, { inputTokens: 162, cacheReadTokens: 760448, cacheCreationTokens: 0, inputTokenSemantics: "excludes-cache", outputTokens: 587 }, 0)!
  expect(checkpoint.reportedInputTokens).toBe(760610)
  expect(checkpoint.reportedOutputTokens).toBe(587)
  const suffix = projectedTokens(next) - projectedTokens(first)
  expect(suffix).toBeGreaterThan(0)
  expect(createProjectionCalibration("synthetic-owner", checkpoint).estimate(next, metadata, 0)).toEqual({ tokens: 760610 + suffix, calibrated: true })
})
it.each(["includes-cache", "excludes-cache"] as const)("normalizes %s usage and persists one scalar prefix chain, restoring its newly projected signed tail", semantics => {
  const calibration = createProjectionCalibration("s"), first = input()
  const checkpoint = calibration.record(first, metadata, { inputTokens: semantics === "includes-cache" ? 1000 : 20, cacheReadTokens: 900, cacheCreationTokens: 80, inputTokenSemantics: semantics, outputTokens: 10 }, 0)!
  expect(checkpoint.reportedInputTokens).toBe(1000)
  expect(checkpoint.inputPrefixFingerprint).toBe(prefixChain(first))
  expect(JSON.stringify(checkpoint)).not.toMatch(/prefix"|units|思/)
  const next = input(true), restored = createProjectionCalibration("s", JSON.parse(JSON.stringify(checkpoint)))
  expect(restored.estimate(next, metadata, 0)).toEqual({ tokens: 1000 + projectedTokens(next) - projectedTokens(first), calibrated: true })
})
it("invalidates restored calibration for owner, endpoint/config, partial identity, shape, rewrite and prefix edits", () => {
  const source = createProjectionCalibration("s"), first = input()
  const checkpoint = source.record(first, metadata, { inputTokens: 1000, inputTokenSemantics: "includes-cache" }, 0)!
  for (const [owner, next, binding, revision] of [
    ["child", input(true), metadata, 0], ["s", input(true), { ...metadata, bindingConfigFingerprint: "b".repeat(64) }, 0],
    ["s", input(true), { ...metadata, identityCoverage: "partial" }, 0], ["s", input(true, "prefix", "changed"), metadata, 0],
    ["s", input(true), metadata, 1], ["s", input(true, "changed"), metadata, 0],
  ] as const) expect(createProjectionCalibration(owner, checkpoint).estimate(next, binding, revision).calibrated).toBe(false)
})
it("prices the actual assistant suffix once and retains total reported output as billing evidence", () => {
  const source = createProjectionCalibration("s"), first = input(), counter = new ProjectionCounter()
  counter.text("system", "system"); counter.unit("prefix", "user", () => counter.text("visibleText", "prefix")); counter.unit("output", "assistant", () => counter.text("visibleText", "short"))
  const next = counter.finish({ protocol: "test", modelId: "m" }, "next", "shape")
  source.record(first, metadata, { inputTokens: 100, inputTokenSemantics: "includes-cache", outputTokens: 200 }, 0)
  expect(source.estimate(next, metadata, 0)).toEqual({ tokens: 100 + projectedTokens(next) - projectedTokens(first), calibrated: true })
})

it.each([true, false])("actual Responses split generation prices replayed input once without charging omitted hidden output (native=%s)", async replay => {
  const client = createOpenAIClient({ apiKey: "controlled", model: "m" })
  const initial: Parameters<NonNullable<typeof client.prepare>>[0] = { systemPrompt: "p", tools: [], messages: [{ role: "user", content: "first" }] }
  const first = (await client.prepare!(initial)).measurement.input
  const next = (await client.prepare!({ ...initial, messages: [...initial.messages,
    { role: "assistant", content: "answer", toolCalls: [{ id: "c", name: "probe", args: { x: 1 } }], providerContinuation: { kind: "openai-responses", model: replay ? "m" : "foreign", reasoningItems: [{ type: "reasoning", summary: [{ type: "summary_text", text: "plan" }], encrypted_content: "cipher" }], outputOrder: [{ kind: "reasoning", index: 0 }, { kind: "tool", index: 0 }, { kind: "text", text: "answer" }] } },
    { role: "tool", toolCallId: "c", content: "result" }, { role: "user", content: "local tail" },
  ] })).measurement.input
  expect(next.units.filter(unit => unit.role === "assistant")).toHaveLength(replay ? 3 : 2)
  expect(next.components.opaqueContinuation.binaryBytes).toBe(replay ? 6 : 0)
  expect(next.components.replayedReasoning.heuristicTokens > 0).toBe(replay)
  const responsesMetadata = { ...metadata, protocol: "openai-responses" }
  const source = createProjectionCalibration("s")
  const checkpoint = source.record(first, responsesMetadata, { inputTokens: 100, inputTokenSemantics: "includes-cache", outputTokens: 10000 }, 0)!
  expect(checkpoint.reportedOutputTokens).toBe(10000)
  const expected = 100 + projectedTokens(next) - projectedTokens(first)
  expect(source.estimate(next, responsesMetadata, 0)).toEqual({ tokens: expected, calibrated: true })
  expect(createProjectionCalibration("s", checkpoint).estimate(next, responsesMetadata, 0)).toEqual({ tokens: expected, calibrated: true })
})
