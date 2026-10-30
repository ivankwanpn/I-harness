import type { CompletedPassiveContext } from '../passive-seed-context.ts'
import type { SeedOriginAddress, TurnExtent } from '../seed-types.ts'
import type { ResultBasis, UnitEvidence } from '../selected-results-types.ts'
import { exchangeCompletion } from '../unit-state.ts'
import { projectHistory } from './replacements.ts'
import type { HistoryFact } from './facts.ts'
import type { HistoryItem } from './types.ts'

export interface ResultUnit {
  item: HistoryItem; extent: TurnExtent; evidence: readonly SeedOriginAddress[]; indices: readonly number[]
  unit: UnitEvidence; state: 'closed' | 'open' | 'unresolved'; partial: boolean
  consumption?: { first: SeedOriginAddress; latest: SeedOriginAddress }
}
export const resultAt = (fact: HistoryFact, part: string = fact.type): SeedOriginAddress => ({ origin: 0, seq: fact.seq!, part })
export function unitBasis(unit: ResultUnit): ResultBasis {
  return unit.consumption ? { kind: 'consumed-closed', unit: unit.unit, consumedAt: unit.consumption.first, latestConsumption: unit.consumption.latest }
    : { kind: 'selected-observation', unit: unit.unit }
}
/** Reuse the existing reducer at rewrite boundaries, once per chain transition.
 * No reconstructed text or alternate exchange-completion policy lives here. */
export function resultUnits(context: CompletedPassiveContext) {
  const facts = context.source.facts, units = new Map<string, ResultUnit>(), consumedBy = new Map<number, Set<string>>()
  const key = (item: HistoryItem) => `${item.establishment.seq}:${item.establishment.part}`
  const remember = (item: HistoryItem): ResultUnit => {
    const id = key(item), existing = units.get(id)
    if (existing) return existing
    const sources = [...item.sources, ...item.provenance.evidence]
    if (sources.some(source => !source.addressable)) throw new TypeError('ambiguous')
    const evidence = [...new Map(sources.map(source => [`${source.seq}:${source.part}`, { origin: 0, seq: source.seq!, part: source.part }])).values()]
    const end = item.step?.members.findLast(index => ['step/end', 'step/failed'].includes(facts[index]!.type))
    const closedAt = end === undefined ? evidence.reduce((last, at) => at.seq > last.seq ? at : last) : resultAt(facts[end]!, 'step')
    const indices = [...new Set([...sources.map(source => source.eventIndex), ...(end === undefined ? [] : [end])])]
    const unit: ResultUnit = { item, extent: item.extent ?? { kind: 'unframed' }, evidence, indices,
      unit: { kind: 'exchange', at: item.unitInfo ? { origin: 0, seq: item.unitInfo.source.seq!, part: item.unitInfo.source.part } : evidence[0]!, closedAt },
      state: item.kind === 'legacy-fragment' ? 'unresolved' : exchangeCompletion(item), partial: false }
    units.set(id, unit); return unit
  }
  for (const rewrite of facts) {
    if (!['compaction/replacement', 'compaction/summary', 'compaction/reset'].includes(rewrite.type)) continue
    const prefix = projectHistory({ length: rewrite.index, get: index => facts[index]! }).items
    const covered = new Set(rewrite.coverage?.flatMap(entry => entry.sources.map(at => at.seq)) ?? rewrite.shadowedSeqs ?? rewrite.removedSeqs ?? [])
    const inheritedUnits = new Set<string>()
    for (const seq of covered) for (const id of consumedBy.get(seq) ?? []) inheritedUnits.add(id)
    for (const item of prefix) {
      const sources = [...item.sources, ...item.provenance.evidence]
      if (!sources.some(source => covered.has(source.seq!))) continue
      if (item.kind === 'summary') continue
      const unit = remember(item)
      const complete = sources.every(source => covered.has(source.seq!)) && unit.state === 'closed'
        && (!item.unitInfo || item.unitInfo.state === 'closed')
        && !prefix.some(other => other !== item && other.unit === item.unit && item.unit && [...other.sources, ...other.provenance.evidence].some(source => !covered.has(source.seq!)))
      if (!complete) { unit.partial = true; continue }
      const at = resultAt(rewrite, 'message')
      unit.consumption = { first: unit.consumption?.first ?? at, latest: at }
      inheritedUnits.add(key(item))
    }
    for (const id of inheritedUnits) {
      const unit = units.get(id)!, at = resultAt(rewrite, 'message')
      unit.consumption = { first: unit.consumption!.first, latest: at }
    }
    if (inheritedUnits.size) consumedBy.set(rewrite.seq!, inheritedUnits)
  }
  for (const item of context.source.history.items) if (item.kind === 'exchange' || item.kind === 'legacy-fragment') remember(item)
  const selected = new Set(context.selected.groups.flatMap(group => group.items).map(key))
  const represented = new Map<number, ResultUnit>(), seedUses = new Map<string, ResultUnit>()
  for (const unit of units.values()) {
    if (!(selected.has(key(unit.item)) || unit.consumption) || unit.partial || unit.state !== 'closed') continue
    for (const recipe of unit.item.recipes) {
      if (recipe.kind === 'result' && recipe.index !== undefined) represented.set(recipe.index, unit)
      if (recipe.kind === 'seed-item') seedUses.set(`${recipe.index}:${recipe.item}`, unit)
    }
  }
  return { units: [...units.values()], represented, seedUses }
}
