import type { SessionView } from '../managed/types.ts'
import { createSemanticSourceConversationIndex } from './validation.ts'
import { historyTurns, enclosingExtent, turnIntervals } from './history/turns.ts'
import { closeSourceIntervals } from './history/intervals.ts'
import { exchangeCompletion } from './unit-state.ts'
import type { HistoryItem } from './history/types.ts'
import type { SeedSelection, SeedRefusal, SeedOmission, TurnExtent } from './seed-types.ts'
import { seedHash } from './seed-digest.ts'
import { historyFact } from './history/facts.ts'
import { originalRewindWindows } from '../projection/rewind.ts'
import type { SelectionSource } from './passive-seed-context.ts'
import { readOwnedSelectionMetadata } from '../managed/view.ts'

export type SemanticTurnBoundary = { last: number; localCutSeq?: number }
/** Closure precedes omission: interleaved complete siblings cannot escape an
 * incomplete shared-evidence interval after one member has been removed. */
export function seedSourceIntervals(keys: readonly (readonly string[])[], complete: readonly boolean[]) {
  return closeSourceIntervals(keys).map(interval => ({ ...interval, complete: complete.slice(interval.first, interval.last + 1).every(Boolean) }))
}
function sourceTurns(view: SessionView) {
  const facts = view.events.map((event, index) => historyFact(event, index))
  return historyTurns({ length: facts.length, get: index => facts[index]! })
}
/** One structural source for conversation selection and passive capture. */
export function buildSelectionSource(view: SessionView): SelectionSource {
  const owned = readOwnedSelectionMetadata(view)
  const index = owned ? undefined : createSemanticSourceConversationIndex(view.events, view.formatVersion, view.header)
  const facts = owned?.facts ?? index!.resultFacts()
  return { view, coordinates: view.events.map((event, index) => ({ index, seq: event.seq ?? index })),
    facts, turns: historyTurns({ length: facts.length, get: index => facts[index]! }), history: owned?.history ?? index!.history(), originalWindows: originalRewindWindows(view) }
}
function validSelection(selection: SeedSelection): boolean {
  if (!selection || typeof selection !== 'object') return false
  const descriptors = Object.getOwnPropertyDescriptors(selection), keys = Reflect.ownKeys(selection)
  if (keys.some(key => typeof key !== 'string' || !descriptors[key]?.enumerable || !Object.hasOwn(descriptors[key]!, 'value'))) return false
  const kind = descriptors.kind?.value
  return ['none', 'all'].includes(kind as string) ? keys.length === 1 : kind === 'last-turns' ? keys.length === 2 && Number.isSafeInteger(descriptors.count?.value) && descriptors.count!.value > 0
    : kind === 'completed' && keys.every(key => ['kind', 'atSeq'].includes(key as string)) && (!descriptors.atSeq || Number.isSafeInteger(descriptors.atSeq.value) && descriptors.atSeq.value >= 0)
}
export function resolveSeedBoundary(view: SessionView, selection: SeedSelection, turns = sourceTurns(view)): { kind: 'resolved'; boundary: SemanticTurnBoundary } | { kind: 'refused'; reason: SeedRefusal } {
  if (!validSelection(selection) || selection.kind === 'none') return { kind: 'refused', reason: 'invalid-selection' }
  if (turns.ambiguous) return { kind: 'refused', reason: 'ambiguous-boundary' }
  if (selection.kind !== 'completed') return { kind: 'resolved', boundary: { last: turns.total } }
  if (selection.atSeq !== undefined) {
    const record = view.events.find(event => event.seq === selection.atSeq)
    if (record?.type === 'conversation/seed-manifest' || record?.type === 'conversation/seed-results') return { kind: 'refused', reason: 'ambiguous-boundary' }
    if (record?.type === 'conversation/seed-group') {
      const extent = record.group.extent
      if (extent.kind !== 'framed' || extent.first !== extent.last) return { kind: 'refused', reason: 'ambiguous-boundary' }
      return turns.completed.some(([first, last]) => extent.last >= first && extent.last <= last) ? { kind: 'resolved', boundary: { last: extent.last } } : { kind: 'refused', reason: 'no-completed-boundary' }
    }
  }
  const inRange = selection.atSeq !== undefined && view.events.some(event => event.seq !== undefined && event.seq >= selection.atSeq!)
  const completed = inRange ? turns.ends.find(end => end.seq >= selection.atSeq!) : turns.ends.at(-1)
  if (completed) return { kind: 'resolved', boundary: { last: completed.turn, localCutSeq: turns.starts.find(start => start.seq > completed.seq)?.seq } }
  if (inRange && turns.starts.some(start => start.seq <= selection.atSeq!)) return { kind: 'refused', reason: 'no-completed-boundary' }
  const inherited = turns.completed.at(-1)?.[1]
  return inherited === undefined ? { kind: 'refused', reason: 'no-completed-boundary' } : { kind: 'resolved', boundary: { last: inherited } }
}

/** Select descriptors before payload rendering. Input observations may be split
 * from an unfinished physical unit only when their own evidence is input-only. */
export function selectSeedHistory(view: SessionView, selection: Exclude<SeedSelection, { kind: 'none' }>, built?: SelectionSource) {
  if (!validSelection(selection)) return { kind: 'refused' as const, reason: 'invalid-selection' as const }
  const source = built ?? buildSelectionSource(view)
  const resolved = resolveSeedBoundary(view, selection, source.turns)
  if (resolved.kind === 'refused') return resolved
  const history = source.history, turns = source.turns, last = resolved.boundary.last
  const first = selection.kind === 'last-turns' ? Math.max(1, turns.total - selection.count + 1) : 1
  const includeUnframed = selection.kind !== 'last-turns' || selection.count >= turns.total
  const rebase = (extent: TurnExtent): TurnExtent => extent.kind === 'unframed' ? extent : { kind: 'framed', first: extent.first - first + 1, last: extent.last - first + 1 }
  const extentSelection = (extent: TurnExtent) => extent.kind === 'unframed' ? includeUnframed ? 'inside' : 'outside'
    : extent.last < first || extent.first > last ? 'outside' : extent.first < first || extent.last > last ? 'straddling' : 'inside'
  const omissions: SeedOmission[] = [], omittedInputs = new Map<HistoryItem, number>()
  const partitioned: HistoryItem[] = [], originalInputs = new Map<HistoryItem, HistoryItem>()
  const omittedUnits = new Map<string, number>()
  const refs = (item: HistoryItem) => [...item.sources, ...item.provenance.evidence, ...(item.unitInfo ? [item.unitInfo.source] : []), ...item.calls.flatMap(call => [call.call, call.result, call.dispatch].filter(ref => !!ref))]
  const complete = (item: HistoryItem) => item.kind !== 'legacy-fragment' && (!item.unitInfo || item.unitInfo.state === 'closed') && (item.kind !== 'exchange' || exchangeCompletion(item) === 'closed')
  for (const item of history.items) {
    if (item.kind === 'input' && !complete(item)) {
      const inputRefs = [...item.sources, ...item.provenance.evidence].filter(ref => ref.part !== 'step')
      if (inputRefs.some(ref => !['user/message', 'agent/input/admitted', 'conversation/seed-group'].includes(view.events[ref.eventIndex]!.type)
        || !['message', 'admission', 'image', 'group'].includes(ref.part) && !/^item:\d+(?::media:\d+)?$/.test(ref.part))) return { kind: 'refused' as const, reason: 'unsafe-input-component' as const }
      const input = { ...item, unit: undefined, unitInfo: undefined, sources: item.sources.filter(ref => ref.part !== 'step'), provenance: { ...item.provenance, evidence: item.provenance.evidence.filter(ref => ref.part !== 'step') } }
      partitioned.push(input); originalInputs.set(input, item)
    } else partitioned.push(item)
  }
  const key = (item: HistoryItem) => item.unitInfo?.source.id ?? item.id
  const omit = (members: HistoryItem[]): number => {
    const unitKeys = new Set(members.map(key))
    const siblings = [...new Set([...members, ...history.items.filter(item => unitKeys.has(key(item)))])]
    const addresses = [...new Map(siblings.flatMap(refs).map(ref => [ref.id, ref])).values()]
    if (addresses.some(ref => !ref.addressable)) throw new TypeError('Unaddressable omitted source')
    const preimage = { extent: enclosingExtent(siblings.map(item => item.extent ?? { kind: 'unframed' })), source: addresses.map(ref => ({ origin: 0, seq: ref.seq!, part: ref.part })), state: siblings.some(item => item.unitInfo?.state === 'open') ? 'open' as const : 'unresolved' as const,
      calls: siblings.reduce((count, item) => count + item.calls.length, 0), relatedInputs: [] as number[] }
    const ordinal = omissions.length
    omissions.push({ ...preimage, digest: seedHash('ih.semantic-seed.omission.v1', preimage) })
    for (const item of siblings) omittedUnits.set(key(item), ordinal)
    return ordinal
  }
  const intervals = seedSourceIntervals(partitioned.map(item => refs(item).map(ref => ref.id)), partitioned.map(complete))
  for (const interval of intervals) if (!interval.complete) omit(partitioned.slice(interval.first, interval.last + 1))
  for (const [input, original] of originalInputs) {
    let omission = omittedUnits.get(key(original))
    if (omission === undefined) omission = omit([original])
    const position = partitioned.indexOf(input), component = intervals.find(interval => interval.first <= position && interval.last >= position)!
    omissions[omission]!.extent = enclosingExtent([omissions[omission]!.extent, ...partitioned.slice(component.first, component.last + 1).map(item => item.extent ?? { kind: 'unframed' } as const)])
    omittedInputs.set(input, omission)
  }
  const groups: { extent: TurnExtent; items: HistoryItem[] }[] = []
  for (const interval of intervals) {
    if (!interval.complete) continue
    const items = partitioned.slice(interval.first, interval.last + 1), extent = enclosingExtent(items.map(item => item.extent ?? { kind: 'unframed' }))
    const selected = extentSelection(extent)
    if (selected === 'outside') continue
    if (selected === 'straddling') return { kind: 'refused' as const, reason: 'straddling-group' as const }
    groups.push({ extent, items })
  }
  const retainedOmissions: SeedOmission[] = [], omissionOrdinals = new Map<number, number>()
  for (const [ordinal, omission] of omissions.entries()) {
    const selected = extentSelection(omission.extent)
    if (selected === 'straddling') return { kind: 'refused' as const, reason: 'straddling-group' as const }
    if (selected === 'inside') { omissionOrdinals.set(ordinal, retainedOmissions.length); retainedOmissions.push({ ...omission, extent: rebase(omission.extent) }) }
  }
  const retainedInputOmissions = new Map<HistoryItem, number>()
  const selectedItems = new Set(groups.flatMap(group => group.items))
  for (const [input, original] of omittedInputs) if (selectedItems.has(input)) {
    const ordinal = omissionOrdinals.get(original)
    if (ordinal === undefined) return { kind: 'refused' as const, reason: 'straddling-group' as const }
    retainedInputOmissions.set(input, ordinal)
  }
  const manifest = view.events.find(event => event.type === 'conversation/seed-manifest')
  const inheritedOmissions: { ordinal: number; omission: SeedOmission }[] = []
  if (manifest?.type === 'conversation/seed-manifest') for (const [ordinal, omission] of manifest.omissions.entries()) {
    const selected = extentSelection(omission.extent)
    if (selected === 'straddling') return { kind: 'refused' as const, reason: 'straddling-group' as const }
    if (selected === 'inside') inheritedOmissions.push({ ordinal, omission: { ...omission, extent: rebase(omission.extent) } })
  }
  return { kind: 'selected' as const, groups, omissions: retainedOmissions, omittedInputs: retainedInputOmissions, inheritedOmissions, rebase,
    turns: { total: Math.max(0, last - first + 1), completed: turnIntervals(turns.completed.filter(([start, end]) => end >= first && start <= last).map(([start, end]) => [Math.max(first, start) - first + 1, Math.min(last, end) - first + 1])), unframedPrefix: includeUnframed && turns.unframedPrefix }, diagnostics: history.diagnostics }
}
