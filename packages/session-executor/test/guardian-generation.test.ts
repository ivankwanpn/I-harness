import { afterEach, expect, it, vi } from 'vitest'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createSessionCoordinator } from '@i-harness/session-persistence'
import { createJsonlBackend } from '@i-harness/session-persistence-jsonl'
import { createOpenAICompatibleClient } from '../../llm-openai-compatible/src/index.ts'
import { createRetryingClient, resolveRetryPolicy } from '@i-harness/llm-seam'
import { createSessionService } from '../src/index.ts'
import { subscribe } from '@i-harness/core-session'

afterEach(() => vi.unstubAllGlobals())
it.each([['isolated', undefined, 'off'], ['isolated', 130_000, 'off'], ['subagent', undefined, 'off'], ['isolated', undefined, 'only'], ['subagent', undefined, 'only'], ['isolated', undefined, 'late'], ['subagent', undefined, 'late']] as const)('%s guardian owns its retry pool before held resolution and preserves timeout %s through %s', async (execution, timeoutMs, mode) => {
  const root = await mkdtemp(join(tmpdir(), 'ih-guardian-generation-'))
  const backend = createJsonlBackend(root), coordinator = createSessionCoordinator(backend, { lock: { enabled: true } }), { id } = await coordinator.create()
  let main = 0, reviews = 0
  const gateEntered = Promise.withResolvers<void>(), releaseGate = Promise.withResolvers<void>()
  vi.stubGlobal('fetch', async (url: string) => {
    let delta: object
    if (url === 'https://guardian-review.fixture.invalid/v1/chat/completions') {
      if (++reviews < 3) return new Response('synthetic busy', { status: 503 })
      delta = { content: JSON.stringify({ outcome: 'deny', rationale: 'Synthetic action denied.', risk_level: 'moderate' }) }
    } else if (url === 'https://guardian-main.fixture.invalid/v1/chat/completions') {
      main++
      const args = { path: join(root, '..', `${id}-outside.txt`), text: 'synthetic' }
      const code = (mode === 'late' ? 'const pending = tools.fixture_gate({}); await yield_control(); await pending; ' : '') + 'text(await tools.write(' + JSON.stringify(args) + '));'
      delta = mode === 'late' && main > 1 ? { content: 'Parent turn finished.' } : { tool_calls: [{ index: 0, id: 'write-call', type: 'function', function: { name: mode === 'off' ? 'write' : 'code_exec', arguments: JSON.stringify(mode === 'off' ? args : { code }) } }] }
    } else throw new Error('Unexpected network destination')
    return new Response('data: ' + JSON.stringify({ choices: [{ delta, finish_reason: null }] }) + '\n\ndata: ' + JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] }) + '\n\ndata: [DONE]\n\n')
  })
  const model = createOpenAICompatibleClient({ apiKey: 'fixture-only', model: 'main', baseUrl: 'https://guardian-main.fixture.invalid' })
  const reviewer = createRetryingClient(createOpenAICompatibleClient({ apiKey: 'fixture-only', model: 'reviewer', baseUrl: 'https://guardian-review.fixture.invalid' }), resolveRetryPolicy({ mode: 'normal', maxRetries: 2, backoff: { initialDelayMs: 1, maxDelayMs: 1, jitterRatio: 0 } }))
  const entered = Promise.withResolvers<void>(), released = Promise.withResolvers<void>()
  const resolveReviewer = async () => {
    entered.resolve(); await released.promise
    return { client: reviewer, identity: { provider: 'fixture', model: 'reviewer' } }
  }
  const service = createSessionService({ workspace: root, coordinator, model, codeMode: { mode: mode === 'late' ? 'only' : mode }, ...(mode === 'late' ? { modelActionTimeoutMs: 1000 } : {}),
    ...(execution === 'subagent' ? { allowSubagentModelSelection: true, roleSelectionFor: () => ({ provider: 'fixture', model: 'reviewer' }), resolveRoleModel: async () => ({ status: 'ready' as const, binding: await resolveReviewer() }) } : {}),
    guardian: { execution, timeoutMs, isolated: { resolveBinding: resolveReviewer } } })
  const assembly = await service.assemblyFor(id), cellClosed = Promise.withResolvers<void>()
  assembly.tools.register({ name: 'fixture_gate', description: 'Controlled test gate.', inputSchema: { type: 'object', properties: {} }, isReadOnly: true, isConcurrencySafe: true, execute: async () => { gateEntered.resolve(); await releaseGate.promise; return { released: true } } })
  const unsubscribe = subscribe(assembly.session, event => { if (event.type === 'code/cell' && ['completed', 'failed', 'terminated', 'interrupted'].includes(event.state)) cellClosed.resolve() })
  const run = service.submit(id, 'Consider the synthetic write.', new AbortController().signal); void run.catch(() => {})
  try {
    if (mode === 'late') {
      await gateEntered.promise; await run
      const first = assembly.session.events.find(event => event.type === 'context/action' && event.op === 'open')!
      if (first.type === 'context/action' && first.op === 'open') await new Promise(resolve => setTimeout(resolve, Math.max(0, first.expiresAt - Date.now() + 10)))
      releaseGate.resolve()
      await Promise.race([entered.promise, cellClosed.promise.then(() => { throw new Error('Late cell closed without reviewer resolution') })])
    } else await Promise.race([entered.promise, run.then(() => { throw new Error('Turn ended without reviewer resolution') })])
    const held = (await backend.read(id)).events
    const opened = held.find(event => event.type === 'context/action' && event.op === 'open' && event.purpose === 'approval')
    expect(opened).toBeDefined()
    expect(opened?.type === 'context/action' && opened.op === 'open' ? opened.origin.kind : undefined).toBe(mode === 'off' ? 'tool' : 'code')
    expect(opened?.type === 'context/action' && opened.op === 'open' ? opened.expiresAt - opened.startedAt : undefined).toBe(timeoutMs ?? 90_000)
    expect(main).toBe(mode === 'late' ? 2 : 1); expect(reviews).toBe(0)
    released.resolve()
    if (mode === 'late') { await cellClosed.promise; expect(assembly.session.events.findLast(event => event.type === 'code/cell' && event.state === 'terminated')).toMatchObject({ error: expect.stringContaining('guardian denied: Synthetic action denied.') }) }
    else await expect(run).rejects.toThrow('guardian denied: Synthetic action denied.')
    expect(reviews).toBe(3)
    const events = (await backend.read(id)).events
    expect(events.filter(event => event.type === 'context/attempt' && event.op === 'reserve' && event.lane === 'auxiliary')).toHaveLength(3)
    expect(events.filter(event => event.type === 'tool/dispatch')).toHaveLength(mode === 'off' ? 0 : 1)
    expect(events.filter(event => event.type === 'code/dispatch')).toHaveLength(mode === 'late' ? 1 : 0)
    expect(events.filter(event => event.type === 'context/action' && event.op === 'open' && event.purpose === 'main')).toHaveLength(mode === 'late' ? 2 : 1)
    if (execution === 'subagent') {
      const children = (await coordinator.list()).filter(child => child !== id)
      expect(children).toHaveLength(1)
      const audit = (await backend.read(children[0]!)).events
      expect(audit.filter(event => event.type === 'model/exchange-accepted')).toHaveLength(1)
      expect(audit.filter(event => event.type === 'context/action' || event.type === 'context/attempt')).toHaveLength(0)
    }
  } finally { releaseGate.resolve(); released.resolve(); await run.catch(() => {}); await service.close().catch(() => {}); unsubscribe(); await coordinator.close().catch(() => {}) }
})

it('an actual approval grant binds once to its exact owned child; copied, foreign and reused bindings refuse before child execution', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ih-guardian-binding-')), backend = createJsonlBackend(root), coordinator = createSessionCoordinator(backend, { lock: { enabled: true } }), { id } = await coordinator.create()
  let sends = 0, checks = 0
  vi.stubGlobal('fetch', async (url: string) => {
    if (url !== 'https://guardian-binding.fixture.invalid/v1/chat/completions') throw new Error('Unexpected network destination')
    const delta = ++sends === 1 ? { tool_calls: [{ index: 0, id: 'capture-approval', type: 'function', function: { name: 'binding_probe', arguments: '{}' } }] } : { content: 'finished' }
    return new Response('data: ' + JSON.stringify({ choices: [{ delta, finish_reason: null }] }) + '\n\ndata: ' + JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] }) + '\n\ndata: [DONE]\n\n')
  })
  const model = createOpenAICompatibleClient({ apiKey: 'fixture-only', model: 'fixture', baseUrl: 'https://guardian-binding.fixture.invalid' })
  const service = createSessionService({ workspace: root, coordinator, model, codeMode: { mode: 'off' } }), assembly = await service.assemblyFor(id)
  const { borrowApprovalGeneration } = await import('../../core-agent/src/agent/tool-generation.ts')
  assembly.tools.register({ name: 'binding_probe', description: 'Controlled binding probe.', inputSchema: { type: 'object', properties: {} }, isReadOnly: true, execute: async (_args, exec) => {
    const generation = await exec.modelGeneration!.approval({ timeoutMs: 1000, selectedClient: () => model })
    const first = await coordinator.create({ parentSession: id, origin: 'approval-review', seedLength: 0 }), second = await coordinator.create({ parentSession: id, origin: 'approval-review', seedLength: 0 })
    const child = await coordinator.openManagedDocument(first.id), foreign = await coordinator.openManagedDocument(second.id)
    try {
      expect(() => generation.forChild.call({ ...generation }, child.view)).toThrow(expect.objectContaining({ code: 'GENERATION_STALE' }))
      const binding = generation.forChild(child.view)
      expect(() => generation.forChild(foreign.view)).toThrow(expect.objectContaining({ code: 'GENERATION_STALE' }))
      expect(() => borrowApprovalGeneration({ ...binding }, child.view)).toThrow(expect.objectContaining({ code: 'GENERATION_STALE' }))
      expect(() => borrowApprovalGeneration(binding, foreign.view)).toThrow(expect.objectContaining({ code: 'GENERATION_STALE' }))
      expect(borrowApprovalGeneration(binding, child.view)).toBe(generation)
      expect(() => borrowApprovalGeneration(binding, child.view)).toThrow(expect.objectContaining({ code: 'GENERATION_STALE' }))
      checks++
      expect(child.view.events).toEqual([]); expect(foreign.view.events).toEqual([])
      return 'checked exact binding'
    } finally { await generation.close('completed') }
  } })
  try {
    await service.submit(id, 'Check the synthetic binding.', new AbortController().signal)
    expect([sends, checks]).toEqual([2, 1])
    const events = (await backend.read(id)).events
    expect(events.filter(event => event.type === 'context/action' && event.op === 'open' && event.purpose === 'approval')).toHaveLength(1)
    expect(events.filter(event => event.type === 'context/attempt' && event.op === 'reserve' && event.lane === 'auxiliary')).toHaveLength(0)
  } finally { await service.close().catch(() => {}); await coordinator.close().catch(() => {}) }
})
