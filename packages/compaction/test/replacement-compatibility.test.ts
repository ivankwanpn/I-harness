import { expect, it } from 'vitest'
import { append, deriveMessages } from '@i-harness/core-session'
import { createCompactionHarness } from './fixtures/engine.ts'
import { history, spyModel, autoConfig } from './fixtures/history.ts'
it('replaces a prior replacement at its actual position and keeps unrelated retained input', async () => {
  const session = history(), f = spyModel(), engine = createCompactionHarness({ model: f.model, config: autoConfig })
  expect((await engine.compact(session)).compacted).toBe(true)
  const first = session.events.find(event => event.type === 'compaction/replacement')!
  append(session, { type: 'user/message', text: 'later completed outcome '.repeat(200) })
  expect((await engine.compact(session)).compacted).toBe(true)
  const second = session.events.at(-1)!
  expect(second.type).toBe('compaction/replacement')
  if (second.type !== 'compaction/replacement') throw Error('replacement required')
  expect(second.coverage[0]?.item).toEqual({ kind: 'summary', at: { seq: first.seq, part: 'message' } })
  expect(deriveMessages(session)).toHaveLength(1)
  expect(session.events.filter(event => event.type === 'compaction/replacement')).toHaveLength(2)
})
