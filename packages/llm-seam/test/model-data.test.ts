import { expect, it } from "vitest"
import { snapshotModelData } from "../src/index.ts"

it("keeps captured controls by identity and legacy SDK data by value", () => {
  const signal = new AbortController().signal, requestScope = { sessionId: "s", turnId: "t" }, callback = () => {}
  const input = { signal, requestScope, callback, date: new Date(0), bytes: Uint8Array.of(1, 2), excluded: 1, nested: { excluded: 2 } }
  const copy = snapshotModelData(input, ["excluded"])
  expect(copy.signal).toBe(signal); expect(copy.requestScope).toBe(requestScope); expect(copy.callback).toBe(callback)
  expect(copy.date).not.toBe(input.date); expect(copy.date.toISOString()).toBe("1970-01-01T00:00:00.000Z")
  expect([...copy.bytes]).toEqual([1, 2]); expect(copy.bytes).not.toBe(input.bytes)
  expect(copy).not.toHaveProperty("excluded"); expect(copy.nested.excluded).toBe(2)
})

it("preserves separate legacy acyclic copies and getter read order for shared inputs", () => {
  let reads = 0
  const shared = { get value() { return ++reads } }
  const copy = snapshotModelData({ a: shared, b: shared })
  expect(copy).toEqual({ a: { value: 1 }, b: { value: 2 } })
  expect(copy.a).not.toBe(copy.b)
})
