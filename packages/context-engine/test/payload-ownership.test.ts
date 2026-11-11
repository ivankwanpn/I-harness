import { expect, it } from 'vitest'
import { captureContextPayload } from '../src/index.ts'

it('reuses only its own deeply immutable tree and owned descendants', () => {
  const source = { nested: { rows: [{ value: 'original' }] } }
  const captured = captureContextPayload(source)
  expect(captured).not.toBe(source)
  expect(captureContextPayload(captured)).toBe(captured)
  expect(Object.isFrozen(captured.nested.rows[0])).toBe(true)
  expect(Reflect.set(captured.nested.rows[0]!, 'value', 'replacement')).toBe(false)
  const wrapper = { owned: captured.nested, caller: { value: 1 } }
  const next = captureContextPayload(wrapper)
  expect(next).not.toBe(wrapper)
  expect(next.owned).toBe(captured.nested)
  expect(next.caller).not.toBe(wrapper.caller)
  wrapper.caller.value = 2
  expect(next.caller.value).toBe(1)
})

it('recaptures mutable callers without retaining stale values or freezing their objects', () => {
  const source = { nested: { value: 1 } }
  const before = captureContextPayload(source)
  source.nested.value = 2
  const after = captureContextPayload(source)
  expect(before.nested.value).toBe(1)
  expect(after.nested.value).toBe(2)
  expect(after).not.toBe(before)
  expect(after.nested).not.toBe(before.nested)
  expect(Object.isFrozen(source)).toBe(false)
  expect(Object.isFrozen(source.nested)).toBe(false)
})

it('copies arbitrary frozen callers and rejects frozen accessor impostors without invoking getters', () => {
  const caller = Object.freeze({ nested: Object.freeze({ value: 1 }) })
  const captured = captureContextPayload(caller)
  expect(captured).not.toBe(caller)
  expect(captured.nested).not.toBe(caller.nested)
  let reads = 0
  const accessor = Object.freeze(Object.defineProperty({}, 'value', { enumerable: true, get() { reads++; return 1 } }))
  expect(() => captureContextPayload(accessor)).toThrow('CONTEXT_SNAPSHOT_UNSUPPORTED')
  expect(reads).toBe(0)
})

it('validates and copies a proxy around an owned node instead of inheriting ownership', () => {
  const owned = captureContextPayload({ nested: { value: 1 } })
  let inspections = 0
  const proxy = new Proxy(owned, { getOwnPropertyDescriptor(target, key) {
    inspections++
    return Reflect.getOwnPropertyDescriptor(target, key)
  } })
  const captured = captureContextPayload(proxy)
  expect(inspections).toBeGreaterThan(0)
  expect(captured).not.toBe(proxy)
  expect(captured).not.toBe(owned)
  expect(captured).toEqual(owned)
})

it('still rejects frozen cycles and unsafe caller values beside owned children', () => {
  const owned = captureContextPayload({ value: 1 })
  const cycle: { child: unknown; self?: unknown } = { child: owned }
  cycle.self = cycle
  Object.freeze(cycle)
  expect(() => captureContextPayload(cycle)).toThrow('CONTEXT_SNAPSHOT_UNSUPPORTED')
  for (const unsafe of [NaN, Infinity, -0, () => 1, new Date()]) {
    expect(() => captureContextPayload({ owned, unsafe })).toThrow('CONTEXT_SNAPSHOT_UNSUPPORTED')
  }
  expect(() => captureContextPayload(undefined)).toThrow('CONTEXT_SNAPSHOT_UNSUPPORTED')
  expect(captureContextPayload(owned)).toBe(owned)
})
