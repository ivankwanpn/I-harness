import { expect, it } from 'vitest'
import * as core from '../src/index.ts'
import { literalSeed } from './fixtures/format11-seed.ts'
import { literalSession } from './fixtures/semantic-observation.ts'

const ref: core.ManagedArtifactRef = { version: 1, id: `ctxv1_${'c'.repeat(64)}`, revision: 'd'.repeat(64), codec: 'json-utf8-v1', encodedBytes: 10, contentDigest: 'e'.repeat(64), completeness: 'complete' }
const catalogRef: core.ManagedArtifactRef = { ...ref, id: `ctxv1_${'f'.repeat(64)}`, revision: 'b'.repeat(64) }
function fixture(distinctCatalog = false) {
  const seed = structuredClone(literalSeed)
  const item = seed.groups[0]!.items[1]!
  if (item.kind !== 'exchange') throw Error('exchange required')
  item.results = [{ kind: 'envelope', message: 1, source: [{ origin: 0, seq: 5, part: 'result' }], media: [], execution: { outcome: 'succeeded', dispatch: 'dispatched' }, sourceRetention: { kind: 'artifact', artifact: 0 }, dependencies: { kind: 'catalog', artifact: 0, count: 2 } }]
  seed.artifacts = [{ ref: { ...ref }, origins: [{ origin: 0, seq: 5, part: 'result' }], uses: [{ kind: 'result' }, { kind: 'dependency-catalog', count: 2 }] }]
  if (distinctCatalog) {
    const result = item.results[0]!
    if (result.kind !== 'envelope') throw Error('envelope required')
    result.dependencies = { kind: 'catalog', artifact: 1, count: 2 }
    seed.artifacts = [{ ...seed.artifacts[0]!, uses: [{ kind: 'result' }] }, { ref: catalogRef, origins: [{ origin: 0, seq: 5, part: 'result' }], uses: [{ kind: 'dependency-catalog', count: 2 }] }]
  }
  return literalSession(seed)
}
it('follows validated result and catalog indices and deduplicates the full same ref', () => {
  expect(core.semanticSeedResultRefs(fixture())).toEqual([ref])
})
it('retains a distinct catalog-only index across reset and replacement, then removes it on rewind', () => {
  const source = fixture(true), catalog = catalogRef
  expect(core.semanticSeedResultRefs(source)).toEqual([ref, catalog])
  const reset = fixture(true)
  reset.events.push({ type: 'compaction/reset', seq: 3, removedSeqs: [1] })
  expect(core.semanticSeedResultRefs(reset)).toEqual([ref, catalog])
  const coverage = core.projectConversation(source).items.map(item => ({ item: item.ref!, sources: item.sources.map(at => ({ seq: at.seq!, part: at.part })).sort((a, b) => a.seq - b.seq || a.part.localeCompare(b.part)) }))
  core.append(source, { type: 'compaction/replacement', version: 1, replacementId: 'distinct-catalog', text: 'replacement', coverage, insertBefore: coverage[0]!.item })
  expect(core.semanticSeedResultRefs(source)).toEqual([ref, catalog])
  core.append(source, { type: 'rewind/point', version: 1, anchorSeq: 1, targetTurn: 0, mode: 'conversation', fileOps: [] })
  expect(core.semanticSeedResultRefs(source)).toEqual([])
})
it('keeps archived seed refs after reset and summary consumption but removes rewound groups', () => {
  const source = fixture()
  source.events.push({ type: 'compaction/reset', seq: 3, removedSeqs: [1] }, { type: 'compaction/summary', seq: 4, text: 'replaced', shadowedSeqs: [1] })
  expect(core.semanticSeedResultRefs(source)).toEqual([ref])
  source.events.push({ type: 'rewind/point', version: 1, seq: 5, anchorSeq: 1, targetTurn: 0, mode: 'conversation', fileOps: [] })
  expect(core.semanticSeedResultRefs(source)).toEqual([])
})
it.each(['unused', 'index', 'count', 'ref', 'hidden-field'])('rejects invalid manifest/group association: %s', kind => {
  const source = fixture(), manifest = source.events[0]!, group = source.events[1]!
  if (manifest.type !== 'conversation/seed-manifest' || group.type !== 'conversation/seed-group') throw Error('fixture')
  const item = group.group.items[1]!
  if (item.kind !== 'exchange' || item.results[0]!.kind !== 'envelope') throw Error('fixture')
  if (kind === 'unused') manifest.artifacts = [...manifest.artifacts, { ...manifest.artifacts[0]!, ref: { ...ref, id: `ctxv1_${'b'.repeat(64)}` } }]
  if (kind === 'index') item.results[0]!.sourceRetention = { kind: 'artifact', artifact: 9 }
  if (kind === 'count') item.results[0]!.dependencies = { kind: 'catalog', artifact: 0, count: 3 }
  if (kind === 'ref') manifest.artifacts[0]!.ref = { ...ref, encodedBytes: -1 }
  if (kind === 'hidden-field') Object.defineProperty(manifest.artifacts[0]!.ref, 'hidden', { value: true })
  expect(() => core.semanticSeedResultRefs(source)).toThrow()
})
it('does not render or read discarded message bodies to find refs', () => {
  const source = fixture(), group = source.events[1]!
  if (group.type !== 'conversation/seed-group') throw Error('fixture')
  Object.defineProperty(group.group.items[1]!.messages[1]!, 'content', { enumerable: true, get() { throw Error('body touched') } })
  expect(core.semanticSeedResultRefs(source)).toEqual([ref])
})



it('keeps seed result refs after a validated whole-group replacement', () => {
  const source = fixture(), projection = core.projectConversation(source)
  const coverage = projection.items.map(item => ({ item: item.ref!, sources: item.sources.map(at => ({ seq: at.seq!, part: at.part })).sort((a, b) => a.seq - b.seq || a.part.localeCompare(b.part)) }))
  core.append(source, { type: 'compaction/replacement', version: 1, replacementId: 'whole', text: 'replacement', coverage, insertBefore: coverage[0]!.item })
  expect(core.semanticSeedResultRefs(source)).toEqual([ref])
})
