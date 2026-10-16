import { addressKey, compareAddresses, itemRefKey, replacementFormatError as fail, type ConversationAddress, type ConversationItemRef } from '../../events/replacement.ts'
import { awaitingItemResults } from '../exchange.ts'
import type { HistoryItem } from './types.ts'
import { historyEntries, type HistoryArchive, type HistoryFact } from './facts.ts'
import { groupConversationHistory } from './group.ts'
import { historyVisibility } from './visibility.ts'
import { conversationSeq } from '../../events/conversation.ts'

export function historyItemRef(item: HistoryItem): ConversationItemRef | undefined {
  if (item.kind === 'legacy-fragment' || !item.establishment.addressable || [...item.sources, ...item.provenance.evidence].some(source => !source.addressable)) return
  return { kind: item.kind, at: { seq: item.establishment.seq!, part: item.establishment.part } }
}
export function historyItemCoverage(item: HistoryItem): ConversationAddress[] {
  const sources = new Map<string, ConversationAddress>()
  for (const source of [...item.sources, ...item.provenance.evidence]) {
    const at = { seq: source.seq!, part: source.part }
    sources.set(addressKey(at), at)
  }
  return [...sources.values()].sort(compareAddresses)
}
const touches = (item: HistoryItem, consumed: ReadonlySet<string>) => [...item.sources, ...item.provenance.evidence].some(source => source.seq !== undefined && consumed.has(addressKey({ seq: source.seq, part: source.part })))

/** Consumed sources are monotone independently of the emitted summary's
 * visibility. A future cut can hide a summary, never undo its consumption. */
export function projectHistory(archive: HistoryArchive, throughSeq?: number) {
  const grouped = groupConversationHistory(archive, throughSeq)
  let items = grouped.items
  const consumed = new Set<string>(), positions = new Map<number, number>()
  const bySeq = new Map<number, number>()
  for (const [index, fact] of historyEntries(archive)) if (fact.seq !== undefined) bySeq.set(fact.seq, index)
  for (const [index, fact] of historyEntries(archive)) {
    if (fact.type !== 'compaction/replacement' || throughSeq !== undefined && fact.seq! > throughSeq) continue
    const origin = fact.coverage![0]!.item.at.seq
    const position = positions.get(origin) ?? bySeq.get(origin)!
    positions.set(fact.seq!, position)
    const summary = items.find(item => item.establishmentIndex === index)
    const names = new Set(fact.coverage!.map(coverage => itemRefKey(coverage.item)))
    const selectedIndex = items.findIndex(item => { const ref = historyItemRef(item); return ref && names.has(itemRefKey(ref)) })
    const before = selectedIndex >= 0 ? items.slice(0, selectedIndex).filter(item => item !== summary && !touches(item, consumed)) : undefined
    for (const coverage of fact.coverage!) for (const source of coverage.sources) consumed.add(addressKey(source))
    const kept = items.filter(item => item !== summary && !touches(item, consumed))
    if (summary && !touches(summary, consumed)) {
      const insertion = before ? before.filter(item => kept.includes(item)).length : kept.findIndex(item => (positions.get(item.establishment.seq!) ?? item.establishmentIndex) > position)
      kept.splice(insertion < 0 ? kept.length : insertion, 0, summary)
    }
    items = kept
  }
  return { ...grouped, items }
}

/** Prefix-only checks: later results, closures, shadows and cuts are absent. */
export function validateHistoricalReplacement(archive: HistoryArchive, replacement: HistoryFact): ReadonlySet<number> {
  const { items } = projectHistory(archive)
  const seq = replacement.seq!
  for (const [, fact] of historyEntries(archive)) if (fact.type === 'compaction/replacement' && fact.replacementId === replacement.replacementId) fail('duplicate-id', seq)
  const coverage = replacement.coverage!
  if (itemRefKey(replacement.insertBefore!) !== itemRefKey(coverage[0]!.item)) fail('noncontiguous', seq)
  const keys = items.map(item => { const ref = historyItemRef(item); return ref && itemRefKey(ref) })
  const start = keys.indexOf(itemRefKey(coverage[0]!.item))
  if (start < 0) fail('missing-source', seq)
  const selected = items.slice(start, start + coverage.length)
  if (coverage.some((entry, index) => keys[start + index] !== itemRefKey(entry.item))) fail('noncontiguous', seq)
  const dependencies = new Set<number>()
  const visibility = historyVisibility(archive)
  let turn: number | undefined
  let ambiguousTurn = false
  for (const [index, event] of historyEntries(archive)) if (visibility.branch(event)) {
    if (event.type === 'turn/start') { if (turn !== undefined) ambiguousTurn = true; turn = index }
    else if (event.type === 'turn/end') { if (turn === undefined) ambiguousTurn = true; turn = undefined }
  }
  if (ambiguousTurn) fail('protected-source', seq)
  for (const [index, item] of selected.entries()) {
    const actual = historyItemCoverage(item), expected = coverage[index]!.sources
    if (actual.length !== expected.length || actual.some((at, index) => at.seq !== expected[index]!.seq || at.part !== expected[index]!.part)) fail('coverage-mismatch', seq)
    if (item.provenance.scope === 'session' || item.kind === 'input' && turn !== undefined && item.establishmentIndex > turn) fail('protected-source', seq)
    if (item.kind === 'legacy-fragment' || item.kind === 'exchange' && (!item.step || !item.step.ended || item.step.failed || item.step.suppressed
      || item.calls.some(call => call.outcome === 'unknown' || call.outcome === 'pending') || awaitingItemResults(item))) fail('incomplete-unit', seq)
    if (item.unit && items.some(other => other.unit === item.unit && !selected.includes(other))) fail('incomplete-unit', seq)
    for (const source of [...item.sources, ...item.provenance.evidence]) {
      if (!source.addressable || source.seq! >= seq) fail('unsafe-address', seq)
      dependencies.add(source.seq!)
    }
    if (item.unit) for (const member of item.unit.members) {
      const fact = archive.get(member)
      if (!['step/start', 'step/end', 'step/failed', 'assistant/message', 'model/exchange-accepted', 'tool/call', 'tool/dispatch', 'tool/result', 'user/message'].includes(fact.type)) continue
      if (fact.seq === undefined) fail('unsafe-address', seq)
      dependencies.add(fact.seq)
    }
    if (item.kind === 'input') {
      let start: HistoryFact | undefined
      for (const [index, fact] of historyEntries(archive)) if (visibility.branch(fact)) {
        if (fact.type === 'turn/start' && index <= item.establishmentIndex) start = fact
        if (fact.type === 'turn/end' && index > item.establishmentIndex && start) {
          if (start.seq === undefined || fact.seq === undefined) fail('unsafe-address', seq)
          dependencies.add(start.seq); dependencies.add(fact.seq); break
        }
      }
    }
  }
  // Prior rewrite evidence and semantics fences make the prefix interpretation
  // reproducible. Seed compilation recursively requires the records they name.
  for (const [, fact] of historyEntries(archive)) if (['conversation/semantics', 'compaction/replacement', 'compaction/summary', 'compaction/reset', 'rewind/point'].includes(fact.type) && fact.seq !== undefined) dependencies.add(fact.seq)
  for (const [, fact] of historyEntries(archive)) if ((fact.type === 'agent/input/promoted' || fact.type === 'agent/input/admitted') && selected.some(item => item.admissionIndex !== undefined && archive.get(item.admissionIndex).inputId === fact.inputId) && fact.seq !== undefined) dependencies.add(fact.seq)
  const counts = new Map<number, number>()
  for (const [, fact] of historyEntries(archive)) if (conversationSeq(fact.seq)) counts.set(fact.seq, (counts.get(fact.seq) ?? 0) + 1)
  for (const dependency of dependencies) if (!conversationSeq(dependency) || dependency >= seq || counts.get(dependency) !== 1) fail('unsafe-address', seq)
  return dependencies
}
