import { afterEach, expect, it, vi } from 'vitest'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { subscribe } from '@i-harness/core-session'
import { createSessionCoordinator } from '@i-harness/session-persistence'
import { createJsonlBackend } from '@i-harness/session-persistence-jsonl'
import { controlledModel } from '../../../packages/session-executor/test/controlled-model.ts'
import { runHeadless } from '../src/run.ts'

afterEach(() => vi.unstubAllGlobals())
it('default CLI parent admission preserves an unbound ordinary child without a synthetic delivery wake', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ih-event-cli-')), backend = createJsonlBackend(root)
  const coordinator = createSessionCoordinator(backend, { lock: { enabled: true } }), { id } = await coordinator.create()
  const document = await coordinator.openManagedDocument(id)
  await document.metadata.admit({ type: 'session/title', title: 'CLI route fixture', source: 'user', messageSeqs: [] })
  const ended = Promise.withResolvers<void>(), requests: string[] = []
  const off = subscribe(document.view, event => { if (event.type === 'subagent/end') ended.resolve() })
  const model = controlledModel(async function* (request) {
    const messages = JSON.stringify(request.messages); requests.push(messages)
    if (requests.length === 1) yield { type: 'tool_call', call: { id: 'cli-original', name: 'spawn_agent', args: { task_name: 'helper', message: 'CLI_CHILD_ONLY', fork_turns: 'none' } } }
    else {
      if (!request.messages.some(message => message.role === 'user' && JSON.stringify(message.content).includes('CLI_CHILD_ONLY'))) await ended.promise
      yield { type: 'text/chunk', text: 'original CLI result' }
    }
    yield { type: 'end' }
  })
  try {
    const result = await runHeadless('delegate CLI work', { workspace: root, coordinator, sessionId: id, model, modelPolicy: 'test-mock', approveAll: true, codeMode: { mode: 'off' } })
    expect(result.exitCode, result.error).toBe(0)
    const events = (await backend.read(id)).events
    expect(events.filter(e => e.type === 'subagent/end')).toHaveLength(1)
    expect(events.filter(e => e.type === 'agent/delivery-source' || e.type === 'agent/delivery-received')).toHaveLength(0)
    const cold=createSessionCoordinator(createJsonlBackend(root),{lock:{enabled:true}})
    try{
      const tasks = await cold.getDocument(`task-${id}`) as { tasks: { outcome: string }[]; notifications: { status: string }[] }
      expect(tasks.tasks).toEqual([expect.objectContaining({ outcome: 'completed' })])
      expect(tasks.notifications).toEqual([expect.objectContaining({ status: 'pending' })])
    }finally{await cold.close()}
    expect(requests).toHaveLength(3)
  } finally { off(); await coordinator.close() }
}, 15000)
