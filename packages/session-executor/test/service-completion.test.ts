import { afterEach, expect, it, vi } from 'vitest'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { decodeFactBatch, subscribe, type BatchKey } from '@i-harness/core-session'
import { createSessionCoordinator } from '@i-harness/session-persistence'
import { createJsonlBackend } from '../../session-persistence-jsonl/src/index.ts'
import { maybeAutoTitle } from '../../session-title/src/index.ts'
import { createSessionService } from '../src/service.ts'

afterEach(() => vi.unstubAllGlobals())
const tick = () => new Promise<void>(resolve => setImmediate(resolve))
async function bounded<T>(work: Promise<T>) {
  let timer: ReturnType<typeof setTimeout> | undefined
  try { return await Promise.race([work.then(value => ({ kind: 'resolved' as const, value }), error => ({ kind: 'rejected' as const, error })), new Promise<{ kind: 'pending' }>(resolve => { timer = setTimeout(() => resolve({ kind: 'pending' }), 1000) })]) }
  finally { clearTimeout(timer) }
}
function causes(error: unknown): Set<unknown> {
  const found = new Set<unknown>(), pending = [error]
  while (pending.length) {
    const next = pending.shift()
    if (found.has(next)) continue
    found.add(next)
    if (next && typeof next === 'object') {
      if ('cause' in next) pending.push(next.cause)
      if (next instanceof AggregateError) pending.push(...next.errors)
    }
  }
  return found
}

it('settles an uncertain original title drain, preserves the completed main/tool work, and recovers only its original frame', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ih-fix1-title-drain-')), backend = createJsonlBackend(root)
  let network = 0, effects = 0, titleWrites = 0, held = true, callbackError: unknown, key: BatchKey | undefined, title = true
  vi.stubGlobal('fetch', async () => { network++; throw new Error('Unexpected network destination') })
  const append = backend.appendOwnedBatch!, reconcile = backend.reconcileOwnedBatch!
  backend.appendOwnedBatch = async (...args) => {
    const events = decodeFactBatch(args[3].bytes).events, outcome = await append(...args)
    if (events.some(event => event.type === 'context/action' && event.op === 'open' && event.purpose === 'title')) {
      titleWrites++; key = args[3].key; return { kind: 'unknown', key }
    }
    return outcome
  }
  backend.reconcileOwnedBatch = async (...args) => held && key?.batchId === args[3].key.batchId ? { kind: 'unknown', key } : reconcile(...args)
  const coordinator = createSessionCoordinator(backend, { lock: { enabled: true } }), { id } = await coordinator.create()
  const service = createSessionService({ workspace: root, coordinator, modelPolicy: 'test-mock', codeMode: { mode: 'off' }, approveAll: true,
    mockScript: [{ role: 'assistant', toolCalls: [{ name: 'fixture_effect', args: {} }] }, { role: 'assistant', text: 'main completed once' }, { role: 'assistant', text: 'later explicit input completed' }],
    additionalTools: [{ name: 'fixture_effect', description: 'Record a controlled effect', inputSchema: {}, isReadOnly: true, execute: async () => { effects++; return { completed: true } } }],
    afterSuccessfulSubmit: async (_id, assembly, _limits, action) => {
      if (!title) return
      title = false
      try { await maybeAutoTitle({ session: assembly.session, model: assembly.model, action }) }
      catch (error) { callbackError = error; throw error }
    },
  })
  const document = await coordinator.openManagedDocument(id), unhandled: unknown[] = [], onUnhandled = (error: unknown) => { unhandled.push(error) }
  process.on('unhandledRejection', onUnhandled)
  let settled = false
  const running = service.submit(id, 'perform exactly one main effect', new AbortController().signal)
  void running.then(() => { settled = true }, () => { settled = true })
  try {
    const outcome = await bounded(running)
    expect(outcome.kind).toBe('rejected')
    await tick()
    expect(unhandled).toEqual([])
    expect(service.queueState(id)).toEqual({ running: false, queued: 0 })
    if (outcome.kind !== 'rejected') throw new Error('Actual service caller must reject')
    expect(causes(outcome.error).has(callbackError)).toBe(true)
    expect([...causes(outcome.error)].some(error => !!error && typeof error === 'object' && 'code' in error && error.code === 'FACT_RECOVERY_REQUIRED')).toBe(true)
    expect([network, effects, titleWrites]).toEqual([0, 1, 1])
    let events = (await backend.read(id)).events
    expect(events.filter(event => event.type === 'model/exchange-accepted')).toHaveLength(2)
    expect(events.filter(event => event.type === 'tool/dispatch')).toHaveLength(1)
    expect(events.filter(event => event.type === 'tool/result')).toHaveLength(1)
    expect(events.filter(event => event.type === 'context/action' && event.op === 'local-invocation')).toHaveLength(2)
    expect(events.filter(event => event.type === 'context/attempt' || event.type === 'session/title')).toEqual([])
    expect(() => document.beginAction()).toThrow()
    const refusedClose = await bounded(service.closeSession(id))
    expect(refusedClose.kind).toBe('rejected')
    expect(titleWrites).toBe(1)
    held = false
    if (!key) throw new Error('Original title frame was not issued')
    await document.reconcile(key)
    expect((await bounded(service.closeSession(id))).kind).toBe('resolved')
    await service.submit(id, 'new explicit input after original recovery', new AbortController().signal)
    events = (await backend.read(id)).events
    expect(events.filter(event => event.type === 'model/exchange-accepted')).toHaveLength(3)
    expect(events.filter(event => event.type === 'context/action' && event.op === 'open' && event.purpose === 'title')).toHaveLength(1)
    expect(events.filter(event => event.type === 'context/action' && event.op === 'open' && event.purpose === 'main')).toHaveLength(3)
    expect(events.filter(event => event.type === 'tool/dispatch')).toHaveLength(1)
    expect([network, effects, titleWrites]).toEqual([0, 1, 1])
  } finally {
    held = false; process.off('unhandledRejection', onUnhandled)
    if (key) await document.reconcile(key).catch(() => {})
    // RED deliberately leaves the reproduced unresolved caller for worker exit;
    // it must not make the original hang a fixture teardown timeout.
    if (settled) { await service.close().catch(() => {}); await coordinator.close().catch(() => {}) }
  }
})

it.each([false, true])('closes original prepared ingress after Stop during held extension refresh, cancellation unknown=%s', async uncertain => {
  const root = await mkdtemp(join(tmpdir(), 'ih-fix1-refresh-stop-')), backend = createJsonlBackend(root)
  let network = 0, refresh = false, hold = true, key: BatchKey | undefined, cancellations = 0, closes = 0, actions = 0, finishes = 0
  vi.stubGlobal('fetch', async () => { network++; throw new Error('Unexpected network destination') })
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>(), prepared = Promise.withResolvers<void>()
  const append = backend.appendOwnedBatch!, reconcile = backend.reconcileOwnedBatch!
  backend.appendOwnedBatch = async (...args) => {
    const events = decodeFactBatch(args[3].bytes).events, outcome = await append(...args)
    closes += events.filter(event => event.type === 'context/action' && event.op === 'close').length
    if (events.some(event => event.type === 'agent/input/cancelled')) {
      cancellations++
      if (uncertain) { key = args[3].key; return { kind: 'unknown', key } }
    }
    return outcome
  }
  backend.reconcileOwnedBatch = async (...args) => hold && key?.batchId === args[3].key.batchId ? { kind: 'unknown', key } : reconcile(...args)
  const coordinator = createSessionCoordinator(backend, { lock: { enabled: true } }), { id } = await coordinator.create()
  const service = createSessionService({ workspace: root, coordinator, modelPolicy: 'test-mock', mockScript: [{ role: 'assistant', text: 'later input completed' }], codeMode: { mode: 'off' },
    extensionsFor: async () => { if (refresh) { entered.resolve(); await release.promise }; return { options: {} } },
  })
  const assembly = await service.assemblyFor(id), document = await coordinator.openManagedDocument(id), begin = document.beginAction.bind(document)
  document.beginAction = signal => { const action = begin(signal), finish = action.finish.bind(action); actions++; action.finish = () => { finishes++; finish() }; return action }
  const off = subscribe(assembly.session, event => { if (event.type === 'agent/input/preparation' && event.op === 'completed') prepared.resolve() })
  refresh = true
  const refreshing = service.refreshExtensions(); await entered.promise
  const stop = new AbortController(), running = service.submit(id, 'prepared original input must not run', stop.signal)
  void running.catch(() => {})
  try {
    await Promise.race([prepared.promise, running.then(() => { throw new Error('No actual preparation') })])
    await tick()
    stop.abort(new Error('Stop during actual refresh'))
    release.resolve(); await refreshing
    const outcome = await bounded(running)
    expect(outcome.kind).toBe(uncertain ? 'rejected' : 'resolved')
    expect([network, actions, finishes, closes, cancellations]).toEqual([0, 1, 1, 1, 1])
    let events = (await backend.read(id)).events
    expect(events.filter(event => event.type === 'agent/input/promoted' || event.type === 'context/attempt' || event.type === 'model/exchange-accepted')).toEqual([])
    expect(events.filter(event => event.type === 'context/action' && event.op === 'close')).toEqual([expect.objectContaining({ disposition: 'stopped' })])
    expect(service.queueState(id).running).toBe(false)
    if (uncertain) {
      if (outcome.kind !== 'rejected' || !key) throw new Error('Unknown original cancellation must reject with retained key')
      expect([...causes(outcome.error)].some(error => !!error && typeof error === 'object' && 'code' in error && error.code === 'FACT_RECOVERY_REQUIRED')).toBe(true)
      expect(() => document.beginAction()).toThrow()
      hold = false; await document.reconcile(key)
      await service.closeSession(id)
    }
    expect((await service.receivedInputFor(id)).pending()).toEqual([])
    expect(service.queueState(id)).toEqual({ running: false, queued: 0 })
    expect([closes, cancellations]).toEqual([1, 1])
    await service.submit(id, 'later explicit input remains usable', new AbortController().signal)
    events = (await backend.read(id)).events
    expect(events.filter(event => event.type === 'agent/input/promoted')).toHaveLength(1)
    expect(events.filter(event => event.type === 'context/action' && event.op === 'local-invocation')).toHaveLength(1)
    expect(events.filter(event => event.type === 'agent/input/cancelled')).toHaveLength(1)
    expect(network).toBe(0)
  } finally { release.resolve(); hold = false; off(); if (key) await document.reconcile(key).catch(() => {}); await service.close().catch(() => {}); await coordinator.close().catch(() => {}) }
})

it('reads the live host completion callback with its original options receiver after the actual binding await', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ih-fix1-live-completion-')), coordinator = createSessionCoordinator(createJsonlBackend(root), { lock: { enabled: true } }), { id } = await coordinator.create()
  vi.stubGlobal('fetch', async () => { throw new Error('Unexpected network destination') })
  const calls: string[] = [], entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>()
  let service!: ReturnType<typeof createSessionService>
  const options: import('../src/service.ts').SessionServiceOptions = { workspace: root, coordinator, modelPolicy: 'test-mock', mockScript: [{ role: 'assistant', text: 'ordinary answer' }], codeMode: { mode: 'off' },
    async afterSuccessfulSubmit() { calls.push('old') },
  }
  service = createSessionService(options)
  await service.assemblyFor(id)
  options.modelBindingFor = async () => { entered.resolve(); await release.promise; return { status: 'unconfigured', reason: 'post-turn fixture binding' } }
  const running = service.submit(id, 'ordinary completion', new AbortController().signal)
  try {
    await Promise.race([entered.promise, running.then(() => { throw new Error('No held post-turn binding') })])
    expect(calls).toEqual([])
    options.afterSuccessfulSubmit = async function () { expect(this).toBe(options); calls.push('new') }
    release.resolve(); await running
    expect(calls).toEqual(['new'])
  } finally { release.resolve(); await running.catch(() => {}); await service.close(); await coordinator.close() }
})
