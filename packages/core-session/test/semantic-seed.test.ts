import { createHash } from 'node:crypto'
import { expect, it, vi } from 'vitest'
import { append, createSession, exportConversationSeed, validateSemanticSeed, closeSourceIntervals, projectConversation, type Session } from '../src/index.ts'
import { literalReady } from './fixtures/format11-seed.ts'

const hashing = vi.hoisted(() => ({ calls: 0 }))
vi.mock('node:crypto', async importOriginal => {
  const actual = await importOriginal<typeof import('node:crypto')>()
  return { ...actual, createHash: (...args: Parameters<typeof actual.createHash>) => { hashing.calls++; return actual.createHash(...args) } }
})

export function literalSource() {
  const source = createSession()
  append(source, { type: 'turn/start' })
  append(source, { type: 'user/message', text: 'old' })
  append(source, { type: 'assistant/message', text: 'answer old' })
  append(source, { type: 'turn/end' })
  append(source, { type: 'turn/start' })
  append(source, { type: 'user/message', text: 'kept' })
  append(source, { type: 'assistant/message', text: 'answer kept' })
  append(source, { type: 'turn/end' })
  append(source, { type: 'compaction/replacement', version: 1, replacementId: 'twelve', text: 'summary twelve',
    coverage: [
      { item: { kind: 'input', at: { seq: 1, part: 'message' } }, sources: [{ seq: 1, part: 'message' }] },
      { item: { kind: 'exchange', at: { seq: 2, part: 'message' } }, sources: [{ seq: 2, part: 'message' }] },
      { item: { kind: 'input', at: { seq: 5, part: 'message' } }, sources: [{ seq: 5, part: 'message' }] },
      { item: { kind: 'exchange', at: { seq: 6, part: 'message' } }, sources: [{ seq: 6, part: 'message' }] },
    ], insertBefore: { kind: 'input', at: { seq: 1, part: 'message' } } })
  return { source, t1InputSeq: 1, t2InputSeq: 5 }
}

it('none observes neither source label nor view', () => {
  const trap = new Proxy({}, { get() { throw Error('observed') }, ownKeys() { throw Error('observed') } })
  const before = hashing.calls
  expect(exportConversationSeed(trap as Session, trap as never, { kind: 'none' })).toEqual({ kind: 'none' })
  expect(hashing.calls).toBe(before)
})

it('does not touch a consumed 100MiB body or hidden envelope value, while public readers remain strict', () => {
  const source = createSession()
  append(source, { type: 'turn/start' })
  append(source, { type: 'step/start' })
  append(source, { type: 'tool/call', callId: 'body', name: 'read', args: {} })
  append(source, { type: 'assistant/message', text: '' })
  append(source, { type: 'tool/result', callId: 'body', name: 'read', output: { data: 'x'.repeat(100 * 1024 * 1024) } })
  append(source, { type: 'step/end' })
  append(source, { type: 'turn/end' })
  append(source, { type: 'compaction/replacement', version: 1, replacementId: 'bounded', text: 'small summary', coverage: [{
    item: { kind: 'exchange', at: { seq: 2, part: 'call' } }, sources: [{ seq: 1, part: 'step' }, { seq: 2, part: 'call' }, { seq: 3, part: 'message' }, { seq: 4, part: 'result' }],
  }], insertBefore: { kind: 'exchange', at: { seq: 2, part: 'call' } } })
  const event = source.events[4]!
  if (event.type !== 'tool/result' || !event.output || typeof event.output !== 'object') throw Error('result required')
  let reads = 0
  Object.defineProperty(event.output, 'data', { enumerable: true, get() { reads++; throw Error('100MiB body read') } })
  let exported = exportConversationSeed(source, { kind: 'anonymous' }, { kind: 'all' })
  expect(exported.kind).toBe('seed'); expect(reads).toBe(0)
  if (exported.kind !== 'seed') throw Error('seed required')
  expect(JSON.stringify(exported.seed).length).toBeLessThan(2000)
  // Invalid hidden raw bytes do not become a whole-source certificate.
  delete event.output
  const retention = { kind: 'inline' as const, encodedBytes: 4, value: null }
  Object.defineProperty(retention, 'value', { enumerable: true, get() { reads++; throw Error('hidden envelope value read') } })
  source.events[4] = { type: 'tool/result', callId: 'body', name: 'read', seq: 4, envelope: { version: 1, execution: { outcome: 'succeeded', dispatch: 'dispatched' }, preview: '', media: [], retention } }
  exported = exportConversationSeed(source, { kind: 'anonymous' }, { kind: 'all' })
  expect(exported.kind).toBe('seed'); expect(reads).toBe(0)
  expect(() => projectConversation(source)).toThrow()
  expect(reads).toBe(0)
  const selected = { ...source, events: source.events.slice(0, 7) }
  expect(exportConversationSeed(selected, { kind: 'anonymous' }, { kind: 'all' })).toEqual({ kind: 'refused', reason: 'invalid-seed' })
  expect(reads).toBe(0)
  const structural = source.events[4]!
  if (structural.type !== 'tool/result' || !structural.envelope) throw Error('envelope required')
  Object.defineProperty(structural.envelope, 'execution', { enumerable: true, get() { reads++; throw Error('structural accessor executed') } })
  expect(exportConversationSeed(source, { kind: 'anonymous' }, { kind: 'all' })).toEqual({ kind: 'refused', reason: 'invalid-seed' })
  expect(reads).toBe(0)
})

it('does not recapture hidden inherited message bytes and refuses selected malformed equivalents', () => {
  const source = structuredClone(literalReady)
  const projection = projectConversation(source)
  const coverage = projection.items.map(item => ({ item: item.ref!, sources: item.sources.map(ref => ({ seq: ref.seq!, part: ref.part })).sort((a, b) => a.seq - b.seq || a.part.localeCompare(b.part)) }))
  append(source, { type: 'compaction/replacement', version: 1, replacementId: 'hidden-seed', text: 'new summary', coverage, insertBefore: coverage[0]!.item })
  const record = source.events[1]!
  if (record.type !== 'conversation/seed-group') throw Error('seed record required')
  let reads = 0
  Object.defineProperty(record.group.items[1]!.messages[1], 'content', { enumerable: true, get() { reads++; throw Error('hidden seed body read') } })
  const exported = exportConversationSeed(source, { kind: 'session', sessionId: 'child' }, { kind: 'all' })
  expect(exported.kind).toBe('seed'); expect(reads).toBe(0)
  expect(() => projectConversation(source)).toThrow()
  expect(exportConversationSeed({ ...source, events: source.events.slice(0, 3) }, { kind: 'anonymous' }, { kind: 'all' })).toEqual({ kind: 'refused', reason: 'invalid-seed' })
  expect(reads).toBe(0)
})

it('exports a pruned inline envelope as observation without reading the original retained value', () => {
  const source = createSession(), value = { full: 'original inline' }
  append(source, { type: 'turn/start' }); append(source, { type: 'step/start' })
  append(source, { type: 'tool/call', callId: 'inline', name: 'read', args: {} }); append(source, { type: 'assistant/message', text: '' })
  append(source, { type: 'tool/result', callId: 'inline', name: 'read', envelope: { version: 1, execution: { outcome: 'succeeded', dispatch: 'dispatched' }, preview: '', media: [], retention: { kind: 'inline', value, encodedBytes: 26 } } })
  append(source, { type: 'step/end' }); append(source, { type: 'turn/end' })
  append(source, { type: 'compaction/prune', version: 1, pruned: [{ callId: 'inline', head: 'head', tail: 'tail', removedBytes: 10 }] })
  const result = source.events[4]!
  if (result.type !== 'tool/result' || result.envelope?.retention.kind !== 'inline') throw Error('envelope required')
  let reads = 0
  Object.defineProperty(result.envelope.retention, 'value', { enumerable: true, get() { reads++; throw Error('pruned original read') } })
  const exported = exportConversationSeed(source, { kind: 'anonymous' }, { kind: 'all' })
  expect(exported.kind).toBe('seed'); expect(reads).toBe(0)
  if (exported.kind !== 'seed') throw Error('seed required')
  expect(exported.seed.groups[0]!.items[0]).toMatchObject({ kind: 'exchange', messages: [{ role: 'assistant', content: '' }, { role: 'tool', content: 'head\n…(pruned 10 bytes)…\ntail' }], results: [{ kind: 'envelope', sourceRetention: { kind: 'inline-observation', encodedBytes: 26 } }] })
  expect(JSON.stringify(exported.seed)).not.toContain('sourceValueDigest')
})

it('keeps independent inputs from an open exchange without inheriting partial tool results', () => {
  const source = createSession()
  append(source, { type: 'turn/start' }); append(source, { type: 'step/start' })
  append(source, { type: 'tool/call', callId: 'pending', name: 'read', args: {} }); append(source, { type: 'assistant/message', text: 'waiting' })
  append(source, { type: 'tool/dispatch', callId: 'pending', eventSeq: 2 })
  append(source, { type: 'user/message', text: 'host input', internal: true, source: { kind: 'plugin', plugin: 'host' }, provenance: { kind: 'plugin', authority: 'observation', scope: 'session', producer: 'host' } })
  const exported = exportConversationSeed(source, { kind: 'anonymous' }, { kind: 'all' })
  expect(exported.kind).toBe('seed')
  if (exported.kind !== 'seed') throw Error('seed required')
  expect(exported.seed.groups.flatMap(group => group.items.flatMap(item => item.messages.map(message => message.content)))).toEqual(['host input'])
  expect(exported.seed.omissions).toHaveLength(1)
  expect(exported.seed.omissions[0]).toMatchObject({ state: 'open', calls: 1, relatedInputs: [0] })
  expect(exported.seed.groups[0]!.items[0]).toMatchObject({ kind: 'input', scope: 'session', input: { omittedWork: 0 } })
})

it('captures a selected source payload in one descriptor walk and then uses only its owned copy', () => {
  const source = createSession(), output = { selected: 'exact selected result' }
  append(source, { type: 'step/start' }); append(source, { type: 'tool/call', callId: 'one', name: 'read', args: {} })
  append(source, { type: 'assistant/message', text: '' }); append(source, { type: 'tool/result', callId: 'one', name: 'read', output }); append(source, { type: 'step/end' })
  let walks = 0
  const original = Object.getOwnPropertyDescriptors
  const spy = vi.spyOn(Object, 'getOwnPropertyDescriptors').mockImplementation(value => { if (value === output) walks++; return original(value) })
  try {
    expect(exportConversationSeed(source, { kind: 'anonymous' }, { kind: 'all' }).kind).toBe('seed')
    expect(walks).toBe(1)
  } finally { spy.mockRestore() }
})

it('closes shared evidence intervals without changing order', () => {
  expect(closeSourceIntervals([['a'], ['b'], ['a'], ['c']])).toEqual([{ first: 0, last: 2 }, { first: 3, last: 3 }])
  expect(closeSourceIntervals([['a'], ['b'], ['b', 'c'], ['a'], ['c']])).toEqual([{ first: 0, last: 4 }])
})

it('selects current effective summary by its original extent and never resurrects consumed inputs', () => {
  const { source, t1InputSeq, t2InputSeq } = literalSource()
  const label = { kind: 'session' as const, sessionId: 'parent' }
  expect(exportConversationSeed(source, label, { kind: 'completed', atSeq: t1InputSeq })).toEqual({ kind: 'refused', reason: 'straddling-group' })
  const exported = exportConversationSeed(source, label, { kind: 'completed', atSeq: t2InputSeq })
  expect(exported.kind).toBe('seed')
  if (exported.kind !== 'seed') throw Error('seed required')
  expect(exported.seed.groups).toEqual([{ extent: { kind: 'framed', first: 1, last: 2 }, items: [{
    kind: 'summary', scope: 'turn', extent: { kind: 'framed', first: 1, last: 2 }, origins: [{ origin: 0, seq: 8, part: 'message' }],
    sourceProvenance: [{ origin: 0, kind: 'summary', authority: 'derived', scope: 'turn' }], messages: [{ role: 'user', content: 'summary twelve' }],
  }] }])
  expect(validateSemanticSeed(exported.seed)).toEqual(exported.seed)
  append(source, { type: 'rewind/point', version: 1, targetTurn: 0, anchorSeq: 8, mode: 'conversation', fileOps: [] })
  const cut = exportConversationSeed(source, label, { kind: 'all' })
  expect(cut.kind === 'seed' && cut.seed.groups).toEqual([])
})

it('hashes the literal noncircular selected preimage independently', () => {
  const { source } = literalSource()
  const exported = exportConversationSeed(source, { kind: 'session', sessionId: 'parent' }, { kind: 'all' })
  if (exported.kind !== 'seed') throw Error('seed required')
  const preimage = { version: 1, source: { kind: 'session', sessionId: 'parent' }, inheritedOrigins: [], selection: { kind: 'all' },
    turns: { total: 2, completed: [[1, 2]], unframedPrefix: false }, omissions: [], artifacts: [], groups: [{
      extent: { kind: 'framed', first: 1, last: 2 }, items: [{ kind: 'summary', scope: 'turn', extent: { kind: 'framed', first: 1, last: 2 },
        origins: [{ origin: 0, seq: 8, part: 'message' }], sourceProvenance: [{ origin: 0, kind: 'summary', authority: 'derived', scope: 'turn' }], messages: [{ role: 'user', content: 'summary twelve' }] }],
    }] }
  const canonical = (value: unknown): string => value && typeof value === 'object'
    ? Array.isArray(value) ? `[${value.map(canonical).join(',')}]` : `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`).join(',')}}` : JSON.stringify(value)
  const digest = createHash('sha256').update('ih.semantic-seed.source.v1\0' + canonical(preimage)).digest('hex')
  expect(exported.sourceObservationDigest).toBe(digest)
  expect(exported.seed.origins).toEqual([{ kind: 'session', sessionId: 'parent', revision: digest }])
  for (const mutate of [(seed: any) => { seed.groups[0].items[0].calls = [] }, (seed: any) => { seed.groups[0].items[0].origins[0].origin = 99 },
    (seed: any) => { seed.turns.completed = [[2, 2], [1, 1]] }, (seed: any) => { seed.groups[0].items[0].messages[0].toolCalls = [] }]) {
    const broken = structuredClone(exported.seed); mutate(broken); expect(() => validateSemanticSeed(broken)).toThrow()
  }
  const accessor = structuredClone(exported.seed)
  Object.defineProperty(accessor, 'version', { enumerable: true, get() { throw Error('accessor executed') } })
  expect(() => validateSemanticSeed(accessor)).toThrow(/seed/i)
})
