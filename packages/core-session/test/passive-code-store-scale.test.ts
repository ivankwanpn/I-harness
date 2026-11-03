import { expect, it } from 'vitest'
import { performance } from 'node:perf_hooks'
import { capturePassiveCodeStore, replayPassiveCodeStore, type OwnedPassiveCandidates } from '../src/projection/passive-code-store.ts'
import { MAX_STORE_BYTES } from '../src/serialization/bounded-json.ts'

function measure(name: string, candidates: OwnedPassiveCandidates) {
  const start = performance.now(), cpu = process.cpuUsage(), data = capturePassiveCodeStore(candidates)
  if (!data) throw Error('Observable passive data required')
  const bytes = Buffer.byteLength(JSON.stringify(data)), used = process.cpuUsage(cpu)
  const result = { name, sourceRows: candidates.rows.length, R: data.rows.filter(row => row.kind !== 'eligible').length,
    E: data.rows.filter(row => row.kind === 'eligible').length, C: data.cuts.length, L: 1 + data.completed.length + data.groups.length,
    Bk: data.keys.reduce((bytes, key) => bytes + Buffer.byteLength(JSON.stringify(key)), 0), Bv: data.values.reduce((bytes, value) => bytes + Buffer.byteLength(value.valueJson), 0),
    distinctValues: data.values.length, groupAliasSlots: data.groups.length, bytes, cpuUserMs: used.user / 1000, cpuSystemMs: used.system / 1000, wallMs: performance.now() - start }
  console.log(JSON.stringify({ control: 'passive retained-size measurement', ...result }))
  return { data, result }
}
function repeated(writes: number, groups: number): OwnedPassiveCandidates {
  // The COMPLETE entry array is exactly4MiB; the native value string leaves
  // room for its key/framing rather than exceeding the actual runtime quota.
  const value = 's'.repeat(MAX_STORE_BYTES - Buffer.byteLength(JSON.stringify([['shared', '']])))
  expect(Buffer.byteLength(JSON.stringify([['shared', value]]))).toBe(MAX_STORE_BYTES)
  const ends = [1, writes / 4, writes / 2, writes].map(count => count * 2)
  return { units: 1, rows: Array.from({ length: writes }, (_, slot) => [{ kind: 'put' as const, unit: 0, key: 'shared', slot }, { kind: 'eligible' as const, unit: 0, value: true }]).flat(),
    slots: Array.from({ length: writes }, (_, slot) => ({ kind: 'local-descriptor', slot, eventIndex: slot, entryIndex: 0, value })),
    cuts: ends.map(end => ({ end, knowledge: { kind: 'unclassified' } })), latest: 3, completed: [{ turn: 1, cut: 0 }, { turn: 2, cut: 1 }, { turn: 3, cut: 2 }], groups: Array(groups).fill(3) }
}
it('interns a repeated4MiB entry across sparse cuts while retaining every thousand-group alias slot', () => {
  const short = measure('shared-128-writes-1000-groups', repeated(128, 1000)), long = measure('shared-512-writes-1000-groups', repeated(512, 1000))
  expect(long.data).toEqual(short.data)
  expect(long.data.values).toHaveLength(1); expect(long.data.groups).toHaveLength(1000); expect(long.data.cuts).toHaveLength(4)
  expect(long.result.R).toBe(4); expect(long.result.E).toBe(4); expect(long.result.L).toBe(1004)
  const one = measure('shared-512-writes-1-group', repeated(512, 1))
  expect(long.data.rows).toEqual(one.data.rows); expect(long.data.values).toEqual(one.data.values)
  const aliasBytes = Buffer.byteLength(JSON.stringify(Array(1000).fill(3))) - Buffer.byteLength(JSON.stringify([3]))
  expect(long.result.bytes - one.result.bytes).toBe(aliasBytes)
  expect(long.result.Bv).toBeLessThan(MAX_STORE_BYTES)
}, 30000)
it('keeps distinct required large values without an arbitrary aggregate cap or duplicated maps', () => {
  const count = 12, candidates: OwnedPassiveCandidates = { units: 1,
    rows: Array.from({ length: count }, (_, slot) => [{ kind: 'put' as const, unit: 0, key: 'version', slot }, { kind: 'eligible' as const, unit: 0, value: true }]).flat(),
    slots: Array.from({ length: count }, (_, slot) => ({ kind: 'local-descriptor', slot, eventIndex: slot, entryIndex: 0, value: String(slot).padStart(2, '0') + 'd'.repeat(512 * 1024 - 2) })),
    cuts: Array.from({ length: count }, (_, cut) => ({ end: (cut + 1) * 2, knowledge: { kind: 'unclassified' } })), latest: count - 1,
    completed: Array.from({ length: count - 1 }, (_, cut) => ({ turn: cut + 1, cut })), groups: Array(1000).fill(count - 1) }
  const { data, result } = measure('12-required-distinct-512KiB-values', candidates)
  expect(data.values).toHaveLength(count); expect(result.bytes).toBeGreaterThan(MAX_STORE_BYTES)
  expect(result.R).toBe(count); expect(result.C).toBe(count); expect(result.L).toBe(1012)
  for (let cut = 0; cut < count; cut++) {
    const replay = replayPassiveCodeStore(data, cut)
    const slot = candidates.slots[cut]!
    expect(replay.kind === 'value' && replay.entries[0]![1]).toBe(slot.kind === 'local-descriptor' ? slot.value : '')
  }
}, 30000)
it('discards an obsolete large body after many overwrites and retains value-free Map insertion witnesses', () => {
  const obsolete = 'OBSOLETE-PRIVATE-BODY'.repeat(Math.floor(MAX_STORE_BYTES / 22)), rows: OwnedPassiveCandidates['rows'][number][] = [
    { kind: 'put', unit: 0, key: 'x', slot: 0 }, { kind: 'put', unit: 0, key: 'y', slot: 1 },
    ...Array.from({ length: 2048 }, (_, index) => ({ kind: 'put' as const, unit: 0, key: 'x', slot: index + 2 })), { kind: 'eligible', unit: 0, value: true },
  ]
  const candidates: OwnedPassiveCandidates = { units: 1, rows, slots: [{ kind: 'local-descriptor', slot: 0, eventIndex: 0, entryIndex: 0, value: obsolete }, { kind: 'local-descriptor', slot: 1, eventIndex: 1, entryIndex: 0, value: 2 },
    ...Array.from({ length: 2048 }, (_, index) => ({ kind: 'local-descriptor' as const, slot: index + 2, eventIndex: index + 2, entryIndex: 0, value: index === 2047 ? 1 : index }))],
    cuts: [{ end: rows.length, knowledge: { kind: 'unclassified' } }], latest: 0, completed: [], groups: Array(1000).fill(0) }
  const { data, result } = measure('2048-overwrites-obsolete-large-body', candidates)
  expect(data.rows[0]).toEqual({ kind: 'touch', unit: 0, key: 0 }); expect(result.R).toBe(3); expect(result.E).toBe(1); expect(result.Bv).toBe(2)
  expect(JSON.stringify(data)).not.toContain('OBSOLETE-PRIVATE-BODY')
  expect(replayPassiveCodeStore(data, data.latest)).toEqual({ kind: 'value', entries: [['x', 1], ['y', 2]] })
})
