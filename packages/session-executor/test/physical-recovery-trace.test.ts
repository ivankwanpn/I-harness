import { afterEach, expect, it, vi } from 'vitest'
import { mkdtemp } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createSessionCoordinator } from '@i-harness/session-persistence'
import { createJsonlBackend } from '@i-harness/session-persistence-jsonl'
import { createOpenAICompatibleClient } from '../../llm-openai-compatible/src/index.ts'
import { createRetryingClient, resolveRetryPolicy } from '@i-harness/llm-seam'
import { checkpointOfLength } from '../../compaction/test/fixtures/checkpoint.ts'
import { createSessionService } from '../src/index.ts'

afterEach(() => vi.unstubAllGlobals())
const completion = (delta: object) => new Response('data: ' + JSON.stringify({ choices: [{ delta, finish_reason: null }] }) + '\n\ndata: ' + JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] }) + '\n\ndata: [DONE]\n\n')
it.each([20, 9])('actual retry→selected summary→changed-input recovery is bounded by literal cap%s without replaying an earlier tool', async cap => {
  const root = await mkdtemp(join(tmpdir(), 'ih-physical-recovery-')), backend = createJsonlBackend(root)
  const coordinator = createSessionCoordinator(backend, { lock: { enabled: true } }), { id } = await coordinator.create()
  let stage: 'seed' | 'reject' | 'recovery' = 'seed', seeded = 0, originals = 0, summaries = 0, recoveries = 0, effects = 0
  const trace: string[] = []
  vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
    if (url !== 'https://physical-recovery.fixture.invalid/v1/chat/completions') throw new Error('Unexpected network destination')
    const body = JSON.parse(String(init.body)), summary = JSON.stringify(body.messages.at(-1)).includes('You are now acting as a compaction engine')
    if (stage === 'seed') return ++seeded === 1 ? completion({ tool_calls: [{ index: 0, id: 'original-effect', type: 'function', function: { name: 'probe', arguments: '{}' } }] }) : completion({ content: 'Historical work completed.' })
    if (summary) {
      trace.push('summary')
      if (++summaries < 8) return new Response('synthetic server failure', { status: 503 })
      stage = 'recovery'
      return completion({ content: checkpointOfLength(600) })
    }
    if (stage === 'reject') {
      trace.push('main')
      if (++originals < 6) return new Response('synthetic server failure', { status: 503 })
      return Response.json({ error: { code: 'context_length_exceeded', type: 'invalid_request_error', message: 'Input is too long for requested model' } }, { status: 400 })
    }
    trace.push('recovery'); recoveries++
    return new Response('synthetic server failure', { status: 503 })
  })
  const base = createOpenAICompatibleClient({ apiKey: 'fixture-only', model: 'fixture', baseUrl: 'https://physical-recovery.fixture.invalid' })
  const retry = (maxRetries: number) => createRetryingClient(base, resolveRetryPolicy({ mode: 'normal', maxRetries, backoff: { initialDelayMs: 1, maxDelayMs: 1, jitterRatio: 0 } }))
  const service = createSessionService({ workspace: root, coordinator, model: retry(5), modelActionMaxAttempts: cap, contextWindow: 100000, maxOutputTokens: 2000, codeMode: { mode: 'off' }, compact: { auto: false, retainTokens: 100, prune: false, summarizationModel: retry(10) } })
  try {
    const assembly = await service.assemblyFor(id)
    assembly.tools.register({ name: 'probe', description: 'Synthetic original read.', isReadOnly: true, inputSchema: { type: 'object', properties: {} }, execute: async () => { effects++; return 'completed original result '.repeat(1000) } })
    await service.submit(id, 'Historical authorized task. '.repeat(1800), new AbortController().signal)
    expect(effects).toBe(1)
    stage = 'reject'
    await expect(service.submit(id, 'Continue from the completed historical work.', new AbortController().signal)).rejects.toThrow()
    expect(trace).toEqual(cap === 20 ? [...Array(6).fill('main'), ...Array(8).fill('summary'), ...Array(6).fill('recovery')] : [...Array(6).fill('main'), ...Array(3).fill('summary')])
    expect([originals, summaries, recoveries, effects]).toEqual(cap === 20 ? [6, 8, 6, 1] : [6, 3, 0, 1])
    const events = (await backend.read(id)).events
    const opened = events.findLast(event => event.type === 'context/action' && event.op === 'open')!
    const reservations = events.flatMap(event => event.type === 'context/attempt' && event.op === 'reserve' && event.actionId === opened.actionId ? [event] : [])
    expect(reservations.map(event => event.lane)).toEqual(trace)
    expect(reservations.map(event => event.ordinal)).toEqual(Array.from({ length: cap }, (_, index) => index + 1))
    expect(events.filter(event => event.type === 'context/action' && event.op === 'phase')).toHaveLength(cap === 20 ? 1 : 0)
    expect(events.filter(event => event.type === 'context/recovery' && event.state === 'retry-started')).toHaveLength(cap === 20 ? 1 : 0)
    expect(events.filter(event => event.type === 'compaction/replacement')).toHaveLength(cap === 20 ? 1 : 0)
    expect(events.filter(event => event.type === 'tool/dispatch')).toHaveLength(1)
  } finally { await service.close().catch(() => {}); await coordinator.close().catch(() => {}) }
})

it('accepted tool work settles across its model deadline and authorizes one fresh response without replay', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ih-tool-past-generation-')), backend = createJsonlBackend(root)
  const coordinator = createSessionCoordinator(backend, { lock: { enabled: true } }), { id } = await coordinator.create()
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>()
  let sends = 0, effects = 0
  vi.stubGlobal('fetch', async (url: string) => {
    if (url !== 'https://tool-deadline.fixture.invalid/v1/chat/completions') throw new Error('Unexpected network destination')
    return ++sends === 1 ? completion({ tool_calls: [{ index: 0, id: 'accepted-read', type: 'function', function: { name: 'held_read', arguments: '{}' } }] }) : completion({ content: 'Finished from the settled result.' })
  })
  const model = createOpenAICompatibleClient({ apiKey: 'fixture-only', model: 'fixture', baseUrl: 'https://tool-deadline.fixture.invalid' })
  const service = createSessionService({ workspace: root, coordinator, model, modelActionTimeoutMs: 1000, codeMode: { mode: 'off' } })
  const assembly = await service.assemblyFor(id)
  assembly.tools.register({ name: 'held_read', description: 'Read held by fixture.', isReadOnly: true, inputSchema: { type: 'object', properties: {} }, execute: async () => { effects++; entered.resolve(); await release.promise; return 'actual settled read result' } })
  const run = service.submit(id, 'Perform the controlled read.', new AbortController().signal); void run.catch(() => {})
  try {
    await Promise.race([entered.promise, run.then(() => { throw new Error('No accepted held tool') })])
    const first = assembly.session.events.find(event => event.type === 'context/action' && event.op === 'open')!
    if (first.type !== 'context/action' || first.op !== 'open') throw new Error('Missing original action')
    await new Promise(resolve => setTimeout(resolve, Math.max(0, first.expiresAt - Date.now() + 10)))
    expect(sends).toBe(1); expect(effects).toBe(1)
    release.resolve(); await run
    const events = (await backend.read(id)).events, actions = events.filter(event => event.type === 'context/action' && event.op === 'open')
    expect([sends, effects]).toEqual([2, 1]); expect(actions).toHaveLength(2)
    expect(actions[1]).toMatchObject({ origin: { kind: 'predecessor' } })
    expect(actions[1]!.startedAt).toBeGreaterThanOrEqual(first.expiresAt)
    expect(events.filter(event => event.type === 'tool/dispatch')).toHaveLength(1)
    expect(events.filter(event => event.type === 'tool/result')).toHaveLength(1)
    expect(events.filter(event => event.type === 'context/attempt' && event.op === 'reserve').map(event => event.actionId)).toEqual(actions.map(event => event.actionId))
  } finally { release.resolve(); await run.catch(() => {}); await service.close().catch(() => {}); await coordinator.close().catch(() => {}) }
})
