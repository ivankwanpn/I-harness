import { createHash } from 'node:crypto'
import { canonicalJsonData, isStrictFactData, validateSemanticSeed, EMPTY_SEMANTIC_SEED_DIGEST, EMPTY_SEMANTIC_DEPENDENCY_DIGEST, type SeedExport, type SeedManifestRecordV1, type SeedManifestV2, type SeedGroupRecord } from '@i-harness/core-session'
import { seedPreimage, semanticSeedDomain, semanticSourceDomain, semanticDependencyDigest, seedLayout } from '@i-harness/core-session/internal/bootstrap'
export interface CompiledSemanticSeed {
  digest: string; dependencyDigest: string;
  sourceObservation: { kind: 'none' } | { kind: 'semantic'; digest: string };
  records: readonly (SeedManifestRecordV1 | SeedManifestV2 | SeedGroupRecord)[];
}
export interface CompiledSelectedResultsSemanticSeed {
  digest: string; dependencyDigest: string; sourceObservation: { kind: 'semantic'; digest: string };
  records: readonly (import('@i-harness/core-session').SeedManifestV3 | import('@i-harness/core-session').SeedResultsRecordV1 | SeedGroupRecord)[];
}
/** Pure metadata compilation. This function owns no target/writer route. */
export function compileSelectedResultsSemanticSeed(exported: Extract<SeedExport<import('@i-harness/core-session').SemanticSeedV3>, { kind: 'seed' }>): CompiledSelectedResultsSemanticSeed {
  if (!exported || !isStrictFactData(exported) || Object.keys(exported).length !== 4 || Object.keys(exported).some(key => !['kind', 'seed', 'digest', 'sourceObservationDigest'].includes(key))
    || exported.kind !== 'seed' || exported.seed.version !== 3) throw new TypeError('Selected results export required')
  const seed = validateSemanticSeed(exported.seed)
  const origin = seed.origins[0]!
  if (bootstrapHash(semanticSeedDomain(seed), seed) !== exported.digest || (origin.kind === 'session' ? origin.revision : origin.contentDigest) !== exported.sourceObservationDigest
    || bootstrapHash(semanticSourceDomain(seed), seedPreimage(seed)) !== exported.sourceObservationDigest) throw new TypeError('Invalid selected results commitment')
  const { groups, results, ...manifest } = seed
  const record = { ...manifest, type: 'conversation/seed-manifest' as const, seq: 0 as const, codec: 'semantic-seed-v3' as const,
    digest: exported.digest, groupCount: groups.length, results: results.summary, resultPageCount: results.pages.length }
  const layout = seedLayout(record)
  return { digest: exported.digest, dependencyDigest: semanticDependencyDigest(seed), sourceObservation: { kind: 'semantic', digest: exported.sourceObservationDigest },
    records: [record, ...results.pages.map(page => ({ type: 'conversation/seed-results' as const, version: 1 as const, seq: 1 + page.ordinal, manifestSeq: 0 as const, ordinal: page.ordinal, page })),
      ...groups.map((group, ordinal): SeedGroupRecord => ({ type: 'conversation/seed-group', version: 1, seq: layout.groupSeq(ordinal), manifestSeq: 0, ordinal, group }))] }
}
export const bootstrapHash = (domain: string, data: unknown): string => createHash('sha256').update(domain + '\0' + canonicalJsonData(data)).digest('hex')
export function compileSemanticSeed(exported: Exclude<SeedExport, { kind: 'refused' }>): CompiledSemanticSeed {
  if (!exported || !isStrictFactData(exported)) throw new TypeError('Invalid semantic export wrapper')
  const keys = exported.kind === 'none' ? ['kind'] : ['kind','seed','digest','sourceObservationDigest']
  if (!['none','seed'].includes(exported.kind) || Object.keys(exported).length !== keys.length || Object.keys(exported).some(key => !keys.includes(key))) throw new TypeError('Invalid semantic export wrapper')
  if (exported.kind === 'none') return { digest: EMPTY_SEMANTIC_SEED_DIGEST, dependencyDigest: EMPTY_SEMANTIC_DEPENDENCY_DIGEST, sourceObservation: { kind: 'none' }, records: [] }
  if (exported.seed.version !== 1 && exported.seed.version !== 2) throw new TypeError('Legacy semantic seed required')
  const seed = validateSemanticSeed(exported.seed)
  const origin = seed.origins[0]!
  if (bootstrapHash(semanticSeedDomain(seed), seed) !== exported.digest || (origin.kind === 'session' ? origin.revision : origin.contentDigest) !== exported.sourceObservationDigest
    || bootstrapHash(semanticSourceDomain(seed), seedPreimage(seed)) !== exported.sourceObservationDigest) throw new TypeError('Invalid exported semantic seed')
  const { groups, ...manifest } = seed
  const record: SeedManifestRecordV1 | SeedManifestV2 = { ...manifest, type: 'conversation/seed-manifest', seq: 0, codec: seed.version === 2 ? 'semantic-seed-v2' : 'semantic-seed-v1', digest: exported.digest, groupCount: groups.length } as SeedManifestRecordV1 | SeedManifestV2
  return { digest: exported.digest, dependencyDigest: bootstrapHash('ih.semantic-seed.dependencies.v1', seed.artifacts), sourceObservation: { kind: 'semantic', digest: exported.sourceObservationDigest },
    records: [record,
      ...groups.map((group, ordinal): SeedGroupRecord => ({ type: 'conversation/seed-group', version: 1, seq: ordinal + 1, manifestSeq: 0, ordinal, group }))] }
}
