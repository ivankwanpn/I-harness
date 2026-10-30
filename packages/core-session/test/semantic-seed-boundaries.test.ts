import { expect, it } from 'vitest'
import { append, createSession, createNondurableFactOwner, exportConversationSeed, projectConversation, subscribe, validateSemanticSeed, type Session, type ResultEnvelope } from '../src/index.ts'
import { bootstrapMemorySession } from '../src/managed/bootstrap.ts'
import { conversationIndexes } from '../src/events/state.ts'
import { validateSemanticSeedPrefix } from '../src/conversation/seed-codec.ts'
import { validateResultFact, validateResultSourceMetadata } from '../src/results/validate.ts'
import { literalReady } from './fixtures/format11-seed.ts'
import { observationHash } from './fixtures/semantic-observation.ts'

const all = (source: Session) => exportConversationSeed(source, { kind: 'anonymous' }, { kind: 'all' })
function inputSource() {
  const source = createSession()
  append(source, { type: 'turn/start' }); append(source, { type: 'user/message', text: 'safe' }); append(source, { type: 'turn/end' })
  return source
}
it.each(['input', 'summary', 'assistant'])('refuses selected %s text accessors without executing them', kind => {
  const source = inputSource()
  if (kind === 'summary') append(source, { type: 'compaction/summary', text: 'summary', shadowedSeqs: [1] })
  if (kind === 'assistant') append(source, { type: 'assistant/message', text: 'assistant' })
  const event = kind === 'input' ? source.events[1]! : source.events.at(-1)!
  expect(all(source).kind).toBe('seed')
  let reads = 0
  Object.defineProperty(event, 'text', { enumerable: true, get() { reads++; return 'benign getter text' } })
  expect(all(source)).toEqual({ kind: 'refused', reason: 'invalid-seed' })
  expect(reads).toBe(0)
})
it('does not inspect consumed text descriptors and keeps ordinary raw text rendering', () => {
  const source = inputSource()
  append(source, { type: 'compaction/summary', text: 'kept summary', shadowedSeqs: [1] })
  let reads = 0
  Object.defineProperty(source.events[1], 'text', { enumerable: true, get() { reads++; return 'discarded' } })
  expect(all(source).kind).toBe('seed'); expect(reads).toBe(0)
  const raw = inputSource()
  Object.defineProperty(raw.events[1], 'text', { enumerable: true, get() { reads++; return 'ordinary raw' } })
  expect(projectConversation(raw).items[0]!.messages[0]!.content).toBe('ordinary raw')
  expect(reads).toBe(1)
})
it.each([
  { name: 'turn seq', make: inputSource, index: 0, key: 'seq' },
  { name: 'turn type', make: inputSource, index: 0, key: 'type' },
  { name: 'step action', make: () => { const s = createSession(); append(s, { type: 'step/start', actionId: 'a', attemptId: 'p' }); append(s, { type: 'step/end' }); return s }, index: 0, key: 'actionId' },
  { name: 'call identity', make: () => { const s = createSession(); append(s, { type: 'tool/call', callId: 'call', name: 'read', args: {} }); return s }, index: 0, key: 'callId' },
])('refuses structural $name accessors before any source read', ({ make, index, key }) => {
  const source = make(), event = source.events[index]!, value = (event as any)[key]
  let reads = 0
  Object.defineProperty(event, key, { enumerable: true, get() { reads++; return value } })
  expect(exportConversationSeed(source, { kind: 'anonymous' }, { kind: 'none' })).toEqual({ kind: 'none' })
  expect(reads).toBe(0)
  expect(all(source)).toEqual({ kind: 'refused', reason: 'invalid-seed' }); expect(reads).toBe(0)
})
it('rejects nested structural getters without inspecting excluded image or native bytes', () => {
  const source = inputSource(), event = source.events[1]! as any
  event.provenance = { kind: 'plugin', authority: 'observation', scope: 'turn', producer: 'test' }
  let reads = 0
  Object.defineProperty(event.provenance, 'scope', { enumerable: true, get() { reads++; return 'turn' } })
  expect(all(source)).toEqual({ kind: 'refused', reason: 'invalid-seed' }); expect(reads).toBe(0)
})

it.each(['events', 'header'])('refuses readonly %s installation without partial bootstrap mutation', key => {
  const target = createSession(), events = target.events
  Object.defineProperty(target, key, { value: key === 'events' ? events : undefined, enumerable: true, writable: false, configurable: true })
  expect(() => bootstrapMemorySession(target, literalReady.header!, literalReady.events, () => true)).toThrow()
  expect(target.header).toBeUndefined(); expect(target.events).toBe(events); expect(target.events).toEqual([])
  expect(conversationIndexes.has(target)).toBe(false)
})
it.each(['events', 'header', 'binding', 'readonly'])('rechecks %s target changes made by current before bootstrap install', kind => {
  const target = createSession(), originalEvents = target.events
  let callbackEvents = originalEvents
  const changedHeader = { parentSession: 'changed target' }
  expect(() => bootstrapMemorySession(target, literalReady.header!, literalReady.events, () => {
    if (kind === 'events') target.events = callbackEvents = []
    if (kind === 'header') target.header = changedHeader
    if (kind === 'binding') createNondurableFactOwner(target)
    if (kind === 'readonly') Object.defineProperty(target, 'events', { writable: false })
    return true
  })).toThrow()
  expect(target.events).toBe(callbackEvents); expect(target.events).toEqual([])
  expect(target.header).toBe(kind === 'header' ? changedHeader : undefined)
  expect(conversationIndexes.has(target)).toBe(false)
})
it('installs a fresh bootstrap completely before notifying ordinary observers', () => {
  const target = createSession(), observed: {events:number;items:number}[] = []
  subscribe(target, () => { observed.push({events:target.events.length,items:projectConversation(target).items.length}) })
  expect(bootstrapMemorySession(target, literalReady.header!, literalReady.events, () => true)).toEqual({ kind: 'memory-ready', seedLength: 2 })
  expect(observed).toEqual([{events:3,items:2},{events:3,items:2},{events:3,items:2}])
})

function catalogSource(counts: number[]) {
  const source = createSession()
  const ref = { version: 1 as const, id: 'ctxv1_' + 'c'.repeat(64), revision: 'd'.repeat(64), codec: 'json-utf8-v1' as const, encodedBytes: 10, contentDigest: 'e'.repeat(64), completeness: 'complete' as const }
  append(source, { type: 'turn/start' }); append(source, { type: 'step/start' })
  counts.forEach((_, i) => append(source, { type: 'tool/call', callId: 'call-' + i, name: 'read', args: {} }))
  append(source, { type: 'assistant/message', text: '' })
  counts.forEach((count, i) => {
    const envelope: ResultEnvelope = { version: 1, execution: { outcome: 'succeeded', dispatch: 'dispatched' }, preview: 'catalog', media: [], retention: { kind: 'unavailable', reason: 'storage-refused' }, dependencies: { kind: 'artifact-set', ref, count } }
    validateResultFact({ type: 'tool/result', callId: 'call-' + i, name: 'read', envelope }, 11)
    append(source, { type: 'tool/result', callId: 'call-' + i, name: 'read', envelope })
  })
  append(source, { type: 'step/end' }); append(source, { type: 'turn/end' })
  return source
}
it('refuses contradictory catalog counts from individually valid actual envelopes', () => {
  for (const count of [1, 2]) expect(all(catalogSource([count])).kind).toBe('seed')
  expect(all(catalogSource([1, 2]))).toEqual({ kind: 'refused', reason: 'invalid-seed' })
  const equal = all(catalogSource([2, 2])); expect(equal.kind).toBe('seed')
  if (equal.kind !== 'seed') throw Error('seed required')
  expect(equal.seed.artifacts[0]!.uses).toEqual([{ kind: 'dependency-catalog', count: 2 }])
})
it('rejects independently rehashed catalog contradictions in full and present-prefix codecs', () => {
  // Build the malformed observation from an otherwise valid equal-count seed;
  // source digest is recalculated independently so only count consistency fails.
  const valid = all(catalogSource([1, 1])); if (valid.kind !== 'seed') throw Error('seed required')
  const seed = structuredClone(valid.seed), item = seed.groups[0]!.items[0]!
  if (item.kind !== 'exchange' || item.results[1]!.kind !== 'envelope') throw Error('exchange required')
  item.results[1]!.dependencies = { kind: 'catalog', count: 2, artifact: 0 }
  seed.artifacts[0]!.uses = [{ kind: 'dependency-catalog', count: 1 }, { kind: 'dependency-catalog', count: 2 }]
  seed.origins = [{ kind: 'anonymous', contentDigest: observationHash('ih.semantic-seed.source.v1', { version: 1, source: { kind: 'anonymous' }, inheritedOrigins: [], selection: seed.selection, turns: seed.turns, omissions: seed.omissions, artifacts: seed.artifacts, groups: seed.groups }) }]
  expect(() => validateSemanticSeed(seed)).toThrow(/semantic seed/)
  expect(() => validateSemanticSeedPrefix(seed)).toThrow(/semantic seed/)
})

function childResultSource() {
  const source = inputSource()
  // A child completion is source metadata, not a selected conversation result.
  append(source, { type: 'subagent/start', version: 1, taskId: 'child', agentPath: 'child', role: 'worker', description: 'excluded child', parentSessionId: 'parent' })
  append(source, { type: 'subagent/end', version: 1, taskId: 'child', outcome: 'completed', resultRevision: 'original', envelope: {
    version: 1, execution: { outcome: 'succeeded', dispatch: 'dispatched' }, preview: '', media: [{ mediaType: 'image/png', dataBase64: 'AA==' }],
    retention: { kind: 'inline', value: 'opaque', encodedBytes: 8 },
  } })
  append(source, { type: 'turn/start' }); append(source, { type: 'user/message', text: 'later safe' }); append(source, { type: 'turn/end' })
  const terminal = source.events.find(event => event.type === 'subagent/end')!
  if (terminal.type !== 'subagent/end' || !terminal.envelope) throw Error('child result fixture')
  return { source, terminal, envelope: terminal.envelope }
}
function opaqueResultPayload(envelope: ResultEnvelope, field: 'inline value' | 'preview' | 'media', read: () => void) {
  const target = field === 'inline value' ? envelope.retention : field === 'preview' ? envelope : envelope.media[0]!
  const key = field === 'inline value' ? 'value' : field === 'preview' ? 'preview' : 'dataBase64'
  Object.defineProperty(target, key, { enumerable: true, configurable: true, get() { read(); return field === 'inline value' ? 'opaque' : field === 'preview' ? '' : 'AA==' } })
}
it.each(['inline value', 'preview', 'media'] as const)('preserves excluded child %s opacity across semantic seed selection boundaries', field => {
  const { source, terminal, envelope } = childResultSource()
  const selections = [{ kind: 'all' }, { kind: 'completed' }, { kind: 'last-turns', count: 1 }] as const
  const baseline = selections.map(selection => exportConversationSeed(source, { kind: 'anonymous' }, selection))
  for (const exported of baseline) expect(exported.kind).toBe('seed')
  if (baseline[0]!.kind !== 'seed') throw Error('plain source must export')
  expect(baseline[0]!.seed.groups.flatMap(group => group.items.flatMap(item => item.messages))).toEqual([{ role: 'user', content: 'safe' }, { role: 'user', content: 'later safe' }])
  let reads = 0
  opaqueResultPayload(envelope, field, () => { reads++ })
  expect(() => validateResultSourceMetadata(terminal, source.formatVersion)).not.toThrow()
  const actual = selections.map(selection => exportConversationSeed(source, { kind: 'anonymous' }, selection))
  expect(exportConversationSeed(source, { kind: 'anonymous' }, { kind: 'none' })).toEqual({ kind: 'none' })
  expect(reads).toBe(0)
  expect(actual).toEqual(baseline)
})
it.each(['inline value', 'preview', 'media'] as const)('still refuses selected result %s accessors without invoking them', field => {
  const source = inputSource(), envelope: ResultEnvelope = { version: 1, execution: { outcome: 'succeeded', dispatch: 'dispatched' }, preview: '', media: [{ mediaType: 'image/png', dataBase64: 'AA==' }], retention: { kind: 'inline', value: 'opaque', encodedBytes: 8 } }
  append(source, { type: 'turn/start' }); append(source, { type: 'step/start' })
  append(source, { type: 'tool/call', callId: 'selected', name: 'read', args: {} }); append(source, { type: 'assistant/message', text: '' })
  append(source, { type: 'tool/result', callId: 'selected', name: 'read', envelope })
  append(source, { type: 'step/end' }); append(source, { type: 'turn/end' })
  expect(all(source).kind).toBe('seed')
  let reads = 0
  opaqueResultPayload(envelope, field, () => { reads++ })
  expect(all(source)).toEqual({ kind: 'refused', reason: 'invalid-seed' })
  expect(reads).toBe(0)
})
it('installs a format 14 memory bootstrap with a memory-ready receipt', () => {
  const target = createSession(); target.formatVersion = 14
  expect(bootstrapMemorySession(target, literalReady.header!, literalReady.events, () => true)).toEqual({kind:'memory-ready',seedLength:2})
  expect(target.events).toHaveLength(3)
})
