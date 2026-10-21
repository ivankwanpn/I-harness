import { createHash } from 'node:crypto'
import { canonicalJsonData } from '../serialization/json-data.ts'
import type { SeedSourceLabel, SemanticSeedV1, SeedOrigin } from './seed-types.ts'

export const EMPTY_SEMANTIC_SEED_DIGEST = 'f682547f170c025d0519512768a13bd41a570527aa5aee1c3f69be82424f2498'
export const EMPTY_SEMANTIC_DEPENDENCY_DIGEST = '7fd4c9f0169abf80e5e11e8cab2e06d9e8bf8bf2cd3d9ee63e17ea0345c6a29c'

export interface SeedSourcePreimageV1 {
  version: 1; source: SeedSourceLabel; inheritedOrigins: readonly SeedOrigin[]
  selection: SemanticSeedV1['selection']; turns: SemanticSeedV1['turns']
  omissions: SemanticSeedV1['omissions']; artifacts: SemanticSeedV1['artifacts']; groups: SemanticSeedV1['groups']
}
export const seedHash = (domain: string, data: unknown): string => createHash('sha256').update(domain + '\0' + canonicalJsonData(data)).digest('hex')
export function seedPreimage(seed: SemanticSeedV1): SeedSourcePreimageV1 {
  const origin = seed.origins[0]!
  return { version: 1, source: origin.kind === 'session' ? { kind: 'session', sessionId: origin.sessionId } : { kind: 'anonymous' }, inheritedOrigins: seed.origins.slice(1),
    selection: seed.selection, turns: seed.turns, omissions: seed.omissions, artifacts: seed.artifacts, groups: seed.groups }
}
