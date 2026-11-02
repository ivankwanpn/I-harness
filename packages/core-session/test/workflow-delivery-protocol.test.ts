import { expect, it } from 'vitest'
import { deliveryInputId, validDeliveryEvent } from '../src/events/delivery.ts'
import { validWorkflowRunResult } from '../src/events/workflow-delivery.ts'
import { createDeliveryIndex, readDeliveries } from '../src/conversation/delivery.ts'
import { validateConversationEventShape } from '../src/events/conversation.ts'
import { encodeFactBatch, readFactJournal, legacyPrefixDigest } from '../src/serialization/fact-journal.ts'
import { managedResultRefs } from '../src/results/projection.ts'
import { captureFactGroup } from '../src/managed/groups.ts'

const ref = { version: 1, id: 'ctxv1_' + 'a'.repeat(64), revision: 'b'.repeat(64), codec: 'json-utf8-v1', encodedBytes: 12, contentDigest: 'c'.repeat(64), completeness: 'complete' } as const
const source = { type: 'agent/delivery-source', version: 1, kind: 'workflow', sourceNamespace: 'workflow', sourceId: 'original-invocation', recipientSessionId: 'parent', generationId: 'g', callSeq: 2, delivery: 'tool', seq: 4 } as const
const terminal = { type: 'workflow/end', version: 1, sourceSeq: 4, invocationId: source.sourceId, execution: { dispatch: 'dispatched', outcome: 'succeeded' }, result: { kind: 'artifact', ref } } as const
const handoff = { type: 'agent/delivery-handoff', version: 1, kind: 'workflow', sourceSeq: 4 } as const
const key = { kind: 'workflow', sourceNamespace: 'workflow', sourceId: source.sourceId, recipientSessionId: 'parent', resultRevision: ref.revision } as const
function history(order: 'terminal-first' | 'handoff-first' | 'background' | 'foreground' = 'terminal-first', received = true): any[] {
  const events: any[] = [
    { type: 'agent/input/admitted', version: 1, inputId: 'human', text: 'work', delivery: 'queue', intent: 'user', provenance: { kind: 'human', authority: 'request', scope: 'turn', producer: 'session.prompt' }, seq: 0 },
    { type: 'agent/delivery-generation', version: 1, op: 'open', recipientSessionId: 'parent', generationId: 'g', originInputSeq: 0, seq: 1 },
    { type: 'tool/call', name: 'workflow_run', callId: 'call', args: {}, seq: 2 }, { type: 'tool/dispatch', callId: 'call', eventSeq: 2, seq: 3 },
    { ...source, delivery: order === 'background' ? 'parent' : 'tool' },
  ]
  if (order === 'handoff-first') events.push({ ...handoff, seq: events.length })
  const terminalSeq = events.length; events.push({ ...terminal, seq: terminalSeq })
  if (order === 'terminal-first') events.push({ ...handoff, seq: events.length })
  if (received) {
    const inputId = deliveryInputId(key as never)
    events.push({ type: 'agent/delivery-received', version: 1, key, sourceSeq: 4, terminalSeq, inputId, seq: events.length })
    events.push({ type: 'agent/input/admitted', version: 1, inputId, text: 'completed', delivery: 'steer', intent: 'system', provenance: { kind: 'child-report', authority: 'observation', scope: 'turn', producer: 'session.delivery.workflow' }, synthetic: { scope: 'turn', description: 'Workflow completed', display: { kind: 'task', title: 'workflow', body: 'completed' } }, seq: events.length })
  }
  return events
}
const read = (events: any[]) => readDeliveries({ formatVersion: 14, header: { sessionId: 'parent' }, events } as never)
it('validates Workflow source handoff and terminal only from physical14', () => {
  for (const event of [source, handoff, terminal]) {
    expect(validDeliveryEvent(event)).toBe(true)
    expect(() => validateConversationEventShape(event as never, 14)).not.toThrow()
    expect(() => validateConversationEventShape(event as never, 13)).toThrow()
  }
})
it.each(['terminal-first','handoff-first','background'] as const)('reduces the original Workflow source and receipt after %s', order => {
  const events = history(order), state = read(events)
  expect(state.receipt(key as never)).toMatchObject({ disposition: 'pending' })
  expect(state.pending()).toHaveLength(1)
  const prefix = legacyPrefixDigest(0, new Uint8Array())
  const bytes = encodeFactBatch('workflow-original', prefix, events).bytes
  const metadata = { version: 1 as const, legacyBodyBytes: 0, legacyEventCount: 0, legacyPrefixDigest: prefix, separatorBytes: 0 as const }
  expect(readFactJournal(bytes, metadata, 14, { sessionId: 'parent' }).events).toEqual(events)
  expect(() => readFactJournal(bytes, metadata, 13, { sessionId: 'parent' })).toThrow()
})
it('rejects wrong source terminal recipient generation codec revision and provenance bindings', () => {
  for (const mutate of [
    (e: any[]) => { e[2].name = 'shell' }, (e: any[]) => { e[3].callId = 'other' }, (e: any[]) => { e[4].generationId = 'other' },
    (e: any[]) => { e[5].invocationId = 'other' }, (e: any[]) => { e[5].sourceSeq = 2 }, (e: any[]) => { e[5].result.ref.codec = 'exec-frames-v1' },
    (e: any[]) => { e[7].key.recipientSessionId = 'other' }, (e: any[]) => { e[7].key.resultRevision = 'd'.repeat(64) },
    (e: any[]) => { e[6].kind = 'exec' }, (e: any[]) => { e[7].key.kind = 'exec' },
    (e: any[]) => { e[8].provenance.producer = 'session.delivery.exec' },
  ]) { const events = structuredClone(history()); mutate(events); expect(() => read(events)).toThrow() }
  expect(() => read(history('foreground'))).toThrow()
})
it('rejects extra/accessor/prototype fields without invoking hooks and validates ordered aggregate attempts', () => {
  let reads = 0
  for (const bad of [{ ...terminal, extra: true }, { ...terminal, dependency: {} }, Object.assign(Object.create({ foreign: true }), terminal),
    Object.defineProperty({ ...terminal }, 'result', { enumerable: true, get() { reads++; return terminal.result } })]) expect(validDeliveryEvent(bad)).toBe(false)
  expect(reads).toBe(0)
  const value = { version: 1, kind: 'workflow-run-result', invocationId: source.sourceId, stdout: '', stderr: '', steps: [{ step: 0, attempt: 1, outcome: 'failed', exitCode: 2, timedOut: false, stdout: '', stderr: '' }, { step: 0, attempt: 2, outcome: 'succeeded', exitCode: 0, timedOut: false, stdout: '', stderr: '' }] }
  expect(validWorkflowRunResult(value)).toBe(true)
  expect(validWorkflowRunResult({ ...value, steps: [...value.steps].reverse() })).toBe(false)
  expect(validWorkflowRunResult({ ...value, extra: true })).toBe(false)
  expect(validWorkflowRunResult({ ...value, steps: Object.assign([...value.steps], { extra: true }) })).toBe(false)
})
it('keeps foreground pending until one handoff and fences candidates after Stop', () => {
  const events = history('foreground', false)
  expect(read(events).workflowPending()).toEqual([])
  events.push({ ...handoff, seq: events.length })
  expect(read(events).workflowPending()).toHaveLength(1)
  expect(() => read([...events, { ...handoff, seq: events.length }])).toThrow()
  events.push({ type: 'agent/delivery-generation', version: 1, op: 'close', recipientSessionId: 'parent', fenceId: 'stop', reason: 'user-stop', seq: events.length })
  expect(read(events).workflowPending()).toEqual([])
  expect(managedResultRefs({ ...terminal, seq: 5 })).toEqual([ref])
  const background = history('background', false)
  expect(() => read([...background, { ...handoff, seq: background.length }])).toThrow()
})
it('excludes canceled unknown unstarted unavailable and incomplete observations from wake candidates', () => {
  const invalidEnds = [
    { ...terminal, execution: { dispatch: 'dispatched', outcome: 'canceled' } }, { ...terminal, execution: { dispatch: 'dispatched', outcome: 'unknown' } },
    { type: 'workflow/end', version: 1, sourceSeq: 4, invocationId: source.sourceId, execution: { dispatch: 'not-dispatched', outcome: 'unknown' }, reason: 'launch-refused' },
    { type: 'workflow/end', version: 1, sourceSeq: 4, invocationId: source.sourceId, execution: { dispatch: 'unknown', outcome: 'unknown' }, reason: 'launch-unknown' },
    { ...terminal, result: { kind: 'unavailable', reason: 'capture-canceled' } },
    ...['producer-incomplete','capture-canceled'].map(completeness => ({ ...terminal, result: { kind: 'artifact', ref: { ...ref, completeness } } })),
  ]
  for (const end of invalidEnds) {
    expect(validDeliveryEvent(end)).toBe(true)
    const events = history('background', false); events[5] = { ...end, seq: 5 }
    expect(read(events).workflowPending()).toEqual([])
    const withReceipt = history('background'); withReceipt[5] = { ...end, seq: 5 }
    expect(() => read(withReceipt)).toThrow()
  }
  const failed = history('background', false); failed[5].execution = { dispatch: 'dispatched', outcome: 'failed' }
  expect(read(failed).workflowPending()).toHaveLength(1)
})
it('rejects duplicate terminal and receipt and preserves existing receipts after Stop', () => {
  const prefix = history('background', false)
  expect(() => read([...prefix, { ...terminal, seq: prefix.length }])).toThrow()
  const events = history('background')
  expect(() => read([...events, { ...events[6], seq: events.length }, { ...events[7], seq: events.length + 1 }])).toThrow()
  events.push({ type: 'agent/delivery-generation', version: 1, op: 'close', recipientSessionId: 'parent', fenceId: 'stop', reason: 'user-stop', seq: events.length })
  expect(read(events).receipt(key)).toMatchObject({ disposition: 'suppressed' })
  expect(read(events).pending()).toEqual([])
})
it('refuses Workflow authority in legacy journal bodies and keeps original capture enrollment disconnected', () => {
  for (const event of [source, { ...handoff, seq: 4 }, { ...terminal, seq: 4 }, history('background').at(-1)!]) {
    const legacy = Buffer.from(JSON.stringify(event) + '\n')
    const metadata = { version: 1 as const, legacyBodyBytes: legacy.length, legacyEventCount: 1, legacyPrefixDigest: legacyPrefixDigest(1, legacy), separatorBytes: 0 as const }
    expect(() => readFactJournal(legacy, metadata, 14)).toThrow()
  }
  expect(captureFactGroup({ kind: 'workflow-delivery-source', event: source } as never)).toMatchObject({ kind: 'not-issued' })
  expect(captureFactGroup({ kind: 'delivery', event: terminal } as never)).toMatchObject({ kind: 'not-issued' })
  // Existing generic handoff schema capture is not a Workflow source/terminal
  // issuer. Reserved settlement-port validation remains independently closed.
  expect(captureFactGroup({ kind: 'delivery', event: handoff } as never)).toMatchObject({ kind: 'captured' })
})
it('stages Workflow candidates transactionally in the original delivery index and consumes the exact key once', () => {
  const events = history(), index = createDeliveryIndex({ sessionId: 'parent' })
  for (const event of events.slice(0, 5)) { const stage = index.stage(); stage.advance(event); stage.commit() }
  const abandoned = index.stage(); abandoned.advance(events[5])
  expect(index.read().workflowPending()).toEqual([])
  const end = index.stage(); end.advance(events[5]); end.commit()
  expect(index.read().workflowPending()).toEqual([])
  const routed = index.stage(); routed.advance(events[6]); routed.commit()
  expect(index.read().workflowPending()).toHaveLength(1)
  const copy = index.read().workflowPending()[0]!
  ;(copy.source as { sourceId: string }).sourceId = 'changed-copy'
  expect(index.read().workflowPending()[0]!.source.sourceId).toBe(source.sourceId)
  const admitted = index.stage(); admitted.advance(events[7]); admitted.advance(events[8]); admitted.commit()
  expect(index.read().workflowPending()).toEqual([])
  expect(index.read().receipt(key)).toMatchObject({ disposition: 'pending' })
})
