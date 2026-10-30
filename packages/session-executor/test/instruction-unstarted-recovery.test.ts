import { expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createContext } from '@i-harness/core-plugin'
import { createToolRegistry } from '@i-harness/core-tools'
import { decodeFactBatch, type BatchKey, type ProducerFactOutcome, type SettlementFacts } from '@i-harness/core-session'
import { createSessionCoordinator } from '../../session-persistence/src/index.ts'
import { createJsonlBackend } from '../../session-persistence-jsonl/src/index.ts'
import { createOpenAICompatibleClient } from '../../llm-openai-compatible/src/index.ts'
import { createGenerationLifecycle } from '../../session-executor/src/lifecycle/generation-actions.ts'
import { createProjectInstructionEnvironment } from '../../session-executor/src/context/instructions/host.ts'
import { createMainInstructionManager } from '../../session-executor/src/context/instructions/manager.ts'
import { createAgent } from '../../core-agent/src/index.ts'
import { createLoopbackProvider } from '../../core-agent/test/helpers/provider-loopback.ts'

it.each([false, true])('recovers the original untransferred source and its accepted batch pin (releaseFault=%s)', async releaseFault => {
  const root = await mkdtemp(join(tmpdir(), 'ih-untransferred-')), backend = createJsonlBackend(join(root, 'sessions'))
  const coordinator = createSessionCoordinator(backend, { lock: { enabled: true } }), { id } = await coordinator.create(), document = await coordinator.openManagedDocument(id)
  const environment = createProjectInstructionEnvironment(), sources = new Set<SettlementFacts<ProducerFactOutcome>>()
  let accepted = false, registrationFailed = false, allowRecovery = false, key: BatchKey | undefined, bodies = 0, releases = 0
  const manager = createMainInstructionManager({ session: document.view, environment, cwd: root, authority: () => ({ kind: 'unbound', revision: '1', workspaceRoot: root }), available: () => true, publish: async () => {} })
  const begin = document.beginAction.bind(document)
  document.beginAction = signal => {
    const action = begin(signal), register = action.registerSettlementSource.bind(action)
    action.registerSettlementSource = (...args) => {
      if (accepted && !registrationFailed) { registrationFailed = true; throw Error('batch source registration failed') }
      const source = register(...args); sources.add(source); return source
    }
    return action
  }
  const append = backend.appendOwnedBatch!, reconcile = backend.reconcileOwnedBatch!
  backend.appendOwnedBatch = async (...args) => {
    const unknown = !key && decodeFactBatch(args[3].bytes).events.some(event => event.type === 'tool/result')
    const outcome = await append(...args)
    if (unknown) { key = args[3].key; return { kind: 'unknown', key } }
    return outcome
  }
  backend.reconcileOwnedBatch = (...args) => key && !allowRecovery ? Promise.resolve({ kind: 'unknown', key: args[3].key }) : reconcile(...args)
  const server = await createLoopbackProvider('/v1/chat/completions', [async response => { response.end(`data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'original', function: { name: 'probe', arguments: '{}' } }] }, finish_reason: 'tool_calls' }] })}\n\ndata: [DONE]\n\n`) }])
  const ctx = createContext(), tools = createToolRegistry(ctx)
  tools.register({ name: 'probe', description: '', inputSchema: {}, execute: async () => { bodies++; return 'never' } })
  const succeeded = manager.succeeded.bind(manager)
  manager.succeeded = handoff => {
    const batch = succeeded(handoff)!, release = batch.release.bind(batch); accepted = true
    return { ...batch, async release() { releases++; if (releaseFault && releases === 1) throw Error('original batch pin release failed'); await release() } }
  }
  const agent = createAgent(ctx, { session: document.view, factOwner: document, sessionId: id, tools, requestContext: manager,
    get systemPrompt() { return manager.text() }, model: createOpenAICompatibleClient({ apiKey: 'fixture', model: 'fixture', baseUrl: server.baseUrl }),
    generationFactory: (action, dependencies) => createGenerationLifecycle(document.view, id, action, undefined, dependencies) })
  try {
    await expect(agent.run('one physical request')).rejects.toThrow()
    expect(accepted).toBe(true); expect(registrationFailed).toBe(true); expect(key).toBeDefined()
    expect(bodies).toBe(0); expect(releases).toBe(0); expect(server.requests).toHaveLength(1)
    await expect(manager.close()).rejects.toThrow()
    allowRecovery = true; await document.reconcile(key!)
    for (const source of sources) await source.close().catch(() => {})
    if (releaseFault) for (const source of sources) await source.close().catch(() => {})
    expect(releases).toBe(releaseFault ? 2 : 1)
    await manager.close()
    const results = (await backend.read(id)).events.filter(event => event.type === 'tool/result')
    expect(results).toMatchObject([{ callId: 'original', output: { code: 'TOOL_ABORTED_BEFORE_DISPATCH' } }])
    expect(results).toHaveLength(1); expect(bodies).toBe(0); expect(server.requests).toHaveLength(1)
  } finally { allowRecovery = true; for (const source of sources) await source.close().catch(() => {}); await manager.close().catch(() => {}); await environment.close().catch(() => {}); await coordinator.close().catch(() => {}); await server.close(); await rm(root, { recursive: true, force: true }) }
})
