import type { SemanticSeedV1, SeedGroup, Digest } from '../conversation/seed-types.ts'

export interface BootstrapInvocation { version: 1; operationId: string; targetSessionId: string; createdAt: string; requestDigest: Digest }
export type BootstrapPhase = 'header' | 'dependencies' | 'seed' | 'completion'
export interface BootstrapResumeToken { version: 1; invocation: BootstrapInvocation; manifestDigest: Digest; phase: BootstrapPhase }
export interface ChildBootstrapIntent { version: 1; invocation: BootstrapInvocation; startedAt: number; expiresAt: number }
export interface SeedHeaderV1 {
  version: 1; codec: 'semantic-seed-v1'; operationId: string; requestDigest: Digest; manifestDigest: Digest; seedDigest: Digest
  dependencyDigest: Digest; seedLength: number; groupCount: number; initialInputId?: string; initialInputDigest?: Digest
  initialStartedAt?: number; initialExpiresAt?: number
}
export interface SeedManifestRecord {
  type: 'conversation/seed-manifest'; version: 1; seq: number; codec: 'semantic-seed-v1'; digest: Digest; groupCount: number
  origins: SemanticSeedV1['origins']; selection: SemanticSeedV1['selection']; turns: SemanticSeedV1['turns']
  omissions: SemanticSeedV1['omissions']; artifacts: SemanticSeedV1['artifacts']
}
export interface SeedGroupRecord { type: 'conversation/seed-group'; version: 1; seq: number; manifestSeq: 0; ordinal: number; group: SeedGroup }
export interface BootstrapCompleteRecord {
  type: 'session/bootstrap'; version: 1; operationId: string; manifestDigest: Digest; dependencyClosureDigest: Digest
  seedLength: number; initialInputId?: string; seq?: number; initialStartedAt?: number; initialExpiresAt?: number
}
