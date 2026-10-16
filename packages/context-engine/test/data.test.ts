import { expect, it } from "vitest"
import { createSession } from "@i-harness/core-session"
import { captureContextSnapshot } from "../src/index.ts"

const capture = (inputSchema: unknown) => captureContextSnapshot(createSession(), { ownerSessionId: "owner", surface: { systemPrompt: "system", tools: [{ name: "probe", description: "probe", inputSchema }] } })

it.each([
  ["hole", Array(1)], ["undefined-array", [undefined]], ["nonfinite", { value: Infinity }], ["negative-zero", { value: -0 }],
  ["unsafe-integer", { value: Number.MAX_SAFE_INTEGER + 1 }], ["bigint", { value: 1n }], ["function", { value() {} }],
  ["toJSON", { toJSON() { throw Error("called") } }], ["class", { child: new (class { value = {} })() }],
  ["symbol", { [Symbol("private")]: 1 }], ["nonenumerable", Object.defineProperty({}, "private", { value: 1 })],
  ["extra-array", Object.assign([], { extra: 1 })],
  ["array-subclass", new (class extends Array<number> {})()],
] as const)("rejects unsupported %s surface data", (_name, input) => {
  expect(capture(input)).toEqual({ kind: "unsupported", code: "CONTEXT_SNAPSHOT_UNSUPPORTED", component: "surface", sourceIds: [] })
})
it("rejects cycles without recursive stack failure", () => {
  const value: { child?: unknown } = {}; value.child = value
  expect(capture(value).kind).toBe("unsupported")
})
it("rejects callable toJSON without invoking it or freezing its original graph", () => {
  let calls = 0
  const input = { nested: { value: 1 }, toJSON() { calls++; return { text: "mutated serialization" } } }
  expect(capture(input).kind).toBe("unsupported")
  expect(calls).toBe(0)
  input.nested.value = 2
  expect(Object.isFrozen(input.nested)).toBe(false)
})
it("retains proto and noncallable toJSON data and omits undefined record slots", () => {
  const input = Object.assign(Object.create(null), { toJSON: "literal", absent: undefined, fractional: .125 })
  Object.defineProperty(input, "__proto__", { value: { safe: true }, enumerable: true })
  const result = capture(input)
  expect(result.kind).toBe("captured")
  if (result.kind !== "captured") throw Error("capture required")
  expect(result.snapshot.surface.tools[0]!.inputSchema).toEqual({ ["__proto__"]: { safe: true }, toJSON: "literal", fractional: .125 })
  expect(Object.getPrototypeOf(result.snapshot.surface.tools[0]!.inputSchema)).toBe(Object.prototype)
})
