import { createHash } from 'node:crypto'
import { canonicalJsonData } from '../serialization/json-data.ts'
import type { SeedSourceLabel, SemanticSeedV1, SemanticSeed, SemanticSeedV2, SemanticSeedV3, SeedOrigin } from './seed-types.ts'

export const EMPTY_SEMANTIC_SEED_DIGEST = 'f682547f170c025d0519512768a13bd41a570527aa5aee1c3f69be82424f2498'
export const EMPTY_SEMANTIC_DEPENDENCY_DIGEST = '7fd4c9f0169abf80e5e11e8cab2e06d9e8bf8bf2cd3d9ee63e17ea0345c6a29c'

export interface SeedSourcePreimageV1 {
  version: 1; source: SeedSourceLabel; inheritedOrigins: readonly SeedOrigin[]
  selection: SemanticSeedV1['selection']; turns: SemanticSeedV1['turns']
  omissions: SemanticSeedV1['omissions']; artifacts: SemanticSeedV1['artifacts']; groups: SemanticSeedV1['groups']
}
export const seedHash = (domain: string, data: unknown): string => createHash('sha256').update(domain + '\0' + canonicalJsonData(data)).digest('hex')
export type SeedSourcePreimageV2 = Omit<SeedSourcePreimageV1, 'version' | 'selection'> & { version: 2; selection: SemanticSeedV2['selection']; passive: SemanticSeedV2['passive'] }
export type SeedSourcePreimageV3 = Omit<SemanticSeedV3, 'origins'> & { source: SeedSourceLabel; inheritedOrigins: readonly SeedOrigin[] }
export function semanticSeedDomain(seed: Pick<SemanticSeed, 'version'>): string {
  switch (seed.version) { case 1: return 'ih.semantic-seed.v1'; case 2: return 'ih.semantic-seed.v2'; case 3: return 'ih.semantic-seed.v3'; default: throw new TypeError('Invalid seed version') }
}
export function semanticSourceDomain(seed: Pick<SemanticSeed, 'version'>): string {
  switch (seed.version) { case 1: return 'ih.semantic-seed.source.v1'; case 2: return 'ih.semantic-seed.source.v2'; case 3: return 'ih.semantic-seed.source.v3'; default: throw new TypeError('Invalid seed version') }
}
export function semanticDependencyDigest(seed: SemanticSeed): string {
  return seed.version === 3 ? seedHash('ih.semantic-seed.dependencies.v3', { version: 3, profile: seed.profile, selection: seed.selection, artifacts: seed.artifacts, results: seed.results })
    : seedHash('ih.semantic-seed.dependencies.v1', seed.artifacts)
}
export function seedPreimage(seed: SemanticSeed): SeedSourcePreimageV1 | SeedSourcePreimageV2 | SeedSourcePreimageV3 {
  const origin = seed.origins[0]!
  const common = { source: origin.kind === 'session' ? { kind: 'session' as const, sessionId: origin.sessionId } : { kind: 'anonymous' as const }, inheritedOrigins: seed.origins.slice(1),
    turns: seed.turns, omissions: seed.omissions, artifacts: seed.artifacts, groups: seed.groups }
  if (seed.version === 3) return { ...common, version: 3, profile: seed.profile, selection: seed.selection, results: seed.results, ...(seed.profile === 'public-completed' ? { passive: seed.passive } : {}) } as SeedSourcePreimageV3
  return seed.version === 2 ? { ...common, version: 2, selection: seed.selection, passive: seed.passive } : { ...common, version: 1, selection: seed.selection }
}
