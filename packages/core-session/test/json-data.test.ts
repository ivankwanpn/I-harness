import { expect, it } from "vitest"
import { stringifyJsonData, canonicalJsonData, lowerJsonData, streamJsonData } from "../src/index.ts"
import { captureData } from '../src/serialization/context-data.ts'
import { runInNewContext } from 'node:vm'

it("preserves source JSON enumeration, omissions, proto data and Unicode with a literal old-output oracle", () => {
  const value = { b: 1, "10": "ten", "2": "two", absent: undefined }
  Object.defineProperty(value, "__proto__", { enumerable: true, value: { ok: true } })
  Object.assign(value, { unicode: "é🙂\ud800" })
  expect(stringifyJsonData(value)).toBe('{"2":"two","10":"ten","b":1,"__proto__":{"ok":true},"unicode":"é🙂\\ud800"}')
  expect(canonicalJsonData(value)).toBe('{"10":"ten","2":"two","__proto__":{"ok":true},"b":1,"unicode":"é🙂\\ud800"}')
  expect(stringifyJsonData([undefined, null, -0, Infinity])).toBe('[null,null,0,null]')
  expect(stringifyJsonData(undefined)).toBeUndefined()
})

it('uses exact capture ownership for frozen data without repeating slot validation', () => {
  const plain = Object.freeze({ z: Object.freeze([Object.freeze({ b: 'é🙂\ud800' })]), '10': 'ten', '2': 'two' })
  const captured = captureData(plain)
  const canonical = canonicalJsonData(plain), sourceOrder = stringifyJsonData(plain)
  const ownedNodes = new Set<object>([captured, captured.z, captured.z[0]!])
  const original = Object.getOwnPropertyDescriptors
  const reads = { owned: 0, plain: 0 }
  Object.getOwnPropertyDescriptors = function (value) {
    if (ownedNodes.has(value as object)) reads.owned++
    if (value === plain) reads.plain++
    return original(value)
  }
  let actualCanonical: string, actualSourceOrder: string | undefined
  try {
    actualCanonical = canonicalJsonData(captured)
    actualSourceOrder = stringifyJsonData(captured)
    canonicalJsonData(plain)
  } finally { Object.getOwnPropertyDescriptors = original }
  expect(actualCanonical).toBe(canonical)
  expect(actualSourceOrder).toBe(sourceOrder)
  expect(reads).toEqual({ owned: 0, plain: 1 })
})

it('honors a later inherited serializer on an owned node and keeps ordinary fallback', () => {
  const captured = captureData({ toJSON: 'own data', values: [1, 2] })
  const descriptor = Object.getOwnPropertyDescriptor(Array.prototype, 'toJSON')
  let reads = 0, canonicalReads = 0, error: unknown, encoded: string | undefined
  Object.defineProperty(Array.prototype, 'toJSON', { configurable: true, get() {
    reads++
    return (key: string) => `array for ${key}`
  } })
  try {
    try { canonicalJsonData(captured) } catch (cause) { error = cause }
    canonicalReads = reads
    encoded = stringifyJsonData(captured)
  } finally {
    if (descriptor) Object.defineProperty(Array.prototype, 'toJSON', descriptor)
    else Reflect.deleteProperty(Array.prototype, 'toJSON')
  }
  expect(error).toBeInstanceOf(TypeError)
  expect(canonicalReads).toBe(0)
  expect(encoded).toBe('{"toJSON":"own data","values":"array for values"}')
  expect(reads).toBe(1)
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

it('invokes toJSON on callable objects with native key/occurrence semantics', () => {
  const fixture = () => {
    let calls = 0
    const callable = Object.assign(() => 'never called', { toJSON(key: string) { calls++; return { key, answer: 42 } } })
    return { value: { callable }, calls: () => calls }
  }
  const original = fixture(), native = fixture()
  expect(stringifyJsonData(original.value)).toBe('{"callable":{"key":"callable","answer":42}}')
  expect(JSON.stringify(native.value)).toBe('{"callable":{"key":"callable","answer":42}}')
  expect(original.calls()).toBe(1); expect(native.calls()).toBe(1)
})

it('canonical encoding refuses non-data callbacks and opaque values without invoking them', () => {
  let reads = 0, conversions = 0
  expect(() => canonicalJsonData({ get value() { reads++; return 'not data' } })).toThrow(TypeError)
  expect(() => canonicalJsonData({ value: { toJSON() { conversions++; return 'not data' } } })).toThrow(TypeError)
  expect(() => canonicalJsonData({ value: new Date(0) })).toThrow(TypeError)
  expect(() => canonicalJsonData({ value: new Number(1) })).toThrow(TypeError)
  expect(() => canonicalJsonData({ value: (JSON as typeof JSON & { rawJSON(text: string): unknown }).rawJSON('2') })).toThrow(TypeError)
  expect({ reads, conversions }).toEqual({ reads: 0, conversions: 0 })
})

it('serializes ordinary DTOs without throwing native boxed-value mismatch exceptions for each container', () => {
  const original = Number.prototype.valueOf
  let mismatch = 0
  Number.prototype.valueOf = function(this: Number) {
    try { return Reflect.apply(original, this, []) }
    catch (cause) { mismatch++; throw cause }
  }
  try {
    const value = { rows: Array.from({ length: 100 }, (_, index) => ({ index, result: { kind: 'ready', values: [1, 2, 3] } })) }
    const expected = JSON.stringify(value)
    expect(stringifyJsonData(value)).toBe(expected)
    expect(canonicalJsonData(value)).toBe(expected)
    expect(mismatch).toBe(0)
  } finally { Number.prototype.valueOf = original }
})

it('preserves native boxed Number and String conversion callbacks while Boolean ignores its override', () => {
  let numbers = 0, strings = 0, booleans = 0
  const number = Object.assign(new Number(1), { valueOf() { numbers++; return 2 } })
  const string = Object.assign(new String('before'), { toString() { strings++; return 'after' } })
  const boolean = Object.assign(new Boolean(true), { valueOf() { booleans++; return false } })
  expect(stringifyJsonData({ number, string, boolean })).toBe('{"number":2,"string":"after","boolean":true}')
  expect({ numbers, strings, booleans }).toEqual({ numbers: 1, strings: 1, booleans: 0 })
  numbers = 0; strings = 0; booleans = 0
  expect([...streamJsonData(lowerJsonData({ number, string, boolean }))].join('')).toBe('{"number":2,"string":"after","boolean":true}')
  expect({ numbers, strings, booleans }).toEqual({ numbers: 1, strings: 1, booleans: 0 })
})

it('preserves a native raw JSON numeric lexeme beyond binary64 through the owned encoding pass', () => {
  const raw = (JSON as typeof JSON & { rawJSON(text: string): unknown }).rawJSON('9007199254740993')
  expect(JSON.stringify({ raw })).toBe('{"raw":9007199254740993}')
  expect([...streamJsonData(lowerJsonData({ raw }))].join('')).toBe('{"raw":9007199254740993}')
})

it('keeps original native Proxy, inherited array, cross-realm and conversion-failure lowering semantics', () => {
  const fixture = () => {
    const reads: string[] = []
    const proxy = new Proxy({ value: 7 }, { get(target, key, receiver) { reads.push(String(key)); return Reflect.get(target, key, receiver) } })
    const prototype = Object.create(Array.prototype)
    Object.defineProperty(prototype, '0', { get() { reads.push('inherited'); return 8 } })
    const inherited = new Array(1); Object.setPrototypeOf(inherited, prototype)
    return { value: { proxy, inherited }, reads }
  }
  const source = fixture(), native = fixture()
  expect([...streamJsonData(lowerJsonData(source.value))].join('')).toBe(JSON.stringify(native.value))
  expect(source.reads).toEqual(native.reads)
  const foreign = runInNewContext(`({ number: Object.assign(new Number(1), {valueOf(){return 2}}), string: Object.assign(new String('before'), {toString(){return 'after'}}), value:{answer:42} })`)
  expect([...streamJsonData(lowerJsonData(foreign))].join('')).toBe(JSON.stringify(foreign))
  expect(stringifyJsonData(foreign)).toBe(JSON.stringify(foreign))
  const failed = Object.assign(new Number(1), { valueOf() { throw new Error('original conversion failure') } })
  expect(() => lowerJsonData(failed)).toThrow('original conversion failure')
  expect(() => stringifyJsonData(failed)).toThrow('original conversion failure')
  expect(() => canonicalJsonData(source.value.inherited)).toThrow(TypeError)
})
