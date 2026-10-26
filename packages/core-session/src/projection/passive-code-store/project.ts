import type { CompletedPassiveContext } from '../../conversation/passive-seed-context.ts'
import { types } from 'node:util'
import { validateSemanticSourceMetadata } from '../../events/conversation-source.ts'
import { meldRewindCut, type RewindCut } from '../rewind.ts'
import type { CandidateRow, DeferredValueSlot, OwnedPassiveCandidates, PassiveCodeStoreV1 } from './types.ts'

/** Private wire→candidate transport; strings and touches remain verbatim. This
 * helper confers no held-source admission and never manufactures source facts. */
export function expandInheritedCodeStore(data: PassiveCodeStoreV1): OwnedPassiveCandidates {
  return { units: data.units, rows: data.rows.map(row => row.kind === 'eligible' ? { ...row }
    : row.kind === 'touch' ? { kind: 'touch', unit: row.unit, key: data.keys[row.key]! }
      : { kind: 'put', unit: row.unit, key: data.keys[row.key]!, slot: row.value }),
  slots: data.values.map((value, slot) => ({ kind: 'inherited-json', slot, valueJson: value.valueJson })),
  cuts: data.cuts.map((cut, oldCut) => ({ end: cut.end, knowledge: { kind: 'inherited-observation', oldCut, outcome: cut.overLimit ? 'limit-exceeded' : 'value' } })),
  inherited: { data, toCandidate: data.cuts.map((_, oldCut) => ({ oldCut, candidateCut: oldCut })) },
  latest: data.latest, completed: data.completed.map(entry => ({ ...entry })), groups: [...data.groups] }
}

function own(value: object, key: string): unknown {
  const field = Object.getOwnPropertyDescriptor(value, key)
  if (!field?.enumerable || !('value' in field)) throw new TypeError('Invalid semantic seed')
  return field.value
}
function array(value: unknown): unknown[] {
  if (!Array.isArray(value) || types.isProxy(value) || Object.getPrototypeOf(value) !== Array.prototype) throw new TypeError('Invalid semantic seed')
  const fields = Object.getOwnPropertyDescriptors(value), keys = Reflect.ownKeys(fields)
  if (keys.length !== value.length + 1 || keys.some(key => typeof key !== 'string') ||
    Object.entries(fields).some(([key, field]) => key !== 'length' && (!field.enumerable || !('value' in field)))) throw new TypeError('Invalid semantic seed')
  for (let index = 0; index < value.length; index++) if (!Object.hasOwn(fields, String(index))) throw new TypeError('Invalid semantic seed')
  return value
}

/** V1 held source projection. Inherited wire transport is kept separate until
 * the V2 manifest/source codec is authorized; no lookalike event grants it. */
export function projectPassiveCodeStore(context: CompletedPassiveContext): OwnedPassiveCandidates {
  context.owner.assertCurrent()
  const { view } = context.source, windows: RewindCut[] = []
  for (const window of context.source.originalWindows) meldRewindCut(windows, window.cutFrom, window.markerSeq)
  const visible = (seq: number) => !windows.some(window => seq >= window.cutFrom && seq < window.markerSeq)
  const upper = context.boundary.upper.kind === 'archive-end' ? context.boundary.upper.eventCount : context.boundary.upper.at.index
  const landmarkRanks = new Set<number>([upper])
  const completedRanks = context.source.turns.ends.filter(end => end.turn <= context.last).map(end => ({ turn: end.turn,
    rank: Math.min(upper, context.source.turns.starts.find(start => start.seq > end.seq)?.seq ?? upper) }))
  for (const entry of completedRanks) landmarkRanks.add(entry.rank)
  for (const group of context.groups) landmarkRanks.add(Math.min(upper, group.anchor.index))
  const ranks = [...landmarkRanks].sort((a, b) => a - b)
  const cutIds = new Map(ranks.map((rank, index) => [rank, index]))
  const records: { index: number; unit: string; event: typeof view.events[number] }[] = []
  for (const [index, event] of view.events.entries()) {
    validateSemanticSourceMetadata(event)
    if (index >= upper || !visible(event.seq ?? index) || !['code/store', 'code/cell'].includes(event.type)) continue
    const sessionId = Object.getOwnPropertyDescriptor(event, 'sessionId')?.value
    const owned = sessionId === context.owner.sourceSessionId || view.header?.parentSession !== undefined && index < (view.header.seedLength ?? 0)
    if (!owned) continue
    const cellId = own(event, 'cellId')
    if (typeof cellId !== 'string' || sessionId !== undefined && typeof sessionId !== 'string') throw new TypeError('Invalid semantic seed')
    records.push({ index, unit: JSON.stringify([sessionId ?? null, cellId]), event })
  }
  // Establish eligibility at every address before opening version/writes.
  const eligible = new Set<number>()
  for (const rank of ranks) {
    const terminals = new Map<string, { index: number; completed: boolean }>()
    for (const record of records) if (record.index < rank && record.event.type === 'code/cell') terminals.set(record.unit, { index: record.index, completed: record.event.state === 'completed' })
    for (const record of records) {
      const terminal = terminals.get(record.unit)
      if (record.event.type === 'code/store' && record.index < rank && terminal?.completed && terminal.index > record.index) eligible.add(record.index)
    }
  }
  const units = new Map<string, number>(), rows: CandidateRow[] = [], slots: DeferredValueSlot[] = [], positions: number[] = []
  const unitId = (key: string) => { let unit = units.get(key); if (unit === undefined) { unit = units.size; units.set(key, unit) } return unit }
  for (const record of records) {
    if (record.event.type === 'code/cell') {
      rows.push({ kind: 'eligible', unit: unitId(record.unit), value: record.event.state === 'completed' }); positions.push(record.index)
    } else if (eligible.has(record.index)) {
      if (own(record.event, 'version') !== 1) throw new TypeError('Invalid semantic seed')
      const writes = array(own(record.event, 'writes'))
      for (const [entryIndex, entry] of writes.entries()) {
        const pair = array(entry)
        if (pair.length !== 2) throw new TypeError('Invalid semantic seed')
        const key = own(pair, '0'), value = own(pair, '1')
        if (typeof key !== 'string') throw new TypeError('Invalid semantic seed')
        const slot = slots.length
        slots.push({ kind: 'local-descriptor', slot, eventIndex: record.index, entryIndex, value })
        rows.push({ kind: 'put', unit: unitId(record.unit), key, slot }); positions.push(record.index)
      }
    }
  }
  const cuts = ranks.map(rank => ({ end: positions.filter(position => position < rank).length, knowledge: { kind: 'unclassified' as const } }))
  context.owner.assertCurrent()
  return { units: units.size, rows, slots, cuts, latest: cutIds.get(upper)!, completed: completedRanks.map(entry => ({ turn: entry.turn, cut: cutIds.get(entry.rank)! })),
    groups: context.groups.map(group => cutIds.get(Math.min(upper, group.anchor.index))!) }
}
