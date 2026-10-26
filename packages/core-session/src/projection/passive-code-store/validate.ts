import type { PassiveCodeStoreV1 } from './types.ts'
import type { SeedTurnDomain } from '../../conversation/seed-types.ts'
import { seedCount, seedData, seedFields, seedInvalid } from '../../conversation/seed-codec.ts'
import { decodeStoreValueJson, json, MAX_STORE_BYTES } from '../../serialization/bounded-json.ts'
import { replayPassiveCodeStore } from './replay.ts'

/** The closed wire certifies retained bytes and structure. A fault is a prior
 * observation; validation does not recover discarded overflow-only values. */
export function validatePassiveCodeStore(value: unknown, turns: SeedTurnDomain, groups: number, partial = false): PassiveCodeStoreV1 {
  seedData(value)
  seedFields(value, ['version', 'units', 'keys', 'values', 'rows', 'cuts', 'latest', 'completed', 'groups'])
  const data = value as PassiveCodeStoreV1
  if (data.version !== 1 || !seedCount(data.units) || ![data.keys, data.values, data.rows, data.cuts, data.completed, data.groups].every(Array.isArray)
    || !data.cuts.length || data.keys.some(key => typeof key !== 'string') || new Set(data.keys).size !== data.keys.length
    || (partial ? data.groups.length < groups : data.groups.length !== groups)) seedInvalid()
  const unitIds = new Set<number>()
  for (const value of data.values) { seedFields(value, ['valueJson']); if (typeof value.valueJson !== 'string') seedInvalid(); decodeStoreValueJson(value.valueJson) }
  if (new Set(data.values.map(value => value.valueJson)).size !== data.values.length) seedInvalid()
  for (const row of data.rows) {
    seedFields(row, ['kind', 'unit', ...(row.kind === 'eligible' ? ['value'] : row.kind === 'put' ? ['key', 'value'] : ['key'])])
    if (!seedCount(row.unit) || row.unit >= data.units) seedInvalid()
    unitIds.add(row.unit)
    if (row.kind === 'eligible') { if (typeof row.value !== 'boolean') seedInvalid() }
    else if (!['put', 'touch'].includes(row.kind) || !seedCount(row.key) || row.key >= data.keys.length || row.kind === 'put' && (!seedCount(row.value) || row.value >= data.values.length)) seedInvalid()
  }
  if (unitIds.size !== data.units) seedInvalid()
  let previous = -1
  for (const cut of data.cuts) {
    seedFields(cut, ['end'], ['overLimit'])
    if (!seedCount(cut.end) || cut.end < previous || cut.end > data.rows.length || Object.hasOwn(cut, 'overLimit') && cut.overLimit !== true) seedInvalid()
    previous = cut.end
  }
  const cutId = (cut: number) => { if (!seedCount(cut) || cut >= data.cuts.length) seedInvalid() }
  cutId(data.latest); for (const cut of data.groups) cutId(cut)
  let turn = 0
  for (const completed of data.completed) {
    seedFields(completed, ['turn', 'cut'])
    if (!seedCount(completed.turn) || completed.turn <= turn || !turns.completed.some(([first, last]) => completed.turn >= first && completed.turn <= last)) seedInvalid()
    cutId(completed.cut); turn = completed.turn
  }
  for (let cut = 0; cut < data.cuts.length; cut++) {
    const result = replayPassiveCodeStore(data, cut)
    if (result.kind === 'value') json(result.entries, MAX_STORE_BYTES, 'Session store', true)
  }
  return data
}
