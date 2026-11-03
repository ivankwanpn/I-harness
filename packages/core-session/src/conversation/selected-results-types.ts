import type { SessionEvent } from '../events/types.ts'
import type { ManagedArtifactRef } from '../results/types.ts'
import type { Digest, SeedOriginAddress, TurnExtent } from './seed-types.ts'
import type { LegacyVisibilityAnchor } from './seed-retention.ts'

export type LegacyRef = Extract<SessionEvent, { type: 'context/result-ref' }>['ref']
export type LocalResultSlot = { event: 'tool/result' | 'code/result' | 'code/output' | 'subagent/end'; slot: 'envelope.retention.ref' | 'envelope.dependencies.ref' }
  | { event: 'job/status'; slot: 'job.result.envelope.retention.ref' | 'job.result.envelope.dependencies.ref' }
  | { event: 'context/result-ref'; slot: 'ref' }
export type ManagedResultSlot = Exclude<LocalResultSlot, { event: 'context/result-ref' }>
export type ResultAddress = ({ kind: 'local'; sessionId: string; seq: number } & LocalResultSlot)
  | { kind: 'seed-use'; sessionId: string; seq: number; event: 'conversation/seed-group'; item: number; result: number; slot: 'sourceRetention.artifact' | 'dependencies.artifact' }
export type ResultUse = { kind: 'result' } | { kind: 'dependency-catalog'; count: number }
export type ManagedResultObservation = { address: ManagedResultSlot; ref: ManagedArtifactRef; use: ResultUse }
export type UnitEvidence = { at: SeedOriginAddress; closedAt: SeedOriginAddress; kind: 'exchange' | 'code-cell' | 'job' | 'subagent' }
export type ResultBasis = { kind: 'selected-observation'; unit: UnitEvidence }
  | { kind: 'consumed-closed'; unit: UnitEvidence; consumedAt: SeedOriginAddress; latestConsumption: SeedOriginAddress }
  | { kind: 'standalone-native'; unit: UnitEvidence; completedCell: SeedOriginAddress }
  | { kind: 'inherited'; parentSeedDigest: Digest; parentResultsDigest: Digest; row: number }
export type ResultRowBase = { ordinal: number; original: ResultAddress; extent: TurnExtent; basis: ResultBasis; branchEvidence: readonly SeedOriginAddress[] }
export type SelectedResultRow = ResultRowBase & ({ protocol: 'managed'; ref: ManagedArtifactRef; use: ResultUse } | { protocol: 'legacy'; ref: LegacyRef })
export type ResultExclusion = 'outside' | 'future' | 'hidden' | 'rewound' | 'open' | 'unresolved' | 'omitted' | 'native-not-completed'
export type ResultClassification = { kind: 'included'; row: Omit<SelectedResultRow, 'ordinal'> }
  | { kind: 'excluded'; reason: ResultExclusion }
  | { kind: 'refused'; reason: 'ambiguous' | 'unsupported-history' | 'metadata-limit' | 'source-changed' }
export type SelectedResultPageV1 = { version: 1; ordinal: number; firstRow: number; extent: TurnExtent; rows: readonly SelectedResultRow[] }
export type ResultsSummaryV1 = { version: 1; rows: number; pages: number; digest: Digest }
export interface HeldSelectedResults {
  readonly summary: ResultsSummaryV1
  assertCurrent(): void
  pages(): AsyncIterable<SelectedResultPageV1>
  classifications(): AsyncIterable<ResultClassification>
}
export type SelectedResultsOutcome = { kind: 'selected'; results: HeldSelectedResults } | Extract<ResultClassification, { kind: 'refused' }>
/** Original protocol owner supplies only its verified plan/canonical metadata. */
export interface HeldInheritedResultMetadata {
  assertCurrent(): void
  legacy(): AsyncIterable<{ ref: LegacyRef; original: ResultAddress; extent: TurnExtent; anchor: LegacyVisibilityAnchor }>
}
