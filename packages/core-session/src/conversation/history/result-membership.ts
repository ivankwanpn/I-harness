import type { HistoryFact } from './facts.ts'
import { historyVisibility } from './visibility.ts'
import type { TurnExtent } from '../seed-types.ts'

/** Metadata membership is determined by page visibility and inherited turn
 * landmarks, including groups physically later than the resource page. */
export function* inheritedResultMembership(facts: readonly HistoryFact[] | (() => Iterable<HistoryFact>)) {
  const entries = typeof facts === 'function' ? facts : () => facts
  const visibility = historyVisibility(entries())
  let manifest: HistoryFact | undefined
  const affected: TurnExtent[] = []
  for (const fact of entries()) { if (fact.type === 'conversation/seed-manifest') manifest = fact; if (fact.seedExtent && !visibility.branch(fact)) affected.push(fact.seedExtent) }
  if (!manifest || !visibility.branch(manifest)) return
  // All current cut mappings must be available before exposing any row.
  for (const fact of entries()) if (fact.seedResults && visibility.content(fact)) for (const row of fact.seedResults) for (const extent of affected) {
    if (extentOverlap(row.extent, extent) === 'partial') throw new TypeError('Ambiguous inherited result cut')
  }
  for (const fact of entries()) {
    if (!fact.seedResults || !visibility.content(fact)) continue
    for (const row of fact.seedResults) {
      let excluded = false
      for (const extent of affected) {
        const overlap = extentOverlap(row.extent, extent)
        if (overlap === 'partial') throw new TypeError('Ambiguous inherited result cut')
        if (overlap === 'inside') excluded = true
      }
      if (!excluded) yield { row, page: fact }
    }
  }
}
export function extentOverlap(value: TurnExtent, container: TurnExtent): 'outside' | 'inside' | 'partial' {
  if (value.kind === 'unframed' || container.kind === 'unframed') return value.kind === container.kind ? 'inside' : 'outside'
  if (container.last < value.first || container.first > value.last) return 'outside'
  return container.first <= value.first && container.last >= value.last ? 'inside' : 'partial'
}
