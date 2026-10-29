import { expect, it } from 'vitest'
import { committedFactSeqs, createNondurableFactOwner, createSession, deliveryInputId } from '@i-harness/core-session'
import { backgroundEventForTool, waitForObservation } from '../src/observation.ts'
async function originalHistory(beforeAdmission?: (session: ReturnType<typeof createSession>) => void) {
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
  beforeAdmission?.(session)
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


it('observes the original receipt without claiming it and stops observing after promotion', async () => {
  const f = await originalHistory()
  try {
    const backgroundEvent = backgroundEventForTool({ session: f.session })!
    const changes = { subscribe: (_wake: () => void) => () => {} }
    expect(await waitForObservation({ ready: () => false, changes, backgroundEvent })).toBe('background-event')
    expect(backgroundEvent.pending()).toBe(true)
    await f.claim()
    expect(backgroundEvent.pending()).toBe(false)
  } finally { await f.close() }
})

it('wakes an already subscribed observer on original admission', async () => {
  let waiting: Promise<string> | undefined
  const f = await originalHistory(session => {
    waiting = waitForObservation({ ready: () => false, changes: { subscribe: () => () => {} }, backgroundEvent: backgroundEventForTool({ session }) })
  })
  try { expect(await waiting).toBe('background-event') } finally { await f.close() }
})
