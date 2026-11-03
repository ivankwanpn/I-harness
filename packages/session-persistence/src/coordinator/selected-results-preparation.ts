import { captureSelectedResultsBootstrapPreparationFacts, type BootstrapPreparationFactsV2 } from '@i-harness/core-session'
import { semanticSeedBodyFromRecords } from '@i-harness/core-session/internal/bootstrap'
import { reconstituteSelectedResultsStage } from './selected-results-header.ts'

type DeepReadonly<T> = T extends object ? { readonly [K in keyof T]: DeepReadonly<T[K]> } : T
export type SelectedResultsPreparationFacts = DeepReadonly<Omit<BootstrapPreparationFactsV2,'semantic'> & {
  semantic: Extract<BootstrapPreparationFactsV2['semantic'],{profile:'public-completed'}>
}>
/** Derive facts only from complete validated records and the exact reconstructed stage. */
export function selectedResultsPreparationFacts(stage: unknown, records: unknown): SelectedResultsPreparationFacts {
  const checked=reconstituteSelectedResultsStage(stage,records), seed=semanticSeedBodyFromRecords(checked.seed.records)
  if (seed.version !== 3 || seed.profile !== 'public-completed') throw new TypeError('Public selected seed required')
  const s=checked.stage, header=JSON.parse(s.headerBytes)
  return captureSelectedResultsBootstrapPreparationFacts({version:2,invocation:s.invocation,manifestDigest:header.semanticSeed.manifestDigest,
    seedDigest:s.seed.digest,dependencyDigest:s.seed.dependencyDigest,sourceObservation:s.seed.sourceObservation,seedLength:s.seed.seedLength,
    groupCount:s.seed.groupCount,resultPageCount:s.seed.resultPageCount,semantic:{version:3,profile:'public-completed',selection:seed.selection,turns:seed.turns,results:seed.results.summary}}) as SelectedResultsPreparationFacts
}
