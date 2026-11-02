import { mkdtemp } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { createJsonlTaskTransitionCoordinator } from '../../session-persistence-jsonl/src/task-document-factory.ts'
import { taskDocumentStorageContract } from '../../subagent/src/task/storage-contract.ts'
import { createSessionService, createDurableSessionLoader, createUnmanagedTaskChildHost } from '../src/index.ts'
import { controlledModel } from './controlled-model.ts'

it('ordinary delegated child executes Code and returns its result without enrolling a Code recipient', async () => {
  const root = await mkdtemp(join(process.env.IH_NATIVE_DEPENDENCY_EVIDENCE_ROOT!, 'code-child-'))
  const coordinator = createJsonlTaskTransitionCoordinator(join(root, 'sessions'), { lock: { enabled: true } }, taskDocumentStorageContract)
  await coordinator.create({ sessionId: 'parent' })
  let parentCalls = 0, childCalls = 0
  const parent = controlledModel(async function* () {
    if (++parentCalls === 1) yield { type: 'tool_call', call: { id: 'spawn-original', name: 'spawn_agent', args: { task_name: 'code-child', agent_type: 'probe', message: 'run code', fork_turns: 'none', background: false } } }
    else yield { type: 'text/chunk', text: 'parent complete' }
    yield { type: 'end' }
  })
  const child = controlledModel(async function* () {
    if (++childCalls === 1) yield { type: 'tool_call', call: { id: 'child-code', name: 'code_exec', args: { code: 'text("original child output")', yield_time_ms: 60000 } } }
    else yield { type: 'text/chunk', text: 'child complete' }
    yield { type: 'end' }
  })
  const service = createSessionService({ workspace: root, coordinator, sessionFor: createDurableSessionLoader(coordinator), prepareTaskChild: createUnmanagedTaskChildHost({ coordinator, policy: 'unmanaged' }), model: parent, modelPolicy: 'test-mock', approveAll: true, sandbox: 'danger-full-access', codeMode: { mode: 'mixed' }, contextWindow: 100000,
    pluginAgents: [{ name: 'probe', description: 'run Code', systemPrompt: 'run Code', tools: ['code_exec', 'code_wait'] }],
    allowSubagentModelSelection: true, roleSelectionFor: () => ({ provider: 'fixture', model: 'child' }), resolveRoleModel: async () => ({ status: 'ready', binding: { client: child, contextWindow: 100000 } }) })
  try {
    await service.submit('parent', 'run the child', new AbortController().signal)
    const children = (await coordinator.list()).filter(id => id !== 'parent')
    expect(children).toHaveLength(1)
    const events = (await coordinator.snapshot!(children[0]!)).session.events
    expect(events.some(e => e.type === 'code/output' && e.envelope?.preview?.includes('original child output'))).toBe(true)
    expect(events.some(e => e.type === 'code/cell' && e.state === 'completed')).toBe(true)
    expect(events.filter(e => e.type === 'agent/delivery-source' && e.kind === 'code')).toHaveLength(0)
    expect(events.filter(e => e.type === 'agent/delivery-received' && e.key.kind === 'code')).toHaveLength(0)
    expect(childCalls).toBe(2)
  } finally { await service.close(); await coordinator.close() }
}, 30000)
