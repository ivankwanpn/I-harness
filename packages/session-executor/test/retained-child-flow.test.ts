import { expect, it, vi } from 'vitest'
import { mkdtemp, rm, readFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { contextWorkspaceLocation } from '@i-harness/context-output'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createSessionCoordinator } from '@i-harness/session-persistence'
import { createJsonlBackend } from '@i-harness/session-persistence-jsonl'
import { createSessionAssembly } from '../src/assembly.ts'
import { controlledModel } from './controlled-model.ts'

it('the actual managed child retains one1MiB terminal body while task/outbox/job/table documents contain only previews and refs', async () => {
  const root = await mkdtemp(join(tmpdir(), 'r4a-child-flow-'))
  const coordinator = createSessionCoordinator(createJsonlBackend(root), { lock: { enabled: true } })
  const { id } = await coordinator.create()
  let sends = 0
  const full = 'x'.repeat(1_048_576)
  const assembly = await createSessionAssembly({ workspace: root, coordinator, sessionId: id, approveAll: true, model: controlledModel(async function* () {
    const send = ++sends
    if (send === 1) yield { type: 'tool_call', call: { id: 'child-once', name: 'spawn_agent', args: { task_name: 'one', message: 'return controlled output', background: false } } }
    else if (send === 4) yield { type: 'tool_call', call: { id: 'child-followup-once', name: 'followup_task', args: { target: 'root/one', message: 'return the same text in a new real revision' } } }
    else yield { type: 'text/chunk', text: send === 2 || send >= 5 ? full : 'parent complete' }
    yield { type: 'end' }
  }) })
  try {
    await assembly.agent.run('start the one controlled child')
    await coordinator.flush(id)
    await vi.waitFor(async () => {
      const current = await coordinator.getDocument(`task-${id}`) as any
      expect(current.tasks[0]?.result?.kind, JSON.stringify({ sends, status: current.tasks[0]?.status, error: current.tasks[0]?.error })).toBe('retained')
    })
    const taskDoc = await coordinator.getDocument(`task-${id}`) as any
    expect(taskDoc.formatVersion).toBe(2)
    expect((await coordinator.profile(taskDoc.tasks[0].childSessionId)).meta).toHaveProperty('subagentProtocolVersion', 1)
    expect(taskDoc.tasks[0].result.kind).toBe('retained')
    expect(taskDoc.tasks[0].result.envelope.retention.kind).toBe('artifact')
    expect(taskDoc.tasks[0].result.envelope.retention.ref.encodedBytes).toBe(1_048_593)
    const state = assembly.subagentState!() as any
    expect(state.formatVersion).toBe(2)
    expect(Buffer.byteLength(JSON.stringify(state))).toBeLessThan(16384)
    expect(state.agentTable[0].result.revision).toBe(taskDoc.tasks[0].result.revision)
    expect(state.jobs[0].result.revision).toBe(taskDoc.tasks[0].result.revision)
    expect(Buffer.byteLength(JSON.stringify(taskDoc))).toBeLessThan(16384)
    expect(sends).toBe(3)
    await assembly.agent.run('follow up once')
    await vi.waitFor(() => {
      const next = assembly.subagentState!() as any
      expect(next.agentTable[0].result.revision).not.toBe(taskDoc.tasks[0].result.revision)
      expect(next.jobs[0].result.kind).toBe('retained')
      expect(next.jobs[0].result.revision).toBe(next.agentTable[0].result.revision)
    })
    const next = assembly.subagentState!() as any
    expect(next.agentTable[0].result.envelope.retention.ref.contentDigest).toBe(taskDoc.tasks[0].result.envelope.retention.ref.contentDigest)
    expect(next.agentTable[0].result.envelope.retention.ref.id).not.toBe(taskDoc.tasks[0].result.envelope.retention.ref.id)
    expect(Buffer.byteLength(JSON.stringify(next))).toBeLessThan(16384)
  } finally { await assembly.dispose(); await coordinator.close(); await rm(root, { recursive: true, force: true }) }
})

it('binds a real managed child synthetic failure to that child document and cold read owner', async () => {
  const root = await mkdtemp(join(tmpdir(), 'r4a-child-synthetic-'))
  const coordinator = createSessionCoordinator(createJsonlBackend(root), { lock: { enabled: true } })
  const { id } = await coordinator.create()
  let sends = 0, projections = 0
  const full = 'z'.repeat(1_048_576)
  const model = controlledModel(async function* () {
    const send = ++sends
    if (send === 1) yield { type: 'tool_call', call: { id: 'synthetic-child', name: 'spawn_agent', args: { task_name: 'synthetic', message: 'call missing tool', background: false } } }
    else if (send === 2) yield { type: 'tool_call', call: { id: 'original-missing', name: 'missing-child-tool', args: {} } }
    else yield { type: 'text/chunk', text: 'done' }
    yield { type: 'end' }
  })
  const assembly = await createSessionAssembly({ workspace: root, coordinator, sessionId: id, approveAll: true, model })
  let cold: typeof assembly | undefined
  assembly.ctx.onCascade('tools/project-synthetic-result', async (dispatch, next) => {
    if ((dispatch as { name?: unknown }).name !== 'missing-child-tool') return next()
    projections++
    return { error: full, code: 'TOOL_FAILED' }
  })
  try {
    await assembly.agent.run('launch')
    const childId = assembly.subagentState!().agentTable[0]!.sessionId!
    const child = (await coordinator.snapshot!(childId)).session
    const event = child.events.find(event => event.type === 'tool/result' && event.callId === 'original-missing')
    if (event?.type !== 'tool/result' || event.envelope?.retention.kind !== 'artifact') throw new Error('Expected retained real synthetic child fact')
    const ref = event.envelope.retention.ref
    const location = await contextWorkspaceLocation(root, root)
    const operation = JSON.parse(await readFile(join(location.serviceRoot, 'context-output', createHash('sha256').update(location.workspaceKey).digest('hex'), 'managed-v1', ref.id, 'operation.json'), 'utf8'))
    expect(operation.owner.sessionId).toBe(childId)
    expect(operation.owner.sessionId).not.toBe(id)
    expect(operation.owner.callId).toBe('original-missing')
    await assembly.dispose()
    cold = await createSessionAssembly({ workspace: root, coordinator, sessionId: childId, approveAll: true, model })
    expect(await cold.tools.get('context_output_read')!.execute({ ref }, { sessionId: childId })).toHaveProperty('data.kind', 'text')
    expect(projections).toBe(1)
    expect(sends).toBe(4)
  } finally { await cold?.dispose(); await assembly.dispose(); await coordinator.close(); await rm(root, { recursive: true, force: true }) }
})
