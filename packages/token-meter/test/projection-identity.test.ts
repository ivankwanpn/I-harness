import { createHash } from "node:crypto"
import { expect, it } from "vitest"
import { encodeSdkCommandData, ProjectionCounter, projectionFingerprint, semanticProjectionDigest } from "../src/index.ts"
import { createAcceptedCalibration } from "../src/index.ts"
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
  expect(a.units[0]).toMatchObject({ heuristicTokens: 17, semanticId: expect.stringMatching(/^[a-f0-9]{64}$/) })
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

it("preserves the v2 tagged bytes for sorted keys, sparse arrays and shared values", () => {
  const text = "a".repeat(4095) + "🙂中文\ud800\n\""
  const shared = { text }
  const input = { "2": -0, "10": 3, left: shared, right: shared,
    slots: [, undefined, null, false, new Date(0), Uint8Array.of(1, 2)] }
  const taggedShared = ["object", [["text", ["string", text]]]]
  const literal = JSON.stringify(["object", [
    ["10", ["number", 3]], ["2", ["number", 0]], ["left", taggedShared], ["right", taggedShared],
    ["slots", ["array", [["undefined"], ["undefined"], ["null"], ["boolean", false],
      ["date", "1970-01-01T00:00:00.000Z"], ["bytes", "AQI="]]]],
  ]])
  expect(encodeSdkCommandData(input)).toBe(literal)
  expect(semanticProjectionDigest("input", input)).toBe(createHash("sha256")
    .update("i-harness:projection:v2:input\0").update(literal).digest("hex"))
})

it("reads sibling getters in reverse order before handling children", () => {
  const reads: string[] = []
  const reflection = { value: 1 }
  const date = new Date(0)
  Object.defineProperty(date, "toISOString", { value: () => { reads.push("date"); return reflection } })
  const input = {
    get z() { reads.push("z"); return { get edit() { reads.push("edit"); reflection.value = 2; return true } } },
    get a() { reads.push("a"); return date },
  }
  expect(encodeSdkCommandData(input)).toBe('["object",[["a",["date",{"value":2}]],["z",["object",[["edit",["boolean",true]]]]]]]')
  expect(reads).toEqual(["z", "a", "date", "edit"])
})

it("keeps tagged data stack-safe and rejects cycles or non-finite numbers", () => {
  const count = 12_000
  let nested: unknown = null
  for (let depth = 0; depth < count; depth++) nested = [nested]
  expect(encodeSdkCommandData(nested)).toBe('["array",['.repeat(count) + '["null"]' + ']]'.repeat(count))
  const cyclic: unknown[] = []
  cyclic.push(cyclic)
  expect(() => encodeSdkCommandData(cyclic)).toThrow("SDK command identity requires acyclic data")
  expect(() => encodeSdkCommandData([Infinity])).toThrow("SDK command identity requires finite data")
})

it("does not convert v1 projection prices or changed reasoning into v2 identity", async () => {
  const client = createAnthropicClient({ apiKey: "controlled", model: "m" })
  const request = { systemPrompt: "sys", messages: [{ role: "user" as const, content: "中" }], tools: [] }
  const current = (await client.prepare!(request)).measurement.input
  const v1 = { ...current, semanticIdentity: undefined, shapeFingerprint: projectionFingerprint({ system: "sys", tools: [] }) }
  expect(createAcceptedCalibration("owner", "live").recordAccepted(v1, {} as never, {} as never, { inputTokens: 90, inputTokenSemantics: "includes-cache" })).toMatchObject({ kind: "ignored" })
  const changed = (await client.prepare!({ ...request, reasoningEffort: "high" })).measurement.input
  expect(changed.semanticIdentity?.pricingVersion).toBe(current.semanticIdentity?.pricingVersion)
  expect(changed.semanticIdentity?.shapeId).not.toBe(current.semanticIdentity?.shapeId)
})
