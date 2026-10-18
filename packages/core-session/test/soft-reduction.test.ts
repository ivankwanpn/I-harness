import { expect, it } from 'vitest'
import * as core from '../src/index.ts'
const d = 'a'.repeat(64), e = 'b'.repeat(64)
const start = (sequenceId = 's', workKey = d) => ({ type: 'context/soft-reduction', version: 1, op: 'start', ownerSessionId: 'owner', sequenceId, workKey, sourceKey: d, protectionKey: d, policyKey: d, acceptedExchanges: 0, humanTurns: 0 })
const terminal = (outcome: string, sequenceId = 's', workKey = d, startSeq = 0) => ({ type: 'context/soft-reduction', version: 1, op: 'terminal', ownerSessionId: 'owner', sequenceId, workKey, sourceKey: d, startSeq, outcome, publication: 'none', consumedBeforeKey: workKey })
function index() {
  expect(core).toHaveProperty('createSoftReductionIndex', expect.any(Function))
  return (core as any).createSoftReductionIndex({ sessionId: 'owner' })
}
it('folds one failure per sequence, pending consumption and only atomic target-ready reset', () => {
  const value = index()
  const append = (events: any[]) => { const stage = value.stage(); for (const event of events) stage.advance(event); stage.commit() }
  append([{ ...start(), seq: 0 }])
  expect(value.read('owner')).toMatchObject({ failures: 0, pending: true })
  expect(value.read('owner').consumed.has(d)).toBe(true)
  append([{ ...terminal('failed'), seq: 1 }])
  expect(value.read('owner')).toMatchObject({ failures: 1, pending: false })
  expect(() => append([{ ...terminal('failed'), seq: 2 }])).toThrow()
  append([{ ...start('s2', e), seq: 2 }, { type: 'compaction/reset', removedSeqs: [], seq: 3 }, { ...terminal('reduced-over-target', 's2', e, 2), publication: 'committed', consumedAfterKey: 'c'.repeat(64), seq: 4 }])
  expect(value.read('owner').failures).toBe(1)
  expect(value.read('owner').consumed.has('c'.repeat(64))).toBe(true)
})
it('rejects cross-session/cross-start and unguarded published terminals', () => {
  const value = index(), stage = value.stage()
  stage.advance({ ...start(), seq: 0 })
  expect(() => stage.advance({ ...terminal('target-ready'), ownerSessionId: 'other', publication: 'committed', consumedAfterKey: e, seq: 1 })).toThrow()
  expect(() => (core as any).validSoftReductionEvent({ ...terminal('target-ready'), publication: 'none' })).not.toThrow()
  expect((core as any).validSoftReductionEvent({ ...terminal('target-ready'), publication: 'none' })).toBe(false)
  expect((core as any).validSoftReductionEvent({ ...start(), workKey: undefined })).toBe(false)
  const getter = Object.defineProperty({ ...start() }, 'workKey', { get() { throw Error('must not execute') }, enumerable: true })
  expect((core as any).validSoftReductionEvent(getter)).toBe(false)
})
