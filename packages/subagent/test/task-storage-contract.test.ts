import { expect, it } from 'vitest'
import { taskDocumentStorageContract } from '../src/task/storage-contract.ts'

it('validates literal v1 and v2 task documents without migration or mutation', () => {
  for (const formatVersion of [1, 2]) {
    const value = Object.freeze({ formatVersion, tasks: Object.freeze([]), notifications: Object.freeze([]) })
    expect(() => taskDocumentStorageContract.validate(value)).not.toThrow()
    expect(value.formatVersion).toBe(formatVersion)
  }
  for (const value of [null, {}, { formatVersion: 3, tasks: {}, notifications: [] }, { formatVersion: 2, tasks: {}, notifications: [] }])
    expect(() => taskDocumentStorageContract.validate(value)).toThrow()
})

it('checks local committed task identities without treating inherited seed or projection as ownership', () => {
  const start = (taskId: string, parentSessionId?: string) => ({ type: 'subagent/start' as const, version: 1 as const, taskId, agentPath: 'a', role: 'worker', description: 'd', ...(parentSessionId === undefined ? {} : { parentSessionId }) })
  const history = [start('inherited'), start('local'), { type: 'subagent/end' as const, version: 1 as const, taskId: 'ended', outcome: 'cancelled' as const }]
  expect(taskDocumentStorageContract.key('parent')).toBe('task-parent')
  expect(taskDocumentStorageContract.empty()).toEqual({ formatVersion: 2, tasks: [], notifications: [] })
  expect(taskDocumentStorageContract.consistency('parent', history, 1, undefined)).toEqual({ kind: 'recovery-required', knownIds: ['local', 'ended'] })
  expect(taskDocumentStorageContract.consistency('parent', [start('inherited')], 1, undefined)).toEqual({ kind: 'consistent', knownIds: [] })
  expect(() => taskDocumentStorageContract.consistency('parent', [start('foreign', 'other')], 0, undefined)).toThrow()
  expect(() => taskDocumentStorageContract.consistency('parent', [start('')], 0, undefined)).toThrow()
  expect(() => taskDocumentStorageContract.consistency('parent', [{ ...start('local'), seq: -1 }], 0, undefined)).toThrow()
})

it('requires exactly one own row for each known ID and permits extra legacy rows', () => {
  const event = { type: 'subagent/start' as const, version: 1 as const, taskId: 't', agentPath: 'a', role: 'worker', description: 'd' }
  const row = { id: 't', parentSessionId: '', agentPath: 'a', description: 'd', prompt: 'p', agent: 'a', delivery: 'tool' as const, status: 'accepted' as const, timeCreated: 1 }
  const doc = { formatVersion: 1 as const, tasks: [row], notifications: [] }
  expect(taskDocumentStorageContract.consistency('p', [event], 0, doc).kind).toBe('consistent')
  expect(taskDocumentStorageContract.consistency('p', [event], 0, { ...doc, tasks: [] }).kind).toBe('recovery-required')
  expect(taskDocumentStorageContract.consistency('p', [event], 0, { ...doc, tasks: [row, row] }).kind).toBe('recovery-required')
  expect(taskDocumentStorageContract.consistency('p', [event], 0, { ...doc, tasks: [{ ...row, parentSessionId: 'foreign' }] }).kind).toBe('recovery-required')
})

it('folds actual core-validated delivery facts without using a projection', async () => {
  const { createSession, createNondurableFactOwner, committedFactSeqs, deliveryInputId, validateConversationHistory, validateDeliveryFrame } = await import('@i-harness/core-session')
  const session = createSession(), owner = createNondurableFactOwner(session), action = owner.beginAction()
  const received = owner.registerReceivedInputSource(async () => {})
  const human = { type: 'agent/input/admitted', version: 1, inputId: 'human', text: 'launch', delivery: 'queue', intent: 'user', provenance: { kind: 'human', authority: 'request', scope: 'turn', producer: 'session.prompt' } } as const
  committedFactSeqs(await received.captureAdmitted(human).admit())
  committedFactSeqs(await action.facts.inputs.start({ type: 'agent/input/promoted', version: 1, inputId: human.inputId }, { type: 'user/message', text: human.text, input: { inputId: human.inputId, intent: 'user' }, provenance: human.provenance }))
  committedFactSeqs(await received.captureDeliveryOpen({ type: 'agent/delivery-generation', version: 1, op: 'open', recipientSessionId: 'parent', generationId: 'g', originInputSeq: 0 }, () => true).admit())
  const [callSeq] = committedFactSeqs(await action.facts.tools.call({ type: 'tool/call', callId: 'spawn', name: 'spawn_agent', args: {} }))
  committedFactSeqs(await action.facts.tools.dispatch('spawn', { kind: 'prior', seq: callSeq!, expectedType: 'tool/call' }))
  const [, sourceSeq] = committedFactSeqs(await action.captureSubagentStart({ type: 'subagent/start', version: 1, taskId: 'task-1', parentSessionId: 'parent', agentPath: 'a', role: 'worker', description: 'd' }, { recipientSessionId: 'parent', generationId: 'g', sourceNamespace: 'registry', sourceId: 'task-1', callSeq: callSeq! }).admit())
  committedFactSeqs(await action.facts.tools.result({ type: 'tool/result', callId: 'spawn', name: 'spawn_agent', output: { task_id: 'task-1' } }))
  committedFactSeqs(await action.facts.agent.lifecycle({ type: 'turn/end' }))
  const terminal = action.registerSettlementSource(async () => {})
  const [terminalSeq] = committedFactSeqs(await terminal.delivery.capture({ type: 'subagent/end', version: 1, taskId: 'task-1', outcome: 'completed', resultRevision: 'revision', envelope: { version: 1, execution: { outcome: 'succeeded', dispatch: 'dispatched' }, preview: '', media: [], retention: { kind: 'inline', value: 'result', encodedBytes: 8 } } }).admit())
  const key = { recipientSessionId: 'parent', sourceNamespace: 'registry', sourceId: 'task-1', resultRevision: 'revision', kind: 'subagent' } as const, inputId = deliveryInputId(key)
  const admitted = { type: 'agent/input/admitted', version: 1, inputId, text: 'result', delivery: 'steer', intent: 'system', provenance: { kind: 'child-report', authority: 'observation', scope: 'turn', producer: 'session.delivery.subagent' }, synthetic: { description: 'd', scope: 'turn', display: { kind: 'task', title: 'd', body: 'result' } } } as const
  committedFactSeqs(await received.captureDeliveryAdmission({ type: 'agent/delivery-received', version: 1, key, sourceSeq: sourceSeq!, terminalSeq: terminalSeq!, inputId }, admitted, () => true).admit())
  committedFactSeqs(await action.facts.compaction.commit([{ type: 'rewind/point', version: 1, targetTurn: 0, anchorSeq: 0, mode: 'conversation', fileOps: [] }]))
  validateConversationHistory(session.events, 13, { sessionId: 'parent' })
  const sourceIndex = session.events.findIndex(event => event.type === 'agent/delivery-source')
  const receiptIndex = session.events.findIndex(event => event.type === 'agent/delivery-received')
  validateDeliveryFrame(session.events.slice(sourceIndex - 1, sourceIndex + 1), 13)
  validateDeliveryFrame(session.events.slice(receiptIndex, receiptIndex + 2), 13)
  expect(taskDocumentStorageContract.consistency('parent', session.events, 0, undefined)).toEqual({ kind: 'recovery-required', knownIds: ['task-1'] })
  action.finish(); await terminal.close(); await received.close()
})
