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

it('keeps reused native ids ambiguous and selects only zero-origin output for each instance', async () => {
  const { buildSavedProcessIndex } = await import('../src/saved-process-index.ts')
  const identity = (instanceId: string) => ({ version: 1, jobId: 'bash-1', instanceId, ownerSessionId: 'owner', sourceId: 'process:1' })
  const fact = (callId: string, name: string, args: object, value: object) => [
    { type: 'tool/call', callId, name, args }, { type: 'tool/result', callId, name, envelope: { execution: { outcome: 'succeeded', dispatch: 'dispatched' }, retention: { kind: 'inline', value } } },
  ]
  const events = [
    ...fact('a', 'shell', {}, { job_id: 'bash-1', native_job: identity('a') }),
    ...fact('b', 'shell', {}, { job_id: 'bash-1', native_job: identity('b') }),
    ...fact('c', 'job_output', { job_id: 'bash-1', job_instance_id: 'a' }, { job_id: 'bash-1', native_job: identity('a'), text: 'prefix', offset_bytes: 0 }),
    ...fact('d', 'job_output', { job_id: 'bash-1', job_instance_id: 'a', offset_bytes: 3 }, { job_id: 'bash-1', native_job: identity('a'), text: 'suffix', offset_bytes: 3 }),
  ]
  const index = buildSavedProcessIndex(events, 'owner')
  expect(index.select('bash-1')).toEqual({ kind: 'ambiguous-selector' })
  expect(index.select('bash-1', 'a')).toMatchObject({ kind: 'selected', candidate: { snapshot: { text: 'prefix' } } })
})

it('binds an artifact descriptor only through an original selected invocation', async () => {
  const { buildSavedProcessIndex } = await import('../src/saved-process-index.ts')
  const ref = (c: string) => ({ version: 1, id: `ctxv1_${c.repeat(64)}`, revision: 'd'.repeat(64), codec: 'json-utf8-v1', encodedBytes: 12, contentDigest: 'e'.repeat(64), completeness: 'complete' })
  const native = { version: 1, jobId: 'bash-1', instanceId: 'instance', ownerSessionId: 'owner', sourceId: 'source' }
  const inline = { execution: { outcome: 'succeeded', dispatch: 'dispatched' }, retention: { kind: 'inline', value: { job_id: 'bash-1', native_job: native } } }
  const artifact = { execution: { outcome: 'succeeded', dispatch: 'dispatched' }, retention: { kind: 'artifact', ref: ref('a') }, dependencies: { kind: 'artifact-set', count: 1, ref: ref('b') }, preview: 'forged' }
  const events = [{ type: 'tool/call', callId: 'a', name: 'shell', args: {} }, { type: 'tool/result', callId: 'a', name: 'shell', envelope: inline },
    { type: 'tool/call', callId: 'b', name: 'job_output', args: { job_id: 'bash-1', job_instance_id: 'instance', source_id: 'source' } },
    { type: 'tool/result', callId: 'b', name: 'job_output', envelope: artifact }]
  const selected = buildSavedProcessIndex(events, 'owner').select('bash-1', 'instance')
  expect(selected).toMatchObject({ kind: 'selected', candidate: { descriptor: { dto: ref('a'), catalog: ref('b') } } })
  artifact.retention.ref.id = ref('c').id
  expect(selected).toMatchObject({ candidate: { descriptor: { dto: ref('a') } } })
})
