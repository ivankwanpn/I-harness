import { expect, it, vi } from 'vitest'
import { append, createSession, exportConversationSeed } from '../src/index.ts'
import { seedSourceIntervals } from '../src/conversation/seed-selection.ts'
import { literalSeed } from './fixtures/format11-seed.ts'
import { literalSession } from './fixtures/semantic-observation.ts'

it('counts hidden and open original turns, rebases suffix turns, and refuses unsafe boundaries', () => {
  const source = createSession()
  append(source, { type: 'user/message', text: 'unframed' })
  append(source, { type: 'turn/start' })
  append(source, { type: 'user/message', text: 'one' })
  append(source, { type: 'turn/end' })
  append(source, { type: 'turn/start' })
  append(source, { type: 'user/message', text: 'two' })
  append(source, { type: 'turn/end' })
  append(source, { type: 'turn/start' })
  append(source, { type: 'user/message', text: 'open' })
  const exported = exportConversationSeed(source, { kind: 'anonymous' }, { kind: 'last-turns', count: 2 })
  if (exported.kind !== 'seed') throw Error('seed required')
  expect(exported.seed.turns).toEqual({ total: 2, completed: [[1, 1]], unframedPrefix: false })
  expect(exported.seed.groups.flatMap(group => group.items.flatMap(item => item.messages.map(message => message.content)))).toEqual(['two', 'open'])
  expect(exportConversationSeed(source, { kind: 'anonymous' }, { kind: 'last-turns', count: 0 })).toEqual({ kind: 'refused', reason: 'invalid-selection' })
  expect(exportConversationSeed({ ...source, formatVersion: 99 }, { kind: 'anonymous' }, { kind: 'all' })).toEqual({ kind: 'refused', reason: 'source-unsupported' })
})

it('omits a transitive evidence interval before filtering any incomplete member', () => {
  expect(seedSourceIntervals([['a'], ['b'], ['a', 'c'], ['b', 'c'], ['tail']], [true, false, true, true, true])).toEqual([
    { first: 0, last: 3, complete: false }, { first: 4, last: 4, complete: true },
  ])
})

it('keeps inherited hidden-turn intervals scalar instead of expanding every ordinal', () => {
  const seed = structuredClone(literalSeed)
  seed.groups = []; seed.turns = { total: 10000, completed: [[1, 10000]], unframedPrefix: false }
  const source = literalSession(seed)
  let insertions = 0
  const add = Set.prototype.add
  const spy = vi.spyOn(Set.prototype, 'add').mockImplementation(function<T>(this: Set<T>, value: T) { insertions++; return add.call(this, value) as Set<T> })
  try {
    const exported = exportConversationSeed(source, { kind: 'anonymous' }, { kind: 'last-turns', count: 1 })
    expect(exported.kind === 'seed' && exported.seed.turns).toEqual({ total: 1, completed: [[1, 1]], unframedPrefix: false })
    expect(insertions).toBeLessThan(500)
  } finally { spy.mockRestore() }
})
