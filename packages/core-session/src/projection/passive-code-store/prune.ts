import type { DataRow, PassiveCodeStoreV1 } from './types.ts'
import { eligibleRows } from './replay.ts'

/** Retain insertion witnesses and final values at addressable landmarks. This
 * stores a union of rows, never a serialized map per group or completed turn. */
export function prunePassiveCodeStore(data: PassiveCodeStoreV1): PassiveCodeStoreV1 {
  const cuts = [...new Set([data.latest, ...data.completed.map(entry => entry.cut), ...data.groups])].sort((a, b) => a - b)
  const keep = new Set<number>(), values = new Set<number>()
  for (const cut of cuts) {
    if (data.cuts[cut]!.overLimit) continue
    const first = new Map<number, number>(), last = new Map<number, number>()
    for (const position of eligibleRows(data.rows, data.cuts[cut]!.end).qualified) {
      const row = data.rows[position]!
      if (row.kind === 'eligible') continue
      if (!first.has(row.key)) first.set(row.key, position)
      if (row.kind === 'put') last.set(row.key, position)
    }
    for (const [key, position] of first) {
      if (!last.has(key)) throw new TypeError('Incomplete passive store touch')
      keep.add(position); keep.add(last.get(key)!); values.add(last.get(key)!)
    }
  }
  const units = new Set([...keep].map(position => data.rows[position]!.unit))
  // Keep the last transition for retained units at every observation, including
  // false and true-before-put. Otherwise pruning can revive an old write.
  for (const cut of cuts) for (const [unit, position] of eligibleRows(data.rows, data.cuts[cut]!.end).terminals) if (units.has(unit)) keep.add(position)
  const keyMap = new Map<number, number>(), unitMap = new Map<number, number>(), valueMap = new Map<number, number>()
  const keys: string[] = [], bodies: { valueJson: string }[] = [], rows: DataRow[] = [], ranks = [0]
  const intern = (map: Map<number, number>, old: number) => { let next = map.get(old); if (next === undefined) { next = map.size; map.set(old, next) } return next }
  for (const [position, row] of data.rows.entries()) {
    if (keep.has(position)) {
      const unit = intern(unitMap, row.unit)
      if (row.kind === 'eligible') rows.push({ kind: 'eligible', unit, value: row.value })
      else {
        const key = intern(keyMap, row.key); keys[key] = data.keys[row.key]!
        if (row.kind === 'put' && values.has(position)) {
          const value = intern(valueMap, row.value); bodies[value] = data.values[row.value]!
          rows.push({ kind: 'put', unit, key, value })
        } else rows.push({ kind: 'touch', unit, key })
      }
    }
    ranks.push(rows.length)
  }
  const cutMap = new Map(cuts.map((cut, index) => [cut, index]))
  return { version: 1, units: unitMap.size, keys, values: bodies, rows,
    cuts: cuts.map(cut => ({ end: ranks[data.cuts[cut]!.end]!, ...(data.cuts[cut]!.overLimit ? { overLimit: true as const } : {}) })),
    latest: cutMap.get(data.latest)!, completed: data.completed.map(entry => ({ turn: entry.turn, cut: cutMap.get(entry.cut)! })), groups: data.groups.map(cut => cutMap.get(cut)!) }
}
