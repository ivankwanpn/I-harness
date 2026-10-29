import { ProjectionCounter } from '@i-harness/token-meter'
import { createPreparedHttpPayload, preparedModelClient } from '@i-harness/llm-seam'
import { expect, it, vi } from 'vitest'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createContext } from '@i-harness/core-plugin'
import { createSession } from '@i-harness/core-session'
import { createToolRegistry } from '@i-harness/core-tools'
import { createOpenAICompatibleClient } from '../../llm-openai-compatible/src/index.ts'
import { createLoopbackProvider } from '../../core-agent/test/helpers/provider-loopback.ts'
import { runIsolatedGuardianReview } from '../../guard-approval/src/guardian/isolated-reviewer.ts'
import { createProjectInstructionEnvironment } from '../src/context/instructions/host.ts'
import { createIsolatedInstructionHost } from '../src/context/instructions/isolated.ts'
import { rmWorkspaceSync } from './helpers.ts'

it('sends the original isolated source in the actual first approval request', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'ih-isolated-source-')); await writeFile(join(cwd, 'AGENTS.md'), 'ISOLATED_PHYSICAL_RULE')
  const environment = createProjectInstructionEnvironment(), parent = createSession(), ctx = createContext(), registry = createToolRegistry(ctx)
  const host = createIsolatedInstructionHost({ cwd, environment, authority: () => ({ kind: 'unbound', revision: '1', workspaceRoot: cwd }), available: () => true })
  const answer = JSON.stringify({ outcome: 'approve', rationale: 'safe', risk_level: 'none' })
  const server = await createLoopbackProvider('/v1/chat/completions', [async response => { response.end(`data: ${JSON.stringify({ choices: [{ delta: { content: answer }, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`) }])
  const model = createOpenAICompatibleClient({ apiKey: 'fixture', model: 'fixture', baseUrl: server.baseUrl })
  try {
    const verdict = await runIsolatedGuardianReview({ parentSession: parent, parentCtx: ctx, parentRegistry: registry, parentModel: model, resolveModel: async () => ({ status: 'unconfigured', reason: 'unused' }), createIsolatedInstructionContext: host.create } as never, { name: 'write', reason: 'review', args: {} })
    expect(verdict.outcome).toBe('approve')
    expect(server.requests).toHaveLength(1); expect(server.errors).toEqual([])
    expect(JSON.stringify(server.requests[0]!.body)).toContain('ISOLATED_PHYSICAL_RULE')
    expect(parent.events.some(event => event.type === 'runtime/context' || event.type === 'model/exchange-accepted')).toBe(false)
  } finally { await host.close(); await environment.close(); await server.close(); rmWorkspaceSync(cwd) }
})

it('denies an aborted isolated response without replay and reports original stream failure', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'ih-isolated-drain-')); await writeFile(join(cwd, 'AGENTS.md'), 'ISOLATED_HELD_RULE')
  const environment = createProjectInstructionEnvironment(), parent = createSession(), ctx = createContext(), registry = createToolRegistry(ctx)
  const host = createIsolatedInstructionHost({ cwd, environment, authority: () => ({ kind: 'unbound', revision: '1', workspaceRoot: cwd }), available: () => true })
  let release!: () => void
  const held = new Promise<void>(resolve => { release = resolve })
  const server = await createLoopbackProvider('/v1/chat/completions', [async response => { response.write(`data: ${JSON.stringify({ choices: [{ delta: { content: '{' }, finish_reason: null }] })}\n\n`); await held; response.end('data: [DONE]\n\n') }])
  const model = createOpenAICompatibleClient({ apiKey: 'fixture', model: 'fixture', baseUrl: server.baseUrl })
  try {
    const verdict = await runIsolatedGuardianReview({ parentSession: parent, parentCtx: ctx, parentRegistry: registry, parentModel: model, timeoutMs: 50, resolveModel: async () => ({ status: 'unconfigured', reason: 'unused' }), createIsolatedInstructionContext: host.create } as never, { name: 'write', reason: 'review', args: {} })
    expect(verdict.outcome).toBe('deny')
    expect(server.requests).toHaveLength(1)
    release()
    await expect(host.close()).rejects.toBeInstanceOf(AggregateError)
    expect(server.requests).toHaveLength(1)
  } finally { release(); await host.close().catch(() => {}); await environment.close(); await server.close(); rmWorkspaceSync(cwd) }
})

it('denies an issued isolated review when original policy generation changes before completion', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'ih-isolated-policy-')); await writeFile(join(cwd, 'AGENTS.md'), 'ISOLATED_POLICY_RULE')
  const original = createProjectInstructionEnvironment(), parent = createSession(), ctx = createContext(), registry = createToolRegistry(ctx)
  let epoch = 'before'
  const environment = { ...original, policy: { ...original.policy, current() { const state = original.policy.current(); return { ...state, generation: `${state.generation}:${epoch}` } } } }
  const host = createIsolatedInstructionHost({ cwd, environment, authority: () => ({ kind: 'unbound', revision: '1', workspaceRoot: cwd }), available: () => true })
  const answer = JSON.stringify({ outcome: 'approve', rationale: 'safe', risk_level: 'none' })
  const server = await createLoopbackProvider('/v1/chat/completions', [async response => { epoch = 'after'; response.end(`data: ${JSON.stringify({ choices: [{ delta: { content: answer }, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`) }])
  const model = createOpenAICompatibleClient({ apiKey: 'fixture', model: 'fixture', baseUrl: server.baseUrl })
  try {
    const verdict = await runIsolatedGuardianReview({ parentSession: parent, parentCtx: ctx, parentRegistry: registry, parentModel: model, resolveModel: async () => ({ status: 'unconfigured', reason: 'unused' }), createIsolatedInstructionContext: host.create } as never, { name: 'write', reason: 'review', args: {} })
    expect(verdict.outcome).toBe('deny'); expect(server.requests).toHaveLength(1)
  } finally { await host.close().catch(() => {}); await original.close(); await server.close(); rmWorkspaceSync(cwd) }
})

it('holds the actual isolated source owner until a timed-out original response reader settles', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'ih-isolated-held-reader-')); await writeFile(join(cwd, 'AGENTS.md'), 'ISOLATED_HELD_READER')
  const environment = createProjectInstructionEnvironment(), parent = createSession(), ctx = createContext(), registry = createToolRegistry(ctx)
  const host = createIsolatedInstructionHost({ cwd, environment, authority: () => ({ kind: 'unbound', revision: '1', workspaceRoot: cwd }), available: () => true })
  let release!: () => void, started!: () => void
  const gate = new Promise<void>(resolve => { release = resolve }), entered = new Promise<void>(resolve => { started = resolve })
  const answer = JSON.stringify({ outcome: 'approve', rationale: 'safe', risk_level: 'none' })
  const server = await createLoopbackProvider('/v1/chat/completions', [async response => { response.end(`data: ${JSON.stringify({ choices: [{ delta: { content: answer }, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`) }])
  const model = preparedModelClient(async request => createPreparedHttpPayload({
    body: { prompt: request.systemPrompt }, request,
    describe(body) { const counter = new ProjectionCounter('projected-pricing-v2'); counter.structured('otherInput', body); return { input: counter.finish({ protocol: 'test', modelId: 'm' }, body, body), packet: { sizeKind: 'http-json-body' as const, inlineBinaryBytes: 0, cacheMetadataBytes: 0, signatureBytes: 0 } } },
    output: () => ({ capSupport: 'supported' as const, effectiveCap: 2048, minimumCap: 1, source: 'request' as const }), cap: body => body,
    transport: { label: 'loopback', prepare: () => ({ url: `${server.baseUrl}/v1/chat/completions`, init: {}, state: undefined }), async *read() { started(); await gate; yield { type: 'text/chunk', text: answer }; yield { type: 'end' } } },
  }))
  try {
    const reviewing = runIsolatedGuardianReview({ parentSession: parent, parentCtx: ctx, parentRegistry: registry, parentModel: model, timeoutMs: 500, resolveModel: async () => ({ status: 'unconfigured', reason: 'unused' }), createIsolatedInstructionContext: host.create } as never, { name: 'write', reason: 'review', args: {} })
    await Promise.race([entered, reviewing.then(() => { throw new Error('review finished before reader') })]); const verdict = await reviewing; expect(verdict.outcome).toBe('deny')
    let settled = false; const closing = host.close().then(() => { settled = true }, () => { settled = true })
    await Promise.resolve(); expect(settled).toBe(false)
    release(); await closing; expect(settled).toBe(true); expect(server.requests).toHaveLength(1)
  } finally { release(); await host.close().catch(() => {}); await environment.close(); await server.close(); rmWorkspaceSync(cwd) }
})

it('retains late isolated source acquisition after timeout and never sends a model request', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'ih-isolated-late-')); await writeFile(join(cwd, 'AGENTS.md'), 'ISOLATED_LATE')
  const original = createProjectInstructionEnvironment(), parent = createSession(), ctx = createContext(), registry = createToolRegistry(ctx)
  let release!: () => void, entered!: () => void
  const gate = new Promise<void>(resolve => { release = resolve }), started = new Promise<void>(resolve => { entered = resolve })
  const environment = { ...original, policy: { ...original.policy, async ready() { await original.policy.ready(); entered(); await gate } } }
  const host = createIsolatedInstructionHost({ cwd, environment, authority: () => ({ kind: 'unbound', revision: '1', workspaceRoot: cwd }), available: () => true })
  const server = await createLoopbackProvider('/v1/chat/completions', [])
  const model = createOpenAICompatibleClient({ apiKey: 'fixture', model: 'fixture', baseUrl: server.baseUrl })
  try {
    const reviewing = runIsolatedGuardianReview({ parentSession: parent, parentCtx: ctx, parentRegistry: registry, parentModel: model, timeoutMs: 100, resolveModel: async () => ({ status: 'unconfigured', reason: 'unused' }), createIsolatedInstructionContext: host.create } as never, { name: 'write', reason: 'review', args: {} })
    await Promise.race([started, reviewing.then(() => { throw new Error('review finished before acquisition') })]); const verdict = await reviewing
    expect(verdict.outcome).toBe('deny')
    let settled = false; const closing = host.close().then(() => { settled = true })
    await Promise.resolve(); expect(settled).toBe(false)
    release(); await closing; expect(server.requests).toHaveLength(0)
  } finally { release(); await host.close().catch(() => {}); await original.close(); await server.close(); rmWorkspaceSync(cwd) }
})

it.each([false, true])('keeps the real approval generation open through its timed-out held producer, close uncertainty %s', async uncertain => {
  const cwd = await mkdtemp(join(tmpdir(), 'ih-isolated-generation-')); await writeFile(join(cwd, 'AGENTS.md'), 'ISOLATED_GENERATION_RULE')
  const { createSessionCoordinator } = await import('@i-harness/session-persistence')
  const { createJsonlBackend } = await import('@i-harness/session-persistence-jsonl')
  const { createSessionService } = await import('../src/index.ts')
  const { OwnedGenerationAction } = await import('../src/lifecycle/generation-action.ts')
  const recover = vi.spyOn(OwnedGenerationAction.prototype, 'recoverClose')
  const sessionRoot = await mkdtemp(join(tmpdir(), 'ih-isolated-sessions-'))
  const backend = createJsonlBackend(sessionRoot)
  const coordinator = createSessionCoordinator(backend, { lock: { enabled: true } }), { id } = await coordinator.create()
  let release!: () => void, started!: () => void
  const gate = new Promise<void>(resolve => { release = resolve }), entered = new Promise<void>(resolve => { started = resolve })
  const answer = JSON.stringify({ outcome: 'approve', rationale: 'safe', risk_level: 'none' })
  const reviewerServer = await createLoopbackProvider('/v1/chat/completions', [async response => { response.end('ok') }])
  const reviewer = preparedModelClient(async request => createPreparedHttpPayload({ body: { prompt: request.systemPrompt }, request,
    describe(body) { const counter = new ProjectionCounter('projected-pricing-v2'); counter.structured('otherInput', body); return { input: counter.finish({ protocol: 'test', modelId: 'reviewer' }, body, body), packet: { sizeKind: 'http-json-body' as const, inlineBinaryBytes: 0, cacheMetadataBytes: 0, signatureBytes: 0 } } },
    output: () => ({ capSupport: 'supported' as const, effectiveCap: 2048, minimumCap: 1, source: 'request' as const }), cap: body => body,
    transport: { label: 'loopback', prepare: () => ({ url: `${reviewerServer.baseUrl}/v1/chat/completions`, init: {}, state: undefined }), async *read() { started(); await gate; yield { type: 'text/chunk', text: answer }; yield { type: 'end' } } },
  }))
  const mainServer = await createLoopbackProvider('/v1/chat/completions', [async response => {
    const delta = { tool_calls: [{ index: 0, id: 'generation-write', type: 'function', function: { name: 'write', arguments: JSON.stringify({ path: join(cwd, 'reviewed-write.txt'), text: 'x' }) } }] }
    response.end(`data: ${JSON.stringify({ choices: [{ delta, finish_reason: 'tool_calls' }] })}\n\ndata: [DONE]\n\n`)
  }])
  const model = createOpenAICompatibleClient({ apiKey: 'fixture', model: 'main', baseUrl: mainServer.baseUrl })
  const diagnosticEnvironment = createProjectInstructionEnvironment(), sources: Array<{ closes: number }> = []
  const originalCreate = diagnosticEnvironment.host.create.bind(diagnosticEnvironment.host)
  diagnosticEnvironment.host.create = scope => { const source = originalCreate(scope), originalClose = source.close.bind(source), count = { closes: 0 }; sources.push(count); return { ...source, async close() { await originalClose(); count.closes++ } } }
  const reviewed = Promise.withResolvers<void>()
  const service = createSessionService({ workspace: cwd, coordinator, model, instructionEnvironment: diagnosticEnvironment, approvalMode: 'ask-all', codeMode: { mode: 'off' }, guardian: { execution: 'isolated', model: reviewer, timeoutMs: 500, isolated: { onReview: () => reviewed.resolve() } } })
  try {
    const assembly = await service.assemblyFor(id), run = service.submit(id, 'review the write', new AbortController().signal); void run.catch(() => {})
    await Promise.race([entered, run.then(() => { throw new Error('parent ended before reviewer') }, error => { throw error })])
    await reviewed.promise
    const originalSource = sources.at(-1)!; expect(originalSource.closes).toBe(0)
    const opened = assembly.session.events.find(event => event.type === 'context/action' && event.op === 'open' && event.purpose === 'approval')
    expect(opened).toBeDefined()
    if (!opened || opened.type !== 'context/action' || opened.op !== 'open') throw new Error('missing approval action')
    expect(assembly.session.events.some(event => event.type === 'context/action' && event.op === 'close' && event.actionId === opened.actionId)).toBe(false)
    const append = backend.appendOwnedBatch!, { decodeFactBatch } = await import('@i-harness/core-session')
    let closeAppends = 0
    backend.appendOwnedBatch = async (...args) => {
      const isClose = decodeFactBatch(args[3].bytes).events.some(event => event.type === 'context/action' && event.op === 'close' && event.actionId === opened.actionId)
      if (!isClose) return append(...args)
      closeAppends++; const result = await append(...args)
      return uncertain && closeAppends === 1 ? { kind: 'unknown', key: args[3].key } : result
    }
    release(); await run.catch(() => {}); await service.close().catch(() => {}); await service.close().catch(() => {})
    expect(closeAppends).toBe(1); expect(originalSource.closes).toBe(1)
    if (uncertain) expect(recover).toHaveBeenCalledTimes(1)
    expect(assembly.session.events.filter(event => event.type === 'context/action' && event.op === 'close' && event.actionId === opened.actionId)).toHaveLength(1)
    expect(reviewerServer.requests).toHaveLength(1)
  } finally { release(); await service.close().catch(() => {}); await coordinator.close().catch(() => {}); await mainServer.close(); await reviewerServer.close(); await diagnosticEnvironment.close(); recover.mockRestore(); rmWorkspaceSync(cwd); rmWorkspaceSync(sessionRoot) }
}, 15000)
