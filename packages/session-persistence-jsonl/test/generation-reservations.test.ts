import { afterEach, expect, it, vi } from 'vitest'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createSessionCoordinator } from '@i-harness/session-persistence'
import { createJsonlBackend } from '../src/index.ts'
import { createGenerationLifecycle } from '../../session-executor/src/lifecycle/generation-actions.ts'
import { createOpenAICompatibleClient } from '../../llm-openai-compatible/src/index.ts'
import { createGenerationControl, createRetryingClient, generationCandidate, prepareModelRequest, resolveRetryPolicy, type GenerationReservation } from '../../llm-seam/src/index.ts'
import { readGenerationActions, type GenerationLane } from '@i-harness/core-session'

afterEach(() => vi.unstubAllGlobals())
it('actual owned HTTP unsent rebinds retain ordinal, invalidate old tickets and stop at three across the action', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ih-generation-rebind-')), backend = createJsonlBackend(root), coordinator = createSessionCoordinator(backend, { lock: { enabled: true } })
  const { id } = await coordinator.create(), document = await coordinator.openManagedDocument(id), source = document.beginAction(), lifecycle = createGenerationLifecycle(document.view, id, source)
  await source.facts.inputs.admit({ type: 'agent/input/admitted', version: 1, inputId: 'rebind', text: 'synthetic', delivery: 'queue', intent: 'user', provenance: { kind: 'human', authority: 'request', scope: 'turn', producer: 'fixture' } })
  const generation = await lifecycle.open('main', { kind: 'input', seq: 0 }), tickets: GenerationReservation[] = [], owned = generation.control('main')
  const observed = createGenerationControl({ signal: owned.signal, async reserve(candidate) { const ticket = await owned.reserve(candidate); tickets.push(ticket); return ticket } })
  let sends = 0
  vi.stubGlobal('fetch', async (url: string) => { if (url !== 'https://rebind-generation.fixture.invalid/v1/chat/completions') throw new Error('Unexpected network destination'); sends++; return new Response('data: {"choices":[{"delta":{"content":"completed"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n') })
  const model = createRetryingClient(createOpenAICompatibleClient({ apiKey: 'fixture-only', model: 'fixture', baseUrl: 'https://rebind-generation.fixture.invalid' }), resolveRetryPolicy({ mode: 'normal', maxRetries: 5, backoff: { initialDelayMs: 1, maxDelayMs: 1, jitterRatio: 0 } }))
  const base = await prepareModelRequest(model, { messages: [{ role: 'user', content: 'synthetic' }], tools: [], systemPrompt: '' })
  await generation.bind(base)
  const stale = Object.assign(new Error('known source rejection before handoff'), { code: 'CONTEXT_INPUT_STALE' })
  const run = async (cap: number, refuse: boolean) => { for await (const _event of base.withOutputCap(cap).stream({ generation: observed, ...(refuse ? { validateBeforeTransport() { throw stale } } : {}) })) {} }
  try {
    for (const cap of [99, 100, 101]) await expect(run(cap, true)).rejects.toBe(stale)
    expect(sends).toBe(0)
    await run(102, false)
    expect(sends).toBe(1)
    const first = generationCandidate(base.withOutputCap(99).measurement)
    if (first.payloadKind !== 'http-json-body') throw new Error('Expected HTTP candidate')
    expect(() => tickets[0]!.issue({ version: 1, ...first, payloadKind: first.payloadKind, sendId: 'old-ticket' })).toThrow(expect.objectContaining({ code: 'GENERATION_STALE' }))
    await expect(run(103, true)).rejects.toBe(stale)
    await expect(run(104, false)).rejects.toMatchObject({ code: 'GENERATION_EXHAUSTED' })
    expect(sends).toBe(1)
    const events = (await backend.read(id)).events
    expect(events.filter(event => event.type === 'context/attempt' && event.op === 'reserve').map(event => event.ordinal)).toEqual([1, 2])
    expect(events.filter(event => event.type === 'context/attempt' && event.op === 'rebind').map(event => event.rebind)).toEqual([1, 2, 3])
  } finally { await generation.close('failed'); await lifecycle.drain(); source.finish(); await coordinator.close().catch(() => {}) }
})
it('a cold unresolved reservation cannot grant a fresh send or recreate private unsent proof', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ih-generation-unresolved-')), backend = createJsonlBackend(root)
  const first = createSessionCoordinator(backend, { lock: { enabled: true } }), { id } = await first.create(), document = await first.openManagedDocument(id)
  const source = document.beginAction(), lifecycle = createGenerationLifecycle(document.view, id, source)
  await source.facts.inputs.admit({ type: 'agent/input/admitted', version: 1, inputId: 'crash-input', text: 'synthetic', delivery: 'queue', intent: 'user', provenance: { kind: 'human', authority: 'request', scope: 'turn', producer: 'fixture' } })
  const client = createRetryingClient(createOpenAICompatibleClient({ apiKey: 'fixture-only', model: 'fixture', baseUrl: 'https://unresolved-generation.fixture.invalid' }), resolveRetryPolicy({ mode: 'normal', maxRetries: 1, backoff: { initialDelayMs: 1, maxDelayMs: 1, jitterRatio: 0 } }))
  const prepared = await prepareModelRequest(client, { systemPrompt: '', messages: [{ role: 'user', content: 'synthetic' }], tools: [] })
  const origin = { kind: 'input' as const, seq: 0 }, original = await lifecycle.open('main', origin)
  await original.bind(prepared)
  await original.control('main').reserve(generationCandidate(prepared.measurement))
  await lifecycle.drain(); source.finish(); await first.close()
  let calls = 0
  vi.stubGlobal('fetch', async (url: string) => { if (url !== 'https://unresolved-generation.fixture.invalid/v1/chat/completions') throw new Error('Unexpected network destination'); calls++; return new Response('synthetic busy', { status: 503 }) })
  const next = createSessionCoordinator(backend, { lock: { enabled: true } }), cold = await next.openManagedDocument(id), action = cold.beginAction(), resumed = createGenerationLifecycle(cold.view, id, action)
  expect(action.owner?.incarnation).not.toBe(source.owner?.incarnation)
  const generation = await resumed.open('main', origin)
  try {
    await generation.bind(prepared)
    const failure = await (async () => { for await (const _event of prepared.stream({ generation: generation.control('main') })) {} })().catch(error => error)
    expect(calls).toBe(0)
    expect(failure).toMatchObject({ code: 'GENERATION_UNCERTAIN' })
    expect((await backend.read(id)).events.filter(event => event.type === 'context/attempt' && event.op === 'reserve')).toHaveLength(1)
  } finally { await generation.close('failed'); await resumed.drain(); action.finish(); await next.close().catch(() => {}) }
})
it('lower main policy and earlier original-start deadline survive higher settings and a cold reopen; a small summary policy does not shrink the main pool', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ih-generation-lower-')), backend = createJsonlBackend(root)
  let coordinator = createSessionCoordinator(backend, { lock: { enabled: true } })
  const { id } = await coordinator.create(), document = await coordinator.openManagedDocument(id)
  const action = document.beginAction(), lifecycle = createGenerationLifecycle(document.view, id, action)
  await action.facts.inputs.admit({ type: 'agent/input/admitted', version: 1, inputId: 'lower-input', text: 'synthetic', delivery: 'queue', intent: 'user', provenance: { kind: 'human', authority: 'request', scope: 'turn', producer: 'fixture' } })
  const origin = { kind: 'input' as const, seq: 0 }, generation = await lifecycle.open('main', origin)
  let calls = 0
  vi.stubGlobal('fetch', async (url: string) => { if (url !== 'https://lower-generation.fixture.invalid/v1/chat/completions') throw new Error('Unexpected network destination'); calls++; return new Response('synthetic busy', { status: 503 }) })
  const base = createOpenAICompatibleClient({ apiKey: 'fixture-only', model: 'fixture', baseUrl: 'https://lower-generation.fixture.invalid' })
  const prepare = (maxRetries: number) => prepareModelRequest(createRetryingClient(base, resolveRetryPolicy({ mode: 'normal', maxRetries, backoff: { initialDelayMs: 1, maxDelayMs: 1, jitterRatio: 0 } })), { systemPrompt: '', messages: [{ role: 'user', content: 'synthetic' }], tools: [] })
  const high = await prepare(5), low = await prepare(0)
  const send = async (owned: typeof generation, prepared = high) => { for await (const _event of prepared.stream({ generation: owned.control('main') })) {} }
  await generation.bind(high)
  await generation.bind(low, 'summary')
  await expect(send(generation)).rejects.toMatchObject({ code: 'SERVER' })
  expect(calls).toBe(6)
  await generation.bind(low)
  await expect(send(generation)).rejects.toMatchObject({ code: 'GENERATION_EXHAUSTED' })
  const constrained = await lifecycle.open('main', origin, { timeoutMs: 5000, maxAttempts: 3 })
  await constrained.bind(high)
  await lifecycle.drain(); action.finish(); await coordinator.close()
  coordinator = createSessionCoordinator(backend, { lock: { enabled: true } })
  const cold = await coordinator.openManagedDocument(id), nextSource = cold.beginAction(), next = createGenerationLifecycle(cold.view, id, nextSource)
  const reopened = await next.open('main', origin, { timeoutMs: 3_600_000, maxAttempts: 20 })
  try {
    await reopened.bind(high)
    await expect(send(reopened)).rejects.toMatchObject({ code: 'GENERATION_EXHAUSTED' })
    expect(calls).toBe(6)
    const [state] = readGenerationActions(cold.view.events)
    expect(state?.limits).toEqual({ total: 3, main: 1, recovery: 1, summary: 8 })
    expect(state!.expiresAt - state!.opened.startedAt).toBe(5000)
    expect(state!.attempts).toHaveLength(6)
  } finally { await reopened.close('failed'); await next.drain(); nextSource.finish(); await coordinator.close().catch(() => {}) }
})
it('upgrades the actual format7 predecessor through its existing writable owner without inventing attempt history', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ih-generation-upgrade7-')), backend = createJsonlBackend(root)
  const first = createSessionCoordinator(backend, { lock: { enabled: true } })
  const { id } = await first.create()
  await first.close()
  const path = join(root, `${id}.jsonl`), lines = (await readFile(path, 'utf8')).split('\n'), header = JSON.parse(lines[0]!)
  await writeFile(path, [JSON.stringify({ ...header, formatVersion: 7 }), ...lines.slice(1)].join('\n'))
  const next = createSessionCoordinator(backend, { lock: { enabled: true } })
  try {
    const document = await next.openManagedDocument(id)
    expect(document.view.formatVersion).toBe(9)
    expect(document.view.events).toEqual([])
    expect((await backend.read(id)).version).toBe(9)
  } finally { await next.close().catch(() => {}) }
})
it.each([20, 9])('the existing journal owns the literal physical trace with total cap %s', async cap => {
  const root = await mkdtemp(join(tmpdir(), 'ih-generation-journal-'))
  const backend = createJsonlBackend(root), coordinator = createSessionCoordinator(backend, { lock: { enabled: true } })
  const { id } = await coordinator.create(), document = await coordinator.openManagedDocument(id)
  const action = document.beginAction(), lifecycle = createGenerationLifecycle(document.view, id, action)
  const received = await action.facts.inputs.admit({ type: 'agent/input/admitted', version: 1, inputId: 'input', text: 'synthetic', delivery: 'queue', intent: 'user', provenance: { kind: 'human', authority: 'request', scope: 'turn', producer: 'fixture' } })
  expect(received.kind).toBe('committed')
  const generation = await lifecycle.open('main', { kind: 'input', seq: 0 }, { maxAttempts: cap })
  let lane: GenerationLane = 'main'
  const networkCalls: { lane: GenerationLane }[] = []
  vi.stubGlobal('fetch', async (url: string) => { if (url !== 'https://journal-generation.fixture.invalid/v1/chat/completions') throw new Error('Unexpected network destination'); networkCalls.push({ lane }); return new Response('synthetic busy', { status: 503 }) })
  const client = createRetryingClient(createOpenAICompatibleClient({ apiKey: 'fixture-only', model: 'fixture', baseUrl: 'https://journal-generation.fixture.invalid' }), resolveRetryPolicy({ mode: 'normal', maxRetries: 5, backoff: { initialDelayMs: 1, maxDelayMs: 1, jitterRatio: 0 } }))
  const prepared = await prepareModelRequest(client, { systemPrompt: '', messages: [{ role: 'user', content: 'synthetic' }], tools: [] })
  await generation.bind(prepared)
  const send = async (next: GenerationLane) => { lane = next; for await (const _event of prepared.stream({ generation: generation.control(next) })) {} }
  try {
    await expect(send('main')).rejects.toMatchObject({ code: 'SERVER' })
    expect(networkCalls).toHaveLength(6)
    if (cap === 9) {
      await expect(send('summary')).rejects.toMatchObject({ code: 'GENERATION_EXHAUSTED' })
      expect(networkCalls.map(call => call.lane)).toEqual(['main', 'main', 'main', 'main', 'main', 'main', 'summary', 'summary', 'summary'])
    } else {
      await expect(send('summary')).rejects.toMatchObject({ code: 'SERVER' })
      await expect(send('summary')).rejects.toMatchObject({ code: 'GENERATION_EXHAUSTED' })
      await generation.phase({ type: 'context/recovery', version: 1, ownerSessionId: id, recoveryId: 'recovery', logicalStepSeq: 0, bindingFingerprint: 'a'.repeat(64), rejectedInputFingerprint: 'b'.repeat(64), state: 'retry-started', retryConsumed: true })
      await expect(send('recovery')).rejects.toMatchObject({ code: 'SERVER' })
      expect(networkCalls.map(call => call.lane)).toEqual([
        'main', 'main', 'main', 'main', 'main', 'main',
        'summary', 'summary', 'summary', 'summary', 'summary', 'summary', 'summary', 'summary',
        'recovery', 'recovery', 'recovery', 'recovery', 'recovery', 'recovery',
      ])
      await expect(send('recovery')).rejects.toMatchObject({ code: 'GENERATION_EXHAUSTED' })
    }
    expect(networkCalls).toHaveLength(cap)
    const events = (await backend.read(id)).events
    const reservations = events.filter(event => event.type === 'context/attempt' && event.op === 'reserve')
    expect(reservations).toHaveLength(cap)
    expect(new Set(reservations.map(event => event.attemptId)).size).toBe(cap)
    expect(Object.isFrozen(action.owner)).toBe(true)
    if (received.kind !== 'committed') throw new Error('Expected actual F1 receipt')
    expect(reservations.map(event => event.incarnation)).toEqual(Array(cap).fill(received.receipt.owner.incarnation))
    expect(events.filter(event => event.type === 'model/exchange-accepted' || event.type === 'tool/dispatch')).toHaveLength(0)
  } finally { await generation.close('failed'); await lifecycle.drain(); action.finish(); await coordinator.close().catch(() => {}) }
})

it('local-test binding rejects a spoofed client and cannot switch its frozen domain through a stable selection', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ih-local-domain-')), backend = createJsonlBackend(root), coordinator = createSessionCoordinator(backend, { lock: { enabled: true } })
  const { id } = await coordinator.create(), document = await coordinator.openManagedDocument(id), source = document.beginAction()
  let network = 0, arbitrary = 0
  vi.stubGlobal('fetch', async () => { network++; throw new Error('Unexpected network destination') })
  const { createMockClient } = await import('../../llm-mock/src/index.ts'), { createStableModelClient } = await import('../../llm-seam/src/index.ts')
  const mock = createMockClient([{ role: 'assistant', text: 'local' }]), spoof = { async *stream() { arbitrary++; yield { type: 'end' as const } }, prepare: mock.prepare }
  let selected: import("../../llm-seam/src/index.ts").ModelClient = spoof
  const stable = createStableModelClient(() => selected), lifecycle = createGenerationLifecycle(document.view, id, source, { enabled: true, selectedClient: () => stable })
  await source.facts.inputs.admit({ type: 'agent/input/admitted', version: 1, inputId: 'local-domain', text: 'literal input', delivery: 'queue', intent: 'user', provenance: { kind: 'human', authority: 'request', scope: 'turn', producer: 'fixture' } })
  const generation = await lifecycle.open('main', { kind: 'input', seq: 0 }), request = { messages: [{ role: 'user' as const, content: 'literal input' }], tools: [], systemPrompt: '' }
  const local = await prepareModelRequest(stable, request)
  try {
    await expect(generation.bind(local)).rejects.toMatchObject({ code: 'GENERATION_UNSUPPORTED' })
    selected = mock
    await generation.bind(await prepareModelRequest(stable, request))
    selected = createOpenAICompatibleClient({ apiKey: 'fixture-only', model: 'fixture', baseUrl: 'https://local-domain.fixture.invalid' })
    const physical = await prepareModelRequest(stable, request)
    await expect(generation.bind(physical)).rejects.toMatchObject({ code: 'GENERATION_UNSUPPORTED' })
    await expect(generation.bind(local)).rejects.toMatchObject({ code: 'GENERATION_UNSUPPORTED' })
    expect([arbitrary, network]).toEqual([0, 0])
    expect(document.view.events.filter(event => event.type === 'context/action' && event.op === 'bind')).toEqual([expect.objectContaining({ executionDomain: 'local-test' })])
    expect(document.view.events.filter(event => event.type === 'context/attempt' || event.type === 'context/action' && event.op === 'local-invocation')).toHaveLength(0)
  } finally { await generation.close('failed'); await lifecycle.drain(); source.finish(); await coordinator.close().catch(() => {}) }
})

it('committed local invocations consume the finite lane across cold reopen with literal zero network', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ih-local-cold-')), backend = createJsonlBackend(root)
  let network = 0
  vi.stubGlobal('fetch', async () => { network++; throw new Error('Unexpected network destination') })
  const { createMockClient } = await import('../../llm-mock/src/index.ts')
  const raw = createMockClient([{ role: 'assistant', text: 'one' }, { role: 'assistant', text: 'must not consume second' }])
  const { mapModelRequest, createWaitingGuard } = await import('../../llm-seam/src/index.ts')
  const model = mapModelRequest(createWaitingGuard(createRetryingClient(raw, resolveRetryPolicy({ mode: 'normal', maxRetries: 0 })), { firstResponseMs: 1000, progressMs: 1000 }), request => ({ ...request, systemPrompt: 'mapped local fixture' }))
  const request = { messages: [{ role: 'user' as const, content: 'literal input' }], tools: [], systemPrompt: '' }, prepared = (await prepareModelRequest(model, request)).withOutputCap(100)
  const first = createSessionCoordinator(backend, { lock: { enabled: true } }), { id } = await first.create(), document = await first.openManagedDocument(id), source = document.beginAction()
  const lifecycle = createGenerationLifecycle(document.view, id, source, { enabled: true, selectedClient: () => model })
  await source.facts.inputs.admit({ type: 'agent/input/admitted', version: 1, inputId: 'local-cold', text: 'literal input', delivery: 'queue', intent: 'user', provenance: { kind: 'human', authority: 'request', scope: 'turn', producer: 'fixture' } })
  const generation = await lifecycle.open('main', { kind: 'input', seq: 0 })
  await generation.bind(prepared)
  for await (const _event of prepared.stream({ generation: generation.control('main') })) {}
  await lifecycle.drain(); source.finish(); await first.close()
  const next = createSessionCoordinator(backend, { lock: { enabled: true } }), cold = await next.openManagedDocument(id), action = cold.beginAction()
  const resumed = createGenerationLifecycle(cold.view, id, action, { enabled: true, selectedClient: () => model }), owned = await resumed.open('main', { kind: 'input', seq: 0 })
  try {
    await owned.bind(prepared)
    await expect((async () => { for await (const _event of prepared.stream({ generation: owned.control('main') })) {} })()).rejects.toMatchObject({ code: 'GENERATION_EXHAUSTED' })
    expect(network).toBe(0)
    const events = (await backend.read(id)).events
    expect(events.filter(event => event.type === 'context/action' && event.op === 'local-invocation')).toHaveLength(1)
    expect(events.filter(event => event.type === 'context/attempt' || event.type === 'model/exchange-accepted')).toHaveLength(0)
  } finally { await owned.close('failed'); await resumed.drain(); action.finish(); await next.close().catch(() => {}) }
})

it.each(['copy', 'replacement', 'foreign', 'skipping-wrapper'] as const)('managed local binding refuses a %s prepared object attached to an actual built-in mock', async kind => {
  const root = await mkdtemp(join(tmpdir(), 'ih-local-prepared-')), backend = createJsonlBackend(root), coordinator = createSessionCoordinator(backend, { lock: { enabled: true } })
  const { id } = await coordinator.create(), document = await coordinator.openManagedDocument(id), source = document.beginAction()
  let callbacks = 0, network = 0
  vi.stubGlobal('fetch', async () => { network++; throw new Error('Unexpected network destination') })
  const { createMockClient } = await import('../../llm-mock/src/index.ts'), { wrapPreparedRequest } = await import('../../llm-seam/src/index.ts')
  const original = createMockClient([{ role: 'assistant', text: 'original' }]), selected = kind === 'foreign' ? createMockClient([{ role: 'assistant', text: 'foreign' }]) : original
  const request = { messages: [], tools: [], systemPrompt: '' }, genuine = await prepareModelRequest(original, request)
  async function* arbitrary() { callbacks++; yield { type: 'end' as const } }
  selected.prepare = async () => kind === 'skipping-wrapper' ? wrapPreparedRequest(genuine, arbitrary) : { ...genuine, ...(kind === 'replacement' ? { stream: arbitrary } : {}) }
  const lifecycle = createGenerationLifecycle(document.view, id, source, { enabled: true, selectedClient: () => selected })
  await source.facts.inputs.admit({ type: 'agent/input/admitted', version: 1, inputId: 'local-forged', text: 'literal input', delivery: 'queue', intent: 'user', provenance: { kind: 'human', authority: 'request', scope: 'turn', producer: 'fixture' } })
  const generation = await lifecycle.open('main', { kind: 'input', seq: 0 })
  try {
    await expect(generation.bind(await prepareModelRequest(selected, request))).rejects.toMatchObject({ code: 'GENERATION_UNSUPPORTED' })
    expect([callbacks, network]).toEqual([0, 0])
    expect(document.view.events.filter(event => event.type === 'context/attempt' || event.type === 'context/action' && ['bind', 'local-invocation'].includes(event.op))).toHaveLength(0)
  } finally { await generation.close('failed'); await lifecycle.drain(); source.finish(); await coordinator.close().catch(() => {}) }
})

it.each(['deadline', 'invalid-clock'] as const)('the actual HTTP owner retains issued settlements but cannot send after its original %s fence', async fence => {
  const root = await mkdtemp(join(tmpdir(), 'ih-generation-clock-')), backend = createJsonlBackend(root), coordinator = createSessionCoordinator(backend, { lock: { enabled: true } })
  const { id } = await coordinator.create(), document = await coordinator.openManagedDocument(id), source = document.beginAction()
  let monotonic = 10, calls = 0
  vi.spyOn(performance, 'now').mockImplementation(() => monotonic)
  vi.stubGlobal('fetch', async (url: string) => {
    if (url !== 'https://clock-generation.fixture.invalid/v1/chat/completions') throw new Error('Unexpected network destination')
    calls++
    monotonic = fence === 'invalid-clock' ? Number.NaN : calls === 1 ? 3_599_010 : 3_600_010
    return new Response('synthetic server failure', { status: 503 })
  })
  const lifecycle = createGenerationLifecycle(document.view, id, source), wall = Date.now()
  await source.facts.inputs.admit({ type: 'agent/input/admitted', version: 1, inputId: 'clock-input', text: 'literal input', delivery: 'queue', intent: 'user', provenance: { kind: 'human', authority: 'request', scope: 'turn', producer: 'fixture' } })
  const generation = await lifecycle.open('main', { kind: 'input', seq: 0 }, { start: { wall, monotonic: 10 } })
  const model = createRetryingClient(createOpenAICompatibleClient({ apiKey: 'fixture-only', model: 'fixture', baseUrl: 'https://clock-generation.fixture.invalid' }), resolveRetryPolicy({ mode: 'normal', maxRetries: 1, backoff: { initialDelayMs: 1, maxDelayMs: 1, jitterRatio: 0 } }))
  const prepared = await prepareModelRequest(model, { messages: [], tools: [], systemPrompt: '' })
  await generation.bind(prepared)
  const send = async (lane: GenerationLane) => { for await (const _event of prepared.stream({ generation: generation.control(lane) })) {} }
  try {
    await expect(send('main')).rejects.toThrow()
    await expect(send('summary')).rejects.toMatchObject({ code: fence === 'deadline' ? 'GENERATION_EXPIRED' : 'GENERATION_CLOCK_INVALID' })
    expect(calls).toBe(fence === 'deadline' ? 2 : 1)
    const events = (await backend.read(id)).events, reserves = events.filter(event => event.type === 'context/attempt' && event.op === 'reserve')
    expect(reserves).toHaveLength(calls)
    expect(events.filter(event => event.type === 'context/attempt' && event.op === 'settle')).toHaveLength(calls)
    expect(events.filter(event => event.type === 'context/action' && event.op === 'open')).toHaveLength(1)
  } finally { await generation.close('failed'); await lifecycle.drain(); source.finish(); vi.restoreAllMocks(); await coordinator.close().catch(() => {}) }
})
