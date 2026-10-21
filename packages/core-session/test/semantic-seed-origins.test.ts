import { expect, it } from 'vitest'
import { append, exportConversationSeed, validateSemanticSeed, projectConversation, type SemanticSeedV1, type SeedOriginAddress, type SeedItem } from '../src/index.ts'
import { literalSeed } from './fixtures/format11-seed.ts'
import { literalSession } from './fixtures/semantic-observation.ts'

function historicalSource(permuted: boolean) {
  const seed = structuredClone(literalSeed)
  const a = { kind: 'session' as const, sessionId: 'ancestor-a', revision: 'c'.repeat(64) }, b = { kind: 'anonymous' as const, contentDigest: 'd'.repeat(64) }
  seed.origins = [seed.origins[0]!, ...(permuted ? [b, a] : [a, b]), { kind: 'anonymous', contentDigest: 'e'.repeat(64) }]
  const slotA = permuted ? 2 : 1, slotB = permuted ? 1 : 2
  const address = (origin: number, part: string): SeedOriginAddress => ({ origin, seq: 4, part })
  const first = seed.groups[0]!.items[0]!
  const input: SeedItem = { ...first, kind: 'input', origins: [address(slotA, 'message')], sourceProvenance: [{ origin: slotA, kind: 'human', authority: 'request', scope: 'session', producer: 'original human' }],
    input: { raw: [address(slotA, 'message')], derivedContext: [address(slotB, 'message')], media: [], omittedWork: 0 } }
  const exchange = seed.groups[0]!.items[1]!
  if (exchange.kind !== 'exchange') throw Error('exchange required')
  const ref = { version: 1 as const, id: `ctxv1_${'f'.repeat(64)}`, revision: 'f'.repeat(64), codec: 'json-utf8-v1' as const, encodedBytes: 10, contentDigest: 'f'.repeat(64), completeness: 'complete' as const }
  seed.groups = [{ ...seed.groups[0]!, items: [input, { ...exchange, origins: [address(slotB, 'call')], sourceProvenance: [{ origin: slotB, kind: 'plugin', authority: 'observation', scope: 'turn', producer: 'plugin' }],
    calls: exchange.calls.map(call => ({ ...call, source: [address(slotA, 'call')] })), results: [{ kind: 'envelope', message: 1, source: [address(slotB, 'result')], media: [], execution: { outcome: 'succeeded', dispatch: 'dispatched' },
      sourceRetention: { kind: 'artifact', artifact: 0 }, dependencies: { kind: 'catalog', artifact: 0, count: 1 } }] }] }]
  seed.artifacts = [{ ref, origins: [address(slotB, 'result')], uses: [{ kind: 'result' }, { kind: 'dependency-catalog', count: 1 }] }]
  seed.omissions = [{ extent: { kind: 'framed', first: 1, last: 2 }, source: [address(slotA, 'step')], digest: '0'.repeat(64), state: 'open', calls: 1, relatedInputs: [0] }]
  return literalSession(seed)
}

it('normalizes all reachable inherited slots independently of the historical table order', () => {
  const sourceA = historicalSource(false), sourceB = historicalSource(true)
  for (const source of [sourceA, sourceB]) {
    append(source, { type: 'turn/start' }); append(source, { type: 'user/message', text: 'local' }); append(source, { type: 'turn/end' })
  }
  const a = exportConversationSeed(sourceA, { kind: 'session', sessionId: 'child' }, { kind: 'all' })
  const b = exportConversationSeed(sourceB, { kind: 'session', sessionId: 'child' }, { kind: 'all' })
  expect(a).toEqual(b)
  expect(a.kind).toBe('seed')
  if (a.kind !== 'seed') throw Error('seed required')
  expect(a.seed.origins).toHaveLength(3)
  expect(JSON.stringify(a.seed.origins)).not.toContain('e'.repeat(64))
  expect(a.seed.groups[0]!.items[0]!.origins[0]!.origin).toBeGreaterThanOrEqual(1)
  expect(a.seed.groups.at(-1)!.items[0]!.origins[0]!.origin).toBe(0)
  expect(validateSemanticSeed(a.seed)).toEqual(a.seed)
  expect(projectConversation(sourceA).items[0]!.provenance).toMatchObject({ kind: 'inherited', authority: 'observation' })
})

it('rebases an old current slot zero as historical and refuses malformed inherited indices', () => {
  const source = literalSession(structuredClone(literalSeed))
  const exported = exportConversationSeed(source, { kind: 'anonymous' }, { kind: 'all' })
  if (exported.kind !== 'seed') throw Error('seed required')
  expect(exported.seed.groups[0]!.items[0]!.origins[0]!.origin).toBe(1)
  const record = source.events[1]!
  if (record.type !== 'conversation/seed-group') throw Error('seed group required')
  record.group.items[0]!.origins = [{ origin: 50, seq: 1, part: 'message' }]
  expect(exportConversationSeed(source, { kind: 'anonymous' }, { kind: 'all' })).toEqual({ kind: 'refused', reason: 'invalid-seed' })
})

it('replays nested T1–T3 then local T4 and selects the current T2–T4 summary exactly', () => {
  const seed: SemanticSeedV1 = structuredClone(literalSeed)
  seed.turns = { total: 3, completed: [[1, 3]], unframedPrefix: false }
  const input: SeedItem = { ...seed.groups[0]!.items[0]!, kind: 'summary', extent: { kind: 'framed', first: 1, last: 1 }, messages: [{ role: 'user', content: 'T1 retained' }] }
  const exchange = { ...seed.groups[0]!.items[1]!, extent: { kind: 'framed' as const, first: 2, last: 3 } }
  seed.groups = [{ extent: input.extent, items: [input] }, { extent: exchange.extent, items: [exchange] }]
  const source = literalSession(seed)
  append(source, { type: 'turn/start' }); append(source, { type: 'user/message', text: 'T4' }); append(source, { type: 'assistant/message', text: 'T4 answer' }); append(source, { type: 'turn/end' })
  const projection = projectConversation(source), selected = projection.items.slice(1)
  const coverage = selected.map(item => ({ item: item.ref!, sources: item.sources.map(ref => ({ seq: ref.seq!, part: ref.part })).sort((a, b) => a.seq - b.seq || a.part.localeCompare(b.part)) }))
  append(source, { type: 'compaction/replacement', version: 1, replacementId: 'nested', text: 'summary T2 through T4', coverage, insertBefore: coverage[0]!.item })
  expect(exportConversationSeed(source, { kind: 'anonymous' }, { kind: 'last-turns', count: 2 })).toEqual({ kind: 'refused', reason: 'straddling-group' })
  const exported = exportConversationSeed(source, { kind: 'anonymous' }, { kind: 'last-turns', count: 3 })
  if (exported.kind !== 'seed') throw Error('seed required')
  expect(exported.seed.turns).toEqual({ total: 3, completed: [[1, 3]], unframedPrefix: false })
  expect(exported.seed.groups).toMatchObject([{ extent: { kind: 'framed', first: 1, last: 3 }, items: [{ messages: [{ role: 'user', content: 'summary T2 through T4' }] }] }])
})

it('rebases omission reverse links by emitted input-only ordinal after nested selection', () => {
  const seed = structuredClone(literalSeed), original = seed.groups[0]!
  const input = (text: string, turn: number, omittedWork: number): SeedItem => ({ kind: 'input', scope: 'turn', extent: { kind: 'framed', first: turn, last: turn },
    origins: [{ origin: 0, seq: turn, part: 'message' }], sourceProvenance: [{ origin: 0, kind: 'plugin', authority: 'observation', scope: 'turn' }],
    messages: [{ role: 'user', content: text }], input: { raw: [{ origin: 0, seq: turn, part: 'message' }], derivedContext: [], media: [], omittedWork } })
  seed.groups = [{ extent: { kind: 'framed', first: 1, last: 1 }, items: [input('first input', 1, 0)] },
    { extent: { kind: 'framed', first: 1, last: 1 }, items: [{ ...original.items[1]!, extent: { kind: 'framed', first: 1, last: 1 } }] },
    { extent: { kind: 'framed', first: 2, last: 2 }, items: [input('second input', 2, 1)] }]
  seed.omissions = [0, 1].map(index => ({ extent: { kind: 'framed' as const, first: index + 1, last: index + 1 }, source: [{ origin: 0, seq: index, part: 'step' }], state: 'open' as const, calls: 1, relatedInputs: [index], digest: '0'.repeat(64) }))
  const source = literalSession(seed)
  const exported = exportConversationSeed(source, { kind: 'anonymous' }, { kind: 'last-turns', count: 1 })
  expect(exported.kind).toBe('seed')
  if (exported.kind !== 'seed') throw Error('seed required')
  expect(exported.seed.omissions).toHaveLength(1)
  expect(exported.seed.omissions[0]!.relatedInputs).toEqual([0])
  expect(exported.seed.groups[0]!.items[0]).toMatchObject({ kind: 'input', input: { omittedWork: 0 } })
  for (const relatedInputs of [[1], [0, 0], []]) {
    const malformed = structuredClone(exported.seed)
    malformed.omissions[0]!.relatedInputs = relatedInputs
    literalSession(malformed)
    expect(() => validateSemanticSeed(malformed)).toThrow()
  }
})
