import { captureSelectedData, decodeStoreValueJson, json, MAX_STORE_BYTES } from '../../serialization/bounded-json.ts'
import { eligibleRows } from './replay.ts'
import { prunePassiveCodeStore } from './prune.ts'
import type { DataRow, OwnedPassiveCandidates, PassiveCodeStoreV1 } from './types.ts'

export function capturePassiveCodeStore(candidates: OwnedPassiveCandidates): PassiveCodeStoreV1 | undefined {
  const data = capturePassiveCodeStoreData(candidates)
  return data.rows.length || data.cuts.some(cut => cut.overLimit) ? data : undefined
}
/** V3 public profiles carry an explicit empty passive observation too. */
export function capturePassiveCodeStoreData(candidates: OwnedPassiveCandidates): PassiveCodeStoreV1 {
  const selected = new Set<number>(), cuts: PassiveCodeStoreV1['cuts'][number][] = []
  const captured = new Map<number, { value: unknown; valueJson?: string }>()
  const slots = new Map(candidates.slots.map(slot => [slot.slot, slot]))
  const addressable = new Set([candidates.latest, ...candidates.completed.map(entry => entry.cut), ...candidates.groups])
  const body = (slot: number) => {
    let result = captured.get(slot)
    if (!result) {
      const source = slots.get(slot)
      if (!source) throw new TypeError('Invalid semantic seed')
      const value = source.kind === 'inherited-json' ? decodeStoreValueJson(source.valueJson) : captureSelectedData(source.value)
      // Validate descriptors/JSON before quota classification, but do not
      // materialize an oversized native string for a discarded fault body.
      result = { value, ...(source.kind === 'inherited-json' ? { valueJson: source.valueJson } : {}) }; captured.set(slot, result)
    }
    return result
  }
  for (const [cutId, cut] of candidates.cuts.entries()) {
    if (!addressable.has(cutId)) { cuts.push({ end: cut.end }); continue }
    const final = new Map<string, number>()
    const qualified = eligibleRows(candidates.rows, cut.end).qualified
    for (const position of qualified) {
      const row = candidates.rows[position]!
      if (row.kind === 'touch') { if (!final.has(row.key)) final.set(row.key, -1) }
      if (row.kind === 'put') final.set(row.key, position)
    }
    const inheritedBase = candidates.inherited?.toCandidate.filter(entry => entry.candidateCut <= cutId).sort((a, b) => b.candidateCut - a.candidateCut)[0]
    const effectiveObservation = inheritedBase === undefined ? undefined : candidates.cuts[inheritedBase.candidateCut]?.knowledge
    const effectiveOldCut = effectiveObservation?.kind === 'inherited-observation' ? effectiveObservation.oldCut : inheritedBase?.oldCut
    const unknownFaultBase = cut.knowledge.kind === 'unclassified' && effectiveOldCut !== undefined && effectiveObservation?.kind !== 'classified' &&
      candidates.inherited!.data.cuts[effectiveOldCut]?.overLimit === true
    if (unknownFaultBase && qualified.some(position => {
      const row = candidates.rows[position]!
      return row.kind === 'put' && slots.get(row.slot)?.kind === 'local-descriptor'
    })) throw new TypeError('Invalid semantic seed')
    const priorFault = cut.knowledge.kind !== 'unclassified' && cut.knowledge.outcome === 'limit-exceeded' || unknownFaultBase
    if (priorFault) { cuts.push({ end: cut.end, overLimit: true }); continue }
    if ([...final.values()].some(position => position < 0)) throw new TypeError('Invalid semantic seed')
    const entries = [...final].map(([key, position]) => { const row = candidates.rows[position]!; if (row.kind !== 'put') throw new TypeError('Invalid semantic seed'); return [key, body(row.slot).value] })
    try {
      json(entries, MAX_STORE_BYTES, 'Session store', true)
      cuts.push({ end: cut.end })
      for (const position of final.values()) selected.add(position)
    } catch (error) {
      if (!(error instanceof Error) || error.message !== 'Session store transfer limit exceeded') throw error
      cuts.push({ end: cut.end, overLimit: true })
    }
  }
  const keyMap = new Map<string, number>(), valueMap = new Map<string, number>(), keys: string[] = [], values: { valueJson: string }[] = []
  const rows: DataRow[] = candidates.rows.map((row, position) => {
    if (row.kind === 'eligible') return row
    let key = keyMap.get(row.key); if (key === undefined) { key = keys.length; keys.push(row.key); keyMap.set(row.key, key) }
    if (row.kind === 'touch' || !selected.has(position)) return { kind: 'touch', unit: row.unit, key }
    const capturedBody = body(row.slot)
    const valueJson = capturedBody.valueJson ??= json(capturedBody.value, MAX_STORE_BYTES, 'Session store', true)
    let value = valueMap.get(valueJson); if (value === undefined) { value = values.length; values.push({ valueJson }); valueMap.set(valueJson, value) }
    return { kind: 'put', unit: row.unit, key, value }
  })
  const data = prunePassiveCodeStore({ version: 1, units: candidates.units, rows, keys, values, cuts, latest: candidates.latest, completed: candidates.completed, groups: candidates.groups })
  return data
}
