import type { SessionView } from '../managed/types.ts'
import type { SeedExport, SeedSourceLabel, SeedSelection, SemanticSeedV1 } from './seed-types.ts'
import { seedData, seedFields, seedId, validateSemanticSeed } from './seed-codec.ts'
import { seedHash } from './seed-digest.ts'
import { selectSeedHistory } from './seed-selection.ts'
import { captureSeedSelection } from './seed-capture.ts'
import { CURRENT_FORMAT_VERSION } from '../events/types.ts'

export function exportConversationSeed(view: SessionView, sourceLabel: SeedSourceLabel, selection: SeedSelection): SeedExport {
  if (selection.kind === 'none') return { kind: 'none' }
  try {
    if (!Number.isSafeInteger(view.formatVersion) || view.formatVersion < 1 || view.formatVersion > CURRENT_FORMAT_VERSION) return { kind: 'refused', reason: 'source-unsupported' }
    seedData(sourceLabel); seedFields(sourceLabel, sourceLabel.kind === 'session' ? ['kind', 'sessionId'] : ['kind'])
    if (sourceLabel.kind !== 'anonymous' && (sourceLabel.kind !== 'session' || !seedId(sourceLabel.sessionId))) return { kind: 'refused', reason: 'source-unsupported' }
    const selected = selectSeedHistory(view, selection)
    if (selected.kind === 'refused') return selected
    const captured = captureSeedSelection(view, selected)
    const preimage = { version: 1, source: sourceLabel, inheritedOrigins: captured.inheritedOrigins, selection, turns: selected.turns,
      omissions: captured.omissions, artifacts: captured.artifacts, groups: captured.groups }
    const sourceObservationDigest = seedHash('ih.semantic-seed.source.v1', preimage)
    const seed: SemanticSeedV1 = { version: 1, origins: [sourceLabel.kind === 'session'
      ? { kind: 'session', sessionId: sourceLabel.sessionId, revision: sourceObservationDigest } : { kind: 'anonymous', contentDigest: sourceObservationDigest }, ...captured.inheritedOrigins],
      selection, turns: selected.turns, omissions: captured.omissions, artifacts: captured.artifacts, groups: captured.groups }
    validateSemanticSeed(seed)
    return { kind: 'seed', seed, digest: seedHash('ih.semantic-seed.v1', seed), sourceObservationDigest }
  } catch { return { kind: 'refused', reason: 'invalid-seed' } }
}
