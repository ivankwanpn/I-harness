import { expect, it } from 'vitest'
import type { Session } from '../src/events/types.ts'
import { replayLegacyCodeStore, replayPassiveCodeStore, capturePassiveCodeStore, type PassiveCodeStoreV1, type OwnedPassiveCandidates } from '../src/projection/passive-code-store.ts'
import { prunePassiveCodeStore } from '../src/projection/passive-code-store/prune.ts'
import { decodeStoreValueJson, json, MAX_STORE_BYTES } from '../src/serialization/bounded-json.ts'

const tape = (rows: PassiveCodeStoreV1['rows'], ends: number[], extra: Partial<PassiveCodeStoreV1> = {}): PassiveCodeStoreV1 => ({
  version: 1, units: 2, keys: ['x', 'y'], values: [{ valueJson: '1' }, { valueJson: '2' }], rows,
  cuts: ends.map(end => ({ end })), latest: ends.length - 1, completed: [], groups: ends.map((_, index) => index), ...extra,
})
it('preserves literal legacy optional and nonmonotone seq replay', () => {
  const source: Session = { formatVersion: 13, events: [
    { type: 'code/cell', cellId: 'c', sessionId: 'o', state: 'completed' },
    { type: 'code/store', version: 1, cellId: 'c', sessionId: 'o', writes: [['x', 7]] },
  ] }
  expect(replayLegacyCodeStore(source, 'o')).toEqual([['x', 7]])
  Object.assign(source.events[0]!, { seq: 10 }); Object.assign(source.events[1]!, { seq: 5 })
  expect(replayLegacyCodeStore(source, 'o')).toEqual([['x', 7]])
})
it('folds concurrent eligible units in write order rather than completion order', () => {
  const data = tape([{ kind: 'put', unit: 0, key: 0, value: 0 }, { kind: 'put', unit: 1, key: 1, value: 1 },
    { kind: 'eligible', unit: 1, value: true }, { kind: 'eligible', unit: 0, value: true }], [3, 4])
  expect(replayPassiveCodeStore(data, 0)).toEqual({ kind: 'value', entries: [['y', 2]] })
  expect(replayPassiveCodeStore(data, 1)).toEqual({ kind: 'value', entries: [['x', 1], ['y', 2]] })
})
it('requires the last true transition to follow a put and preserves earlier failure revival', () => {
  const data = tape([{ kind: 'put', unit: 0, key: 0, value: 0 }, { kind: 'eligible', unit: 0, value: true },
    { kind: 'put', unit: 0, key: 1, value: 1 }, { kind: 'eligible', unit: 0, value: false }], [3, 4])
  expect(replayPassiveCodeStore(data, 0)).toEqual({ kind: 'value', entries: [['x', 1]] })
  expect(replayPassiveCodeStore(data, 1)).toEqual({ kind: 'value', entries: [] })
})
it('keeps equal-end fault and ordinary aliases distinct', () => {
  const data: PassiveCodeStoreV1 = { version: 1, units: 0, keys: [], values: [], rows: [], cuts: [{ end: 0, overLimit: true }, { end: 0 }], latest: 1, completed: [], groups: [0] }
  expect(replayPassiveCodeStore(data, 0)).toEqual({ kind: 'limit-exceeded' })
  expect(replayPassiveCodeStore(data, 1)).toEqual({ kind: 'value', entries: [] })
  expect(prunePassiveCodeStore(data)).toEqual(data)
  expect(Math.min(data.groups[0]!, data.latest)).toBe(0)
})
it('replaces obsolete first bodies with insertion touches and removes unused slots', () => {
  const data = tape([{ kind: 'put', unit: 0, key: 0, value: 2 }, { kind: 'put', unit: 0, key: 1, value: 1 },
    { kind: 'put', unit: 0, key: 0, value: 0 }, { kind: 'eligible', unit: 0, value: true }], [0, 4],
  { values: [{ valueJson: '1' }, { valueJson: '2' }, { valueJson: JSON.stringify('obsolete'.repeat(1000)) }], groups: [1], completed: [{ turn: 1, cut: 1 }] })
  const pruned = prunePassiveCodeStore(data)
  expect(pruned.rows[0]).toEqual({ kind: 'touch', unit: 0, key: 0 })
  expect(pruned.units).toBe(1); expect(pruned.cuts).toHaveLength(1)
  expect(pruned.values).toEqual([{ valueJson: '2' }, { valueJson: '1' }])
  expect(JSON.stringify(pruned)).not.toContain('obsolete')
  expect(replayPassiveCodeStore(pruned, pruned.latest)).toEqual(replayPassiveCodeStore(data, data.latest))
  expect(replayPassiveCodeStore(pruned, pruned.latest)).toEqual({ kind: 'value', entries: [['x', 1], ['y', 2]] })
})
it('retains repeated true transitions across relevant puts and each exposed cut', () => {
  const data = tape([{ kind: 'put', unit: 0, key: 0, value: 0 }, { kind: 'eligible', unit: 0, value: true },
    { kind: 'put', unit: 0, key: 1, value: 1 }, { kind: 'eligible', unit: 0, value: true }], [2, 4])
  const pruned = prunePassiveCodeStore(data)
  expect(pruned.rows.filter(row => row.kind === 'eligible')).toHaveLength(2)
  for (const cut of [0, 1]) expect(replayPassiveCodeStore(pruned, cut)).toEqual(replayPassiveCodeStore(data, cut))
})
it('preserves strict native value spellings, member order and literal special keys', () => {
  const value = JSON.parse('{"z":[1,{"__proto__":{"origin":"literal"}}],"a":2}')
  const encoded = json(value, MAX_STORE_BYTES, 'Session store', true)
  expect(encoded).toBe('{"z":[1,{"__proto__":{"origin":"literal"}}],"a":2}')
  expect(decodeStoreValueJson(encoded)).toEqual(value)
  for (const malformed of ['{"x":1,"x":2}', ' 1', '"\\u0061"', 'NaN', '[1,]']) expect(() => decodeStoreValueJson(malformed)).toThrow()
  expect(() => json([['x', 'é']], Buffer.byteLength('[["x","é"]]') - 1, 'Session store', true)).toThrow('transfer limit exceeded')
  expect(json([['x', 'é']], Buffer.byteLength('[["x","é"]]'), 'Session store', true)).toBe('[["x","é"]]')
})
it('captures only selected final bodies, preserves earlier outcomes and classifies original entry bytes', () => {
  const cycle: unknown[] = []; cycle.push(cycle)
  const candidates: OwnedPassiveCandidates = { units: 1, rows: [{ kind: 'put', unit: 0, key: 'x', slot: 0 }, { kind: 'put', unit: 0, key: 'x', slot: 1 }, { kind: 'eligible', unit: 0, value: true }, { kind: 'eligible', unit: 0, value: false }],
    slots: [{ kind: 'local-descriptor', slot: 0, eventIndex: 0, entryIndex: 0, value: cycle }, { kind: 'local-descriptor', slot: 1, eventIndex: 1, entryIndex: 0, value: 7 }],
    cuts: [{ end: 3, knowledge: { kind: 'unclassified' } }, { end: 4, knowledge: { kind: 'unclassified' } }], latest: 1, groups: [0], completed: [] }
  const captured = capturePassiveCodeStore(candidates)!
  expect(replayPassiveCodeStore(captured, captured.latest)).toEqual({ kind: 'value', entries: [] })
  expect(replayPassiveCodeStore(captured, captured.groups[0]!)).toEqual({ kind: 'value', entries: [['x', 7]] })
  candidates.slots = [{ kind: 'local-descriptor', slot: 0, eventIndex: 0, entryIndex: 0, value: cycle }, { kind: 'local-descriptor', slot: 1, eventIndex: 1, entryIndex: 0, value: 'a'.repeat(MAX_STORE_BYTES) }]
  const fault = capturePassiveCodeStore(candidates)!
  expect(replayPassiveCodeStore(fault, fault.groups[0]!)).toEqual({ kind: 'limit-exceeded' })
  expect(fault.values).toEqual([])
})
