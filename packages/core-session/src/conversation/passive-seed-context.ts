import type { SessionView } from '../managed/types.ts'
import type { FactOwner } from '../managed/ports.ts'
import type { SeedSelection, SeedRefusal, TurnExtent } from './seed-types.ts'
import type { selectSeedHistory } from './seed-selection.ts'
import { buildSelectionSource, resolveSeedBoundary, selectSeedHistory as selectHistory } from './seed-selection.ts'
import { isManagedFactOwner } from '../managed/view.ts'
import { immutableCompletedMetadata } from './completed-metadata.ts'
import { seedData, seedFields } from './seed-codec.ts'
export type CompletedSelection = Extract<SeedSelection, { kind: 'completed' }>
export type Coordinate = Readonly<{ index: number; seq: number }>
export type Upper = { kind: 'before-event'; at: Coordinate } | { kind: 'archive-end'; eventCount: number }
type InheritedLatest = { kind: 'empty' } | { kind: 'latest'; manifest: Coordinate }
export type Boundary = { kind: 'local-completed'; lastTurn: number; end: Coordinate; upper: Upper; inherited: InheritedLatest }
  | { kind: 'explicit-inherited-group'; lastTurn: number; group: Coordinate; ordinal: number; upper: Upper; inherited: { kind: 'empty' } | { kind: 'completed'; manifest: Coordinate; turn: number } }
  | { kind: 'inherited-default'; lastTurn: number; upper: Upper; inherited: InheritedLatest }
export interface HeldSeedOwner { kind: 'held-public-fork'; sourceSessionId: string; view: SessionView; factOwner: FactOwner; assertCurrent(): void }
export interface SelectionSource { view: SessionView; coordinates: readonly Coordinate[]; facts: readonly import('./history/facts.ts').HistoryFact[]; turns: ReturnType<typeof import('./history/turns.ts').historyTurns>; history: ReturnType<import('./validation.ts').ConversationValidationIndex['history']>; originalWindows: readonly import('../projection/rewind.ts').OriginalWindow[] }
export interface CompletedPassiveContext {
  kind: 'completed-passive'; owner: HeldSeedOwner; selection: CompletedSelection; source: SelectionSource; first: 1; last: number
  selected: Extract<ReturnType<typeof selectSeedHistory>, { kind: 'selected' }>; boundary: Boundary
  groups: readonly { ordinal: number; extent: TurnExtent; establishments: readonly Coordinate[]; anchor: Coordinate }[]
}
export type ContextResult = { kind: 'ready'; context: CompletedPassiveContext } | { kind: 'refused'; reason: SeedRefusal }
export type PassiveExportOption = { kind: 'public-completed-passive'; owner: HeldSeedOwner }
const completedContexts = new WeakMap<CompletedPassiveContext, { owner: HeldSeedOwner; source: SelectionSource; selected: CompletedPassiveContext['selected']; boundary: Boundary }>()
export function isOriginalCompletedPassiveContext(context: CompletedPassiveContext): boolean {
  const original = completedContexts.get(context)
  return !!original && original.owner === context.owner && original.source === context.source && original.selected === context.selected && original.boundary === context.boundary
}
export function createCompletedPassiveContext(owner: HeldSeedOwner, selection: CompletedSelection): ContextResult {
  if (owner.kind !== 'held-public-fork' || !isManagedFactOwner(owner.view, owner.factOwner)) return { kind: 'refused', reason: 'source-unsupported' }
  try { owner.assertCurrent() } catch { return { kind: 'refused', reason: 'source-changed' } }
  try {
    try { seedFields(selection, ['kind'], ['atSeq']); seedData(selection) }
    catch { return { kind: 'refused', reason: 'invalid-selection' } }
    selection = Object.freeze({ ...selection })
    for (const [index, event] of owner.view.events.entries()) {
      const field = Object.getOwnPropertyDescriptor(event, 'seq')
      if (!field || !field.enumerable || !('value' in field) || field.value !== index) return { kind: 'refused', reason: 'source-unsupported' }
    }
    const source = buildSelectionSource(owner.view), resolved = resolveSeedBoundary(owner.view, selection, source.turns)
    if (resolved.kind === 'refused') return resolved
    const selected = selectHistory(owner.view, selection, source)
    if (selected.kind === 'refused') return selected
    const last = resolved.boundary.last, coordinate = (index: number) => {
      const at = source.coordinates[index]; if (!at) throw new TypeError('Invalid passive boundary'); return at
    }
    const before = (index: number): Upper => index < source.coordinates.length ? { kind: 'before-event', at: coordinate(index) } : { kind: 'archive-end', eventCount: source.coordinates.length }
    const requested = selection.atSeq === undefined ? undefined : owner.view.events[selection.atSeq]
    const manifestIndex = owner.view.events.findIndex(event => event.type === 'conversation/seed-manifest' && (event.version === 2 || event.version === 3 && event.profile === 'public-completed'))
    const manifest = manifestIndex < 0 ? undefined : coordinate(manifestIndex)
    const inheritedLatest: InheritedLatest = manifest ? { kind: 'latest', manifest } : { kind: 'empty' }
    const local = source.turns.ends.find(end => end.turn === last)
    let boundary: Boundary
    if (requested?.type === 'conversation/seed-group') {
      boundary = { kind: 'explicit-inherited-group', lastTurn: last, group: coordinate(selection.atSeq!), ordinal: requested.ordinal,
        upper: before(owner.view.header?.seedLength ?? 0), inherited: manifest ? { kind: 'completed', manifest, turn: last } : { kind: 'empty' } }
    } else if (local) {
      const next = source.turns.starts.find(start => start.seq > local.seq)
      boundary = { kind: 'local-completed', lastTurn: last, end: coordinate(local.seq), upper: before(next?.seq ?? source.coordinates.length), inherited: inheritedLatest }
    } else {
      const next = source.turns.starts[0]
      boundary = { kind: 'inherited-default', lastTurn: last, upper: before(next?.seq ?? source.coordinates.length), inherited: inheritedLatest }
    }
    const groups = selected.groups.map((group, ordinal) => {
      const establishments = group.items.map(item => coordinate(item.establishmentIndex))
      const anchor = establishments.reduce((first, at) => at.index < first.index ? at : first)
      return { ordinal, extent: group.extent, establishments, anchor }
    })
    const { rebase, ...selectedMetadata } = selected
    const metadata = immutableCompletedMetadata({ selection, boundary, groups, selected: selectedMetadata,
      source: { coordinates: source.coordinates, turns: source.turns, history: source.history, originalWindows: source.originalWindows } })
    // The history index already owns a frozen fact array and frozen facts.
    // Keep that exact owner metadata; do not clone its declaration population.
    const capturedSource = Object.freeze({ ...metadata.source, facts: source.facts, view: source.view })
    const capturedSelected = Object.freeze({ ...metadata.selected, rebase })
    const capturedOwner: HeldSeedOwner = Object.freeze({ kind: owner.kind, sourceSessionId: owner.sourceSessionId, view: owner.view, factOwner: owner.factOwner,
      assertCurrent: owner.assertCurrent.bind(owner) })
    const context: CompletedPassiveContext = Object.freeze({ kind: 'completed-passive', owner: capturedOwner, selection: metadata.selection, source: capturedSource,
      first: 1, last, selected: capturedSelected, boundary: metadata.boundary, groups: metadata.groups })
    try { capturedOwner.assertCurrent() } catch { return { kind: 'refused', reason: 'source-changed' } }
    completedContexts.set(context, { owner: capturedOwner, source: capturedSource, selected: capturedSelected, boundary: metadata.boundary })
    return { kind: 'ready', context }
  } catch { return { kind: 'refused', reason: 'invalid-seed' } }
}
