import { expect, it } from 'vitest'
import { append, deriveMessages, type Session } from '@i-harness/core-session'
import { createCompactionEngine } from '../src/index.ts'

it('refuses every old reducer before summary calls or markers and allows ordinary continuation', async () => {
  const session: Session = { formatVersion: 7, events: [
    { type: 'turn/start', seq: 0 }, { type: 'user/message', seq: 1, text: 'H' },
    { type: 'step/start', seq: 2 }, { type: 'assistant/message', seq: 3, text: 'E' }, { type: 'step/end', seq: 4 }, { type: 'turn/end', seq: 5 },
    { type: 'compaction/replacement', version: 1, seq: 6, replacementId: 'reader', text: 'S',
      coverage: [{ item: { kind: 'exchange', at: { seq: 3, part: 'message' } }, sources: [{ seq: 2, part: 'step' }, { seq: 3, part: 'message' }] }],
      insertBefore: { kind: 'exchange', at: { seq: 3, part: 'message' } } },
  ] }
  let calls = 0
  const engine = createCompactionEngine({ model: { async *stream() { calls++; yield { type: 'text/chunk' as const, text: 'summary' }; yield { type: 'end' as const } } }, config: { contextWindow: 1000, thresholdRatio: .01 } })
  const original = JSON.stringify(session)
  for (const result of [await engine.maybeCompact(session), await engine.compact(session), await engine.recover(session), await engine.resetWindow(session, 1)]) {
    expect(result).toMatchObject({ compacted: false, reason: 'replacement-history-unsupported', shadowedSeqs: [] })
  }
  expect(calls).toBe(0)
  expect(JSON.stringify(session)).toBe(original)
  append(session, { type: 'user/message', text: 'next' })
  expect(deriveMessages(session).map(message => message.content)).toEqual(['H', 'S', 'next'])
})
