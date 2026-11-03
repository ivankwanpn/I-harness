import { expect, it } from 'vitest'
import { append, exportConversationSeed } from '../src/index.ts'
import { literalSeed } from './fixtures/format11-seed.ts'
import { literalSession } from './fixtures/semantic-observation.ts'

it('retains and rebases unlinked metadata-only omissions and refuses a crossing completed boundary', () => {
  const seed = structuredClone(literalSeed)
  seed.turns = { total: 3, completed: [[1, 3]], unframedPrefix: false }
  const item = { ...seed.groups[0]!.items[0]!, extent: { kind: 'framed' as const, first: 1, last: 1 } }
  seed.groups = [{ extent: item.extent, items: [item] }]
  seed.omissions = [{ extent: { kind: 'framed', first: 1, last: 2 }, source: [{ origin: 0, seq: 8, part: 'step' }], state: 'unresolved', calls: 2, relatedInputs: [], digest: '0'.repeat(64) }]
  const source = literalSession(seed)
  append(source, { type: 'compaction/reset', removedSeqs: [1] })
  const exported = exportConversationSeed(source, { kind: 'anonymous' }, { kind: 'all' })
  expect(exported.kind).toBe('seed')
  if (exported.kind !== 'seed') throw Error('seed required')
  expect(exported.seed.groups).toEqual([])
  expect(exported.seed.omissions).toMatchObject([{ extent: { kind: 'framed', first: 1, last: 2 }, state: 'unresolved', calls: 2, relatedInputs: [] }])
  expect(exportConversationSeed(source, { kind: 'anonymous' }, { kind: 'completed', atSeq: 1 })).toEqual({ kind: 'refused', reason: 'straddling-group' })
  const outside = exportConversationSeed(source, { kind: 'anonymous' }, { kind: 'last-turns', count: 1 })
  expect(outside.kind === 'seed' && outside.seed.omissions).toEqual([])
  const nested = exportConversationSeed(literalSession(exported.seed), { kind: 'session', sessionId: 'nested' }, { kind: 'completed' })
  expect(nested.kind).toBe('seed')
  expect(nested.kind === 'seed' && nested.seed.omissions).toMatchObject([{ extent: { kind: 'framed', first: 1, last: 2 }, state: 'unresolved', relatedInputs: [] }])
})

it('rebases contained omission ranges and excludes unframed observations for a strict suffix', () => {
  const seed = structuredClone(literalSeed)
  seed.groups = []; seed.turns = { total: 3, completed: [[1, 3]], unframedPrefix: true }
  seed.omissions = [{ extent: { kind: 'unframed' }, source: [{ origin: 0, seq: 0, part: 'step' }], state: 'open', calls: 1, relatedInputs: [], digest: '0'.repeat(64) },
    { extent: { kind: 'framed', first: 2, last: 3 }, source: [{ origin: 0, seq: 4, part: 'step' }], state: 'open', calls: 1, relatedInputs: [], digest: '0'.repeat(64) }]
  const exported = exportConversationSeed(literalSession(seed), { kind: 'anonymous' }, { kind: 'last-turns', count: 2 })
  expect(exported.kind).toBe('seed')
  expect(exported.kind === 'seed' && exported.seed.omissions).toMatchObject([{ extent: { kind: 'framed', first: 1, last: 2 }, relatedInputs: [] }])
  expect(exported.kind === 'seed' && exported.seed.omissions.length).toBe(1)
})
