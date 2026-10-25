import assert from 'node:assert/strict'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { decodeFactBatch } from '@i-harness/core-session'
import { createSessionCoordinator } from '@i-harness/session-persistence'
import { createJsonlBackend } from '@i-harness/session-persistence-jsonl'
import { createContextOutputService } from '@i-harness/context-output'
import { createOpenAICompatibleClient } from '../../../llm-openai-compatible/src/index.ts'
import { createSessionService, createDurableSessionLoader } from '../../src/index.ts'

// Task2's single cut: original result/task/end committed, first recipient
// receipt not issued. Task3 owns the wider physical/process-cut matrix.
const [root, endpoint, nonce] = process.argv.slice(2)
assert(root && endpoint && nonce && process.env.IH_CONFIG_DIR)
const backend = createJsonlBackend(join(root, 'sessions'))
const coordinator = createSessionCoordinator(backend, { lock: { enabled: true } })
await coordinator.create({ sessionId: 'parent' })
const document = await coordinator.openManagedDocument('parent')
const output = createContextOutputService({ root: join(root, 'results'), workspaceId: 'd1a-crash', config: { enabled: false } })
const parent = createOpenAICompatibleClient({ apiKey: 'fixture-only', model: 'parent', baseUrl: endpoint })
const child = createOpenAICompatibleClient({ apiKey: 'fixture-only', model: 'child', baseUrl: endpoint })
const append = backend.appendOwnedBatch!
backend.appendOwnedBatch = async (...args) => {
  const events = decodeFactBatch(args[3].bytes).events
  if (args[0] === 'parent' && events.some(e => e.type === 'agent/delivery-received')) {
    const terminal = document.view.events.findLast(e => e.type === 'subagent/end')
    const binding = document.view.events.find(e => e.type === 'agent/delivery-source')
    const taskDocument = await coordinator.getDocument('task-parent') as import('@i-harness/subagent').TaskProtocolDocument
    assert(terminal?.type === 'subagent/end' && terminal.outcome === 'completed' && terminal.envelope?.retention.kind === 'artifact')
    assert(binding?.type === 'agent/delivery-source')
    const task = taskDocument.tasks.find(t => t.id === terminal.taskId)
    assert(task?.result?.kind === 'retained' && task.result.revision === terminal.resultRevision && task.outcome === 'completed')
    assert(!document.view.events.some(e => e.type === 'agent/delivery-received'))
    const cut = { nonce, kind: 'before-first-receipt', root, binding, terminal, taskDocument, unissuedReceiptKey: args[3].key, cleanup: 'process cut: original live owners deliberately not disposed' }
    await writeFile(join(root, 'cut.json'), JSON.stringify(cut, null, 2))
    await new Promise<void>((resolve, reject) => process.send!(cut, error => error ? reject(error) : resolve()))
    process.exit(0)
  }
  return append(...args)
}
const service = createSessionService({ workspace: root, coordinator, sessionFor: createDurableSessionLoader(coordinator), contextOutput: output,
  model: parent, modelPolicy: 'test-mock', approveAll: true, sandbox: 'danger-full-access', codeMode: { mode: 'off' }, contextWindow: 100000,
  pluginAgents: [{ name: 'probe', description: 'delivery crash fixture', systemPrompt: 'Return original child result', tools: [] }],
  allowSubagentModelSelection: true, roleSelectionFor: () => ({ provider: 'fixture', model: 'child' }),
  resolveRoleModel: async () => ({ status: 'ready', binding: { client: child, contextWindow: 100000 } }),
})
await service.submit('parent', 'run original ordinary child', new AbortController().signal)
// IPC keeps the original real source alive until the backend cut is reached.
process.on('message', () => {})
