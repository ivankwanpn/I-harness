import { expect, it } from 'vitest'
import * as projection from '../src/results/projection.ts'
import { historyFact } from '../src/conversation/history/facts.ts'
import type { ManagedArtifactRef, ResultEnvelope, SessionEventView } from '../src/index.ts'
import { literalSeed } from './fixtures/format11-seed.ts'
import { literalSession } from './fixtures/semantic-observation.ts'
import { resultFactMetadata } from '../src/conversation/history/result-metadata.ts'

const ref = (digit: string): ManagedArtifactRef => ({ version: 1, id: 'ctxv1_' + digit.repeat(64), revision: digit.repeat(64), codec: 'json-utf8-v1', encodedBytes: 12, contentDigest: digit.repeat(64), completeness: 'source-limited' })
const first = ref('a'), second = ref('b')
const events = ['tool/result', 'code/result', 'code/output', 'subagent/end', 'job/status'] as const
function event(type: typeof events[number], retention: boolean, catalog: boolean, same: boolean): SessionEventView {
  const envelope: ResultEnvelope = { version: 1, execution: { outcome: 'succeeded', dispatch: 'dispatched' }, preview: '', media: [],
    retention: retention ? { kind: 'artifact', ref: first } : { kind: 'inline', value: null, encodedBytes: 4 },
    ...(catalog ? { dependencies: { kind: 'artifact-set', ref: same ? first : second, count: 7 } as const } : {}) }
  return (type === 'job/status' ? { type, version: 1, seq: 4, job: { jobId: 'j', kind: 'process', label: 'job', status: 'completed', outputAvailable: true, result: { version: 1, revision: 'r', kind: 'retained', envelope } } }
    : { type, seq: 4, callId: 'call', cellId: 'cell', name: 'tool', version: 1, taskId: 'task', outcome: 'completed', resultRevision: 'revision', envelope }) as SessionEventView
}
it.each(events)('%s preserves exact slot/use/count and compatibility order including duplicate refs', type => {
  expect(typeof projection.managedResultSlots).toBe('function')
  for (const [retention, catalog, same] of [[true, false, false], [false, true, false], [true, true, false], [true, true, true]]) {
    const fact = event(type, retention!, catalog!, same!), prefix = type === 'job/status' ? 'job.result.envelope.' : 'envelope.'
    const expected = [...(retention ? [{ address: { event: type, slot: prefix + 'retention.ref' }, ref: first, use: { kind: 'result' } }] : []),
      ...(catalog ? [{ address: { event: type, slot: prefix + 'dependencies.ref' }, ref: same ? first : second, use: { kind: 'dependency-catalog', count: 7 } }] : [])]
    expect(projection.managedResultSlots(fact)).toEqual(expected)
    expect(projection.managedResultRefs(fact)).toEqual(expected.map(row => row.ref))
  }
})
it.each(events)('extracts %s named declaration metadata without reading payload getters', type => {
  expect(typeof projection.managedResultSlots).toBe('function')
  let reads = 0
  const fact = event(type, true, true, true) as any
  for (const key of ['args', 'output', 'source', 'provider', 'text', 'providerContinuation', 'resultText']) Object.defineProperty(fact, key, { get() { reads++; throw Error(key) } })
  const envelope = type === 'job/status' ? fact.job.result.envelope : fact.envelope
  for (const key of ['preview', 'media']) Object.defineProperty(envelope, key, { get() { reads++; throw Error(key) } })
  expect(projection.managedResultSlots(fact)).toHaveLength(2)
  expect(resultFactMetadata(fact).resultDeclarations).toHaveLength(2)
  expect(reads).toBe(0)
})
it('distinguishes inherited item/result/slot indices even when all uses share one physical ref', () => {
  const seed = structuredClone(literalSeed), exchange = seed.groups[0]!.items[1]!
  if (exchange.kind !== 'exchange') throw Error('Literal exchange required')
  exchange.results = [...exchange.results, ...exchange.results].map(result => ({ ...result, kind: 'envelope', execution: { outcome: 'succeeded', dispatch: 'dispatched' }, sourceRetention: { kind: 'artifact', artifact: 0 }, dependencies: { kind: 'catalog', artifact: 0, count: 7 } }))
  seed.artifacts = [{ ref: first, origins: [{ origin: 0, seq: 5, part: 'result' }], uses: [{ kind: 'result' }, { kind: 'dependency-catalog', count: 7 }] }]
  const source = literalSession(seed)
  Object.defineProperty(exchange, 'messages', { enumerable: true, get() { throw Error('Inherited body discovery') } })
  const fact = historyFact(source.events[1]!, 1)
  expect(fact.seedItems![1]!.resultUses).toEqual([
    { result: 0, slot: 'sourceRetention.artifact', artifact: 0, use: { kind: 'result' } },
    { result: 0, slot: 'dependencies.artifact', artifact: 0, use: { kind: 'dependency-catalog', count: 7 } },
    { result: 1, slot: 'sourceRetention.artifact', artifact: 0, use: { kind: 'result' } },
    { result: 1, slot: 'dependencies.artifact', artifact: 0, use: { kind: 'dependency-catalog', count: 7 } },
  ])
})
