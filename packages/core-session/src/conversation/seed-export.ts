import type { SessionView } from '../managed/types.ts'
import type { SeedExport, SeedSourceLabel, SeedSelection, SemanticSeedV1, LegacySemanticSeed, SemanticSeedV3Public, SeedOrigin } from './seed-types.ts'
import { seedData, seedFields, seedId, validateSemanticSeed } from './seed-codec.ts'
import { seedHash, semanticSeedDomain } from './seed-digest.ts'
import { selectSeedHistory } from './seed-selection.ts'
import { captureSeedSelection, captureSeedSelectionForResults, captureSeedSelectionFromArchive } from './seed-capture.ts'
import { CURRENT_FORMAT_VERSION } from '../events/types.ts'
import { createCompletedPassiveContext, type PassiveExportOption } from './passive-seed-context.ts'
import { projectPassiveCodeStore, capturePassiveCodeStore } from '../projection/passive-code-store.ts'
import { projectSelectedResults } from './selected-results.ts'
import { isOriginalCompletedPassiveContext, type CompletedPassiveContext } from './passive-seed-context.ts'
import type { HeldInheritedResultMetadata, ResultClassification, SelectedResultPageV1 } from './selected-results-types.ts'
import { capturePassiveCodeStoreData } from '../projection/passive-code-store/capture.ts'
import { types } from 'node:util'
import { readOriginalRestoredTaskHistory } from '../managed/restored-view.ts'

const ownData = (value: unknown, key: string): unknown => value && typeof value === 'object' && !types.isProxy(value) ? Object.getOwnPropertyDescriptor(value, key)?.value : undefined

export function exportConversationSeed(view: SessionView, sourceLabel: SeedSourceLabel, selection: SeedSelection): SeedExport<SemanticSeedV1>
export function exportConversationSeed(view: SessionView, sourceLabel: SeedSourceLabel, selection: SeedSelection, passive: PassiveExportOption): SeedExport
export function exportConversationSeed(view: SessionView, sourceLabel: SeedSourceLabel, selection: SeedSelection, passive?: PassiveExportOption): SeedExport {
  if (selection.kind === 'none') return { kind: 'none' }
  try {
    if (ownData(ownData(ownData(view, 'header'), 'semanticSeed'), 'version') === 3) return { kind: 'refused', reason: 'source-unsupported' }
    const first = view.events[0]
    if (ownData(first, 'type') === 'conversation/seed-manifest' && ownData(first, 'version') === 3) return { kind: 'refused', reason: 'source-unsupported' }
    if (!Number.isSafeInteger(view.formatVersion) || view.formatVersion < 1 || view.formatVersion > CURRENT_FORMAT_VERSION) return { kind: 'refused', reason: 'source-unsupported' }
    seedData(sourceLabel); seedFields(sourceLabel, sourceLabel.kind === 'session' ? ['kind', 'sessionId'] : ['kind'])
    if (sourceLabel.kind !== 'anonymous' && (sourceLabel.kind !== 'session' || !seedId(sourceLabel.sessionId))) return { kind: 'refused', reason: 'source-unsupported' }
    const owned = selection.kind === 'completed' && passive !== undefined
    if (owned && (passive.kind !== 'public-completed-passive' || passive.owner.view !== view || sourceLabel.kind !== 'session' || sourceLabel.sessionId !== passive.owner.sourceSessionId)) return { kind: 'refused', reason: 'source-unsupported' }
    const context = owned ? createCompletedPassiveContext(passive.owner, selection) : undefined
    if (context?.kind === 'refused') return context
    const selected = context?.kind === 'ready' ? context.context.selected : selectSeedHistory(view, selection)
    if (selected.kind === 'refused') return selected
    const codeStore = context?.kind === 'ready' ? capturePassiveCodeStore(projectPassiveCodeStore(context.context)) : undefined
    const captured = captureSeedSelection(view, selected)
    const result = finalizeSeed(sourceLabel, selection, selected, captured, codeStore)
    if (owned) { try { passive.owner.assertCurrent() } catch { return { kind: 'refused', reason: 'source-changed' } } }
    return result
  } catch { return { kind: 'refused', reason: 'invalid-seed' } }
}

function finalizeSeed(sourceLabel: SeedSourceLabel, selection: Exclude<SeedSelection, {kind:'none'}>, selected: Extract<ReturnType<typeof selectSeedHistory>, {kind:'selected'}>, captured: ReturnType<typeof captureSeedSelection>, codeStore?: ReturnType<typeof capturePassiveCodeStore>) {
  const preimage = { version: codeStore ? 2 : 1, source: sourceLabel, inheritedOrigins: captured.inheritedOrigins, selection, turns: selected.turns,
    omissions: captured.omissions, artifacts: captured.artifacts, groups: captured.groups, ...(codeStore ? { passive: { codeStore } } : {}) }
  const sourceObservationDigest = seedHash(codeStore ? 'ih.semantic-seed.source.v2' : 'ih.semantic-seed.source.v1', preimage)
  const origins: SeedOrigin[] = [sourceLabel.kind === 'session'
    ? { kind: 'session', sessionId: sourceLabel.sessionId, revision: sourceObservationDigest } : { kind: 'anonymous', contentDigest: sourceObservationDigest }, ...captured.inheritedOrigins]
  const common = { origins,
    turns: selected.turns, omissions: captured.omissions, artifacts: captured.artifacts, groups: captured.groups }
  const seed: LegacySemanticSeed = codeStore && selection.kind === 'completed' ? { ...common, version: 2, selection, passive: { codeStore } } : { ...common, version: 1, selection }
  validateSemanticSeed(seed)
  return { kind: 'seed' as const, seed, digest: seedHash(semanticSeedDomain(seed), seed), sourceObservationDigest }
}

/** Internal entry accepts only a source issued by the restored conversation owner. */
export async function exportManagedTaskConversationSeed(source: object, selection: Extract<SeedSelection, {kind:'all'|'last-turns'}>): Promise<SeedExport<SemanticSeedV1>> {
  try {
    const original = readOriginalRestoredTaskHistory(source), prepared = await original.select(selection)
    if (prepared.kind === 'refused') return prepared
    if (!Number.isSafeInteger(prepared.formatVersion) || prepared.formatVersion < 1 || prepared.formatVersion > CURRENT_FORMAT_VERSION || ownData(ownData(prepared.header, 'semanticSeed'), 'version') === 3 || ownData(prepared.manifest, 'version') === 3) return {kind:'refused', reason:'source-unsupported'}
    const captured = captureSeedSelectionFromArchive(prepared.archive, prepared.header, prepared.manifest, prepared.selected, {sourceCoordinates:prepared.coordinates, pruneSubstitutes:prepared.substitutes})
    return finalizeSeed({kind:'session', sessionId:original.sessionId}, selection, prepared.selected, captured) as SeedExport<SemanticSeedV1>
  } catch { return {kind:'refused', reason:'invalid-seed'} }
}

/** Internal single-capture public metadata exporter. No route or grant is
 * created here; the original held owner supplies all source authority. */
export async function exportSelectedResultsConversationSeed(context: CompletedPassiveContext, inherited: HeldInheritedResultMetadata): Promise<SeedExport<SemanticSeedV3Public> | Extract<ResultClassification, { kind: 'refused' }>> {
  try {
    if (!isOriginalCompletedPassiveContext(context)) return { kind: 'refused', reason: 'unsupported-history' }
    context.owner.assertCurrent(); inherited.assertCurrent()
    const projected = await projectSelectedResults(context, inherited)
    if (projected.kind === 'refused') return projected
    const held = projected.results, pages: SelectedResultPageV1[] = []
    for await (const page of held.pages()) pages.push(page)
    held.assertCurrent()
    const captured = captureSeedSelectionForResults(context, held)
    const codeStore = capturePassiveCodeStoreData(projectPassiveCodeStore(context))
    held.assertCurrent()
    const source = { kind: 'session' as const, sessionId: context.owner.sourceSessionId }
    const metadata = { version: 3 as const, profile: 'public-completed' as const, selection: context.selection, turns: context.selected.turns,
      omissions: captured.omissions, artifacts: captured.artifacts, groups: captured.groups, results: { summary: held.summary, pages }, passive: { codeStore } }
    const sourceObservationDigest = seedHash('ih.semantic-seed.source.v3', { ...metadata, source, inheritedOrigins: captured.inheritedOrigins })
    const seed: SemanticSeedV3Public = { ...metadata, origins: [{ kind: 'session', sessionId: source.sessionId, revision: sourceObservationDigest }, ...captured.inheritedOrigins] }
    validateSemanticSeed(seed); held.assertCurrent()
    return { kind: 'seed', seed, digest: seedHash('ih.semantic-seed.v3', seed), sourceObservationDigest }
  } catch {
    try { context.owner.assertCurrent(); inherited.assertCurrent() } catch { return { kind: 'refused', reason: 'source-changed' } }
    return { kind: 'refused', reason: 'unsupported-history' }
  }
}
