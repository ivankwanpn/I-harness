import { expect, it } from 'vitest'
import { captureFactGroup, committedFactSeqs, createNondurableFactOwner, createSession, deliveryInputId, exportConversationSeed, readDeliveries, resolveFactGroup } from '../src/index.ts'
import { bootstrapMemorySession } from '../src/managed/bootstrap.ts'
import { literalSession } from './fixtures/semantic-observation.ts'

async function originalHistory() {
  const session = createSession(), owner = createNondurableFactOwner(session), action = owner.beginAction()
  const received = owner.registerReceivedInputSource(async () => {})
  const human = { type: 'agent/input/admitted', version: 1, inputId: 'human', text: 'launch original child', delivery: 'queue', intent: 'user', provenance: { kind: 'human', authority: 'request', scope: 'turn', producer: 'session.prompt' } } as const
  committedFactSeqs(await received.captureAdmitted(human).admit())
  committedFactSeqs(await action.facts.inputs.start({ type: 'agent/input/promoted', version: 1, inputId: human.inputId }, { type: 'user/message', text: human.text, input: { inputId: human.inputId, intent: 'user' }, provenance: human.provenance }))
  committedFactSeqs(await received.captureDeliveryOpen({ type: 'agent/delivery-generation', version: 1, op: 'open', recipientSessionId: 'parent', generationId: 'original-generation', originInputSeq: 0 }, () => true).admit())
  const [callSeq] = committedFactSeqs(await action.facts.tools.call({ type: 'tool/call', callId: 'spawn', name: 'spawn_agent', args: {} }))
  committedFactSeqs(await action.facts.tools.dispatch('spawn', { kind: 'prior', seq: callSeq!, expectedType: 'tool/call' }))
  const [, sourceSeq] = committedFactSeqs(await action.captureSubagentStart({ type: 'subagent/start', version: 1, taskId: 'task-1', parentSessionId: 'parent', agentPath: 'root/original', role: 'probe', description: 'original' }, { recipientSessionId: 'parent', generationId: 'original-generation', sourceNamespace: 'registry', sourceId: 'task-1', callSeq: callSeq! }).admit())
  committedFactSeqs(await action.facts.tools.result({ type: 'tool/result', callId: 'spawn', name: 'spawn_agent', output: { task_id: 'task-1' } }))
  committedFactSeqs(await action.facts.agent.lifecycle({ type: 'turn/end' }))
  const terminal = action.registerSettlementSource(async () => {})
  const [terminalSeq] = committedFactSeqs(await terminal.delivery.capture({ type: 'subagent/end', version: 1, taskId: 'task-1', outcome: 'completed', resultRevision: 'original-revision', envelope: { version: 1, execution: { outcome: 'succeeded', dispatch: 'dispatched' }, preview: '', media: [], retention: { kind: 'inline', value: 'original result', encodedBytes: 17 } } }).admit())
  const key = { recipientSessionId: 'parent', sourceNamespace: 'registry', sourceId: 'task-1', resultRevision: 'original-revision', kind: 'subagent' } as const, inputId = deliveryInputId(key)
  const admitted = { type: 'agent/input/admitted', version: 1, inputId, text: 'original result', delivery: 'steer', intent: 'system', provenance: { kind: 'child-report', authority: 'observation', scope: 'turn', producer: 'session.delivery.subagent' }, synthetic: { description: 'original', scope: 'turn', display: { kind: 'task', title: 'original', body: 'original result' } } } as const
  committedFactSeqs(await received.captureDeliveryAdmission({ type: 'agent/delivery-received', version: 1, key, sourceSeq: sourceSeq!, terminalSeq: terminalSeq!, inputId }, admitted, () => true).admit())
  return { session, action, received, key, inputId, sourceSeq: sourceSeq!, terminalSeq: terminalSeq!,
    async claim() {
      committedFactSeqs(await action.facts.inputs.start({ type: 'agent/input/promoted', version: 1, inputId }, { type: 'user/message', text: admitted.text, input: { inputId, intent: 'system', synthetic: admitted.synthetic }, provenance: admitted.provenance }))
      committedFactSeqs(await action.facts.agent.auditAssistant({ type: 'assistant/message', text: 'observed original result' }))
      committedFactSeqs(await action.facts.agent.lifecycle({ type: 'turn/end' }))
    },
    async close() { action.finish(); await terminal.close(); await received.close() },
  }
}

it.each(['pending', 'claimed'] as const)('semantic export and target bootstrap import context without original %s delivery authority', async disposition => {
  const f = await originalHistory()
  try {
    if (disposition === 'claimed') await f.claim()
    const generation = readDeliveries(f.session).activeGeneration(), originalEvents = JSON.stringify(f.session.events)
    const exported = exportConversationSeed(f.session, { kind: 'session', sessionId: 'parent' }, { kind: 'all' })
    expect(exported.kind).toBe('seed')
    if (exported.kind !== 'seed') throw new Error('Actual semantic export refused original history')
    // This is a current seed bootstrap using the independent existing codec
    // fixture. It is not predecessor/old-format qualification.
    const compiled = literalSession(exported.seed), target = createSession()
    bootstrapMemorySession(target, compiled.header!, compiled.events, () => true)
    expect(target.formatVersion).toBe(13)
    expect(target.events.some(e => e.type.startsWith('agent/delivery-'))).toBe(false)
    expect(readDeliveries(target).activeGeneration()).toBeUndefined()
    expect(readDeliveries(target).pending()).toEqual([])
    expect(readDeliveries(target).source('registry', 'task-1')).toBeUndefined()
    expect(JSON.stringify(target.events)).toContain('launch original child')
    expect(JSON.stringify(f.session.events)).toBe(originalEvents)
    expect(readDeliveries(f.session).activeGeneration()).toEqual(generation)
    expect(readDeliveries(f.session).receipt(f.key)?.disposition).toBe(disposition)
    expect(readDeliveries(f.session).isEligible(f.inputId)).toBe(disposition === 'pending')
  } finally { await f.close() }
})

it.each(['pending', 'claimed'] as const)('actual compaction preserves original %s disposition and rewind never resurrects consumption', async disposition => {
  const f = await originalHistory()
  try {
    if (disposition === 'claimed') await f.claim()
    const receipt = f.session.events.find(e => e.type === 'agent/delivery-received')!
    const admission = f.session.events.find(e => e.type === 'agent/input/admitted' && e.inputId === f.inputId)!
    committedFactSeqs(await f.action.facts.compaction.commit([{ type: 'compaction/reset', removedSeqs: [f.sourceSeq, f.terminalSeq, receipt.seq!, admission.seq!] }]))
    expect(readDeliveries(f.session).receipt(f.key)?.disposition).toBe(disposition)
    expect(readDeliveries(f.session).isEligible(f.inputId)).toBe(disposition === 'pending')
    committedFactSeqs(await f.action.facts.compaction.commit([{ type: 'rewind/point', version: 1, targetTurn: 0, anchorSeq: 0, mode: 'conversation', fileOps: [] }]))
    expect(readDeliveries(f.session).receipt(f.key)?.disposition).toBe(disposition === 'pending' ? 'suppressed' : 'claimed')
    expect(readDeliveries(f.session).isEligible(f.inputId)).toBe(false)
    expect(readDeliveries(f.session).pending()).toEqual([])
  } finally { await f.close() }
})

it.each(['binding', 'receipt'] as const)('refuses an actual original %s pair through inherited seed import', async kind => {
  const f = await originalHistory()
  try {
    const records = f.session.events.filter(e => kind === 'binding' ? e.type === 'subagent/start' || e.type === 'agent/delivery-source' : e.type === 'agent/delivery-received' || e.type === 'agent/input/admitted' && e.inputId === f.inputId)
    expect(records).toHaveLength(2)
    const capture = captureFactGroup({ kind: 'seed-import', events: records })
    expect(capture.kind).toBe('captured')
    if (capture.kind !== 'captured') throw new Error('Seed capture setup refused')
    expect(() => resolveFactGroup(capture.group, createSession(), 0)).toThrow(/authority/)
  } finally { await f.close() }
})
