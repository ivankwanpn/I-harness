import * as seam from '@i-harness/llm-seam'
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

import { subscribe, decodeFactBatch, projectConversation, type BatchKey } from '@i-harness/core-session'
import * as snapshot from '../../core-agent/src/agent/request-snapshot.ts'
import { writeFile } from 'node:fs/promises'

const frame = (value: unknown) => `data: ${JSON.stringify(value)}\n\n`
const failure = { error: { message: 'Fixture temporary server error private-fixture-9182', type: 'server_error', code: 'server_error' } }
const partial = frame({ choices: [{ delta: { content: 'unaccepted partial', tool_calls: [{ index: 0, id: 'failed-call', function: { name: 'effect', arguments: '{}' } }] } }] })
const success = frame({ choices: [{ delta: { content: 'follow-up succeeded' }, finish_reason: 'stop' }], usage: { prompt_tokens: 30, completion_tokens: 4 } }) + 'data: [DONE]\n\n'

async function fixture(answer: (response: ServerResponse, ordinal: number) => void, options: { retries?: number; cap?: number; timeout?: number; backend?: Parameters<typeof createJsonlBackend>[1] } = {}) {
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
  const backend = createJsonlBackend(join(root, 'sessions'), options.backend), coordinator = createSessionCoordinator(backend, { lock: { enabled: true } })
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
    ...(options.timeout ? { modelActionTimeoutMs: options.timeout } : {}),
    additionalTools: [{ name: 'effect', description: 'Bounded controlled effect counter', inputSchema: { type: 'object', properties: {} }, async execute() { effects++; return { effects } } }],
  })
  return { service, model, backend, coordinator, id, bodies, events, usageOwners, effects: () => effects,
    facts: async () => (await backend.read(id)).events,
    async close(recoveryRequired = false) {
      const failures: unknown[] = []
      try { await service.close() } catch (error) { failures.push(error) }
      try { await coordinator.close() } catch (error) { failures.push(error) }
      server.closeAllConnections(); await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
      // Unsettled owner evidence stays on disk; fixture teardown cannot reissue it.
      if (!failures.length) rmWorkspaceSync(root)
      if (recoveryRequired) expect(failures.length).toBeGreaterThan(0)
      else if (failures.length) throw new AggregateError(failures, 'Fixture cleanup failed')
    },
  }
}


it.each(['text', 'text-tool', 'reasoning'] as const)('recovers actual partial %s under the original candidate', async kind => {
  const original = snapshot.sameRequestCandidate
  const comparisons: unknown[] = []
  const observing = vi.spyOn(snapshot, 'sameRequestCandidate').mockImplementation((before, current) => {
    const result = original(before, current)
    comparisons.push({ result, items: current.snapshot.conversation.items, protection: current.snapshot.protection, before: before.snapshot.coordinates, current: current.snapshot.coordinates,
      model: before.model === current.model, binding: before.bindingIdentity === current.bindingIdentity, surface: before.snapshot.surfaceRevision === current.snapshot.surfaceRevision })
    return result
  })
  const output = kind === 'text-tool' ? partial : frame({ choices: [{ delta: kind === 'text' ? { content: 'unaccepted partial' } : { reasoning_content: 'unaccepted thought' } }] })
  const f = await fixture((response, ordinal) => response.end(ordinal === 1 ? output + frame({ ...failure, usage: { prompt_tokens: 12, completion_tokens: 3 } }) : success), { retries: 1 })
  try {
    await f.service.submit(f.id, 'partial retry', new AbortController().signal)
    expect(f.bodies).toHaveLength(2)
    expect(f.bodies[1]).toBe(f.bodies[0])
    expect(f.effects()).toBe(0)
    const facts = await f.facts()
    expect(facts.filter(e => e.type === 'context/attempt' && e.op === 'settle').map(e => e.disposition)).toEqual(['failed', 'completed'])
    expect(new Set(facts.filter(e => e.type === 'step/start').map(e => e.actionId)).size).toBe(1)
    expect(new Set(facts.filter(e => e.type === 'step/start').map(e => e.attemptId)).size).toBe(2)
    expect(facts.filter(e => e.type === 'model/exchange-accepted')).toHaveLength(1)
    expect(facts.filter(e => e.type === 'context/usage' && e.version === 2 && e.op === 'sample')).toHaveLength(1)
    expect(facts.filter(e => e.type === 'tool/result')).toHaveLength(kind === 'text-tool' ? 1 : 0)
    if (kind === 'reasoning') expect(facts.filter(e => e.type === 'reasoning').map(e => e.text)).toEqual(['unaccepted thought'])
    expect(f.events.filter(e => e.type === 'provider/usage').map(e => e.data)).toEqual([
      { inputTokens: 12, inputTokenSemantics: 'includes-cache', outputTokens: 3 },
      { inputTokens: 30, inputTokenSemantics: 'includes-cache', outputTokens: 4 },
    ])
    await f.service.submit(f.id, 'ordinary follow-up', new AbortController().signal)
    expect(f.bodies).toHaveLength(3)
    expect(f.bodies[2]).not.toContain('unaccepted')
    expect(f.bodies[2]).not.toContain('failed-call')
    await f.service.closeSession(f.id)
    await f.service.submit(f.id, 'cold follow-up', new AbortController().signal)
    expect(f.bodies).toHaveLength(4)
    expect(f.bodies[3]).not.toContain('unaccepted')
    expect((await f.facts()).filter(e => e.type === 'step/failed')).toHaveLength(1)
  } finally {
    if (process.env.FAILED_RETRY_EVIDENCE) await writeFile(process.env.FAILED_RETRY_EVIDENCE + '/' + kind + '.json', JSON.stringify({ comparisons, facts: await f.facts(), bodies: f.bodies }, null, 2))
    observing.mockRestore(); await f.close()
  }
})

it('two discarded failures preserve one action and earlier accepted effects once', async () => {
  const tool = frame({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'accepted-call', function: { name: 'effect', arguments: '{}' } }] }, finish_reason: 'tool_calls' }] }) + 'data: [DONE]\n\n'
  const f = await fixture((response, ordinal) => response.end(ordinal === 1 ? tool : ordinal < 4
    ? frame({ choices: [{ delta: { content: 'unaccepted-' + ordinal, tool_calls: [{ index: 0, id: 'failed-' + ordinal, function: { name: 'effect', arguments: '{}' } }] } }] }) + frame({ ...failure, usage: { prompt_tokens: 12, completion_tokens: 3 } }) : success), { retries: 2 })
  try {
    await f.service.submit(f.id, 'earlier accepted effect', new AbortController().signal)
    expect(f.bodies).toHaveLength(4); expect(f.effects()).toBe(1)
    expect(f.bodies[2]).toBe(f.bodies[1]); expect(f.bodies[3]).toBe(f.bodies[1])
    const facts = await f.facts(), steps = facts.filter(e => e.type === 'step/start')
    expect(new Set(steps.slice(1).map(e => e.actionId)).size).toBe(1)
    expect(new Set(steps.map(e => e.attemptId)).size).toBe(4)
    expect(facts.filter(e => e.type === 'tool/dispatch')).toHaveLength(1)
    expect(facts.filter(e => e.type === 'tool/result').map(e => e.callId)).toEqual(['accepted-call', 'failed-2', 'failed-3'])
    expect(facts.filter(e => e.type === 'context/attempt' && e.op === 'settle').map(e => e.disposition)).toEqual(['completed', 'failed', 'failed', 'completed'])
    expect(facts.filter(e => e.type === 'context/attempt' && e.op === 'reserve').map(e => e.ordinal)).toEqual([1, 1, 2, 3])
    expect(f.events.filter(e => e.type === 'provider/usage')).toHaveLength(3)
  } finally { await f.close() }
})

it.each(['pending-human', 'equal-current-source', 'surface', 'binding'] as const)('actual %s still invalidates the partial retry candidate', async kind => {
  const reached = Promise.withResolvers<ServerResponse>()
  const f = await fixture(response => reached.resolve(response), { retries: 1 })
  const run = f.service.submit(f.id, 'same text', new AbortController().signal)
  void run.catch(() => {})
  try {
    const response = await reached.promise
    if (kind === 'pending-human') await (await f.service.receivedInputFor(f.id)).admit({ inputId: 'steer', text: 'same text', delivery: 'steer', intent: 'user', provenance: { kind: 'human', authority: 'request', scope: 'turn', producer: 'fixture' } })
    else if (kind === 'surface') (await f.service.assemblyFor(f.id)).tools.register({ name: 'new_surface', description: 'new schema', inputSchema: {}, execute: async () => 'unused' })
    else if (kind === 'binding') (await f.service.assemblyFor(f.id)).setModel!({ ...f.model })
    else {
      const document = await f.coordinator.openManagedDocument(f.id), action = document.beginAction()
      const prior = document.view.events.findLast(e => e.type === 'runtime/context')!
      if (prior.type !== 'runtime/context') throw Error('current context required')
      await action.captureRuntimeContext({ type: 'runtime/context', version: 1, sections: prior.sections.map(section => ({ ...section })) }, () => true).admit()
      action.finish()
    }
    response.end(partial + frame(failure))
    await expect(run).rejects.toMatchObject({ code: 'CONTEXT_INPUT_STALE' })
    expect(f.bodies).toHaveLength(1); expect(f.effects()).toBe(0)
    expect((await f.facts()).filter(e => e.type === 'model/exchange-accepted')).toHaveLength(0)
  } finally { await run.catch(() => {}); await f.close() }
})

it('Stop interrupts actual ten-second capacity backoff without a second reservation', async () => {
  const f = await fixture(response => response.end(partial + frame({ error: { code: 'server_is_overloaded', message: 'capacity' } })), { retries: 1 })
  const stop = new AbortController(), waiting = Promise.withResolvers<void>()
  await f.service.assemblyFor(f.id)
  const unsub = subscribe(f.service.liveSession(f.id)!, e => { if (e.type === 'model/retry' && e.retry.phase === 'waiting') { expect(e.retry.delayMs).toBe(10000); waiting.resolve(); stop.abort() } })
  const run = f.service.submit(f.id, 'stop waiting', stop.signal)
  void run.catch(() => {})
  try {
    await waiting.promise; await expect(run).rejects.toThrow()
    expect(f.bodies).toHaveLength(1)
    expect((await f.facts()).filter(e => e.type === 'context/attempt' && e.op === 'reserve')).toHaveLength(1)
    expect(f.effects()).toBe(0)
  } finally { unsub(); stop.abort(); await run.catch(() => {}); await f.close() }
})

it.each(['tool/result', 'assistant/message', 'step/end', 'reasoning'].flatMap(type => ['committed', 'unknown', 'absent'].map(disposition => ({ type, disposition }))))('$disposition $type save joins the original managed operation without reopening', async ({ type, disposition }) => {
  const committed = disposition === 'committed'
  const output = type === 'reasoning' ? frame({ choices: [{ delta: { reasoning_content: 'pending original reasoning' } }] }) : partial
  let blocked = true, key: BatchKey | undefined, issued = 0, captured = false
  const committedFacts: ReturnType<typeof decodeFactBatch>['events'][number][] = []
  const f = await fixture((response, ordinal) => response.end(ordinal === 1 ? output + frame({ ...failure, usage: { prompt_tokens: 12, completion_tokens: 3 } }) : success), {
    retries: 1,
    backend: {
      wrapOwnedBatch: append => async (...args) => {
        const events = decodeFactBatch(args[3].bytes).events
        if (blocked && events.some(event => event.type === type)) {
          captured = true; key = args[3].key; issued++
          if (committed) { expect((await append(...args)).kind).toBe('committed'); committedFacts.push(...events) }
          return { kind: disposition === 'absent' ? 'absent' : 'unknown', key }
        }
        const outcome = await append(...args)
        if (outcome.kind === 'committed') committedFacts.push(...events)
        return outcome
      },
      wrapOwnedReconcile: reconcile => async (...args) => blocked ? { kind: 'unknown', key: args[3].key } : reconcile(...args),
    },
  })
  const consume = seam.consumeRetryFailure
  let originalFailure: unknown
  const observing = vi.spyOn(seam, 'consumeRetryFailure').mockImplementation(event => { const record = consume(event); originalFailure = record?.failure; return record })
  try {
    const error = await f.service.submit(f.id, 'save refusal', new AbortController().signal).catch(e => e)
    const primary = (e: unknown): unknown => e instanceof AggregateError ? primary(e.cause) : e
    expect(primary(error)).toBe(originalFailure)
    expect(originalFailure).toMatchObject({ code: 'SERVER' })
    expect(f.events.filter(e => e.type === 'provider/usage')).toHaveLength(1)
    expect(f.bodies).toHaveLength(1); expect(f.effects()).toBe(0); expect(issued).toBe(1); expect(key).toBeDefined()
    await expect(f.service.submit(f.id, 'must not reopen', new AbortController().signal)).rejects.toThrow()
    expect(f.bodies).toHaveLength(1); expect(issued).toBe(1)
    const facts = await f.facts()
    expect(facts.filter(e => e.type === 'model/exchange-accepted' || e.type === 'tool/dispatch' || e.type === 'context/usage')).toEqual([])
    expect(facts).toEqual(committedFacts)
    const results = facts.filter(event => event.type === 'tool/result')
    expect(results.length).toBeLessThanOrEqual(1)
    if (type === 'tool/result') expect(results).toHaveLength(committed ? 1 : 0)
    if (type === 'step/end') expect(results).toHaveLength(1)
    for (const result of facts.filter(e => e.type === 'tool/result')) expect(result).toMatchObject({ callId: 'failed-call', name: 'effect', isError: true, output: { code: 'TOOL_ABORTED_BEFORE_DISPATCH' } })
    expect(facts.filter(e => e.type === 'context/action' && e.op === 'open')).toHaveLength(1)
    const projection = projectConversation({ formatVersion: 12, events: facts })
    if (type !== 'reasoning' && (type !== 'step/end' || !committed)) expect(projection.items.some(i => i.unit?.state === 'unresolved' || i.unit?.state === 'open')).toBe(true)
  } finally {
    observing.mockRestore()
    blocked = false
    if (captured && committed) {
      await (await f.coordinator.openManagedDocument(f.id)).reconcile(key!)
      await f.service.closeSession(f.id)
      const settled = await f.facts()
      expect(settled.filter(e => e.type === 'tool/result' && e.callId === 'failed-call')).toHaveLength(type === 'reasoning' ? 0 : 1)
      if (type === 'reasoning') expect(settled.filter(e => e.type === 'reasoning').map(e => e.text)).toEqual(['pending original reasoning'])
      await f.service.submit(f.id, 'after original persistence settles', new AbortController().signal)
      expect(f.bodies).toHaveLength(2); expect(f.bodies[1]).not.toContain('failed-call'); expect(f.effects()).toBe(0)
    }
    await f.close(!committed)
  }
})

it('expired original deadline refuses partial retry without resetting its action', async () => {
  const reached = Promise.withResolvers<ServerResponse>()
  const f = await fixture(response => reached.resolve(response), { retries: 1, timeout: 60000 })
  const run = f.service.submit(f.id, 'deadline control', new AbortController().signal)
  void run.catch(() => {})
  let clock: ReturnType<typeof vi.spyOn> | undefined
  try {
    const response = await reached.promise, now = performance.now.bind(performance)
    clock = vi.spyOn(performance, 'now').mockImplementation(() => now() + 60001)
    response.end(partial + frame(failure))
    await expect(run).rejects.toMatchObject({ code: 'GENERATION_EXPIRED' })
    expect(f.bodies).toHaveLength(1); expect(f.effects()).toBe(0)
    const facts = await f.facts()
    expect(facts.filter(e => e.type === 'context/action' && e.op === 'open')).toHaveLength(1)
    expect(facts.filter(e => e.type === 'context/attempt' && e.op === 'reserve')).toHaveLength(1)
  } finally { clock?.mockRestore(); await run.catch(() => {}); await f.close() }
})

it('actual prepared Chat retry keeps the original cause when usage observation throws', async () => {
  const f = await fixture((response, ordinal) => response.end(ordinal === 1 ? partial + frame({ ...failure, usage: { prompt_tokens: 12, completion_tokens: 3 } }) : success), { retries: 1 })
  const assembly = await f.service.assemblyFor(f.id), telemetry = assembly.telemetry!
  const emit = telemetry.emit.bind(telemetry), consume = seam.consumeRetryFailure, observer = new Error('controlled observer failure')
  let originalFailure: unknown, reports = 0
  const observing = vi.spyOn(seam, 'consumeRetryFailure').mockImplementation(event => { const record = consume(event); originalFailure = record?.failure; return record })
  const reporting = vi.spyOn(telemetry, 'emit').mockImplementation(event => { emit(event); if (event.type === 'provider/usage') { reports++; throw observer } })
  try {
    const error = await f.service.submit(f.id, 'observer failure', new AbortController().signal).catch(e => e)
    expect(error.cause).toBe(originalFailure); expect(error.errors).toContain(observer)
    expect(originalFailure).toMatchObject({ code: 'SERVER' })
    expect(reports).toBe(1); expect(f.bodies).toHaveLength(1); expect(f.effects()).toBe(0)
    const facts = await f.facts()
    expect(facts.filter(e => e.type === 'tool/result')).toHaveLength(1)
    expect(facts.filter(e => e.type === 'assistant/message')).toHaveLength(1)
    expect(facts.filter(e => e.type === 'model/exchange-accepted' || e.type === 'context/usage' || e.type === 'tool/dispatch')).toEqual([])
    expect(f.events.filter(e => e.type === 'provider/usage')).toHaveLength(1)
    expect(JSON.stringify(f.events)).not.toContain('private-fixture-9182')
  } finally { reporting.mockRestore(); observing.mockRestore(); await f.close() }
})
