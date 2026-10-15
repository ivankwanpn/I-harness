import { createHash } from "node:crypto"
import { expect, it } from "vitest"
import { ProjectionCounter, projectionFingerprint, semanticProjectionDigest } from "../src/index.ts"
import { createProjectionCalibration } from "../src/checkpoint.ts"
import { createAnthropicClient } from "../../llm-anthropic/src/index.ts"

it("versions semantic pricing, canonically binds options, and rotates legacy compatibility", () => {
  const describe = (options: unknown) => {
    const counter = new ProjectionCounter("projected-pricing-v2")
    counter.unit({ role: "user", content: "中" }, "user", () => counter.text("visibleText", "中"))
    return counter.finish({ protocol: "fixture", modelId: "m" }, { messages: ["中"] }, options)
  }
  const a = describe({ b: 2, a: 1 }), b = describe({ a: 1, b: 2 }), changed = describe({ a: 1, b: 3 })
  expect(a.semanticIdentity).toMatchObject({ version: 2, schema: "projected-input-v2", pricingVersion: "projected-pricing-v2", bindingId: expect.stringMatching(/^[a-f0-9]{64}$/) })
  expect(a.semanticIdentity).toEqual(b.semanticIdentity)
  expect(changed.semanticIdentity?.semanticId).not.toBe(a.semanticIdentity?.semanticId)
  expect(a.units[0]).toMatchObject({ heuristicTokens: 19, semanticId: expect.stringMatching(/^[a-f0-9]{64}$/) })
  expect(a.shapeFingerprint).toBe(projectionFingerprint(["projection-compat-v2", a.semanticIdentity!.shapeId, "projected-pricing-v2"]))
  expect(a.shapeFingerprint).not.toBe(projectionFingerprint({ b: 2, a: 1 }))
  // Ordinary public v1 hashing stays source-order JSON, including Unicode.
  expect(projectionFingerprint({ x: "中" })).toBe(createHash("sha256").update('{"x":"中"}').digest("hex"))
})
it("separates hash domains even for the same literal data", () => {
  const expected = createHash("sha256").update('i-harness:projection:v2:unit\0["string","same"]').digest("hex")
  expect(semanticProjectionDigest("unit", "same")).toBe(expected)
  for (const domain of ["binding", "shape", "input", "prefix-seed", "prefix-link"] as const) expect(semanticProjectionDigest(domain, "same")).not.toBe(expected)
})
it("rejects restored v1 prices and reasoning changes inside the same v2 pricing version", async () => {
  const client = createAnthropicClient({ apiKey: "controlled", model: "m" })
  const request = { systemPrompt: "sys", messages: [{ role: "user" as const, content: "中" }], tools: [] }
  const current = (await client.prepare!(request)).measurement.input
  const v1 = { ...current, semanticIdentity: undefined, shapeFingerprint: projectionFingerprint({ system: "sys", tools: [] }) }
  const metadata = { version: 1 as const, modelId: "m", protocol: "anthropic-messages", identityCoverage: "complete" as const, bindingConfigFingerprint: "a".repeat(64) }
  const old = createProjectionCalibration("owner").record(v1, metadata, { inputTokens: 90, inputTokenSemantics: "includes-cache" }, 0)!
  expect(createProjectionCalibration("owner", old).estimate(current, metadata, 0).calibrated).toBe(false)
  const changed = (await client.prepare!({ ...request, reasoningEffort: "high" })).measurement.input
  expect(changed.semanticIdentity?.pricingVersion).toBe(current.semanticIdentity?.pricingVersion)
  const checkpoint = createProjectionCalibration("owner").record(current, metadata, { inputTokens: 90, inputTokenSemantics: "includes-cache" }, 0)!
  expect(createProjectionCalibration("owner", checkpoint).estimate(changed, metadata, 0).calibrated).toBe(false)
})
