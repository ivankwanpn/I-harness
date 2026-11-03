import { expect, it } from 'vitest'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createContext } from '@i-harness/core-plugin'
import { createToolRegistry } from '@i-harness/core-tools'
import { registerCodeMode } from '../../code-mode/src/register.ts'
import { spawnChild } from '../../subagent/src/child.ts'
import { registerSubagent } from '../../subagent/src/index.ts'
import { createJsonlBackend } from '../../session-persistence-jsonl/src/index.ts'
import { createSessionCoordinator } from '../../session-persistence/src/index.ts'
import { createOpenAICompatibleClient } from '../../llm-openai-compatible/src/index.ts'
import { createLoopbackProvider } from '../../core-agent/test/helpers/provider-loopback.ts'
import { createGenerationLifecycle } from '../src/lifecycle/generation-actions.ts'
import { createProjectInstructionEnvironment } from '../src/context/instructions/host.ts'
import { createMainInstructionManager } from '../src/context/instructions/manager.ts'
import { createChildInstructionHost } from '../src/context/instructions/child-host.ts'
import { rmWorkspaceSync } from './helpers.ts'

async function fixture() {
  const cwd = await mkdtemp(join(tmpdir(), 'ih-initial-acquire-')); await writeFile(join(cwd, 'AGENTS.md'), 'RULE')
  const coordinator = createSessionCoordinator(createJsonlBackend(join(cwd, 'sessions')), { lock: { enabled: true } })
  await coordinator.create({ sessionId: 'parent' }); const document = await coordinator.openManagedDocument('parent'), parent = document.view
  const environment = createProjectInstructionEnvironment(), ctx = createContext(), registry = createToolRegistry(ctx), order: string[] = []
  const open = coordinator.openManagedDocument.bind(coordinator)
  coordinator.openManagedDocument = async (...args) => { const child = await open(...args), close = child.close.bind(child); child.close = async () => { order.push('document'); await close() }; return child }
  const mount = ctx.scope.mount.bind(ctx.scope)
  ctx.scope.mount = (...args) => { const child = mount(...args), unmount = child.scope.unmount.bind(child.scope); child.scope.unmount = () => { order.push('scope'); return unmount() }; return child }
  const hostOptions = { cwd, environment, authority: () => ({ kind: 'unbound' as const, revision: '1', workspaceRoot: cwd }), available: () => true }
  const manager = createMainInstructionManager({ ...hostOptions, session: parent, publish: async () => {} }), host = createChildInstructionHost({ ...hostOptions, root: { session: parent, factOwner: document, manager } })
  const server = await createLoopbackProvider('/v1/chat/completions', []), model = createOpenAICompatibleClient({ apiKey: 'fixture', model: 'fixture', baseUrl: server.baseUrl })
  const resolveModel = async () => ({ status: 'unconfigured' as const, reason: 'unused' })
  const subagent = registerSubagent(ctx, registry, { parentSession: parent, factOwner: document, parentModel: model, exec: {} as never, resolveModel })
  await subagent.ready
  const options = { taskName: 'child', message: 'work', parentPath: 'root', parentRegistry: registry, parentSession: parent, parentCtx: ctx,
    role: { name: 'reader', description: '', systemPrompt: 'child', tools: [] as string[] }, parentModel: model, resolveModel,
    jobs: subagent.jobs, table: subagent.table, agents: subagent.agents, retainInitialSetup: subagent.retainInitialSetup,
    childSessions: { coordinator, parentSessionId: 'parent' }, generationFactoryFor: (owner: import('@i-harness/core-session').FactOwner, id: string, selected: () => import('@i-harness/llm-seam').ModelClient | undefined) => (action: import('@i-harness/core-session').ManagedAction<import('@i-harness/core-session').ProducerFactOutcome>) => createGenerationLifecycle(owner.view, id, action, { enabled: true, selectedClient: selected }) }
  return { order, options, host, subagent, registry, server, async close() { await subagent.dispose().catch(() => {}); await host.close().catch(() => {}); await manager.close().catch(() => {}); await environment.close(); await coordinator.close().catch(() => {}); await server.close(); rmWorkspaceSync(cwd) } }
}

it.each(['requestContext', 'settleOriginals', 'retire'] as const)('retains returned lease cleanup when %s validation refuses', async invalid => {
  const f = await fixture(); let creates = 0, closes = 0, getters = 0, settled = 0
  try {
    await expect(spawnChild({ ...f.options, createInstructionContext(input) {
      creates++; const actual = f.host.create(input)
      const lease = { requestContext: actual.requestContext,
        retire() { expect(this).toBe(lease); actual.retire() },
        async settleOriginals() { expect(this).toBe(lease); settled++; await actual.settleOriginals() },
        async close() { expect(this).toBe(lease); f.order.push('lease'); if (++closes === 1) throw Error('original returned close fault'); await actual.close() } }
      Object.defineProperty(lease, invalid, { get() { getters++; throw Error('accessor must not run') } })
      return lease
    } })).rejects.toMatchObject({ code: 'FACT_RECOVERY_REQUIRED' })
    expect(closes).toBe(1); expect(f.order).toEqual(['lease']); expect(getters).toBe(0)
    expect(f.server.requests).toEqual([]); expect(f.subagent.table.entries().size).toBe(0)
    await f.subagent.dispose()
    expect(closes).toBe(2); expect(creates).toBe(1); expect(getters).toBe(0)
    expect(settled).toBe(invalid === 'settleOriginals' ? 0 : 1)
    expect(f.order).toEqual(['lease', 'lease', 'document', 'scope'])
  } finally { await f.close() }
})

it.each([false, true])('retains the real mount cleanup across held ready replacement (reject=%s)', async rejectReady => {
  const f = await fixture(), entered = Promise.withResolvers<void>(), ready = Promise.withResolvers<void>()
  let cancels = 0, disposes = 0, replacements = 0, leaseCloses = 0
  let returned!: ReturnType<typeof registerCodeMode>
  f.registry.register({ name: 'probe', description: '', inputSchema: {}, execute: async () => 'never' })
  const work = spawnChild({ ...f.options, role: { ...f.options.role, tools: ['probe'] },
    createInstructionContext(input) { const actual = f.host.create(input); return { requestContext: actual.requestContext, retire: () => actual.retire(), settleOriginals: () => actual.settleOriginals(), async close() { leaseCloses++; f.order.push('lease'); await actual.close() } } },
    codeModeFactory(ctx, tools, options) {
      const actual = registerCodeMode(ctx, tools, { ...options, config: { mode: 'mixed' } })
      returned = { ...actual, async ready() { await actual.ready?.(); entered.resolve(); await ready.promise },
        async cancel(reason) { expect(this).toBe(returned); cancels++; await actual.cancel(reason) },
        async dispose() { expect(this).toBe(returned); f.order.push('runtime'); if (++disposes === 1) throw Error('original runtime dispose fault'); await actual.dispose() } }
      return returned
    } }); void work.catch(() => {})
  try {
    await entered.promise
    returned.cancel = async () => { replacements++ }; returned.dispose = async () => { replacements++ }
    const retirement = f.subagent.dispose(); void retirement.catch(() => {})
    if (rejectReady) ready.reject(Error('original readiness failed')); else ready.resolve()
    const outcome = await work.then(value => ({ value }), error => ({ error }))
    const retired = await retirement.then(() => ({ closed: true }), error => ({ error }))
    expect([cancels, disposes, replacements, leaseCloses]).toEqual([1, 1, 0, 0])
    expect(outcome).toMatchObject({ error: { code: 'FACT_RECOVERY_REQUIRED' } }); expect(retired).toHaveProperty('error')
    expect(f.order).toEqual(['runtime']); expect(f.server.requests).toEqual([]); expect(f.subagent.table.entries().size).toBe(0)
    await f.subagent.dispose()
    expect([cancels, disposes, replacements, leaseCloses]).toEqual([1, 2, 0, 1])
    expect(f.order).toEqual(['runtime', 'runtime', 'lease', 'document', 'scope'])
  } finally { ready.resolve(); await work.catch(() => {}); await f.close() }
})
