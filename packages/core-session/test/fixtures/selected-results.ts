import { observationHash as hash } from './semantic-observation.ts'

export const codecRef = { version: 1, id: 'ctxv1_' + 'a'.repeat(64), revision: 'a'.repeat(64), codec: 'json-utf8-v1', encodedBytes: 12, contentDigest: 'a'.repeat(64), completeness: 'source-limited' }
export function codecRow(ordinal = 0, turn = 1): any {
  return { ordinal, original: { kind: 'local', sessionId: 'source', seq: ordinal + 4, event: 'tool/result', slot: 'envelope.retention.ref' }, extent: { kind: 'framed', first: turn, last: turn },
    basis: { kind: 'selected-observation', unit: { kind: 'exchange', at: { origin: 0, seq: ordinal + 1, part: 'call' }, closedAt: { origin: 0, seq: ordinal + 4, part: 'result' } } },
    branchEvidence: [{ origin: 0, seq: ordinal + 4, part: 'result' }], protocol: 'managed', ref: { ...codecRef }, use: { kind: 'result' } }
}
export function codecPage(rows: any[], ordinal = 0): any { return { version: 1, ordinal, firstRow: rows[0].ordinal, extent: rows[0].extent, rows } }
export function sealCodecSeed(seed: any): any {
  const pages = seed.results.pages, rows = pages.reduce((n: number, p: any) => n + p.rows.length, 0)
  let previous = hash('ih.selected-results.start.v1', { version: 1, rows, pages: pages.length })
  for (const page of pages) previous = hash('ih.selected-results.page.v1', { previous, page })
  seed.results.summary = { version: 1, rows, pages: pages.length, digest: hash('ih.selected-results.end.v1', { previous, rows, pages: pages.length }) }
  const revision = hash('ih.semantic-seed.source.v3', { version: 3, source: { kind: 'session', sessionId: seed.origins[0].sessionId }, inheritedOrigins: seed.origins.slice(1), profile: seed.profile,
    selection: seed.selection, turns: seed.turns, omissions: seed.omissions, artifacts: seed.artifacts, groups: seed.groups, results: seed.results,
    ...(seed.profile === 'public-completed' ? { passive: seed.passive } : {}) })
  seed.origins[0].revision = revision
  return { kind: 'seed', seed, digest: hash('ih.semantic-seed.v3', seed), sourceObservationDigest: revision }
}
export function codecSeed(profile = 'child-history', pages: any[] = []): any {
  return sealCodecSeed({ version: 3, profile, origins: [{ kind: 'session', sessionId: 'source', revision: '' }],
    selection: { kind: profile === 'public-completed' ? 'completed' : 'all' }, turns: { total: 2, completed: [[1, 2]], unframedPrefix: false },
    omissions: [], artifacts: [], groups: [], results: { summary: {}, pages },
    ...(profile === 'public-completed' ? { passive: { codeStore: { version: 1, units: 0, keys: [], values: [], rows: [], cuts: [{ end: 0 }], latest: 0, completed: [], groups: [] } } } : {}) })
}
export function codecWire(exported: any): any {
  const seed = exported.seed, pages = seed.results.pages, { groups, results, ...manifest } = seed, seedLength = 1 + pages.length + groups.length
  const dependencyDigest = hash('ih.semantic-seed.dependencies.v3', { version: 3, profile: seed.profile, selection: seed.selection, artifacts: seed.artifacts, results: seed.results })
  const header = { version: 3, codec: 'semantic-seed-v3', profile: seed.profile, results: results.summary, resultPageCount: pages.length, operationId: 'codec', requestDigest: 'a'.repeat(64), manifestDigest: 'b'.repeat(64), seedDigest: exported.digest, dependencyDigest, seedLength, groupCount: groups.length }
  const records = [{ ...manifest, type: 'conversation/seed-manifest', seq: 0, codec: 'semantic-seed-v3', digest: exported.digest, groupCount: groups.length, results: results.summary, resultPageCount: pages.length },
    ...pages.map((page: any) => ({ type: 'conversation/seed-results', version: 1, seq: 1 + page.ordinal, manifestSeq: 0, ordinal: page.ordinal, page })),
    ...groups.map((group: any, ordinal: number) => ({ type: 'conversation/seed-group', version: 1, seq: 1 + pages.length + ordinal, manifestSeq: 0, ordinal, group }))]
  return { formatVersion: 13, header: { seedLength, semanticSeed: header }, records, events: [...records,
    { type: 'session/bootstrap', version: 1, seq: seedLength, operationId: 'codec', manifestDigest: header.manifestDigest, dependencyClosureDigest: dependencyDigest, seedLength }] }
}
