import { expect, it } from 'vitest'
import { captureFactGroup, createNondurableFactOwner, createSession, append, deriveMessages } from '../src/index.ts'

it('admits only closed rewrite records through the dedicated family', () => {
  expect(captureFactGroup({ kind: 'context-reduction', events: [{ type: 'compaction/reset', removedSeqs: [] }] })).toMatchObject({ kind: 'captured' })
  expect(captureFactGroup({ kind: 'context-reduction', events: [{ type: 'session/title', title: 'arbitrary' }] } as any)).toMatchObject({ kind: 'not-issued', code: 'FACT_INVALID_GROUP' })
  expect(captureFactGroup({ kind: 'metadata', event: { type: 'compaction/reset', removedSeqs: [] } } as any)).toMatchObject({ kind: 'not-issued' })
})
it('does not allocate or install a stale nondurable rewrite and returns a closed disposition', async () => {
  const session = createSession(); append(session, { type: 'user/message', text: 'history' })
  const action = createNondurableFactOwner(session).beginAction()
  let current = true
  const capture = action.captureContextReduction!({ kind: 'context-reduction', events: [{ type: 'compaction/reset', removedSeqs: [0] }] }, () => current)
  current = false
  expect(await capture.admit()).toEqual({ kind: 'not-issued', code: 'FACT_PRECONDITION_STALE' })
  expect(session.events).toHaveLength(1)
  expect(deriveMessages(session).map(message => message.content)).toEqual(['history'])
  current = true
  expect(await capture.admit()).toEqual({ kind: 'not-issued', code: 'FACT_PRECONDITION_STALE' })
})
