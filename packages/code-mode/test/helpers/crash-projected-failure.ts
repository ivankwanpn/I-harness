import { join } from 'node:path'
import { onExecutionEvent } from '@i-harness/core-plugin'
import { createJsonlBackend } from '../../../session-persistence-jsonl/src/index.ts'
import { composeJsonlTaskTransitionCoordinator } from '../../../session-persistence-jsonl/src/task-document-factory.ts'
import { taskDocumentStorageContract } from '../../../subagent/src/task/storage-contract.ts'
import { createLoopbackProvider } from '../../../core-agent/test/helpers/provider-loopback.ts'
import { createOpenAICompatibleClient } from '../../../llm-openai-compatible/src/index.ts'
import { acquireAssemblyResultStore } from '../../../session-executor/src/lifecycle/result-store.ts'
import { createSessionService } from '../../../session-executor/src/service.ts'

const root = process.argv[2]
if (!root) throw Error('Expected original session directory')
let revoke: (() => void) | undefined, revoked = false, bodies = 0, newHooks = 0, writes = 0
const backend = createJsonlBackend(join(root, 'sessions'), { wrapOwnedBatch(append) {
  return async (...input) => {
    const bytes = Buffer.from(input[3].bytes).toString('utf8')
    if (!revoked && bytes.includes('"type":"agent/delivery-source"') && bytes.includes('"kind":"code"')) {
      if (!revoke) throw Error('Original hook scope unavailable')
      revoked = true; revoke()
    }
    const result = await append(...input)
    if (result.kind === 'committed' && bytes.includes('"type":"tool/result"') && bytes.includes('TOOL_RESULT_PROJECTION_UNAVAILABLE')) {
      writes++
      // The native frame is synced; its original caller never receives this ACK.
      await new Promise<never>(() => { process.stdout.write(JSON.stringify({ durable: true, bodies, newHooks, writes }) + '\n', () => process.exit(0)) })
    }
    return result
  }
} })
const coordinator = composeJsonlTaskTransitionCoordinator(backend, { lock: { enabled: true } }, taskDocumentStorageContract)
await coordinator.create({ sessionId: 'crash' })
const server = await createLoopbackProvider('/v1/chat/completions', [async response => {
  response.end(`data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'original-call', function: { name: 'code_exec', arguments: JSON.stringify({ code: 'await tools.probe({});text("RAW_WORKER_VALUE")', yield_time_ms: 60000 }) } }] }, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 20, completion_tokens: 2 } })}\n\ndata: [DONE]\n\n`)
}])
const service = createSessionService({ workspace: root, coordinator,
  managedRuntime: { systemPrompt: 'controlled', tools: [{ name: 'probe', description: 'original body', inputSchema: { type: 'object' }, async execute() { bodies++; return 'RAW_WORKER_VALUE' } }],
    mountRegistry({ ctx }) { revoke = () => onExecutionEvent(ctx, 'tools/pre-execute', () => { newHooks++ }) },
    ownedCode: { config: { mode: 'mixed' }, async acquireOutput(sessionId, retain) {
      let lease: Awaited<ReturnType<typeof acquireAssemblyResultStore>> | undefined
      retain(async () => { await lease?.release() })
      lease = await acquireAssemblyResultStore({ workspace: root, coordinator, sessionId, projectContext: () => ({ id: 'p', roots: [root] }) })
      if (!lease.service || !lease.sourceFor) throw Error('Original output owner unavailable')
      return { service: lease.service, sourceFor: lease.sourceFor }
    } }
  }, model: createOpenAICompatibleClient({ apiKey: 'loopback', model: 'fixture', baseUrl: server.baseUrl }), contextWindow: 16000, maxOutputTokens: 128
})
const deadline = setTimeout(() => { process.stderr.write('Original projection did not reach durable frame\n'); process.exit(2) }, 30000)
try { await service.submit('crash', 'run original code', new AbortController().signal); throw Error('Original durable boundary was not reached') }
finally { clearTimeout(deadline); await service.close(); await coordinator.close(); await server.close() }
