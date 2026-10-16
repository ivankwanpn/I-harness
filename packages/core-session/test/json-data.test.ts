import { expect, it } from "vitest"
import { stringifyJsonData, canonicalJsonData } from "../src/index.ts"

it("preserves source JSON enumeration, omissions, proto data and Unicode with a literal old-output oracle", () => {
  const value = { b: 1, "10": "ten", "2": "two", absent: undefined }
  Object.defineProperty(value, "__proto__", { enumerable: true, value: { ok: true } })
  Object.assign(value, { unicode: "é🙂\ud800" })
  expect(stringifyJsonData(value)).toBe('{"2":"two","10":"ten","b":1,"__proto__":{"ok":true},"unicode":"é🙂\\ud800"}')
  expect(canonicalJsonData(value)).toBe('{"10":"ten","2":"two","__proto__":{"ok":true},"b":1,"unicode":"é🙂\\ud800"}')
  expect(stringifyJsonData([undefined, null, -0, Infinity])).toBe('[null,null,0,null]')
  expect(stringifyJsonData(undefined)).toBeUndefined()
})

it("retains legacy native serialization for toJSON, accessors and opaque instances", () => {
  let reads = 0, conversions = 0
  const value = { get data() { reads++; return 1 }, date: new Date(0), custom: { toJSON() { conversions++; return "converted" } } }
  expect(stringifyJsonData(value)).toBe('{"data":1,"date":"1970-01-01T00:00:00.000Z","custom":"converted"}')
  expect(reads).toBe(1); expect(conversions).toBe(1)
  const cycle: { self?: unknown } = {}; cycle.self = cycle
  expect(() => stringifyJsonData(cycle)).toThrow(TypeError)
})

it("serializes and canonicalizes deep data without using the call stack", () => {
  let value: unknown = { leaf: "retained" }
  for (let i = 0; i < 6000; i++) value = { child: value }
  const expected = '{"child":'.repeat(6000) + '{"leaf":"retained"}' + '}'.repeat(6000)
  expect(stringifyJsonData(value)).toBe(expected)
  expect(canonicalJsonData(value)).toBe(expected)
})

it("retains the native raw-JSON marker instead of encoding its implementation field", () => {
  const rawJSON = (JSON as typeof JSON & { rawJSON(text: string): unknown }).rawJSON
  expect(stringifyJsonData({ value: rawJSON("2") })).toBe('{"value":2}')
})
