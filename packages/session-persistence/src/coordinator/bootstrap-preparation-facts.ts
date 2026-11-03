import { captureBootstrapPreparationFacts, type SessionEvent } from '@i-harness/core-session'
import type { BootstrapHeaderStage } from './bootstrap-types.ts'

/** The caller supplies captured request records or checkBirth-validated history. */
export function preparationFacts(stage: BootstrapHeaderStage, events: readonly SessionEvent[]) {
  const first = events[0]
  const header = JSON.parse(stage.headerBytes).semanticSeed
  if (stage.version !== 1 || stage.kind !== 'semantic-bootstrap-header' || !(header?.version === 1 && header.codec === 'semantic-seed-v1' || header?.version === 2 && header.codec === 'semantic-seed-v2')
    || first?.type === 'conversation/seed-manifest' && !(first.version === 1 && first.codec === 'semantic-seed-v1' || first.version === 2 && first.codec === 'semantic-seed-v2')) throw new TypeError('Legacy preparation facts required')
  return captureBootstrapPreparationFacts({ version: 1, invocation: stage.invocation,
    manifestDigest: JSON.parse(stage.headerBytes).semanticSeed.manifestDigest,
    seedDigest: stage.seed.digest, sourceObservation: stage.seed.sourceObservation, groupCount: stage.seed.groupCount,
    ...(first?.type === 'conversation/seed-manifest' ? { semantic: { selection: first.selection, turns: first.turns } } : {}) })
}
