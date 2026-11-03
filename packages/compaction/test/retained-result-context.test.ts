import { expect, it } from 'vitest'
import { append, createSession, createNondurableFactOwner, deriveMessages, fromJSONL, toJSONL, type ResultEnvelope } from '@i-harness/core-session'
import { softAdvances } from '../../core-agent/src/agent/context-reduction/automatic.ts'

it('preserves actual unknown disposition in bounded projection and soft-reduction progress after cold replay', async () => {
  const session = createSession()
  append(session, { type: 'user/message', text: 'current request' })
  append(session, { type: 'tool/call', callId: 'effect', name: 'effect', args: {} })
  append(session, { type: 'tool/dispatch', callId: 'effect', eventSeq: 1 })
  const envelope: ResultEnvelope = { version: 1, execution: { outcome: 'unknown', dispatch: 'dispatched' }, preview: 'Execution effect is unknown.', media: [], retention: { kind: 'unavailable', reason: 'capture-canceled' } }
  const action = createNondurableFactOwner(session).beginAction(), source = action.registerSettlementSource(async () => {})
  expect((await source.tools.captureResult({ type: 'tool/result', callId: 'effect', name: 'effect', envelope }).admit()).kind).toBe('memory-committed')
  for (const view of [session, fromJSONL(toJSONL(session))]) {
    const projected = deriveMessages(view)
    expect(projected.find(message => message.role === 'tool')).toMatchObject({ isError: true, content: expect.stringContaining('"outcome":"unknown"') })
    expect(softAdvances(view.events).acceptedExchanges).toBe(0)
    expect(Buffer.byteLength(JSON.stringify(projected))).toBeLessThanOrEqual(64000)
  }
  await source.close(); action.finish()
})
