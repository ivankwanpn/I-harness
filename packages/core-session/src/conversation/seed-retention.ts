import { createHash } from 'node:crypto'
import type { SessionView } from '../managed/types.ts'
import type { SessionEvent } from '../events/types.ts'
import type { SeedSelection, SeedRefusal, TurnExtent } from './seed-types.ts'
import { streamJsonData } from '../serialization/json-stream.ts'
import { resolveSeedBoundary, selectSeedHistory } from './seed-selection.ts'
import { historyVisibility } from './history/visibility.ts'
import { historyFact } from './history/facts.ts'
import { historyTurns, turnIntervals } from './history/turns.ts'
import { createSemanticSourceConversationIndex } from './validation.ts'
import { CURRENT_FORMAT_VERSION } from '../events/types.ts'
import { seedLayout } from './seed-layout.ts'
import { inheritedResultMembership } from './history/result-membership.ts'
import { canonicalJsonData } from '../serialization/json-data.ts'

type Anchor = { kind: 'manifest'; seq: 0 } | { kind: 'seed-group'; manifestSeq: 0; ordinal: number } | {kind:'seed-result';manifestSeq:0;pageOrdinal:number;rowOrdinal:number}
type Ref = Extract<SessionEvent, { type: 'context/result-ref' }>['ref']
type Candidate = { ref: Ref; original: { seq: number; part: 'context/result-ref.ref' }; extent: TurnExtent; anchor: Anchor }
type Refused = { kind: 'refused'; reason: SeedRefusal | 'legacy-anchor-unsupported' }

function legacyStructure(view: SessionView) {
  const seen = new Set<number>()
  for (const event of view.events) {
    if (!Number.isSafeInteger(event.seq) || event.seq! < 0 || seen.has(event.seq!)) return { kind: 'refused', reason: 'legacy-anchor-unsupported' } as Refused
    seen.add(event.seq!)
  }
  const facts = view.events.map((event, index) => historyFact(event, index))
  const turns = historyTurns({ length: facts.length, get: index => facts[index]! })
  return { kind: 'structure' as const, facts, turns, visibility: historyVisibility(facts) }
}

export type LegacyVisibilityAnchor = Anchor
export type LegacyVisibleRef = { ref: Ref; original: { seq: number; part: 'context/result-ref.ref' } }
export type LegacyReadVisibility = Refused | { kind: 'visible'; local(): Iterable<LegacyVisibleRef>; anchorVisible(anchor: LegacyVisibilityAnchor, extent: TurnExtent): boolean; resultRow(anchor: Extract<LegacyVisibilityAnchor,{kind:'seed-result'}>, extent:TurnExtent): Extract<import('./selected-results-types.ts').SelectedResultRow,{protocol:'legacy'}>|undefined }

/** Current-coordinate read visibility; B1 remains the projection/consumption owner. */
export function createLegacyReadVisibility(view: SessionView): LegacyReadVisibility {
  try {
    if (!Number.isSafeInteger(view.formatVersion) || view.formatVersion < 1 || view.formatVersion > CURRENT_FORMAT_VERSION) return { kind: 'refused', reason: 'source-unsupported' }
    const structure = legacyStructure(view)
    if (structure.kind === 'refused') return structure
    const { facts, turns, visibility } = structure
    if (turns.ambiguous) return { kind: 'refused', reason: 'ambiguous-boundary' }
    const history = createSemanticSourceConversationIndex(view.events, view.formatVersion, view.header).history()
    function* local(): Iterable<LegacyVisibleRef> {
      for (const [index, event] of view.events.entries()) {
        if (event.type === 'context/result-ref' && visibility.content(facts[index]!)) yield { ref: event.ref as Ref, original: { seq: event.seq!, part: 'context/result-ref.ref' } }
      }
    }
    let results:Map<number,{row:import('./selected-results-types.ts').SelectedResultRow;page:number}>|undefined
    return { kind: 'visible', local,
      resultRow(anchor,extent) {
        const manifest=view.events[0];if(manifest?.type!=='conversation/seed-manifest'||manifest.version!==3||anchor.manifestSeq!==0)return
        if(!Number.isSafeInteger(anchor.pageOrdinal)||anchor.pageOrdinal<0||!Number.isSafeInteger(anchor.rowOrdinal)||anchor.rowOrdinal<0)return
        let seq:number;try{seq=seedLayout(manifest).resultPageSeq(anchor.pageOrdinal)}catch{return}
        const event=view.events[seq];if(!event||event.type!=='conversation/seed-results'||event.seq!==seq||event.ordinal!==anchor.pageOrdinal||event.manifestSeq!==0)return
        const row=event.page.rows[anchor.rowOrdinal-event.page.firstRow]
        if(!row||row.ordinal!==anchor.rowOrdinal||row.protocol!=='legacy'||canonicalJsonData(row.extent)!==canonicalJsonData(extent))return
        if(!results){const captured=new Map<number,{row:import('./selected-results-types.ts').SelectedResultRow;page:number}>();for(const member of inheritedResultMembership(facts)){if(captured.has(member.row.ordinal))throw TypeError('Duplicate selected result ordinal');captured.set(member.row.ordinal,{row:member.row,page:member.page.index})}results=captured}
        const member=results.get(row.ordinal);if(member&&member.page===seq&&canonicalJsonData(member.row)===canonicalJsonData(row))return row
      },
      anchorVisible(anchor, extent) {
        if (extent.kind === 'framed' && (!Number.isSafeInteger(extent.first) || !Number.isSafeInteger(extent.last) || extent.first < 1 || extent.last < extent.first || extent.last > turns.total)) return false
        if (extent.kind !== 'framed' && extent.kind !== 'unframed') return false
        const manifest = view.events[0]
        if (manifest?.type !== 'conversation/seed-manifest' || manifest.seq !== 0) return false
        if (anchor.kind === 'manifest') return anchor.seq === 0 && extent.kind === 'unframed' && manifest.turns.unframedPrefix && visibility.content(facts[0]!)
        if (anchor.kind !== 'seed-group' || anchor.manifestSeq !== 0 || !Number.isSafeInteger(anchor.ordinal) || anchor.ordinal < 0 || extent.kind !== 'framed') return false
        const index = view.events.findIndex(event => event.type === 'conversation/seed-group' && event.manifestSeq === 0 && event.ordinal === anchor.ordinal)
        const event = view.events[index]
        if (!event || event.type !== 'conversation/seed-group' || event.seq !== seedLayout(manifest).groupSeq(anchor.ordinal) || !visibility.content(facts[index]!)
          || event.group.extent.kind !== 'framed' || extent.first < event.group.extent.first || extent.last > event.group.extent.last) return false
        const extents: (readonly [number, number])[] = []
        for (const item of history.items) for (const recipe of item.recipes) {
          if (recipe.kind !== 'seed-item' || recipe.index !== index || recipe.item === undefined) continue
          const source = event.group.items[recipe.item]
          if (!source) throw new TypeError('Invalid surviving seed recipe')
          if (source.extent.kind === 'framed') extents.push([source.extent.first, source.extent.last])
        }
        return turnIntervals(extents).some(([first, last]) => first <= extent.first && last >= extent.last)
      } }
  } catch { return { kind: 'refused', reason: 'legacy-anchor-unsupported' } }
}

/** Shares B1's boundary, branch and closed-group selection without rendering. */
export function createLegacyRetentionSelection(view: SessionView, selection: Exclude<SeedSelection, { kind: 'none' }>) {
  const selected = selectSeedHistory(view, selection), boundary = resolveSeedBoundary(view, selection)
  if (selected.kind === 'refused') return selected
  if (boundary.kind === 'refused') return boundary
  const chosen = selected
  const structure = legacyStructure(view)
  if (structure.kind === 'refused') return structure
  const { facts, turns, visibility } = structure
  const anchorFor = (extent: TurnExtent, callId?: string): Anchor | undefined => {
    if (extent.kind === 'unframed') return selected.turns.unframedPrefix ? { kind: 'manifest', seq: 0 } : undefined
    const matches = selected.groups.flatMap((group, ordinal) => group.extent.kind === 'framed' && group.extent.first <= extent.first && group.extent.last >= extent.last ? [ordinal] : [])
    const correlated = matches.length > 1 && callId !== undefined ? matches.filter(ordinal => selected.groups[ordinal]!.items.some(item => item.calls.some(call => call.callId === callId))) : matches
    return correlated.length === 1 ? { kind: 'seed-group', manifestSeq: 0, ordinal: correlated[0]! } : undefined
  }
  function* local(): Iterable<Candidate> {
    let priorTurn: TurnExtent = { kind: 'unframed' }
    for (const [index, event] of view.events.entries()) {
      if (event.type === 'turn/start') priorTurn = turns.extents.get(index)!
      if (event.type !== 'context/result-ref' || !visibility.content(facts[index]!) || boundary.kind !== 'resolved' || boundary.boundary.localCutSeq !== undefined && event.seq! >= boundary.boundary.localCutSeq) continue
      const extent = priorTurn
      if (selection.kind === 'last-turns') {
        // Reuse the semantic selector's original-to-child extent mapping. Refs
        // outside the chosen suffix need no transfer and no guessed anchor.
        const rebased = chosen.rebase(extent)
        if (rebased.kind === 'unframed' && !chosen.turns.unframedPrefix) continue
        if (rebased.kind === 'framed') {
          if (rebased.last < 1 || rebased.first > chosen.turns.total) continue
          if (rebased.first < 1 || rebased.last > chosen.turns.total) throw new TypeError('legacy-anchor-unsupported')
        }
      } else if (extent.kind === 'framed' && extent.last > chosen.turns.total) continue
      const anchor = anchorFor(extent, event.ref.callId)
      if (!anchor) throw new TypeError('legacy-anchor-unsupported')
      yield { ref: event.ref as Ref, original: { seq: event.seq!, part: 'context/result-ref.ref' }, extent: chosen.rebase(extent), anchor }
    }
  }
  // Detect unsupported anchors before the caller can publish a prefix.
  try { for (const _ of local()) { /* metadata only */ } } catch { return { kind: 'refused', reason: 'legacy-anchor-unsupported' } as Refused }
  const hash = createHash('sha256').update('ih.legacy-fork.turn-domain.v1\0')
  for (const chunk of streamJsonData(selected.turns, { lexical: true, dataOnly: true })) hash.update(chunk)
  return { kind: 'selected' as const, turnDomainDigest: hash.digest('hex'), totalTurns: selected.turns.total, unframedPrefix: selected.turns.unframedPrefix, local,
    inherited(extent: TurnExtent, anchor: Anchor) {
      if (selection.kind === 'last-turns') {
        if (extent.kind === 'framed' && (!Number.isSafeInteger(extent.first) || !Number.isSafeInteger(extent.last) || extent.first < 1 || extent.last < extent.first)) {
          return { kind: 'refused' as const, reason: 'legacy-anchor-unsupported' as const }
        }
        const rebased = selected.rebase(extent)
        if (rebased.kind === 'unframed' && !selected.turns.unframedPrefix) return { kind: 'omitted' as const }
        if (rebased.kind === 'framed') {
          if (rebased.last < 1 || rebased.first > selected.turns.total) return { kind: 'omitted' as const }
          if (rebased.first < 1 || rebased.last > selected.turns.total) return { kind: 'refused' as const, reason: 'legacy-anchor-unsupported' as const }
        }
      } else {
        if (extent.kind === 'framed' && extent.first > selected.turns.total) return { kind: 'omitted' as const }
        if (extent.kind === 'framed' && extent.last > selected.turns.total) return { kind: 'refused' as const, reason: 'legacy-anchor-unsupported' as const }
      }
      if (anchor.kind === 'seed-group') {
        const event = view.events.find(event => event.type === 'conversation/seed-group' && event.ordinal === anchor.ordinal)
        if (!event || !visibility.content(facts[view.events.indexOf(event)]!)) return { kind: 'omitted' as const }
        const index = view.events.indexOf(event), groups = selected.groups.flatMap((group, ordinal) => group.items.some(item => item.sources.some(source => source.eventIndex === index) || item.recipes.some(recipe => recipe.index === index)) ? [ordinal] : [])
        if (groups.length !== 1) return { kind: 'refused' as const, reason: 'legacy-anchor-unsupported' as const }
        return { kind: 'included' as const, extent: selected.rebase(extent), anchor: { kind: 'seed-group' as const, manifestSeq: 0 as const, ordinal: groups[0]! } }
      }
      if(anchor.kind==='seed-result')return { kind: 'refused' as const, reason: 'legacy-anchor-unsupported' as const }
      const rebased = anchorFor(extent)
      return rebased ? { kind: 'included' as const, extent: selected.rebase(extent), anchor: rebased } : { kind: 'refused' as const, reason: 'legacy-anchor-unsupported' as const }
    } }
}
