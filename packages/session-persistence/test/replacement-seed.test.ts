import { expect, it } from 'vitest'
import { deriveMessages, type SessionEvent } from '@i-harness/core-session'
import { remapConversationSeed, SessionForkUnavailableError } from '../src/seed.ts'

const source = (): SessionEvent[] => [
  { type: 'context/recovery', version: 1, seq: 0, ownerSessionId: 'parent', recoveryId: 'audit', logicalStepSeq: 0, bindingFingerprint: 'a'.repeat(64), rejectedInputFingerprint: 'b'.repeat(64), state: 'resolved' },
  { type: 'turn/start', seq: 1 }, { type: 'user/message', seq: 2, text: 'H' },
  { type: 'step/start', seq: 3 }, { type: 'assistant/message', seq: 4, text: 'E' }, { type: 'step/end', seq: 5 }, { type: 'turn/end', seq: 6 },
  { type: 'compaction/replacement', version: 1, seq: 7, replacementId: 'r7', text: 'S',
    coverage: [{ item: { kind: 'exchange', at: { seq: 4, part: 'message' } }, sources: [{ seq: 3, part: 'step' }, { seq: 4, part: 'message' }] }],
    insertBefore: { kind: 'exchange', at: { seq: 4, part: 'message' } } } as SessionEvent,
]

it('remaps complete in-boundary replacement proof exactly once', () => {
  const parent = source()
  const seed = remapConversationSeed({ source: parent, retained: parent.slice(1), sourceFormat: 7 })
  expect(seed[6]).toMatchObject({ type: 'compaction/replacement', seq: 6,
    coverage: [{ item: { kind: 'exchange', at: { seq: 3, part: 'message' } }, sources: [{ seq: 2, part: 'step' }, { seq: 3, part: 'message' }] }],
    insertBefore: { kind: 'exchange', at: { seq: 3, part: 'message' } }, replacementId: expect.stringMatching(/^seed:/) })
  expect(deriveMessages({ formatVersion: 7, events: seed }).map(message => message.content)).toEqual(['H', 'S'])
  expect(parent[7]).toMatchObject({ replacementId: 'r7', seq: 7 })
})

it('refuses a tail missing original proof rather than broadening its boundary', () => {
  const parent = source()
  expect(() => remapConversationSeed({ source: parent, retained: parent.slice(4), sourceFormat: 7 })).toThrow(SessionForkUnavailableError)
})
