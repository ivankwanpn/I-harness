import type { SemanticSeedV1, SemanticSeedV2, SeedGroup, Digest } from '../conversation/seed-types.ts'

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
export type SeedHeader = SeedHeaderV1 | SeedHeaderV2
export interface SeedManifestRecordV1 {
  type: 'conversation/seed-manifest'; version: 1; seq: number; codec: 'semantic-seed-v1'; digest: Digest; groupCount: number
  origins: SemanticSeedV1['origins']; selection: SemanticSeedV1['selection']; turns: SemanticSeedV1['turns']
  omissions: SemanticSeedV1['omissions']; artifacts: SemanticSeedV1['artifacts']
}
export type SeedManifestV2 = Omit<SeedManifestRecordV1, 'version' | 'codec' | 'selection'> & {
  version: 2; codec: 'semantic-seed-v2'; selection: SemanticSeedV2['selection']; passive: SemanticSeedV2['passive']
}
export type SeedManifestRecord = SeedManifestRecordV1 | SeedManifestV2
export interface SeedGroupRecord { type: 'conversation/seed-group'; version: 1; seq: number; manifestSeq: 0; ordinal: number; group: SeedGroup }
export interface BootstrapCompleteRecord {
  type: 'session/bootstrap'; version: 1; operationId: string; manifestDigest: Digest; dependencyClosureDigest: Digest
  seedLength: number; initialInputId?: string; seq?: number; initialStartedAt?: number; initialExpiresAt?: number
}
