import { expect, it } from 'vitest'
import { decodeSavedCalls } from '../src/saved-process-index.ts'

it('pairs only unique matching original calls and never promotes preview or duplicate calls', () => {
  const events = [
    { type: 'tool/call', callId: 'a', name: 'shell', args: {}, seq: 1 },
    { type: 'tool/result', callId: 'a', name: 'shell', seq: 2, envelope: { execution: { outcome: 'succeeded', dispatch: 'dispatched' }, retention: { kind: 'inline', value: { job_id: 'one' } }, preview: 'forged' } },
    { type: 'tool/call', callId: 'b', name: 'shell', args: {}, seq: 3 },
    { type: 'tool/call', callId: 'b', name: 'shell', args: {}, seq: 4 },
    { type: 'tool/result', callId: 'b', name: 'shell', output: { job_id: 'two' }, seq: 5 },
    { type: 'tool/call', callId: 'c', name: 'shell', args: {}, seq: 6 },
    { type: 'tool/result', callId: 'c', name: 'shell', seq: 7, envelope: { execution: { outcome: 'succeeded', dispatch: 'dispatched' }, retention: { kind: 'artifact' }, preview: '{"job_id":"fake"}' } },
  ]
  expect(decodeSavedCalls(events, 'owner')).toMatchObject([{ callIndex: 0, resultIndex: 1, value: { job_id: 'one' }, provenance: 'inline' }])
})

it('rejects foreign cells, mismatched dispatches, hidden facts and failed envelopes', () => {
  const envelope = { execution: { outcome: 'succeeded', dispatch: 'dispatched' }, retention: { kind: 'inline', value: { job_id: 'x' } } }
  const events = [
    { type: 'code/cell', cellId: 'c', sessionId: 'foreign', state: 'started', seq: 1 },
    { type: 'code/call', cellId: 'c', callId: 'a', name: 'shell', args: {}, seq: 2 },
    { type: 'code/result', cellId: 'c', callId: 'a', name: 'shell', envelope, seq: 3 },
    { type: 'tool/call', callId: 'b', name: 'shell', args: {}, seq: 4 },
    { type: 'tool/dispatch', callId: 'b', eventSeq: 9, seq: 5 },
    { type: 'tool/result', callId: 'b', name: 'shell', envelope, seq: 6 },
    { type: 'tool/call', callId: 'c', name: 'shell', args: {}, seq: 7 },
    { type: 'tool/result', callId: 'c', name: 'shell', envelope, seq: 8 },
    { type: 'rewind/point', anchorSeq: 7, seq: 9 },
    { type: 'tool/call', callId: 'd', name: 'shell', args: {}, seq: 10 },
    { type: 'tool/result', callId: 'd', name: 'shell', envelope: { ...envelope, execution: { outcome: 'failed', dispatch: 'dispatched' } }, seq: 11 },
  ]
  expect(decodeSavedCalls(events, 'owner')).toEqual([])
})
