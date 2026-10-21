import type { HistoryArchive } from './facts.ts'
import type { TurnExtent, SeedTurnDomain } from '../seed-types.ts'

export function enclosingExtent(extents: readonly TurnExtent[]): TurnExtent {
  const framed = extents.filter((extent): extent is Extract<TurnExtent, { kind: 'framed' }> => extent.kind === 'framed')
  return framed.length === extents.length && framed.length ? { kind: 'framed', first: Math.min(...framed.map(extent => extent.first)), last: Math.max(...framed.map(extent => extent.last)) } : { kind: 'unframed' }
}
/** Recorded turn ordinals survive shadows and branch cuts. No body reads. */
export function historyTurns(archive: HistoryArchive) {
  const extents = new Map<number, TurnExtent>(), bySeq = new Map<number, TurnExtent>()
  const ends: { seq: number; turn: number }[] = [], starts: { seq: number; turn: number }[] = []
  let inherited: SeedTurnDomain = { total: 0, completed: [], unframedPrefix: false }
  let total = 0, active: number | undefined, unframedPrefix = false, ambiguous = false
  const completed: (readonly [number, number])[] = []
  for (let index = 0; index < archive.length; index++) {
    const fact = archive.get(index)
    if (fact.seedTurns) { inherited = fact.seedTurns; total = inherited.total; unframedPrefix ||= inherited.unframedPrefix; completed.push(...inherited.completed) }
    if (fact.type === 'turn/start') { if (active !== undefined) ambiguous = true; active = ++total; if (!Number.isSafeInteger(total)) throw new TypeError('Unsafe semantic turn ordinal'); if (fact.seq !== undefined) starts.push({ seq: fact.seq, turn: total }) }
    const extent: TurnExtent = fact.seedExtent ?? (active === undefined ? { kind: 'unframed' } : { kind: 'framed', first: active, last: active })
    const consumed = fact.coverage?.map(entry => bySeq.get(entry.item.at.seq) ?? { kind: 'unframed' } as const)
      ?? fact.shadowedSeqs?.map(seq => bySeq.get(seq) ?? { kind: 'unframed' } as const)
    const actual = consumed?.length ? enclosingExtent(consumed) : extent
    extents.set(index, actual)
    if (fact.seq !== undefined) bySeq.set(fact.seq, actual)
    if (active === undefined && ['user/message', 'assistant/message', 'tool/call', 'tool/result'].includes(fact.type)) unframedPrefix = true
    if (fact.type === 'turn/end') {
      if (active === undefined) ambiguous = true
      else { completed.push([active, active]); if (fact.seq !== undefined) ends.push({ seq: fact.seq, turn: active }) }
      active = undefined
    }
  }
  return { total, completed: turnIntervals(completed), unframedPrefix, ambiguous, inherited, extents, bySeq, ends, starts }
}
export function turnIntervals(intervals: readonly (readonly [number, number])[]): readonly (readonly [number, number])[] {
  const result: [number, number][] = []
  for (const [first, last] of [...intervals].sort((a, b) => a[0] - b[0])) {
    const previous = result.at(-1)
    if (previous && first <= previous[1] + 1) previous[1] = Math.max(previous[1], last)
    else result.push([first, last])
  }
  return result
}
