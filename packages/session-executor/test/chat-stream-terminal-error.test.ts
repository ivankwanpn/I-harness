import { expect, it, vi } from 'vitest'
import { createServer, type ServerResponse } from 'node:http'
import { mkdtemp, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { createSessionCoordinator } from '@i-harness/session-persistence'
import { createJsonlBackend } from '@i-harness/session-persistence-jsonl'
import { createTelemetry, type TelemetryEvent } from '@i-harness/telemetry'
import { SettingsStore } from '@i-harness/settings'
import { createProviderRegistry } from '../../provider/src/index.ts'
import { createProviderRuntime } from '../../provider-runtime/src/index.ts'
import type { CredentialStore } from '../../credentials/src/index.ts'
import { createSessionService } from '../src/index.ts'
import { rmWorkspaceSync } from './helpers.ts'
import * as chatUsage from '../../llm-openai-compatible/src/stream/usage.ts'

const frame = (value: unknown) => `data: ${JSON.stringify(value)}\n\n`
const failure = { error: { message: 'Fixture temporary server error private-fixture-9182', type: 'server_error', code: 'server_error' } }
const partial = frame({ choices: [{ delta: { content: 'unaccepted partial', tool_calls: [{ index: 0, id: 'failed-call', function: { name: 'effect', arguments: '{}' } }] } }] })
const success = frame({ choices: [{ delta: { content: 'follow-up succeeded' }, finish_reason: 'stop' }], usage: { prompt_tokens: 30, completion_tokens: 4 } }) + 'data: [DONE]\n\n'

async function fixture(answer: (response: ServerResponse, ordinal: number) => void, options: { retries?: number; cap?: number } = {}) {
  // A short controlled path also keeps Windows named-pipe/SQLite paths bounded.
  const base = process.env.IH_CONFIG_DIR
  if (!base) throw new Error('Connected fixture requires a controlled IH_CONFIG_DIR')
  await mkdir(base, { recursive: true })
  const root = await mkdtemp(join(base, 'chat-'))
  const bodies: string[] = [], events: TelemetryEvent[] = []
  const usageOwners: { attemptId?: string; physicalAttemptId?: string }[] = []
  const server = createServer(async (request, response) => {
    let body = ''; for await (const chunk of request) body += chunk
    bodies.push(body)
    if (request.method !== 'POST' || request.url !== '/v1/chat/completions') { response.writeHead(404); response.end(); return }
    response.writeHead(200, { 'content-type': 'text/event-stream' })
    answer(response, bodies.length)
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Missing localhost listener')
  const settings = new SettingsStore({ path: join(root, 'settings.json') })
  await settings.load()
  await settings.set({ llm: { defaultModel: { provider: 'fixture', model: 'fixture' }, providers: { fixture: { protocol: 'openai-completions', apiKeyEnv: 'LOCAL_FIXTURE', baseURL: `http://127.0.0.1:${address.port}`, models: [{ id: 'fixture', contextWindow: 100000, maxTokens: 1024 }] } } } })
  // Credential input is deliberately in-memory; never consult host credentials.
  const credentials: CredentialStore = {
    resolve: ref => ref === 'LOCAL_FIXTURE' ? 'local-fixture-only' : undefined,
    describe: refs => Object.fromEntries(refs.map(ref => [ref, { configured: ref === 'LOCAL_FIXTURE', source: 'file', writable: false }])),
    async set() { throw new Error('Fixture credentials are immutable') }, async unset() { throw new Error('Fixture credentials are immutable') },
  }
  const registry = createProviderRegistry()
  registry.register({ name: 'fixture', displayName: 'fixture', protocol: 'openai-compatible', retryPolicy: { mode: 'normal', maxRetries: options.retries ?? 0, backoff: { initialDelayMs: 1, maxDelayMs: 1, jitterRatio: 0 } } })
  const runtime = createProviderRuntime({ settings, credentials, registry })
  const resolved = await runtime.resolveModel({ sessionSelection: { provider: 'fixture', model: 'fixture' } })
  if (resolved.status !== 'ready') throw new Error(`Fixture binding failed: ${resolved.status}`)
  const model = resolved.binding.client
  const backend = createJsonlBackend(join(root, 'sessions')), coordinator = createSessionCoordinator(backend, { lock: { enabled: true } })
  const { id } = await coordinator.create()
  let effects = 0
  const service = createSessionService({ workspace: root, coordinator, model, telemetry: createTelemetry([{ onEvent(event) {
    events.push(event)
    if (event.type === 'provider/usage') {
      const facts = service.liveSession(id)!.events
      const step = facts.findLast(event => event.type === 'step/start')
      const physical = facts.findLast(event => event.type === 'context/attempt' && event.op === 'reserve')
      usageOwners.push({ attemptId: step?.type === 'step/start' ? step.attemptId : undefined, physicalAttemptId: physical?.type === 'context/attempt' ? physical.attemptId : undefined })
    }
  } }]),
    contextWindow: resolved.binding.contextWindow, maxOutputTokens: resolved.binding.maxOutputTokens, codeMode: { mode: 'off' }, approveAll: true, sandbox: 'danger-full-access',
    ...(options.cap ? { modelActionMaxAttempts: options.cap } : {}),
    additionalTools: [{ name: 'effect', description: 'Bounded controlled effect counter', inputSchema: { type: 'object', properties: {} }, async execute() { effects++; return { effects } } }],
  })
  return { service, id, bodies, events, usageOwners, effects: () => effects,
    facts: async () => (await backend.read(id)).events,
    async close() { await service.close(); await coordinator.close(); server.closeAllConnections(); await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); rmWorkspaceSync(root) },
  }
}

it.each(['before-done', 'after-done', 'after-eof', 'after-residual'] as const)('actual localhost %s failure has no accepted effects/calibration and the same session progresses', async scenario => {
  const hasPartial = scenario !== 'before-done'
  const failedWire = (hasPartial ? partial : '') + frame({ usage: { prompt_tokens: 12 } }) + frame({ ...failure, usage: { completion_tokens: 3 } }).trimEnd()
    + (scenario === 'after-residual' ? '' : '\n\n') + (scenario.endsWith('done') ? 'data: [DONE]\n\n' : '')
  const f = await fixture((response, ordinal) => response.end(ordinal === 1 ? failedWire : success))
  try {
    const assembly = await f.service.assemblyFor(f.id)
    await expect(f.service.submit(f.id, 'fail safely', new AbortController().signal)).rejects.toThrow()
    expect(f.bodies).toHaveLength(1)
    expect(f.effects()).toBe(0)
    const failedFacts = await f.facts()
    expect(failedFacts.filter(event => event.type === 'model/exchange-accepted' || event.type === 'tool/dispatch' || event.type === 'context/usage')).toEqual([])
    expect(failedFacts.filter(event => event.type === 'tool/call')).toHaveLength(hasPartial ? 1 : 0)
    expect(failedFacts.filter(event => event.type === 'step/failed')).toHaveLength(1)
    expect(failedFacts.filter(event => event.type === 'context/attempt' && event.op === 'reserve').map(event => event.ordinal)).toEqual([1])
    expect(failedFacts.filter(event => event.type === 'context/attempt' && event.op === 'settle').map(event => event.disposition)).toEqual(['failed'])
    expect(f.events.filter(event => event.type === 'provider/usage').map(event => event.data)).toEqual([{ inputTokens: 12, inputTokenSemantics: 'includes-cache', outputTokens: 3 }])
    expect(f.events.filter(event => event.type === 'session/error')).toHaveLength(1)
    expect(JSON.stringify(f.events)).not.toContain('private-fixture-9182')
    await expect(f.service.submit(f.id, 'valid follow-up', new AbortController().signal)).resolves.toBeUndefined()
    expect(f.service.liveAssembly(f.id)).toBe(assembly)
    expect(f.bodies).toHaveLength(2)
    expect(f.bodies[1]).not.toContain('failed-call')
    expect(f.bodies[1]).not.toContain('unaccepted partial')
    expect(f.effects()).toBe(0)
    const finalFacts = await f.facts()
    expect(finalFacts.filter(event => event.type === 'model/exchange-accepted')).toHaveLength(1)
    expect(finalFacts.filter(event => event.type === 'context/usage' && event.version === 2 && event.op === 'sample')).toHaveLength(1)
    expect(finalFacts.filter(event => event.type === 'context/attempt' && event.op === 'settle').map(event => event.disposition)).toEqual(['failed', 'completed'])
  } finally { await f.close() }
})

it('retries a real pre-output failure under explicit discard and charges both sends', async () => {
  const f = await fixture((response, ordinal) => response.end(ordinal === 1 ? frame({ ...failure, usage: { prompt_tokens: 12, completion_tokens: 3 } }) : success), { retries: 1 })
  try {
    await f.service.submit(f.id, 'bounded retry', new AbortController().signal)
    expect(f.bodies).toHaveLength(2)
    const facts = await f.facts()
    expect(facts.filter(event => event.type === 'context/attempt' && event.op === 'reserve').map(event => event.ordinal)).toEqual([1, 2])
    expect(facts.filter(event => event.type === 'context/attempt' && event.op === 'settle').map(event => event.disposition)).toEqual(['failed', 'completed'])
    expect(facts.filter(event => event.type === 'model/exchange-accepted')).toHaveLength(1)
    expect(facts.filter(event => event.type === 'model/retry' && event.retry.phase === 'waiting')).toHaveLength(1)
    expect(f.effects()).toBe(0)
    expect(f.bodies[1]).not.toContain('failed-call')
    const stepIds = facts.filter(event => event.type === 'step/start').map(event => event.attemptId)
    const physicalIds = facts.filter(event => event.type === 'context/attempt' && event.op === 'reserve').map(event => event.attemptId)
    expect(f.usageOwners).toEqual([{ attemptId: stepIds[0], physicalAttemptId: physicalIds[0] }, { attemptId: stepIds[1], physicalAttemptId: physicalIds[1] }])
    expect(stepIds[0]).not.toBe(stepIds[1])
    expect(f.events.filter(event => event.type === 'provider/usage').map(event => event.data)).toEqual([
      { inputTokens: 12, inputTokenSemantics: 'includes-cache', outputTokens: 3 },
      { inputTokens: 30, inputTokenSemantics: 'includes-cache', outputTokens: 4 },
    ])
    expect(facts.filter(event => event.type === 'context/usage' && event.version === 2 && event.op === 'sample')).toHaveLength(1)
  } finally { await f.close() }
})

it('the existing candidate guard blocks automatic partial-output replay, retains its failed debit, and allows a new submit', async () => {
  const f = await fixture((response, ordinal) => response.end(ordinal === 1 ? partial + frame({ ...failure, usage: { prompt_tokens: 12, completion_tokens: 3 } }) : success), { retries: 1 })
  try {
    const assembly = await f.service.assemblyFor(f.id)
    await expect(f.service.submit(f.id, 'partial retry guard', new AbortController().signal)).rejects.toMatchObject({ code: 'CONTEXT_INPUT_STALE' })
    expect(f.bodies).toHaveLength(1)
    const facts = await f.facts()
    expect(facts.filter(event => event.type === 'context/attempt' && event.op === 'settle').map(event => event.disposition)).toEqual(['failed', 'unsent'])
    expect(facts.filter(event => event.type === 'model/exchange-accepted' || event.type === 'tool/dispatch' || event.type === 'context/usage')).toEqual([])
    expect(f.effects()).toBe(0)
    expect(f.events.filter(event => event.type === 'provider/usage').map(event => event.data)).toEqual([{ inputTokens: 12, inputTokenSemantics: 'includes-cache', outputTokens: 3 }])
    await expect(f.service.submit(f.id, 'new submit after guarded retry', new AbortController().signal)).resolves.toBeUndefined()
    expect(f.service.liveAssembly(f.id)).toBe(assembly)
    expect(f.bodies).toHaveLength(2)
    expect(f.bodies[1]).not.toContain('failed-call')
    expect(f.effects()).toBe(0)
    expect((await f.facts()).filter(event => event.type === 'model/exchange-accepted')).toHaveLength(1)
  } finally { await f.close() }
})

it('the same real tool dispatcher can execute an accepted call and keeps normal usage separate', async () => {
  const tool = frame({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'accepted-call', function: { name: 'effect', arguments: '{}' } }] }, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 12, completion_tokens: 3 } }) + 'data: [DONE]\n\n'
  const f = await fixture((response, ordinal) => response.end(ordinal === 1 ? tool : success), { retries: 1 })
  try {
    await f.service.submit(f.id, 'positive effect control', new AbortController().signal)
    expect(f.effects()).toBe(1)
    expect(f.bodies).toHaveLength(2)
    const facts = await f.facts()
    expect(facts.filter(event => event.type === 'tool/dispatch')).toHaveLength(1)
    expect(facts.filter(event => event.type === 'model/exchange-accepted')).toHaveLength(2)
    expect(facts.filter(event => event.type === 'context/usage' && event.version === 2 && event.op === 'sample')).toHaveLength(2)
    expect(facts.filter(event => event.type === 'step/failed')).toHaveLength(0)
    expect(f.events.filter(event => event.type === 'provider/usage').map(event => event.data)).toEqual([
      { inputTokens: 12, inputTokenSemantics: 'includes-cache', outputTokens: 3 },
      { inputTokens: 30, inputTokenSemantics: 'includes-cache', outputTokens: 4 },
    ])
  } finally { await f.close() }
})

it('preserves each failed attempt usage when the configured retry allowance ends', async () => {
  const f = await fixture(response => response.end(frame({ ...failure, usage: { prompt_tokens: 12, completion_tokens: 3 } })), { retries: 1 })
  try {
    await expect(f.service.submit(f.id, 'bounded failures', new AbortController().signal)).rejects.toMatchObject({ code: 'SERVER' })
    expect(f.bodies).toHaveLength(2)
    const facts = await f.facts()
    expect(facts.filter(event => event.type === 'context/attempt' && event.op === 'reserve').map(event => event.ordinal)).toEqual([1, 2])
    expect(facts.filter(event => event.type === 'context/attempt' && event.op === 'settle').map(event => event.disposition)).toEqual(['failed', 'failed'])
    expect(f.events.filter(event => event.type === 'provider/usage').map(event => event.data)).toEqual([
      { inputTokens: 12, inputTokenSemantics: 'includes-cache', outputTokens: 3 },
      { inputTokens: 12, inputTokenSemantics: 'includes-cache', outputTokens: 3 },
    ])
    expect(facts.filter(event => event.type === 'model/exchange-accepted' || event.type === 'context/usage')).toEqual([])
  } finally { await f.close() }
})

it('genuine Stop cancels capacity waiting after the actual failed response connection closes', async () => {
  const closed = Promise.withResolvers<void>()
  const f = await fixture(response => {
    response.on('close', () => closed.resolve())
    response.write(frame({ error: { code: 'server_is_overloaded', message: 'fixture capacity' } }))
    // Deliberately leave HTTP open: the decoder must cancel at terminal failure.
  }, { retries: 1 })
  const stop = new AbortController()
  const run = f.service.submit(f.id, 'wait then stop', stop.signal)
  void run.catch(() => {})
  try {
    await vi.waitFor(async () => expect((await f.facts()).filter(event => event.type === 'model/retry' && event.retry.phase === 'waiting')).toHaveLength(1))
    const waiting = (await f.facts()).find(event => event.type === 'model/retry' && event.retry.phase === 'waiting')
    expect(waiting).toMatchObject({ retry: { code: 'CAPACITY', delayMs: 10_000 } })
    await closed.promise
    stop.abort()
    await expect(run).rejects.toThrow()
    expect(f.bodies).toHaveLength(1)
    expect((await f.facts()).filter(event => event.type === 'model/exchange-accepted')).toEqual([])
  } finally { stop.abort(); await run.catch(() => {}); await f.close() }
})

it('genuine Stop after observed localhost usage retains its original attempt billing and allows later work', async () => {
  let parsedUsage = false
  const nextRead = Promise.withResolvers<void>(), closed = Promise.withResolvers<void>()
  const originalMap = chatUsage.mapUsage, originalRead = ReadableStreamDefaultReader.prototype.read
  // Observation only: real usage mapper and real response reads remain intact.
  // A new read after mapping means the usage frame has crossed the waiting
  // wrapper and the retry owner is now waiting for the next provider frame.
  const mapping = vi.spyOn(chatUsage, 'mapUsage').mockImplementation(value => { const usage = originalMap(value); if (usage?.inputTokens === 12) parsedUsage = true; return usage })
  const reading = vi.spyOn(ReadableStreamDefaultReader.prototype, 'read').mockImplementation(function (this: ReadableStreamDefaultReader) { if (parsedUsage) nextRead.resolve(); return originalRead.call(this) })
  const f = await fixture((response, ordinal) => {
    if (ordinal > 1) { response.end(success); return }
    response.on('close', () => closed.resolve())
    response.write(frame({ usage: { prompt_tokens: 12, completion_tokens: 3 } }))
    // Remain open without any content/error/end until the caller actually Stops.
  }, { retries: 1 })
  const stop = new AbortController()
  let runSignal: AbortSignal | undefined
  const assembly = await f.service.assemblyFor(f.id)
  assembly.ctx.on('agent/pre-step', payload => { runSignal = (payload as { signal: AbortSignal }).signal })
  const run = f.service.submit(f.id, 'stop after usage', stop.signal)
  void run.catch(() => {})
  try {
    await nextRead.promise
    stop.abort()
    const error = await run.catch(error => error)
    expect(error).toBe(runSignal!.reason)
    await closed.promise
    expect(f.bodies).toHaveLength(1); expect(f.effects()).toBe(0)
    const facts = await f.facts()
    expect(facts.filter(event => event.type === 'context/attempt' && event.op === 'reserve')).toHaveLength(1)
    expect(facts.filter(event => event.type === 'context/attempt' && event.op === 'settle').map(event => event.disposition)).toEqual(['unknown'])
    expect(facts.filter(event => event.type === 'model/exchange-accepted' || event.type === 'context/usage' || event.type === 'tool/call' || event.type === 'tool/dispatch')).toEqual([])
    expect(f.events.filter(event => event.type === 'provider/usage').map(event => event.data)).toEqual([{ inputTokens: 12, inputTokenSemantics: 'includes-cache', outputTokens: 3 }])
    const step = facts.find(event => event.type === 'step/start'), physical = facts.find(event => event.type === 'context/attempt' && event.op === 'reserve')
    expect(f.usageOwners).toEqual([{ attemptId: step?.type === 'step/start' ? step.attemptId : undefined, physicalAttemptId: physical?.type === 'context/attempt' ? physical.attemptId : undefined }])
    await expect(f.service.submit(f.id, 'valid follow-up after Stop', new AbortController().signal)).resolves.toBeUndefined()
    expect(f.service.liveAssembly(f.id)).toBe(assembly)
    expect(f.bodies).toHaveLength(2); expect(f.effects()).toBe(0)
    expect((await f.facts()).filter(event => event.type === 'model/exchange-accepted')).toHaveLength(1)
    expect(f.events.filter(event => event.type === 'provider/usage')).toHaveLength(2)
  } finally { stop.abort(); await run.catch(() => {}); mapping.mockRestore(); reading.mockRestore(); await f.close() }
})

it.each([false, true])('an actual allowance of one refuses retry after observed output=%s without minting an unsent allowance', async output => {
  const f = await fixture(response => response.end((output ? partial : '') + frame(failure)), { retries: 2, cap: 1 })
  try {
    await expect(f.service.submit(f.id, 'one physical attempt', new AbortController().signal)).rejects.toMatchObject({ code: 'GENERATION_EXHAUSTED' })
    expect(f.bodies).toHaveLength(1)
    expect(f.effects()).toBe(0)
    const facts = await f.facts()
    expect(facts.filter(event => event.type === 'context/attempt' && event.op === 'reserve').map(event => event.ordinal)).toEqual([1])
    expect(facts.filter(event => event.type === 'context/attempt' && event.op === 'settle').map(event => event.disposition)).toEqual(['failed'])
    expect(facts.filter(event => event.type === 'model/exchange-accepted' || event.type === 'tool/dispatch' || event.type === 'context/usage')).toEqual([])
  } finally { await f.close() }
})
