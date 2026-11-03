import type { SemanticSeedV1, SemanticSeedV2, SemanticSeedV3, SemanticSeedV3Public, SemanticSeedV3Child, SeedGroup, Digest } from '../conversation/seed-types.ts'
import type { ResultsSummaryV1, SelectedResultPageV1 } from '../conversation/selected-results-types.ts'

export interface BootstrapInvocation { version: 1; operationId: string; targetSessionId: string; createdAt: string; requestDigest: Digest }
export type BootstrapPhase = 'header' | 'dependencies' | 'seed' | 'completion'
export type BootstrapResumeToken = { version: 1; invocation: BootstrapInvocation; manifestDigest: Digest; phase: BootstrapPhase }
  | { version: 1; invocation: BootstrapInvocation; phase: 'header'; manifest: 'unknown' }
export interface ChildBootstrapIntent { version: 1; invocation: BootstrapInvocation; startedAt: number; expiresAt: number }
export interface SeedHeaderV1 {
  version: 1; codec: 'semantic-seed-v1'; operationId: string; requestDigest: Digest; manifestDigest: Digest; seedDigest: Digest
  dependencyDigest: Digest; seedLength: number; groupCount: number; initialInputId?: string; initialInputDigest?: Digest
  initialStartedAt?: number; initialExpiresAt?: number
}
export type SeedHeaderV2 = Omit<SeedHeaderV1, 'version' | 'codec'> & { version: 2; codec: 'semantic-seed-v2' }
export type SeedHeaderV3 = Omit<SeedHeaderV1, 'version' | 'codec'> & { version: 3; codec: 'semantic-seed-v3'; profile: SemanticSeedV3['profile']; results: ResultsSummaryV1; resultPageCount: number }
export type SeedHeader = SeedHeaderV1 | SeedHeaderV2 | SeedHeaderV3
export interface SeedManifestRecordV1 {
  type: 'conversation/seed-manifest'; version: 1; seq: number; codec: 'semantic-seed-v1'; digest: Digest; groupCount: number
  origins: SemanticSeedV1['origins']; selection: SemanticSeedV1['selection']; turns: SemanticSeedV1['turns']
  omissions: SemanticSeedV1['omissions']; artifacts: SemanticSeedV1['artifacts']
}
export type SeedManifestV2 = Omit<SeedManifestRecordV1, 'version' | 'codec' | 'selection'> & {
  version: 2; codec: 'semantic-seed-v2'; selection: SemanticSeedV2['selection']; passive: SemanticSeedV2['passive']
}
type SeedManifestV3Of<T extends SemanticSeedV3> = Omit<T, 'groups' | 'results'> & { type: 'conversation/seed-manifest'; seq: 0; codec: 'semantic-seed-v3'; digest: Digest; groupCount: number; results: ResultsSummaryV1; resultPageCount: number }
export type SeedManifestV3 = SeedManifestV3Of<SemanticSeedV3Public> | SeedManifestV3Of<SemanticSeedV3Child>
export type SeedManifestRecord = SeedManifestRecordV1 | SeedManifestV2 | SeedManifestV3
// Event intake assigns physical sequence numbers before the closed codec
// verifies the V3 manifest's required zero coordinate.
type PhysicalManifest<T> = T extends SeedManifestRecord ? Omit<T, 'seq'> & { seq: number } : never
export type SeedManifestEvent = PhysicalManifest<SeedManifestRecord>
export interface SeedResultsRecordV1 { type: 'conversation/seed-results'; version: 1; seq: number; manifestSeq: 0; ordinal: number; page: SelectedResultPageV1 }
export interface SeedGroupRecord { type: 'conversation/seed-group'; version: 1; seq: number; manifestSeq: 0; ordinal: number; group: SeedGroup }
export interface BootstrapCompleteRecord {
  type: 'session/bootstrap'; version: 1; operationId: string; manifestDigest: Digest; dependencyClosureDigest: Digest
  seedLength: number; initialInputId?: string; seq?: number; initialStartedAt?: number; initialExpiresAt?: number
}
