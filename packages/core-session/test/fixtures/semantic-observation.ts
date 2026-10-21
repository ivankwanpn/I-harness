import { createHash } from 'node:crypto'
import type { SemanticSeedV1, Session } from '../../src/index.ts'

// Test-only independent canonical digest oracle, never the production compiler.
export function observationHash(domain: string, value: unknown): string {
  const canonical = (item: unknown): string => item && typeof item === 'object' ? Array.isArray(item) ? `[${item.map(canonical).join(',')}]`
    : `{${Object.keys(item).sort().map(key => `${JSON.stringify(key)}:${canonical((item as Record<string, unknown>)[key])}`).join(',')}}` : JSON.stringify(item)
  return createHash('sha256').update(domain + '\0' + canonical(value)).digest('hex')
}
export function literalSession(seed: SemanticSeedV1): Session {
  const label = seed.origins[0]!
  for (const omission of seed.omissions) { const { digest: _, ...data } = omission; omission.digest = observationHash('ih.semantic-seed.omission.v1', data) }
  const digest = observationHash('ih.semantic-seed.source.v1', { version: 1, source: label.kind === 'session' ? { kind: 'session', sessionId: label.sessionId } : { kind: 'anonymous' }, inheritedOrigins: seed.origins.slice(1),
    selection: seed.selection, turns: seed.turns, omissions: seed.omissions, artifacts: seed.artifacts, groups: seed.groups })
  seed.origins = [label.kind === 'session' ? { ...label, revision: digest } : { ...label, contentDigest: digest }, ...seed.origins.slice(1)]
  const seedDigest = observationHash('ih.semantic-seed.v1', seed), dependencyDigest = observationHash('ih.semantic-seed.dependencies.v1', seed.artifacts)
  const seedLength = seed.groups.length + 1
  return { formatVersion: 11, header: { seedLength, semanticSeed: { version: 1, codec: 'semantic-seed-v1', operationId: 'literal', requestDigest: 'a'.repeat(64), manifestDigest: 'b'.repeat(64), seedDigest, dependencyDigest, seedLength, groupCount: seed.groups.length } }, events: [
    { type: 'conversation/seed-manifest', version: 1, seq: 0, codec: 'semantic-seed-v1', digest: seedDigest, groupCount: seed.groups.length, origins: seed.origins, selection: seed.selection, turns: seed.turns, omissions: seed.omissions, artifacts: seed.artifacts },
    ...seed.groups.map((group, ordinal) => ({ type: 'conversation/seed-group' as const, version: 1 as const, seq: ordinal + 1, manifestSeq: 0 as const, ordinal, group })),
    { type: 'session/bootstrap', version: 1, seq: seedLength, operationId: 'literal', manifestDigest: 'b'.repeat(64), dependencyClosureDigest: dependencyDigest, seedLength },
  ] }
}
