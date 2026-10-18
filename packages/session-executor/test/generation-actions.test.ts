import { afterEach, expect, it, vi } from 'vitest'
import { mkdtemp, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createSessionCoordinator, forkSession, remapConversationSeed } from '@i-harness/session-persistence'
import { createJsonlBackend } from '@i-harness/session-persistence-jsonl'
import { createOpenAICompatibleClient } from '../../llm-openai-compatible/src/index.ts'
import { createPreparedPayload, createRetryingClient, createWaitingGuard, prepareModelRequest, resolveRetryPolicy, wrapPreparedRequest, type LLMStreamEvent, type ModelClient } from '@i-harness/llm-seam'
import { createMockClient } from '@i-harness/llm-mock'
import { createSessionService, type SessionServiceOptions } from '../src/index.ts'
import { createSession, append, projectConversation, fromJSONL } from '@i-harness/core-session'
import { forkTurns } from '../../subagent/src/fork.ts'
import { maybeAutoTitle } from '../../session-title/src/index.ts'
import { openExecutorDocument } from '../src/lifecycle/managed-document.ts'

afterEach(() => vi.unstubAllGlobals())
const success = () => new Response('data: {"choices":[{"delta":{"content":"ok"},"finish_reason":null}]}\n\ndata: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } })
async function fixture(cap?: number) {
  const root = await mkdtemp(join(tmpdir(), 'ih-generation-owner-'))
  const backend = createJsonlBackend(root), coordinator = createSessionCoordinator(backend, { lock: { enabled: true } })
  const { id } = await coordinator.create()
  const network: RequestInit[] = []
  vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
    if (url !== 'https://generation.fixture.invalid/v1/chat/completions') throw new Error('Unexpected network destination')
    network.push(init)
    return network.length < 3 ? new Response('synthetic busy', { status: 503 }) : success()
  })
  const model = createRetryingClient(createOpenAICompatibleClient({ apiKey: 'fixture-only', model: 'fixture', baseUrl: 'https://generation.fixture.invalid' }), resolveRetryPolicy({ mode: 'normal', maxRetries: 2, backoff: { initialDelayMs: 1, maxDelayMs: 1, jitterRatio: 0 } }))
  const service = createSessionService({ workspace: root, coordinator, model, codeMode: { mode: 'off' }, ...(cap ? { modelActionMaxAttempts: cap } : {}) } as SessionServiceOptions)
  return { service, backend, coordinator, id, network, async close() { await service.close().catch(() => {}); await coordinator.close().catch(() => {}) } }
}

it('three real wrapper sends commit three reservations and exactly one physical acceptance link', async () => {
  const value = await fixture()
  try {
    await value.service.submit(value.id, 'synthetic work', new AbortController().signal)
    expect(value.network).toHaveLength(3)
    const events = (await value.backend.read(value.id)).events
    expect(events.filter(event => event.type === 'context/attempt' && event.op === 'reserve').map(event => event.ordinal)).toEqual([1, 2, 3])
    expect(events.filter(event => event.type === 'context/action' && event.op === 'accepted')).toHaveLength(1)
    expect(events.filter(event => event.type === 'model/exchange-accepted')).toHaveLength(1)
    expect(events.filter(event => event.type === 'tool/dispatch')).toHaveLength(0)
  } finally { await value.close() }
})

it('the actual executor cap denies a second retry transport while retaining the first conservative debit', async () => {
  const value = await fixture(1)
  try {
    await expect(value.service.submit(value.id, 'synthetic capped work', new AbortController().signal)).rejects.toMatchObject({ code: 'GENERATION_EXHAUSTED' })
    expect(value.network).toHaveLength(1)
    const events = (await value.backend.read(value.id)).events
    expect(events.filter(event => event.type === 'context/attempt' && event.op === 'reserve')).toHaveLength(1)
    expect(events.filter(event => event.type === 'model/exchange-accepted')).toHaveLength(0)
    expect(events.filter(event => event.type === 'tool/dispatch')).toHaveLength(0)
  } finally { await value.close() }
})

it('commits raw admission and the pending generation before awaiting the actual model resolver', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ih-generation-early-'))
  const backend = createJsonlBackend(root), coordinator = createSessionCoordinator(backend, { lock: { enabled: true } })
  const { id } = await coordinator.create(), entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>()
  let calls = 0
  vi.stubGlobal('fetch', async (url: string) => { if (url !== 'https://generation.fixture.invalid/v1/chat/completions') throw new Error('Unexpected network destination'); calls++; return success() })
  const model = createOpenAICompatibleClient({ apiKey: 'fixture-only', model: 'fixture', baseUrl: 'https://generation.fixture.invalid' })
  const service = createSessionService({ workspace: root, coordinator, codeMode: { mode: 'off' }, modelBindingFor: async () => {
    entered.resolve(); await release.promise
    return { status: 'ready', binding: { providerId: 'fixture', modelId: 'fixture', label: 'fixture', model } }
  } })
  const run = service.submit(id, 'raw received instruction', new AbortController().signal)
  void run.catch(() => {})
  try {
    await entered.promise
    const events = (await backend.read(id)).events
    expect(events.filter(event => event.type === 'agent/input/admitted')).toEqual([expect.objectContaining({ text: 'raw received instruction', provenance: { kind: 'human', authority: 'request', scope: 'turn', producer: 'session.prompt' } })])
    expect(events.filter(event => event.type === 'context/action' && event.op === 'open')).toEqual([expect.objectContaining({ purpose: 'main' })])
    expect(events.filter(event => event.type === 'context/action' && event.op === 'bind')).toHaveLength(0)
    expect(calls).toBe(0)
    release.resolve(); await run
  } finally { release.resolve(); await run.catch(() => {}); await service.close().catch(() => {}); await coordinator.close().catch(() => {}) }
})

it('promotes the exact raw human input and records command expansion once as a derived observation', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ih-generation-prepared-input-'))
  const backend = createJsonlBackend(root), coordinator = createSessionCoordinator(backend, { lock: { enabled: true } })
  const { id } = await coordinator.create()
  let transforms = 0
  const wire: string[] = []
  vi.stubGlobal('fetch', async (url: string, init: RequestInit) => { if (url !== 'https://generation.fixture.invalid/v1/chat/completions') throw new Error('Unexpected network destination'); wire.push(String(init.body)); return success() })
  const model = createOpenAICompatibleClient({ apiKey: 'fixture-only', model: 'fixture', baseUrl: 'https://generation.fixture.invalid' })
  const service = createSessionService({ workspace: root, coordinator, model, codeMode: { mode: 'off' }, transformPrompt: async () => { transforms++; return 'expanded command context' } })
  try {
    await service.submit(id, '/fixture', new AbortController().signal, { context: 'supplemental context' })
    const events = (await backend.read(id)).events
    expect(events.filter(event => event.type === 'agent/input/admitted').map(event => event.text)).toEqual(['/fixture'])
    const messages = events.filter((event): event is Extract<typeof event, { type: 'user/message' }> => event.type === 'user/message' && event.inputPreparation !== undefined)
    expect(messages[0]).toMatchObject({ text: '/fixture', provenance: { kind: 'human', authority: 'request' } })
    expect(messages.slice(1)).toHaveLength(2)
    expect(messages.slice(1).every(event => event.provenance?.authority === 'observation' && event.internal === true)).toBe(true)
    expect(wire).toHaveLength(1)
    expect(wire[0]).toContain('/fixture')
    expect(wire[0]).toContain('expanded command context')
    expect(wire[0]).toContain('supplemental context')
    expect(transforms).toBe(1)
    expect(events.filter(event => event.type === 'agent/input/preparation').map(event => event.op)).toEqual(['started', 'completed', 'promoted'])
    const fork = await forkSession(coordinator, id), forked = await coordinator.openManagedDocument(fork.sessionId)
    const inherited = projectConversation(forked.view)
    expect(inherited.items.filter(item => item.kind === 'input').map(item => item.messages)).toEqual(projectConversation(service.liveSession(id)!).items.filter(item => item.kind === 'input').map(item => item.messages))
    expect(forked.view.events.filter(event => event.type === 'context/action' || event.type === 'context/attempt' || event.type === 'agent/input/preparation')).toHaveLength(0)
    const raw = forked.view.events.find(event => event.type === 'user/message' && event.text === '/fixture')!
    expect(forked.view.events.flatMap(event => event.type === 'user/message' && event.seedInputContext ? [event.seedInputContext.rawMessageSeq] : [])).toEqual([raw.seq, raw.seq])
    const childSeed = forkTurns(forked.view.events, Infinity, forked.view.formatVersion, forked.view.header)
    expect(childSeed.filter(event => event.type === 'user/message' && event.seedInputContext)).toHaveLength(2)
    expect(() => remapConversationSeed({ source: forked.view.events, retained: forked.view.events.filter(event => event.type === 'user/message' && event.seedInputContext), sourceFormat: 8, sourceHeader: forked.view.header })).toThrow(/raw source/)
    const detached = fromJSONL(await readFile(join(root, `${id}.jsonl`), 'utf8'))
    const compiled = remapConversationSeed({ source: detached.events, retained: detached.events, sourceFormat: detached.formatVersion, sourceHeader: detached.header })
    const declared = await coordinator.create({ parentSession: id, seedLength: compiled.length })
    const imported = await openExecutorDocument({ coordinator, sessionId: declared.id, detachedSession: detached })
    expect(imported.session.events).toEqual(compiled)
    expect(imported.inbox.pending()).toHaveLength(0)
    for (const header of [{}, { parentSession: id, seedLength: compiled.length + 1 }, { parentSession: 'foreign-source', seedLength: compiled.length }]) {
      const target = await coordinator.create(header), path = join(root, `${target.id}.jsonl`), before = await readFile(path, 'utf8')
      await expect(openExecutorDocument({ coordinator, sessionId: target.id, detachedSession: detached })).rejects.toThrow(/predeclared exact seed prefix/)
      await coordinator.closeManagedDocument(target.id)
      await expect(openExecutorDocument({ coordinator, sessionId: target.id, detachedSession: detached })).rejects.toThrow(/predeclared exact seed prefix/)
      expect(await readFile(path, 'utf8')).toBe(before)
    }
    const occupied = await coordinator.create()
    await coordinator.append(occupied.id, [{ type: 'user/message', text: 'already live target' }])
    const occupiedPath = join(root, `${occupied.id}.jsonl`), beforeOccupied = await readFile(occupiedPath, 'utf8')
    await expect(openExecutorDocument({ coordinator, sessionId: occupied.id, detachedSession: detached })).rejects.toThrow(/empty owned document/)
    expect(await readFile(occupiedPath, 'utf8')).toBe(beforeOccupied)
  } finally { await service.close().catch(() => {}); await coordinator.close().catch(() => {}) }
})

it('the explicitly selected built-in persistent mock accepts one local invocation with zero physical attempts', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ih-generation-local-'))
  const backend = createJsonlBackend(root), coordinator = createSessionCoordinator(backend, { lock: { enabled: true } })
  const { id } = await coordinator.create()
  let calls = 0
  vi.stubGlobal('fetch', async () => { calls++; throw new Error('Unexpected network destination') })
  const service = createSessionService({ workspace: root, coordinator, modelPolicy: 'test-mock', mockScript: [{ role: 'assistant', text: 'local response' }], codeMode: { mode: 'off' } })
  try {
    await service.submit(id, 'synthetic local work', new AbortController().signal)
    const events = (await backend.read(id)).events
    expect(calls).toBe(0)
    expect(events.filter(event => event.type === 'context/attempt')).toHaveLength(0)
    expect(events.filter(event => event.type === 'context/action' && event.op === 'local-invocation')).toHaveLength(1)
    expect(events.filter(event => event.type === 'context/action' && event.op === 'accepted')).toEqual([expect.objectContaining({ executionDomain: 'local-test', localInvocationId: expect.any(String) })])
    expect(events.filter(event => event.type === 'model/exchange-accepted')).toEqual([expect.objectContaining({ version: 1 })])
  } finally { await service.close().catch(() => {}); await coordinator.close().catch(() => {}) }
})

it.each(['old-human', 'notification', 'schedule'] as const)('a %s admission remains literal and never replays the host command transform', async kind => {
  const root = await mkdtemp(join(tmpdir(), 'ih-generation-literal-input-'))
  const backend = createJsonlBackend(root), coordinator = createSessionCoordinator(backend, { lock: { enabled: true } })
  const { id } = await coordinator.create(), document = await coordinator.openManagedDocument(id)
  const source = document.beginAction(new AbortController().signal)
  await source.facts.inputs.admit({ type: 'agent/input/admitted', version: 1, inputId: 'old-input', text: '/old-command', delivery: 'queue', intent: kind === 'old-human' ? 'user' : 'system', provenance: kind === 'old-human'
    ? { kind: 'human', authority: 'request', scope: 'turn', producer: 'session.prompt' }
    : { kind: kind === 'notification' ? 'child-report' : 'plugin', authority: 'observation', scope: 'turn', producer: kind === 'notification' ? 'session.notification' : 'session.schedule' } })
  source.finish()
  let transforms = 0
  const wire: string[] = []
  vi.stubGlobal('fetch', async (url: string, init: RequestInit) => { if (url !== 'https://generation.fixture.invalid/v1/chat/completions') throw new Error('Unexpected network destination'); wire.push(String(init.body)); return success() })
  const model = createOpenAICompatibleClient({ apiKey: 'fixture-only', model: 'fixture', baseUrl: 'https://generation.fixture.invalid' })
  const service = createSessionService({ workspace: root, coordinator, model, codeMode: { mode: 'off' }, transformPrompt: async () => { transforms++; return 'effectful expansion' } })
  try {
    await service.submit(id, '/old-command', new AbortController().signal, { admittedInputId: 'old-input' })
    expect(transforms).toBe(0)
    expect(wire).toHaveLength(1)
    expect(wire[0]).toContain('/old-command')
    expect(wire[0]).not.toContain('effectful expansion')
  } finally { await service.close().catch(() => {}); await coordinator.close().catch(() => {}) }
})
it('trusted retry/wait composition preserves an actual built-in mock source without a generic local bypass', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ih-generation-local-wrappers-'))
  const backend = createJsonlBackend(root), coordinator = createSessionCoordinator(backend, { lock: { enabled: true } })
  const { id } = await coordinator.create()
  let calls = 0
  vi.stubGlobal('fetch', async () => { calls++; throw new Error('Unexpected network destination') })
  const model = createWaitingGuard(createRetryingClient(createMockClient([{ role: 'assistant', text: 'local wrapped response' }]), resolveRetryPolicy({ mode: 'normal', maxRetries: 2 })), { firstResponseMs: 1000, progressMs: 1000 })
  const service = createSessionService({ workspace: root, coordinator, model, modelPolicy: 'test-mock', codeMode: { mode: 'off' } })
  try {
    await service.submit(id, 'synthetic local wrapped work', new AbortController().signal)
    expect(calls).toBe(0)
    const events = (await backend.read(id)).events
    expect(events.filter(event => event.type === 'context/action' && event.op === 'local-invocation')).toHaveLength(1)
    expect(events.filter(event => event.type === 'context/attempt')).toHaveLength(0)
  } finally { await service.close().catch(() => {}); await coordinator.close().catch(() => {}) }
})

it.each(['copied-prepared', 'generic-execute', 'skipping-wrapper'] as const)('refuses managed %s before its arbitrary callback or network handoff', async kind => {
  const root = await mkdtemp(join(tmpdir(), 'ih-generation-opaque-'))
  const backend = createJsonlBackend(root), coordinator = createSessionCoordinator(backend, { lock: { enabled: true } })
  const { id } = await coordinator.create()
  let calls = 0, arbitraryCallbacks = 0
  vi.stubGlobal('fetch', async (url: string) => { if (url !== 'https://opaque-generation.fixture.invalid/v1/chat/completions') throw new Error('Unexpected network destination'); calls++; return success() })
  const real = createOpenAICompatibleClient({ apiKey: 'fixture-only', model: 'fixture', baseUrl: 'https://opaque-generation.fixture.invalid' })
  async function* uncontrolled(): AsyncIterable<LLMStreamEvent> {
    arbitraryCallbacks++
    await fetch('https://opaque-generation.fixture.invalid/v1/chat/completions', { method: 'POST', body: '{}' })
    yield { type: 'text/chunk', text: 'uncontrolled' }; yield { type: 'end' }
  }
  const model: ModelClient = { stream: uncontrolled, async prepare(request) {
    const genuine = await prepareModelRequest(real, request)
    if (kind === 'copied-prepared') return { ...genuine, stream: uncontrolled }
    if (kind === 'skipping-wrapper') return wrapPreparedRequest(genuine, () => uncontrolled())
    return createPreparedPayload({ body: { model: 'fixture' }, request, describe: () => ({ input: genuine.measurement.input, packet: genuine.measurement.packet }), output: () => genuine.measurement.output, cap: body => body, execute: uncontrolled })
  } }
  const service = createSessionService({ workspace: root, coordinator, model, codeMode: { mode: 'off' } })
  try {
    await expect(service.submit(id, 'synthetic opaque work', new AbortController().signal)).rejects.toMatchObject({ code: 'GENERATION_UNSUPPORTED' })
    expect(arbitraryCallbacks).toBe(0)
    expect(calls).toBe(0)
    const events = (await backend.read(id)).events
    expect(events.filter(event => event.type === 'context/attempt' || event.type === 'model/exchange-accepted' || event.type === 'tool/dispatch')).toHaveLength(0)
  } finally { await service.close().catch(() => {}); await coordinator.close().catch(() => {}) }
})

it('explicit manual compaction owns one summary-only allowance of eight physical sends and opens no main action', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ih-generation-manual-'))
  const backend = createJsonlBackend(root), coordinator = createSessionCoordinator(backend, { lock: { enabled: true } })
  const { id } = await coordinator.create(), seed = createSession()
  for (let index = 0; index < 8; index++) append(seed, { type: 'user/message', text: `historical-${index} ${'x'.repeat(2000)}` })
  await coordinator.append(id, seed.events)
  let calls = 0
  vi.stubGlobal('fetch', async (url: string) => { if (url !== 'https://manual-generation.fixture.invalid/v1/chat/completions') throw new Error('Unexpected network destination'); calls++; return new Response('synthetic busy', { status: 503 }) })
  const model = createRetryingClient(createOpenAICompatibleClient({ apiKey: 'fixture-only', model: 'fixture', baseUrl: 'https://manual-generation.fixture.invalid' }), resolveRetryPolicy({ mode: 'normal', maxRetries: 10, backoff: { initialDelayMs: 1, maxDelayMs: 1, jitterRatio: 0 } }))
  const service = createSessionService({ workspace: root, coordinator, model, contextWindow: 100000, compact: { auto: true, prune: false }, codeMode: { mode: 'off' } })
  try {
    const assembly = await service.assemblyFor(id)
    await expect(assembly.compactNow()).rejects.toMatchObject({ code: 'GENERATION_EXHAUSTED' })
    expect(calls).toBe(8)
    const events = (await backend.read(id)).events
    expect(events.filter(event => event.type === 'context/action' && event.op === 'open').map(event => event.purpose)).toEqual(['manual'])
    expect(events.filter(event => event.type === 'context/attempt' && event.op === 'reserve').map(event => event.lane)).toEqual(['summary', 'summary', 'summary', 'summary', 'summary', 'summary', 'summary', 'summary'])
    expect(events.filter(event => event.type === 'step/start' || event.type === 'model/exchange-accepted')).toHaveLength(0)
  } finally { await service.close().catch(() => {}); await coordinator.close().catch(() => {}) }
})

it.each([[undefined, 30000], [8000, 8000]] as const)('post-turn title owns its actual retry pool and timeout %s independently of the accepted parent', async (timeoutMs, duration) => {
  const root = await mkdtemp(join(tmpdir(), 'ih-generation-title-'))
  const backend = createJsonlBackend(root), coordinator = createSessionCoordinator(backend, { lock: { enabled: true } })
  const { id } = await coordinator.create()
  const network: string[] = []
  let titles = 0
  vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
    if (url !== 'https://title-generation.fixture.invalid/v1/chat/completions') throw new Error('Unexpected network destination')
    const body = JSON.parse(String(init.body)), title = !body.tools?.length
    network.push(title ? 'title' : 'main')
    return title && ++titles < 3 ? new Response('synthetic busy', { status: 503 }) : success()
  })
  const model = createRetryingClient(createOpenAICompatibleClient({ apiKey: 'fixture-only', model: 'fixture', baseUrl: 'https://title-generation.fixture.invalid' }), resolveRetryPolicy({ mode: 'normal', maxRetries: 2, backoff: { initialDelayMs: 1, maxDelayMs: 1, jitterRatio: 0 } }))
  const service = createSessionService({ workspace: root, coordinator, model, codeMode: { mode: 'off' }, afterSuccessfulSubmit: async (_id, assembly, _limits, action) => {
    await maybeAutoTitle({ session: assembly.session, action, model: assembly.model, ...(timeoutMs === undefined ? {} : { timeoutMs }) })
  } })
  try {
    await service.submit(id, 'synthetic titled work', new AbortController().signal)
    expect(network).toEqual(['main', 'title', 'title', 'title'])
    const events = (await backend.read(id)).events
    const titleAction = events.find(event => event.type === 'context/action' && event.op === 'open' && event.purpose === 'title')
    expect(titleAction?.type === 'context/action' && titleAction.op === 'open' ? titleAction.expiresAt - titleAction.startedAt : undefined).toBe(duration)
    expect(events.filter(event => event.type === 'context/attempt' && event.op === 'reserve' && event.lane === 'auxiliary')).toHaveLength(3)
    expect(events.filter(event => event.type === 'model/exchange-accepted')).toHaveLength(1)
  } finally { await service.close().catch(() => {}); await coordinator.close().catch(() => {}) }
})
