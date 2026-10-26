import { createHash } from 'node:crypto'
import { canonicalJsonData } from '../serialization/json-data.ts'
import type { SeedSourceLabel, SemanticSeedV1, SemanticSeed, SemanticSeedV2, SeedOrigin } from './seed-types.ts'

export const EMPTY_SEMANTIC_SEED_DIGEST = 'f682547f170c025d0519512768a13bd41a570527aa5aee1c3f69be82424f2498'
export const EMPTY_SEMANTIC_DEPENDENCY_DIGEST = '7fd4c9f0169abf80e5e11e8cab2e06d9e8bf8bf2cd3d9ee63e17ea0345c6a29c'

export interface SeedSourcePreimageV1 {
  version: 1; source: SeedSourceLabel; inheritedOrigins: readonly SeedOrigin[]
  selection: SemanticSeedV1['selection']; turns: SemanticSeedV1['turns']
  omissions: SemanticSeedV1['omissions']; artifacts: SemanticSeedV1['artifacts']; groups: SemanticSeedV1['groups']
}
export const seedHash = (domain: string, data: unknown): string => createHash('sha256').update(domain + '\0' + canonicalJsonData(data)).digest('hex')
export type SeedSourcePreimageV2 = Omit<SeedSourcePreimageV1, 'version' | 'selection'> & { version: 2; selection: SemanticSeedV2['selection']; passive: SemanticSeedV2['passive'] }
export const semanticSeedDomain = (seed: Pick<SemanticSeed, 'version'>) => seed.version === 2 ? 'ih.semantic-seed.v2' : 'ih.semantic-seed.v1'
export const semanticSourceDomain = (seed: Pick<SemanticSeed, 'version'>) => seed.version === 2 ? 'ih.semantic-seed.source.v2' : 'ih.semantic-seed.source.v1'
export function seedPreimage(seed: SemanticSeed): SeedSourcePreimageV1 | SeedSourcePreimageV2 {
  const origin = seed.origins[0]!
  const common = { source: origin.kind === 'session' ? { kind: 'session' as const, sessionId: origin.sessionId } : { kind: 'anonymous' as const }, inheritedOrigins: seed.origins.slice(1),
    turns: seed.turns, omissions: seed.omissions, artifacts: seed.artifacts, groups: seed.groups }
  return seed.version === 2 ? { ...common, version: 2, selection: seed.selection, passive: seed.passive } : { ...common, version: 1, selection: seed.selection }
}
