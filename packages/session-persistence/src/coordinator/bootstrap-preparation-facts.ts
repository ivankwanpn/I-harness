import { captureBootstrapPreparationFacts, type SessionEvent } from '@i-harness/core-session'
import type { BootstrapHeaderStage } from './bootstrap-types.ts'

/** The caller supplies captured request records or checkBirth-validated history. */
export function preparationFacts(stage: BootstrapHeaderStage, events: readonly SessionEvent[]) {
  const first = events[0]
  return captureBootstrapPreparationFacts({ version: 1, invocation: stage.invocation,
    manifestDigest: JSON.parse(stage.headerBytes).semanticSeed.manifestDigest,
    seedDigest: stage.seed.digest, sourceObservation: stage.seed.sourceObservation, groupCount: stage.seed.groupCount,
    ...(first?.type === 'conversation/seed-manifest' ? { semantic: { selection: first.selection, turns: first.turns } } : {}) })
}
