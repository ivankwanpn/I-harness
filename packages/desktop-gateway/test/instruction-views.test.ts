import { expect, it, vi } from 'vitest'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createSessionCoordinator } from '@i-harness/session-persistence'
import { createJsonlBackend } from '@i-harness/session-persistence-jsonl'
import { createSessionService } from '@i-harness/session-executor'
import { createOpenAICompatibleClient } from '../../llm-openai-compatible/src/index.ts'
import { createLoopbackProvider } from '../../core-agent/test/helpers/provider-loopback.ts'
import { createInstructionViews } from '../src/instructions/views.ts'

it('observes a real live publication through one scoped subscription and cleans up', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'ih-i6-gateway-')), root = await mkdtemp(join(tmpdir(), 'ih-i6-session-'))
  await writeFile(join(workspace, 'AGENTS.md'), 'GATEWAY_I6_RULE')
  const coordinator = createSessionCoordinator(createJsonlBackend(root), { lock: { enabled: true } }), { id } = await coordinator.create()
  const server = await createLoopbackProvider('/v1/chat/completions', [async response => { response.end(`data: ${JSON.stringify({ choices: [{ delta: { content: 'done' }, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`) }])
  const model = createOpenAICompatibleClient({ apiKey: 'fixture', model: 'fixture', baseUrl: server.baseUrl }), service = createSessionService({ workspace, coordinator, model })
  let allowed = true, hold = false
  const gate = Promise.withResolvers<void>(), entered = Promise.withResolvers<void>()
  const events: unknown[] = [], views = createInstructionViews(coordinator, service, async scope => { if (hold) { entered.resolve(); await gate.promise }; if (!allowed || scope.sessionId !== id) throw new Error('foreign parent'); return 'fixture-authority' }, event => events.push(event))
  try {
    await service.assemblyFor(id)
    const first = await views.subscribe({ sessionId: id }), second = await views.subscribe({ sessionId: id })
    views.acknowledge(first.subscriptionId); views.acknowledge(second.subscriptionId)
    expect(first.report.state).toBe('not-published'); expect(second.cursor).toEqual(first.cursor)
    await service.submit(id, 'hello', new AbortController().signal)
    await vi.waitFor(() => { for (const subscriptionId of [first.subscriptionId, second.subscriptionId]) expect(events).toContainEqual(expect.objectContaining({ subscriptionId, reason: 'changed' })) })
    const state = await views.read({ sessionId: id }); expect(state).toMatchObject({ state: 'ready', publication: { sources: [{ path: join(workspace, 'AGENTS.md') }] } })
    expect(server.requests).toHaveLength(1); expect(JSON.stringify(server.requests[0]!.body)).toContain('GATEWAY_I6_RULE')
    allowed = false; await service.reconcileExecutionAuthority([id])
    await vi.waitFor(() => { for (const subscriptionId of [first.subscriptionId, second.subscriptionId]) expect(events).toContainEqual(expect.objectContaining({ subscriptionId, reason: 'revoked' })) })
    await expect(views.read({ sessionId: id })).rejects.toThrow('foreign parent')
    allowed = true; views.unsubscribe(first.subscriptionId); views.unsubscribe(second.subscriptionId)
    const third = await views.subscribe({ sessionId: id }); views.acknowledge(third.subscriptionId); const prior = events.length
    hold = true; await service.reconcileExecutionAuthority([id]); await entered.promise
    views.unsubscribe(third.subscriptionId); gate.resolve(); await Promise.resolve(); await Promise.resolve(); expect(events).toHaveLength(prior)
    hold = false; await service.refreshInstructions!(id); await Promise.resolve(); expect(events).toHaveLength(prior)
  } finally { gate.resolve(); views.close(); await service.close(); await coordinator.close(); await server.close(); await rm(workspace, { recursive: true, force: true }); await rm(root, { recursive: true, force: true }) }
}, 15000)

it('reports cold instruction state through the actual gateway RPC without creating runtime context', async () => {
  const { mkdir, readFile } = await import('node:fs/promises')
  const { createDesktopHost } = await import('../src/host.ts')
  const base = await mkdtemp(join(tmpdir(), 'ih-i6-rpc-')), workspace = join(base, 'workspace'), sessionDir = join(base, 'sessions')
  await mkdir(workspace); await mkdir(sessionDir)
  const coordinator = createSessionCoordinator(createJsonlBackend(sessionDir)), { id } = await coordinator.create(); await coordinator.close()
  const settingsPath = join(base, 'settings.json'), credentialsPath = join(base, 'credentials.json'); await writeFile(settingsPath, '{}'); await writeFile(credentialsPath, '{}')
  const log = join(sessionDir, `${id}.jsonl`), before = await readFile(log, 'utf8'), frames: any[] = []
  const host = await createDesktopHost({ workspace, sessionDir, settingsPath, credentialsPath, onWrite: frame => frames.push(frame) })
  const call = (number: number, method: string, params: unknown) => host.handleLine(JSON.stringify({ jsonrpc: '2.0', id: number, method, params }))
  try {
    await call(1, 'initialize', {}); await call(2, 'desktop/instructions/state', { sessionId: id })
    expect(frames.find(frame => frame.id === 2)).toMatchObject({ result: { scope: { sessionId: id }, report: { state: 'not-published' }, cursor: { epoch: expect.any(String), revision: expect.any(Number) } } })
    await call(3, 'desktop/instructions/state', { sessionId: id, childSessionId: 'foreign' }); expect(frames.find(frame => frame.id === 3)).toHaveProperty('error')
    expect(await readFile(log, 'utf8')).toBe(before)
  } finally { await host.close(); await rm(base, { recursive: true, force: true }) }
}, 15000)

it('catches an actual publication during the original subscription snapshot', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'ih-i6-race-')), root = await mkdtemp(join(tmpdir(), 'ih-i6-race-session-')); await writeFile(join(workspace, 'AGENTS.md'), 'RACE_RULE')
  const coordinator = createSessionCoordinator(createJsonlBackend(root), { lock: { enabled: true } }), { id } = await coordinator.create()
  const server = await createLoopbackProvider('/v1/chat/completions', [async response => { response.end(`data: ${JSON.stringify({ choices: [{ delta: { content: 'done' }, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`) }])
  const model = createOpenAICompatibleClient({ apiKey: 'fixture', model: 'fixture', baseUrl: server.baseUrl }), service = createSessionService({ workspace, coordinator, model })
  const gate = Promise.withResolvers<void>(), entered = Promise.withResolvers<void>(); let checks = 0
  const events: any[] = [], views = createInstructionViews(coordinator, service, async input => { if (input.sessionId !== id) throw new Error('foreign'); if (++checks === 2) { entered.resolve(); await gate.promise }; return 'stable' }, event => events.push(event))
  try {
    await service.assemblyFor(id)
    const subscribing = views.subscribe({ sessionId: id }); await entered.promise
    await service.submit(id, 'hello', new AbortController().signal)
    gate.resolve(); const initial = await subscribing; views.acknowledge(initial.subscriptionId)
    await vi.waitFor(() => expect(events).toContainEqual(expect.objectContaining({ subscriptionId: initial.subscriptionId, reason: 'changed', cursor: expect.objectContaining({ revision: expect.any(Number) }) })))
    expect(events.some(event => event.subscriptionId === initial.subscriptionId && event.cursor.revision > initial.cursor.revision)).toBe(true)
    expect(server.requests).toHaveLength(1)
  } finally { gate.resolve(); views.close(); await service.close(); await coordinator.close(); await server.close(); await rm(workspace, { recursive: true, force: true }); await rm(root, { recursive: true, force: true }) }
}, 15000)

it('delivers live published instruction metadata through actual host RPC and notifications', async () => {
  const { mkdir } = await import('node:fs/promises'), { createDesktopHost } = await import('../src/host.ts'), { createHostFixtureModel } = await import('./host-fixture-model.ts')
  const base = await mkdtemp(join(tmpdir(), 'ih-i6-live-rpc-')), workspace = join(base, 'workspace'), sessionDir = join(base, 'sessions'); await mkdir(workspace); await writeFile(join(workspace, 'AGENTS.md'), 'REAL_RPC_RULE')
  const server = await createLoopbackProvider('/v1/chat/completions', [async response => { response.end(`data: ${JSON.stringify({ choices: [{ delta: { content: 'done' }, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`) }])
  const settingsPath = join(base, 'settings.json'), credentialsPath = join(base, 'credentials.json')
  await writeFile(settingsPath, JSON.stringify({ autoTitle: false, llm: { providers: { fixture: { protocol: 'openai-completions', baseURL: `${server.baseUrl}/v1`, apiKeyEnv: 'IH_I6_FIXTURE_KEY', models: [{ id: 'fixture', contextWindow: 272000 }] } }, defaultModel: { provider: 'fixture', model: 'fixture' } } }))
  await writeFile(credentialsPath, JSON.stringify({ refs: { IH_I6_FIXTURE_KEY: 'fixture' } }))
  const previousFetch = globalThis.fetch
  const frames: any[] = [], host = await createDesktopHost({ workspace, sessionDir, settingsPath, credentialsPath, buildProviderClient: createHostFixtureModel(server.baseUrl), onWrite: frame => frames.push(frame) })
  let request = 0
  const call = async (method: string, params: unknown = {}) => { const id = ++request; await host.handleLine(JSON.stringify({ jsonrpc: '2.0', id, method, params })); const frame = frames.find(value => value.id === id); if (frame?.error) throw new Error(JSON.stringify(frame.error)); return frame?.result }
  try {
    await call('initialize'); const { sessionId } = await call('session/create')
    await call('session/prompt', { sessionId, prompt: 'hello' })
    const state = await call('desktop/instructions/state', { sessionId })
    expect(state.report).toMatchObject({ state: 'ready', publication: { sources: [{ path: join(workspace, 'AGENTS.md'), state: 'loaded' }] } })
    expect(JSON.stringify(state)).not.toContain('REAL_RPC_RULE'); expect(server.requests).toHaveLength(1); expect(server.errors).toEqual([]); expect(JSON.stringify(server.requests[0]!.body)).toContain('REAL_RPC_RULE'); const sentBeforeRefresh = server.requests.length
    const subscription = await call('desktop/instructions/subscribe', { sessionId })
    await call('desktop/instructions/refresh', { sessionId }); await vi.waitFor(() => expect(frames).toContainEqual(expect.objectContaining({ method: 'desktop/instructions/changed', params: expect.objectContaining({ subscriptionId: subscription.subscriptionId }) })))
    const saved = await call('desktop/instructions/configure', { patch: { enabled: false, maxBytes: 0 } }); expect(saved.saved).toMatchObject({ enabled: false, maxBytes: 0 })
    await expect(call('desktop/instructions/configure', { patch: { maxBytes: -1 } })).rejects.toThrow()
    expect((await call('desktop/instructions/settings')).saved).toMatchObject({ enabled: false, maxBytes: 0 })
    await vi.waitFor(async () => { const updated = await call('desktop/instructions/state', { sessionId }); expect(updated.report.effectivePolicy).toMatchObject({ enabled: false, maxBytes: 0 }); expect(updated.report.state).not.toBe('ready') })
    await call('desktop/session/manage', { sessionId, action: 'archive' })
    await vi.waitFor(() => expect(frames).toContainEqual(expect.objectContaining({ method: 'desktop/instructions/changed', params: expect.objectContaining({ subscriptionId: subscription.subscriptionId, reason: 'revoked' }) })))
    await expect(call('desktop/instructions/state', { sessionId })).rejects.toThrow()
    await call('desktop/instructions/unsubscribe', { subscriptionId: subscription.subscriptionId }); expect(server.requests).toHaveLength(sentBeforeRefresh)
  } finally { await host.close(); globalThis.fetch = previousFetch; await server.close(); await rm(base, { recursive: true, force: true }) }
}, 20000)

it('authorizes only the actual live child lineage before exposing child publication metadata', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'ih-i6-child-gateway-')), root = await mkdtemp(join(tmpdir(), 'ih-i6-child-sessions-')); await writeFile(join(workspace, 'AGENTS.md'), 'CHILD_GATEWAY_RULE')
  const coordinator = createSessionCoordinator(createJsonlBackend(root), { lock: { enabled: true } }), { id } = await coordinator.create(), { id: foreign } = await coordinator.create()
  const emit = (delta: object, finish: string) => async (response: import('node:http').ServerResponse) => { response.end(`data: ${JSON.stringify({ choices: [{ delta, finish_reason: finish }] })}\n\ndata: [DONE]\n\n`) }
  const server = await createLoopbackProvider('/v1/chat/completions', [emit({ tool_calls: [{ index: 0, id: 'spawn-i6', type: 'function', function: { name: 'spawn_agent', arguments: JSON.stringify({ task_name: 'child-i6', message: 'inspect', agent_type: 'general', background: false }) } }] }, 'tool_calls'), emit({ content: 'child done' }, 'stop'), emit({ content: 'parent done' }, 'stop')])
  const model = createOpenAICompatibleClient({ apiKey: 'fixture', model: 'fixture', baseUrl: server.baseUrl }), service = createSessionService({ workspace, coordinator, model, codeMode: { mode: 'off' }, approveAll: true })
  const views = createInstructionViews(coordinator, service, async scope => { if (scope.sessionId !== id && scope.sessionId !== foreign) throw new Error('foreign'); return 'same-project' }, () => {})
  try {
    await service.submit(id, 'spawn child', new AbortController().signal)
    const assembly = service.liveAssembly(id)!, child = assembly.subagentState().agentTable.find(row => row.sessionId)?.sessionId
    expect(child).toBeTruthy()
    const report = await views.read({ sessionId: id, childSessionId: child! })
    expect(report).toMatchObject({ state: 'ready', publication: { sources: [{ path: join(workspace, 'AGENTS.md'), state: 'loaded' }] } })
    await expect(views.read({ sessionId: foreign, childSessionId: child! })).rejects.toThrow()
    // Retire the real child through its original registered control while the
    // final authorization awaits; the observation Session row remains retained.
    let holding = false, checks = 0
    const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>(), events: any[] = []
    const lifetimeViews = createInstructionViews(coordinator, service, async () => { if (holding && ++checks === 4) { entered.resolve(); await release.promise }; return 'same-project' }, event => events.push(event))
    try {
      const subscribed = await lifetimeViews.subscribe({ sessionId: id, childSessionId: child! }); lifetimeViews.acknowledge(subscribed.subscriptionId)
      holding = true
      const reading = lifetimeViews.read({ sessionId: id, childSessionId: child! }); await entered.promise
      const entry = assembly.subagentState().agentTable.find(row => row.sessionId === child)!
      await assembly.tools.get('close_agent')!.execute({ target: entry.path }, { sessionId: id })
      release.resolve()
      expect((await reading).state).toBe('revoked')
      await vi.waitFor(() => expect(events).toContainEqual(expect.objectContaining({ subscriptionId: subscribed.subscriptionId, reason: 'revoked' })))
      expect(assembly.instructionDiagnostics?.(child!)).toBeUndefined()
    } finally { release.resolve(); lifetimeViews.close() }
    expect(server.errors).toEqual([])
  } finally { views.close(); await service.close().catch(() => {}); await coordinator.close(); await server.close(); await rm(workspace, { recursive: true, force: true }); await rm(root, { recursive: true, force: true }) }
}, 15000)
