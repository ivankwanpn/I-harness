import type { SessionView } from '../managed/types.ts'
import type { SeedExport, SeedSourceLabel, SeedSelection, SemanticSeedV1, SemanticSeed, SeedOrigin } from './seed-types.ts'
import { seedData, seedFields, seedId, validateSemanticSeed } from './seed-codec.ts'
import { seedHash, semanticSeedDomain } from './seed-digest.ts'
import { selectSeedHistory } from './seed-selection.ts'
import { captureSeedSelection } from './seed-capture.ts'
import { CURRENT_FORMAT_VERSION } from '../events/types.ts'
import { createCompletedPassiveContext, type PassiveExportOption } from './passive-seed-context.ts'
import { projectPassiveCodeStore, capturePassiveCodeStore } from '../projection/passive-code-store.ts'

export function exportConversationSeed(view: SessionView, sourceLabel: SeedSourceLabel, selection: SeedSelection): SeedExport<SemanticSeedV1>
export function exportConversationSeed(view: SessionView, sourceLabel: SeedSourceLabel, selection: SeedSelection, passive: PassiveExportOption): SeedExport
export function exportConversationSeed(view: SessionView, sourceLabel: SeedSourceLabel, selection: SeedSelection, passive?: PassiveExportOption): SeedExport {
  if (selection.kind === 'none') return { kind: 'none' }
  try {
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
    const preimage = { version: codeStore ? 2 : 1, source: sourceLabel, inheritedOrigins: captured.inheritedOrigins, selection, turns: selected.turns,
      omissions: captured.omissions, artifacts: captured.artifacts, groups: captured.groups, ...(codeStore ? { passive: { codeStore } } : {}) }
    const sourceObservationDigest = seedHash(codeStore ? 'ih.semantic-seed.source.v2' : 'ih.semantic-seed.source.v1', preimage)
    const origins: SeedOrigin[] = [sourceLabel.kind === 'session'
      ? { kind: 'session', sessionId: sourceLabel.sessionId, revision: sourceObservationDigest } : { kind: 'anonymous', contentDigest: sourceObservationDigest }, ...captured.inheritedOrigins]
    const common = { origins,
      turns: selected.turns, omissions: captured.omissions, artifacts: captured.artifacts, groups: captured.groups }
    const seed: SemanticSeed = codeStore && selection.kind === 'completed' ? { ...common, version: 2, selection, passive: { codeStore } } : { ...common, version: 1, selection }
    validateSemanticSeed(seed)
    if (owned) { try { passive.owner.assertCurrent() } catch { return { kind: 'refused', reason: 'source-changed' } } }
    return { kind: 'seed', seed, digest: seedHash(semanticSeedDomain(seed), seed), sourceObservationDigest }
  } catch { return { kind: 'refused', reason: 'invalid-seed' } }
}
