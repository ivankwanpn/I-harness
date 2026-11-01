import { expect, it } from 'vitest'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createContext } from '@i-harness/core-plugin'
import { createSession, createNondurableFactOwner } from '@i-harness/core-session'
import { createToolRegistry } from '@i-harness/core-tools'
import { createAgentRegistry } from '@i-harness/core-agent'
import { createOpenAICompatibleClient } from '../../llm-openai-compatible/src/index.ts'
import { createLoopbackProvider } from '../../core-agent/test/helpers/provider-loopback.ts'
import { spawnChild } from '../../subagent/src/child.ts'
import { registerSubagent } from '../../subagent/src/index.ts'
import { createJsonlBackend } from '../../session-persistence-jsonl/src/index.ts'
import { createSessionCoordinator } from '../../session-persistence/src/index.ts'
import { createGenerationLifecycle } from '../src/lifecycle/generation-actions.ts'
import { createJobRegistry } from '../../subagent/src/jobs.ts'
import { createAgentTable } from '../../subagent/src/agent-table.ts'
import { createProjectInstructionEnvironment } from '../src/context/instructions/host.ts'
import { createMainInstructionManager } from '../src/context/instructions/manager.ts'
import { createChildInstructionHost } from '../src/context/instructions/child-host.ts'
import { rmWorkspaceSync } from './helpers.ts'

it('publishes the original fresh child instruction view in its actual first provider request', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'ih-fresh-child-instructions-')); await writeFile(join(cwd, 'AGENTS.md'), 'FRESH_CHILD_RULE')
  const environment = createProjectInstructionEnvironment(), parent = createSession(), parentOwner = createNondurableFactOwner(parent), ctx = createContext(), registry = createToolRegistry(ctx)
  const options = { cwd, environment, authority: () => ({ kind: 'unbound' as const, revision: '1', workspaceRoot: cwd }), available: () => true }
  const manager = createMainInstructionManager({ ...options, session: parent, publish: async () => {} }), host = createChildInstructionHost({ ...options, root: { session: parent, factOwner: parentOwner, manager } })
  const server = await createLoopbackProvider('/v1/chat/completions', [async response => { response.end(`data: ${JSON.stringify({ choices: [{ delta: { content: 'done' }, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`) }])
  const model = createOpenAICompatibleClient({ apiKey: 'fixture', model: 'fixture', baseUrl: server.baseUrl }), table = createAgentTable(), jobs = createJobRegistry(), agents = createAgentRegistry()
  try {
    const result = await spawnChild({ taskName: 'child', message: 'work', parentPath: 'root', parentRegistry: registry, parentSession: parent, parentCtx: ctx,
      role: { name: 'reader', description: '', systemPrompt: 'child', tools: [] }, parentModel: model, resolveModel: async () => ({ status: 'unconfigured', reason: 'unused' }), jobs, table, agents, createInstructionContext: host.create })
    const entry = table.get(result.path)!; await entry.followupChain
    expect(server.requests).toHaveLength(1); expect(server.errors).toEqual([])
    expect(JSON.stringify(server.requests[0]!.body)).toContain('FRESH_CHILD_RULE')
    expect(entry.session.events.some(event => event.type === 'runtime/context')).toBe(true)
    expect(parent.events.some(event => event.type === 'runtime/context')).toBe(false)
    await entry.dispose?.()
  } finally { for (const entry of table.entries().values()) await entry.dispose?.().catch(() => {}); await host.close().catch(() => {}); await manager.close().catch(() => {}); await environment.close(); await server.close(); rmWorkspaceSync(cwd) }
})

it('retries the same original initial-child instruction lease without replaying the launcher', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'ih-child-close-retry-')); await writeFile(join(cwd, 'AGENTS.md'), 'RULE')
  const environment = createProjectInstructionEnvironment(), parent = createSession(), parentOwner = createNondurableFactOwner(parent), ctx = createContext(), registry = createToolRegistry(ctx)
  const options = { cwd, environment, authority: () => ({ kind: 'unbound' as const, revision: '1', workspaceRoot: cwd }), available: () => true }
  const manager = createMainInstructionManager({ ...options, session: parent, publish: async () => {} }), host = createChildInstructionHost({ ...options, root: { session: parent, factOwner: parentOwner, manager } })
  const server = await createLoopbackProvider('/v1/chat/completions', [async response => { response.end(`data: ${JSON.stringify({ choices: [{ delta: { content: 'done' }, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`) }])
  const model = createOpenAICompatibleClient({ apiKey: 'fixture', model: 'fixture', baseUrl: server.baseUrl }), table = createAgentTable(), jobs = createJobRegistry(), agents = createAgentRegistry()
  let creates = 0, closes = 0, retires = 0
  try {
    const result = await spawnChild({ taskName: 'child', message: 'work', parentPath: 'root', parentRegistry: registry, parentSession: parent, parentCtx: ctx,
      role: { name: 'reader', description: '', systemPrompt: 'child', tools: [] }, parentModel: model, resolveModel: async () => ({ status: 'unconfigured', reason: 'unused' }), jobs, table, agents,
      createInstructionContext(input) {
        creates++; const actual = host.create(input)
        return { requestContext: actual.requestContext, retire() { retires++; actual.retire() }, settleOriginals: () => actual.settleOriginals(), async close() { if (++closes === 1) throw new Error('original close fault'); await actual.close() } }
      } })
    const entry = table.get(result.path)!; await entry.followupChain
    await expect(entry.dispose!()).rejects.toThrow('original close fault')
    await entry.dispose!()
    expect([creates, closes, retires, server.requests.length]).toEqual([1, 2, 1, 1])
  } finally { for (const entry of table.entries().values()) await entry.dispose?.().catch(() => {}); await host.close().catch(() => {}); await manager.close().catch(() => {}); await environment.close(); await server.close(); rmWorkspaceSync(cwd) }
})

it('retains late initial lease cleanup through parent retirement and retries the same close without launching', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'ih-child-late-')); await writeFile(join(cwd, 'AGENTS.md'), 'RULE')
  const environment = createProjectInstructionEnvironment(), parent = createSession(), parentOwner = createNondurableFactOwner(parent), ctx = createContext(), registry = createToolRegistry(ctx)
  const options = { cwd, environment, authority: () => ({ kind: 'unbound' as const, revision: '1', workspaceRoot: cwd }), available: () => true }
  const manager = createMainInstructionManager({ ...options, session: parent, publish: async () => {} }), host = createChildInstructionHost({ ...options, root: { session: parent, factOwner: parentOwner, manager } })
  const server = await createLoopbackProvider('/v1/chat/completions', []), model = createOpenAICompatibleClient({ apiKey: 'fixture', model: 'fixture', baseUrl: server.baseUrl })
  const subagent = registerSubagent(ctx, registry, { parentSession: parent, parentModel: model, exec: {} as never, resolveModel: async () => ({ status: 'unconfigured', reason: 'unused' }) })
  let creates = 0, closes = 0, retirement: Promise<void> | undefined
  try {
    await subagent.ready
    await expect(spawnChild({ taskName: 'late', message: 'work', parentPath: 'root', parentRegistry: registry, parentSession: parent, parentCtx: ctx,
      role: { name: 'reader', description: '', systemPrompt: 'child', tools: [] }, parentModel: model, resolveModel: async () => ({ status: 'unconfigured', reason: 'unused' }), jobs: subagent.jobs, table: subagent.table, agents: subagent.agents, retainInitialSetup: subagent.retainInitialSetup,
      createInstructionContext(input) {
        creates++; const actual = host.create(input)
        retirement = subagent.dispose(); void retirement.catch(() => {})
        return { requestContext: actual.requestContext, retire: () => actual.retire(), settleOriginals: () => actual.settleOriginals(), async close() { if (++closes === 1) throw new Error('original close fault'); await actual.close() } }
      } })).rejects.toMatchObject({ code: 'FACT_RECOVERY_REQUIRED' })
    await expect(retirement).rejects.toBeDefined()
    expect(server.requests).toEqual([]); expect(subagent.table.entries().size).toBe(0); expect([creates, closes]).toEqual([1, 1])
    await subagent.dispose(); expect([creates, closes]).toEqual([1, 2])
    expect(server.requests).toEqual([])
  } finally { await subagent.dispose().catch(() => {}); await host.close().catch(() => {}); await manager.close().catch(() => {}); await environment.close(); await server.close(); rmWorkspaceSync(cwd) }
})

it('retains the original managed document and scope until the initial child lease closes', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'ih-child-managed-order-')); await writeFile(join(cwd, 'AGENTS.md'), 'RULE')
  const backend = createJsonlBackend(join(cwd, 'sessions')), coordinator = createSessionCoordinator(backend, { lock: { enabled: true } })
  await coordinator.create({ sessionId: 'parent' }); const parentDocument = await coordinator.openManagedDocument('parent'), parent = parentDocument.view
  const environment = createProjectInstructionEnvironment(), ctx = createContext(), registry = createToolRegistry(ctx), order: string[] = []
  const originalOpen = coordinator.openManagedDocument.bind(coordinator)
  coordinator.openManagedDocument = async (...args) => { const doc = await originalOpen(...args), original = doc.close.bind(doc); doc.close = async () => { order.push('document'); await original() }; return doc }
  const originalMount = ctx.scope.mount.bind(ctx.scope)
  ctx.scope.mount = (...args) => { const child = originalMount(...args), original = child.scope.unmount.bind(child.scope); child.scope.unmount = () => { order.push('scope'); return original() }; return child }
  const options = { cwd, environment, authority: () => ({ kind: 'unbound' as const, revision: '1', workspaceRoot: cwd }), available: () => true }
  const manager = createMainInstructionManager({ ...options, session: parent, publish: async () => {} }), host = createChildInstructionHost({ ...options, root: { session: parent, factOwner: parentDocument, manager } })
  const server = await createLoopbackProvider('/v1/chat/completions', [async response => { response.end(`data: ${JSON.stringify({ choices: [{ delta: { content: 'done' }, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`) }])
  const model = createOpenAICompatibleClient({ apiKey: 'fixture', model: 'fixture', baseUrl: server.baseUrl }), table = createAgentTable(), jobs = createJobRegistry(), agents = createAgentRegistry()
  let closes = 0
  try {
    const result = await spawnChild({ taskName: 'child', message: 'work', parentPath: 'root', parentRegistry: registry, parentSession: parent, parentCtx: ctx,
      role: { name: 'reader', description: '', systemPrompt: 'child', tools: [] }, parentModel: model, resolveModel: async () => ({ status: 'unconfigured', reason: 'unused' }), jobs, table, agents, childSessions: { coordinator, parentSessionId: 'parent' },
      generationFactoryFor: (owner, id, selected) => action => createGenerationLifecycle(owner.view, id, action, { enabled: true, selectedClient: selected }),
      createInstructionContext(input) {
        const actual = host.create(input)
        return { requestContext: actual.requestContext, retire: () => actual.retire(), settleOriginals: () => actual.settleOriginals(), async close() { order.push('lease'); if (++closes === 1) throw new Error('held lease'); await actual.close() } }
      } })
    const entry = table.get(result.path)!; await entry.followupChain
    await expect(entry.dispose!()).rejects.toThrow('held lease'); expect(order).toEqual(['lease'])
    await entry.dispose!(); expect(order).toEqual(['lease', 'lease', 'document', 'scope'])
    expect(server.requests).toHaveLength(1)
  } finally { for (const entry of table.entries().values()) await entry.dispose?.().catch(() => {}); await host.close().catch(() => {}); await manager.close().catch(() => {}); await environment.close(); await coordinator.close().catch(() => {}); await server.close(); rmWorkspaceSync(cwd) }
})
