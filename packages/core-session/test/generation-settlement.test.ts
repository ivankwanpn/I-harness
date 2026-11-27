import { expect, it } from 'vitest'
import { createGenerationIndex } from '../src/conversation/generation.ts'
import { createConversationValidationIndex } from '../src/conversation/validation.ts'
import { generationLimits } from '../src/events/generation.ts'
import type { SessionEvent } from '../src/events/types.ts'

const action = { type: 'context/action', version: 1, ownerSessionId: 'document', actionId: 'origin', trustedAt: 100 } as const
const open = { ...action, op: 'open', purpose: 'main', startedAt: 100, expiresAt: 1000 } as const
const retry = { mode: 'off', maxRetries: 0 } as const

function toolCall(seq: number, callId: string): Extract<SessionEvent, { type: 'tool/call' }> {
  return { type: 'tool/call', seq, callId, name: 'fixture', args: {} }
}

function toolResult(seq: number, callId: string): Extract<SessionEvent, { type: 'tool/result' }> {
  return { type: 'tool/result', seq, callId, name: 'fixture', output: 'ok' }
}

// Only the generation index is under test here. The outer conversation
// validator adds exchange shape and dispatch rules independently.
function predecessor(calls: SessionEvent[], callSeqs = calls.map(event => event.seq!)) {
  const index = createGenerationIndex()
  const append = (...events: SessionEvent[]) => {
    const stage = index.stage()
    for (const event of events) stage.advance(event)
    stage.commit()
  }
  const acceptedSeq = 5 + calls.length
  append({ type: 'user/message', seq: 0, text: 'work', provenance: { kind: 'human', authority: 'request', scope: 'turn', producer: 'test' } },
    { ...open, seq: 1, origin: { kind: 'input', seq: 0 } },
    { ...action, op: 'bind', executionDomain: 'local-test', seq: 2, retry, limits: generationLimits('main', retry) },
    { ...action, op: 'local-invocation', seq: 3, lane: 'main', incarnation: 'runtime', ordinal: 1, localInvocationId: 'invocation' },
    { ...action, op: 'local-settle', seq: 4, localInvocationId: 'invocation', disposition: 'completed' },
    ...calls,
    { type: 'model/exchange-accepted', version: 1, seq: acceptedSeq, exchangeId: 'exchange', actionId: 'origin', attemptId: 'attempt', stepStartSeq: 1, assistantSeq: 2, callSeqs },
    { ...action, seq: acceptedSeq + 1, op: 'accepted', executionDomain: 'local-test', localInvocationId: 'invocation', acceptedSeq },
    { ...action, seq: acceptedSeq + 2, op: 'close', disposition: 'accepted' })
  const successor = { ...open, seq: acceptedSeq + 30, actionId: 'successor', origin: { kind: 'predecessor', seq: acceptedSeq } } as const
  return { index, append, successor, nextSeq: acceptedSeq + 3 }
}

it('settles all matching addresses but separates tool and code results and different IDs', () => {
  const codeCall = { type: 'code/call', seq: 7, cellId: 'cell', callId: 'shared', name: 'fixture', args: {} } as const
  const { index, append, successor, nextSeq } = predecessor([toolCall(5, 'shared'), toolCall(6, 'shared'), codeCall, toolCall(8, 'other')])
  append(toolResult(nextSeq, 'shared'))
  expect(() => index.stage().advance(successor)).toThrow(/ineligible generation origin/)
  append(toolResult(nextSeq + 1, 'other'))
  expect(() => index.stage().advance(successor)).toThrow(/ineligible generation origin/)
  append({ type: 'code/result', seq: nextSeq + 2, cellId: 'cell', callId: 'shared', name: 'fixture', output: 'ok' }, successor)
  expect(index.read().at(-1)?.opened).toBe(successor)
})

it('keeps discarded results private and settles a later call that reuses the same ID', () => {
  const { index, append, successor, nextSeq } = predecessor([toolCall(5, 'shared')], [5, 10])
  const discarded = index.stage()
  discarded.advance(toolResult(nextSeq, 'shared'))
  expect(() => index.stage().advance(successor)).toThrow(/ineligible generation origin/)

  const stage = index.stage()
  stage.advance(toolResult(nextSeq, 'shared'))
  const later = toolCall(nextSeq + 1, 'shared')
  stage.advance(later)
  later.callId = 'changed after capture'
  expect(() => stage.advance(successor)).toThrow(/ineligible generation origin/)
  stage.advance(toolResult(nextSeq + 2, 'shared'))
  stage.validate()
  stage.commit()
  append(successor)
  expect(index.read().at(-1)?.opened).toBe(successor)
})

it('uses the existing committed-then-staged settlement order for a repeated legacy address', () => {
  const { index, append, successor, nextSeq } = predecessor([toolCall(5, 'original')])
  append(toolResult(nextSeq, 'original'))
  const overlapping = index.stage()
  overlapping.advance(toolCall(5, 'shadow'))
  expect(() => overlapping.advance(successor)).toThrow(/ineligible generation origin/)
  overlapping.advance(toolResult(nextSeq + 1, 'original'))
  overlapping.advance(successor)
  overlapping.commit()
  expect(index.read().at(-1)?.opened).toBe(successor)
})

it('continues to use legacy result accessors without keeping their event objects as pending references', () => {
  const { append, index, successor, nextSeq } = predecessor([toolCall(5, 'original')])
  let readable = true
  const result = Object.defineProperty(toolResult(nextSeq, 'unread'), 'callId', {
    get() {
      if (!readable) throw new Error('The result is no longer available')
      return 'original'
    },
  })
  append(result)
  readable = false
  append(successor)
  expect(index.read().at(-1)?.opened).toBe(successor)
})

it('publishes one suffix from the same conversation base and refuses the competing stale suffix', () => {
  const index = createConversationValidationIndex([toolCall(0, 'pending')])
  const winner = index.stage([toolResult(1, 'pending')])
  const stale = index.stage([toolCall(1, 'superseded')])
  winner.commit()
  expect(() => stale.commit()).toThrow(/stale staged suffix/)
  expect(index.eventCount).toBe(2)
  index.stage([toolCall(2, 'pending'), toolResult(3, 'pending')]).commit()
  expect(index.eventCount).toBe(4)
})
