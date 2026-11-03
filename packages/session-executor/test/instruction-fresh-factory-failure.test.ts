import { expect, it, vi } from 'vitest'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createContext } from '@i-harness/core-plugin'
import { createSession, createNondurableFactOwner } from '@i-harness/core-session'
import { createToolRegistry } from '@i-harness/core-tools'
import { createOpenAICompatibleClient } from '../../llm-openai-compatible/src/index.ts'
import { createLoopbackProvider } from '../../core-agent/test/helpers/provider-loopback.ts'
import { spawnChild } from '../../subagent/src/child.ts'
import { registerSubagent } from '../../subagent/src/index.ts'
import { createJsonlBackend } from '../../session-persistence-jsonl/src/index.ts'
import { createSessionCoordinator } from '../../session-persistence/src/index.ts'
import { createProjectInstructionEnvironment } from '../src/context/instructions/host.ts'
import { createMainInstructionManager } from '../src/context/instructions/manager.ts'
import { createChildInstructionHost } from '../src/context/instructions/child-host.ts'
import { rmWorkspaceSync } from './helpers.ts'

const controlled = vi.hoisted(() => ({ enabled: false, closes: 0 }))
vi.mock('@i-harness/runtime-context', async original => {
  const api = await original<typeof import('@i-harness/runtime-context')>()
  return { ...api, createRuntimeContext(...args: Parameters<typeof api.createRuntimeContext>) {
    const runtime = api.createRuntimeContext(...args)
    if (!controlled.enabled) return runtime
    return { ...runtime, registerSection(...section: Parameters<typeof runtime.registerSection>) { runtime.registerSection(...section); throw new Error('original factory failure') }, async close() { if (++controlled.closes <= 2) throw new Error('original runtime close fault'); await runtime.close() } }
  } }
})

it('retains an original never-returned factory slot and child setup until exact cleanup succeeds', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'ih-child-factory-failure-')); await writeFile(join(cwd, 'AGENTS.md'), 'RULE')
  const environment = createProjectInstructionEnvironment(), parent = createSession(), parentOwner = createNondurableFactOwner(parent), ctx = createContext(), registry = createToolRegistry(ctx)
  const options = { cwd, environment, authority: () => ({ kind: 'unbound' as const, revision: '1', workspaceRoot: cwd }), available: () => true }
  const manager = createMainInstructionManager({ ...options, session: parent, publish: async () => {} }), host = createChildInstructionHost({ ...options, root: { session: parent, factOwner: parentOwner, manager } })
  const server = await createLoopbackProvider('/v1/chat/completions', []), model = createOpenAICompatibleClient({ apiKey: 'fixture', model: 'fixture', baseUrl: server.baseUrl })
  const subagent = registerSubagent(ctx, registry, { parentSession: parent, parentModel: model, exec: {} as never, resolveModel: async () => ({ status: 'unconfigured', reason: 'unused' }) })
  try {
    await subagent.ready; controlled.enabled = true; controlled.closes = 0
    await expect(spawnChild({ taskName: 'failed', message: 'work', parentPath: 'root', parentRegistry: registry, parentSession: parent, parentCtx: ctx,
      role: { name: 'reader', description: '', systemPrompt: 'child', tools: [] }, parentModel: model, resolveModel: async () => ({ status: 'unconfigured', reason: 'unused' }), jobs: subagent.jobs, table: subagent.table, agents: subagent.agents, retainInitialSetup: subagent.retainInitialSetup, createInstructionContext: host.create })).rejects.toMatchObject({ code: 'FACT_RECOVERY_REQUIRED' })
    expect(controlled.closes).toBe(2); expect(server.requests).toEqual([]); expect(subagent.table.entries().size).toBe(0)
    controlled.enabled = false; await subagent.dispose()
    expect(controlled.closes).toBe(3); expect(server.requests).toEqual([])
  } finally { controlled.enabled = false; await subagent.dispose().catch(() => {}); await host.close().catch(() => {}); await manager.close().catch(() => {}); await environment.close(); await server.close(); rmWorkspaceSync(cwd) }
})

it('failed-construction settlement cannot close a successfully returned live lease', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'ih-child-factory-live-')), environment = createProjectInstructionEnvironment(), parent = createSession(), parentOwner = createNondurableFactOwner(parent)
  const options = { cwd, environment, authority: () => ({ kind: 'unbound' as const, revision: '1', workspaceRoot: cwd }), available: () => true }
  const manager = createMainInstructionManager({ ...options, session: parent, publish: async () => {} }), host = createChildInstructionHost({ ...options, root: { session: parent, factOwner: parentOwner, manager } })
  const child = createSession(), factOwner = createNondurableFactOwner(child), input = { session: child, factOwner, lifetime: { available: () => true } }
  const lease = host.create(input)
  try {
    await expect(host.create.settleFailed!(input)).rejects.toMatchObject({ code: 'FACT_RECOVERY_REQUIRED' })
    await expect(lease.requestContext.reconcile()).resolves.toBeUndefined()
  } finally { await lease.close(); await host.close(); await manager.close(); await environment.close(); rmWorkspaceSync(cwd) }
})

it('holds the original managed child document and scope behind a never-returned factory cleanup debt', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'ih-child-failed-managed-')), backend = createJsonlBackend(join(cwd, 'sessions')), coordinator = createSessionCoordinator(backend, { lock: { enabled: true } })
  await coordinator.create({ sessionId: 'parent' }); const parentDocument = await coordinator.openManagedDocument('parent'), parent = parentDocument.view
  const environment = createProjectInstructionEnvironment(), ctx = createContext(), registry = createToolRegistry(ctx), order: string[] = []
  const originalMount = ctx.scope.mount.bind(ctx.scope); ctx.scope.mount = (...args) => { const child = originalMount(...args), original = child.scope.unmount.bind(child.scope); child.scope.unmount = () => { order.push('scope'); return original() }; return child }
  const originalOpen = coordinator.openManagedDocument.bind(coordinator)
  coordinator.openManagedDocument = async (...args) => { const doc = await originalOpen(...args), original = doc.close.bind(doc); doc.close = async () => { order.push('document'); await original() }; return doc }
  const options = { cwd, environment, authority: () => ({ kind: 'unbound' as const, revision: '1', workspaceRoot: cwd }), available: () => true }
  const manager = createMainInstructionManager({ ...options, session: parent, publish: async () => {} }), host = createChildInstructionHost({ ...options, root: { session: parent, factOwner: parentDocument, manager } })
  const server = await createLoopbackProvider('/v1/chat/completions', []), model = createOpenAICompatibleClient({ apiKey: 'fixture', model: 'fixture', baseUrl: server.baseUrl })
  const subagent = registerSubagent(ctx, registry, { parentSession: parent, factOwner: parentDocument, parentModel: model, exec: {} as never, resolveModel: async () => ({ status: 'unconfigured', reason: 'unused' }) })
  try {
    await subagent.ready; controlled.enabled = true; controlled.closes = 0
    await expect(spawnChild({ taskName: 'failed', message: 'work', parentPath: 'root', parentRegistry: registry, parentSession: parent, parentCtx: ctx,
      role: { name: 'reader', description: '', systemPrompt: 'child', tools: [] }, parentModel: model, resolveModel: async () => ({ status: 'unconfigured', reason: 'unused' }), jobs: subagent.jobs, table: subagent.table, agents: subagent.agents, retainInitialSetup: subagent.retainInitialSetup, createInstructionContext: host.create,
      childSessions: { coordinator, parentSessionId: 'parent' } })).rejects.toMatchObject({ code: 'FACT_RECOVERY_REQUIRED' })
    expect(controlled.closes).toBe(2); expect(order).toEqual([]); expect(server.requests).toEqual([]); expect(subagent.table.entries().size).toBe(0)
    controlled.enabled = false; await subagent.dispose()
    expect(controlled.closes).toBe(3); expect(order).toEqual(['document', 'scope']); expect(server.requests).toEqual([])
  } finally { controlled.enabled = false; await subagent.dispose().catch(() => {}); await host.close().catch(() => {}); await manager.close().catch(() => {}); await environment.close(); await coordinator.close().catch(() => {}); await server.close(); rmWorkspaceSync(cwd) }
})
