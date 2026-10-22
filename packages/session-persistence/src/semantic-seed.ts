import { createHash } from 'node:crypto'
import { canonicalJsonData, isStrictFactData, validateSemanticSeed, EMPTY_SEMANTIC_SEED_DIGEST, EMPTY_SEMANTIC_DEPENDENCY_DIGEST, type SeedExport, type SeedManifestRecord, type SeedGroupRecord } from '@i-harness/core-session'
import { seedPreimage } from '@i-harness/core-session/internal/bootstrap'
export interface CompiledSemanticSeed {
  digest: string; dependencyDigest: string;
  sourceObservation: { kind: 'none' } | { kind: 'semantic'; digest: string };
  records: readonly (SeedManifestRecord | SeedGroupRecord)[];
}
export const bootstrapHash = (domain: string, data: unknown): string => createHash('sha256').update(domain + '\0' + canonicalJsonData(data)).digest('hex')
export function compileSemanticSeed(exported: Exclude<SeedExport, { kind: 'refused' }>): CompiledSemanticSeed {
  if (!exported || !isStrictFactData(exported)) throw new TypeError('Invalid semantic export wrapper')
  const keys = exported.kind === 'none' ? ['kind'] : ['kind','seed','digest','sourceObservationDigest']
  if (!['none','seed'].includes(exported.kind) || Object.keys(exported).length !== keys.length || Object.keys(exported).some(key => !keys.includes(key))) throw new TypeError('Invalid semantic export wrapper')
  if (exported.kind === 'none') return { digest: EMPTY_SEMANTIC_SEED_DIGEST, dependencyDigest: EMPTY_SEMANTIC_DEPENDENCY_DIGEST, sourceObservation: { kind: 'none' }, records: [] }
  const seed = validateSemanticSeed(exported.seed)
  const origin = seed.origins[0]!
  if (bootstrapHash('ih.semantic-seed.v1', seed) !== exported.digest || (origin.kind === 'session' ? origin.revision : origin.contentDigest) !== exported.sourceObservationDigest
    || bootstrapHash('ih.semantic-seed.source.v1', seedPreimage(seed)) !== exported.sourceObservationDigest) throw new TypeError('Invalid exported semantic seed')
  const { groups, version: _, ...manifest } = seed
  return { digest: exported.digest, dependencyDigest: bootstrapHash('ih.semantic-seed.dependencies.v1', seed.artifacts), sourceObservation: { kind: 'semantic', digest: exported.sourceObservationDigest },
    records: [{ ...manifest, type: 'conversation/seed-manifest', version: 1, seq: 0, codec: 'semantic-seed-v1', digest: exported.digest, groupCount: groups.length },
      ...groups.map((group, ordinal): SeedGroupRecord => ({ type: 'conversation/seed-group', version: 1, seq: ordinal + 1, manifestSeq: 0, ordinal, group }))] }
}
