import { decodeStoreValueJson } from '../../serialization/bounded-json.ts'
import type { CandidateRow, DataRow, PassiveCodeStoreV1, StoreEntries, StoreReplay } from './types.ts'

/** One positional evaluator for capture, pruning and replay. Raw legacy replay
 * deliberately has its own optional-seq predicate. No payload is read here. */
export function eligibleRows<Row extends CandidateRow | DataRow>(rows: readonly Row[], end: number) {
  const terminals = new Map<number, number>()
  for (let position = 0; position < end; position++) {
    const row = rows[position]!
    if (row.kind === 'eligible') terminals.set(row.unit, position)
  }
  const qualified: number[] = []
  for (let position = 0; position < end; position++) {
    const row = rows[position]!, terminal = terminals.get(row.unit)
    if (row.kind !== 'eligible' && terminal !== undefined && terminal > position && (rows[terminal] as Extract<Row, { kind: 'eligible' }>).value) qualified.push(position)
  }
  return { qualified, terminals }
}

export function replayPassiveCodeStore(data: PassiveCodeStoreV1, cut: number): StoreReplay {
  const landmark = data.cuts[cut]
  if (!landmark) throw new TypeError('Invalid passive store cut')
  if (landmark.overLimit) return { kind: 'limit-exceeded' }
  const values = new Map<string, StoreEntries[number][1] | undefined>()
  for (const position of eligibleRows(data.rows, landmark.end).qualified) {
    const row = data.rows[position]!
    if (row.kind === 'eligible') continue
    const key = data.keys[row.key]!
    if (row.kind === 'touch') { if (!values.has(key)) values.set(key, undefined) }
    else values.set(key, decodeStoreValueJson(data.values[row.value]!.valueJson) as StoreEntries[number][1])
  }
  if ([...values.values()].some(value => value === undefined)) throw new TypeError('Incomplete passive store touch')
  return { kind: 'value', entries: [...values] as StoreEntries }
}
