import { afterEach, expect, it, vi } from 'vitest'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createSessionCoordinator } from '@i-harness/session-persistence'
import { createJsonlBackend } from '@i-harness/session-persistence-jsonl'
import { createOpenAICompatibleClient } from '../../llm-openai-compatible/src/index.ts'
import { createSessionService } from '../src/index.ts'
import { createGenerationLifecycle } from '../src/lifecycle/generation-actions.ts'
import { PNG } from '../../image-validation/test/fixtures.ts'

afterEach(() => vi.unstubAllGlobals())
const success = () => new Response('data: {"choices":[{"delta":{"content":"done"},"finish_reason":null}]}\n\ndata: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n')
it('two human steers before the first response prepare once each and share its original action', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ih-first-steer-')), backend = createJsonlBackend(root)
  const coordinator = createSessionCoordinator(backend, { lock: { enabled: true } }), { id } = await coordinator.create()
  const entered = Promise.withResolvers<void>(), released = Promise.withResolvers<void>(), wire: string[] = [], transformed: string[] = []
  vi.stubGlobal('fetch', async (url: string, init: RequestInit) => { if (url !== 'https://first-steer.fixture.invalid/v1/chat/completions') throw new Error('Unexpected network destination'); wire.push(String(init.body)); return success() })
  const model = createOpenAICompatibleClient({ apiKey: 'fixture-only', model: 'main', baseUrl: 'https://first-steer.fixture.invalid' })
  const service = createSessionService({ workspace: root, coordinator, codeMode: { mode: 'off' }, modelBindingFor: async () => { entered.resolve(); await released.promise; return { status: 'ready', binding: { providerId: 'fixture', modelId: 'main', label: 'main', model } } }, transformPrompt: async (_assembly, text) => { transformed.push(text); return text.startsWith('/') ? 'expanded ' + text : text } })
  const run = service.submit(id, 'original raw input', new AbortController().signal); void run.catch(() => {})
  try {
    await Promise.race([entered.promise, run.then(() => { throw new Error('Turn finished before held model resolution') })])
    const inbox = await service.receivedInputFor(id)
    for (const inputId of ['one', 'two']) await inbox.admit({ inputId, text: '/' + inputId, delivery: 'steer', intent: 'user', preparationPolicy: 'human-host', provenance: { kind: 'human', authority: 'request', scope: 'turn', producer: 'desktop.input' } })
    expect(wire).toHaveLength(0)
    released.resolve(); await run
    expect(wire).toHaveLength(1)
    for (const inputId of ['one', 'two']) { expect(transformed.filter(text => text === '/' + inputId)).toHaveLength(1); expect(wire[0]).toContain('expanded /' + inputId) }
    const events = (await backend.read(id)).events, opened = events.filter(event => event.type === 'context/action' && event.op === 'open')
    expect(opened).toHaveLength(1)
    expect(events.flatMap(event => event.type === 'agent/input/preparation' && event.op === 'started' && event.claim === 'steer' ? [event.actionId] : [])).toEqual([opened[0]!.actionId, opened[0]!.actionId])
    expect(events.filter(event => event.type === 'agent/input/promoted')).toHaveLength(3)
  } finally { released.resolve(); await run.catch(() => {}); await service.close().catch(() => {}); await coordinator.close().catch(() => {}) }
})

it.each(['started', 'completed'] as const)('cold %s preparation never replays the command and retains raw/context/image content', async disposition => {
  const root = await mkdtemp(join(tmpdir(), 'ih-cold-input-prep-')), backend = createJsonlBackend(root)
  const first = createSessionCoordinator(backend, { lock: { enabled: true } }), { id } = await first.create(), document = await first.openManagedDocument(id)
  const action = document.beginAction(), generations = createGenerationLifecycle(document.view, id, action)
  await action.facts.inputs.admit({ type: 'agent/input/admitted', version: 1, inputId: 'cold-input', text: '/original', supplementalContext: 'saved supplemental bytes', images: [{ mediaType: 'image/png', dataBase64: PNG }], delivery: 'queue', intent: 'user', preparationPolicy: 'human-host', provenance: { kind: 'human', authority: 'request', scope: 'turn', producer: 'desktop.input' } })
  const generation = await generations.open('main', { kind: 'input', seq: 0 })
  const envelope = { type: 'agent/input/preparation' as const, version: 1 as const, preparationId: 'cold-preparation', actionId: generation.actionId, actionSeq: generation.openedSeq, admissionSeq: 0, inputId: 'cold-input' }
  await action.captureInputPreparation({ ...envelope, op: 'started', startedAt: Date.now() }, () => true).admit()
  if (disposition === 'completed') {
    const source = action.registerSettlementSource(async () => {})
    await source.inputPreparation.capture({ ...envelope, op: 'completed', observations: [{ producer: 'host-preparation', text: 'saved expansion bytes' }, { producer: 'supplemental-context', text: 'saved supplemental bytes' }] }).admit()
    await source.close()
  }
  await generations.drain(); action.finish(); await first.close()
  const coordinator = createSessionCoordinator(backend, { lock: { enabled: true } }), wire: string[] = []
  let transforms = 0
  vi.stubGlobal('fetch', async (url: string, init: RequestInit) => { if (url !== 'https://cold-prep.fixture.invalid/v1/chat/completions') throw new Error('Unexpected network destination'); wire.push(String(init.body)); return success() })
  const model = createOpenAICompatibleClient({ apiKey: 'fixture-only', model: 'main', baseUrl: 'https://cold-prep.fixture.invalid', inputModalities: ['text', 'image'] })
  const service = createSessionService({ workspace: root, coordinator, model, codeMode: { mode: 'off' }, transformPrompt: async (_assembly, text) => { transforms++; return text } })
  try {
    const run = service.submit(id, '/original', new AbortController().signal, { admittedInputId: 'cold-input' })
    if (disposition === 'started') {
      await expect(run).rejects.toMatchObject({ code: 'GENERATION_UNCERTAIN' })
      expect(wire).toHaveLength(0)
      expect((await backend.read(id)).events.filter(event => event.type === 'agent/input/preparation' && event.op === 'failed')).toEqual([expect.objectContaining({ code: 'PREPARATION_UNKNOWN' })])
    } else {
      await run
      expect(wire).toHaveLength(1)
      for (const content of ['/original', 'saved expansion bytes', 'saved supplemental bytes']) expect(wire[0]).toContain(content)
      expect((wire[0]!.match(/data:image\/png;base64/g) ?? [])).toHaveLength(1)
    }
    expect(transforms).toBe(0)
    const raw = (await backend.read(id)).events.find(event => event.type === 'agent/input/admitted')!
    expect(raw).toMatchObject({ text: '/original', supplementalContext: 'saved supplemental bytes', images: [{ dataBase64: PNG }] })
    await service.submit(id, 'new explicit input', new AbortController().signal)
    expect(wire).toHaveLength(disposition === 'started' ? 1 : 2)
  } finally { await service.close().catch(() => {}); await coordinator.close().catch(() => {}) }
})

it('a known command failure cancels only its unpromoted input and permits a later explicit input', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ih-prep-known-failure-')), backend = createJsonlBackend(root)
  const coordinator = createSessionCoordinator(backend, { lock: { enabled: true } }), { id } = await coordinator.create()
  let sends = 0, transforms = 0
  vi.stubGlobal('fetch', async (url: string) => { if (url !== 'https://known-prep.fixture.invalid/v1/chat/completions') throw new Error('Unexpected network destination'); sends++; return success() })
  const model = createOpenAICompatibleClient({ apiKey: 'fixture-only', model: 'main', baseUrl: 'https://known-prep.fixture.invalid' })
  const service = createSessionService({ workspace: root, coordinator, model, codeMode: { mode: 'off' }, transformPrompt: async (_assembly, text) => { transforms++; if (text === '/fail') throw new Error('synthetic command failure'); return text } })
  try {
    await expect(service.submit(id, '/fail', new AbortController().signal)).rejects.toThrow('synthetic command failure')
    expect(sends).toBe(0)
    expect((await service.receivedInputFor(id)).pending()).toHaveLength(0)
    await service.submit(id, 'new human input', new AbortController().signal)
    expect(sends).toBe(1); expect(transforms).toBe(2)
  } finally { await service.close().catch(() => {}); await coordinator.close().catch(() => {}) }
})
it.each(['service', 'run', 'runAdmitted'] as const)('%s expiry during the actual input-promotion backend await installs no claim and sends no model request', async entry => {
  const root = await mkdtemp(join(tmpdir(), 'ih-promotion-generation-')), backend = createJsonlBackend(root)
  const append = backend.appendOwnedBatch!.bind(backend), entered = Promise.withResolvers<void>(), released = Promise.withResolvers<void>()
  backend.appendOwnedBatch = async (id, owner, prefix, batch) => {
    const frame = JSON.parse(Buffer.from(batch.bytes).toString('utf8'))
    if (frame.events.some((event: { type: string; internal?: boolean }) => event.type === 'user/message' && !event.internal)) { entered.resolve(); await released.promise }
    return append(id, owner, prefix, batch)
  }
  let sends = 0
  vi.stubGlobal('fetch', async () => { sends++; throw new Error('Unexpected network send') })
  const coordinator = createSessionCoordinator(backend, { lock: { enabled: true } }), { id } = await coordinator.create()
  const model = createOpenAICompatibleClient({ apiKey: 'fixture-only', model: 'main', baseUrl: 'https://promotion-generation.fixture.invalid' })
  const service = createSessionService({ workspace: root, coordinator, model, codeMode: { mode: 'off' }, modelActionTimeoutMs: 1000 })
  const assembly = entry === 'service' ? undefined : await service.assemblyFor(id)
  if (entry === 'runAdmitted') await assembly!.inbox.admit({ inputId: 'direct-admitted', text: 'Exact received text.', delivery: 'queue', intent: 'user', provenance: { kind: 'human', authority: 'request', scope: 'turn', producer: 'fixture.direct' } })
  const run = entry === 'service' ? service.submit(id, 'Exact received text.', new AbortController().signal)
    : entry === 'run' ? assembly!.agent.run('Exact received text.', new AbortController().signal)
    : assembly!.agent.runAdmitted!('Exact received text.', new AbortController().signal, undefined, 'direct-admitted')
  void run.catch(() => {})
  try {
    await Promise.race([entered.promise, run.then(() => { throw new Error('Turn ended without input promotion') })])
    const opened = service.liveSession(id)!.events.find(event => event.type === 'context/action' && event.op === 'open')
    expect(opened).toBeDefined()
    if (opened?.type !== 'context/action' || opened.op !== 'open') throw new Error('Missing action clock')
    await new Promise(resolve => setTimeout(resolve, Math.max(0, opened.expiresAt - Date.now() + 10)))
    released.resolve(); await expect(run).rejects.toThrow()
    const events = (await backend.read(id)).events
    expect(events.filter(event => event.type === 'agent/input/promoted')).toHaveLength(0)
    expect(events.filter(event => event.type === 'user/message')).toHaveLength(0)
    expect(sends).toBe(0)
  } finally { released.resolve(); await run.catch(() => {}); await service.close().catch(() => {}); await coordinator.close().catch(() => {}) }
})

it('an already issued promotion settles truthfully after Stop without replay, then a new explicit input remains usable', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ih-promotion-issued-')), backend = createJsonlBackend(root)
  const append = backend.appendOwnedBatch!.bind(backend), entered = Promise.withResolvers<void>(), released = Promise.withResolvers<void>()
  let held = false, transforms = 0, sends = 0
  backend.appendOwnedBatch = async (id, owner, prefix, batch) => {
    const outcome = await append(id, owner, prefix, batch)
    const frame = JSON.parse(Buffer.from(batch.bytes).toString('utf8'))
    if (!held && frame.events.some((event: { type: string; internal?: boolean }) => event.type === 'user/message' && !event.internal)) { held = true; entered.resolve(); await released.promise }
    return outcome
  }
  vi.stubGlobal('fetch', async (url: string) => { if (url !== 'https://issued-promotion.fixture.invalid/v1/chat/completions') throw new Error('Unexpected network destination'); sends++; return success() })
  const coordinator = createSessionCoordinator(backend, { lock: { enabled: true } }), { id } = await coordinator.create()
  const model = createOpenAICompatibleClient({ apiKey: 'fixture-only', model: 'main', baseUrl: 'https://issued-promotion.fixture.invalid' })
  const service = createSessionService({ workspace: root, coordinator, model, codeMode: { mode: 'off' }, transformPrompt: async (_assembly, text) => { transforms++; return 'derived ' + text } })
  const stop = new AbortController(), run = service.submit(id, '/issued', stop.signal); void run.catch(() => {})
  try {
    await Promise.race([entered.promise, run.then(() => { throw new Error('No held promotion') })])
    stop.abort(new Error('fixture Stop after irreversible write')); released.resolve()
    await expect(run).rejects.toThrow()
    const events = (await backend.read(id)).events
    expect(events.filter(event => event.type === 'agent/input/promoted')).toHaveLength(1)
    expect(events.filter(event => event.type === 'agent/input/preparation' && event.op === 'promoted')).toHaveLength(1)
    const messages = events.filter(event => event.type === 'user/message')
    expect(messages).toHaveLength(2); expect(messages[0]).toMatchObject({ text: '/issued', provenance: { kind: 'human', authority: 'request' } })
    expect(messages[1]).toMatchObject({ internal: true, provenance: { kind: 'plugin', authority: 'observation' } }); expect(messages[1]!.text).toContain('derived /issued')
    expect(transforms).toBe(1); expect(sends).toBe(0)
    await service.submit(id, 'new explicit input', new AbortController().signal)
    expect(sends).toBe(1); expect(transforms).toBe(2)
  } finally { released.resolve(); await run.catch(() => {}); await service.close().catch(() => {}); await coordinator.close().catch(() => {}) }
})


it('the actual guarded input-promotion capture rejects other families and accessors before dispatch or storage', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ih-promotion-family-')), backend = createJsonlBackend(root)
  const append = backend.appendOwnedBatch!.bind(backend)
  let writes = 0, reads = 0, guards = 0
  backend.appendOwnedBatch = async (...args) => { writes++; return append(...args) }
  const coordinator = createSessionCoordinator(backend, { lock: { enabled: true } }), { id } = await coordinator.create(), document = await coordinator.openManagedDocument(id)
  const action = document.beginAction(), before = writes
  const accessor = { kind: 'input-start', get message() { reads++; return { type: 'user/message', text: 'must never read' } } }
  const invalid = [accessor, { kind: 'metadata', event: { type: 'user/message', text: 'wrong family' } }, { kind: 'generation', events: [] }, { kind: 'context-reduction', action: {} }, { kind: 'input-start', message: { type: 'user/message', text: 'no closed preparation' } }]
  try {
    for (const value of invalid) {
      const captured = action.captureInputPromotion(value as never, () => { guards++; return true })
      expect(await captured.admit()).toMatchObject({ kind: 'not-issued', code: 'FACT_INVALID_GROUP' })
      expect(await captured.reconcile()).toMatchObject({ kind: 'not-issued', code: 'FACT_INVALID_GROUP' })
      expect(await captured.observe()).toMatchObject({ kind: 'not-issued', code: 'FACT_INVALID_GROUP' })
    }
    expect([reads, guards, writes - before]).toEqual([0, 0, 0])
    expect(document.view.events).toHaveLength(0)
  } finally { action.finish(); await coordinator.close().catch(() => {}) }
})

it.each(['immediate', 'late'] as const)('an uncertain issued promotion reconciles its original frame without a second transform or claim (%s)', async recovery => {
  const root = await mkdtemp(join(tmpdir(), 'ih-promotion-unknown-')), backend = createJsonlBackend(root)
  const append = backend.appendOwnedBatch!.bind(backend), reconcile = backend.reconcileOwnedBatch!.bind(backend)
  let transforms = 0, sends = 0, promotions = 0
  const issuedKeys: unknown[] = [], reconciledKeys: unknown[] = []
  let allowReconcile = recovery === 'immediate'
  backend.appendOwnedBatch = async (...args) => {
    const frame = JSON.parse(Buffer.from(args[3].bytes).toString('utf8'))
    const result = await append(...args)
    if (frame.events.some((event: { type: string; internal?: boolean }) => event.type === 'user/message' && !event.internal)) {
      promotions++
      if (promotions === 1) { issuedKeys.push(args[3].key); return { kind: 'unknown', key: args[3].key } }
    }
    return result
  }
  backend.reconcileOwnedBatch = async (...args) => { reconciledKeys.push(args[3].key); return allowReconcile ? reconcile(...args) : { kind: 'unknown', key: args[3].key } }
  vi.stubGlobal('fetch', async (url: string) => { if (url !== 'https://unknown-promotion.fixture.invalid/v1/chat/completions') throw new Error('Unexpected network destination'); sends++; return success() })
  const coordinator = createSessionCoordinator(backend, { lock: { enabled: true } }), { id } = await coordinator.create()
  const model = createOpenAICompatibleClient({ apiKey: 'fixture-only', model: 'main', baseUrl: 'https://unknown-promotion.fixture.invalid' })
  const service = createSessionService({ workspace: root, coordinator, model, codeMode: { mode: 'off' }, transformPrompt: async (_assembly, text) => { transforms++; return 'derived ' + text } })
  try {
    await expect(service.submit(id, '/unknown', new AbortController().signal)).rejects.toThrow()
    expect([transforms, sends, promotions]).toEqual([1, 0, 1])
    expect(reconciledKeys.length).toBeGreaterThan(0)
    expect(reconciledKeys.every(key => JSON.stringify(key) === JSON.stringify(issuedKeys[0]))).toBe(true)
    if (recovery === 'late') {
      expect((await backend.read(id)).events.filter(event => event.type === 'turn/end')).toHaveLength(0)
      allowReconcile = true
      const document = await coordinator.openManagedDocument(id)
      expect(await document.reconcile(issuedKeys[0] as import('@i-harness/core-session').BatchKey)).toMatchObject({ kind: 'committed' })
      await service.closeSession(id)
    }
    const events = (await backend.read(id)).events
    expect(events.filter(event => event.type === 'turn/start')).toHaveLength(1)
    expect(events.filter(event => event.type === 'turn/end')).toHaveLength(1)
    expect(events.filter(event => event.type === 'agent/input/promoted')).toHaveLength(1)
    expect(events.filter(event => event.type === 'agent/input/preparation' && event.op === 'promoted')).toHaveLength(1)
    await service.submit(id, 'new explicit input', new AbortController().signal)
    expect([transforms, sends, promotions]).toEqual([2, 1, 2])
  } finally { await service.close().catch(() => {}); await coordinator.close().catch(() => {}) }
})

it('a completed steer whose guarded promotion expires cannot poison the next explicit input or transform twice', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ih-steer-promotion-expiry-')), backend = createJsonlBackend(root)
  const append = backend.appendOwnedBatch!.bind(backend), resolverEntered = Promise.withResolvers<void>(), resolverRelease = Promise.withResolvers<void>(), entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>()
  backend.appendOwnedBatch = async (...args) => {
    const frame = JSON.parse(Buffer.from(args[3].bytes).toString('utf8'))
    if (frame.events.some((event: { type: string; inputId?: string }) => event.type === 'agent/input/promoted' && event.inputId === 'old-steer')) { entered.resolve(); await release.promise }
    return append(...args)
  }
  let sends = 0, transformations = 0
  vi.stubGlobal('fetch', async (url: string) => { if (url !== 'https://steer-promotion-expiry.fixture.invalid/v1/chat/completions') throw new Error('Unexpected network destination'); sends++; return success() })
  const coordinator = createSessionCoordinator(backend, { lock: { enabled: true } }), { id } = await coordinator.create()
  const model = createOpenAICompatibleClient({ apiKey: 'fixture-only', model: 'fixture', baseUrl: 'https://steer-promotion-expiry.fixture.invalid' })
  const service = createSessionService({ workspace: root, coordinator, codeMode: { mode: 'off' }, modelActionTimeoutMs: 1000, modelBindingFor: async () => { resolverEntered.resolve(); await resolverRelease.promise; return { status: 'ready', binding: { model, modelId: 'fixture', providerId: 'fixture', label: 'fixture' } } }, transformPrompt: async (_assembly, text) => { if (text === '/old-steer') { transformations++; return 'derived old steer' } return text } })
  const run = service.submit(id, 'original main request', new AbortController().signal); void run.catch(() => {})
  try {
    await resolverEntered.promise
    const inbox = await service.receivedInputFor(id)
    await inbox.admit({ inputId: 'old-steer', text: '/old-steer', delivery: 'steer', intent: 'user', preparationPolicy: 'human-host', provenance: { kind: 'human', authority: 'request', scope: 'turn', producer: 'desktop.input' } })
    resolverRelease.resolve(); await entered.promise
    const events = (await backend.read(id)).events, opened = events.find(event => event.type === 'context/action' && event.op === 'open')!
    if (opened.type !== 'context/action' || opened.op !== 'open') throw new Error('Missing actual generation')
    expect(events.filter(event => event.type === 'agent/input/preparation' && event.op === 'completed' && event.inputId === 'old-steer')).toHaveLength(1)
    await new Promise(resolve => setTimeout(resolve, Math.max(0, opened.expiresAt - Date.now() + 10)))
    release.resolve(); await expect(run).rejects.toThrow()
    expect(sends).toBe(0); expect(transformations).toBe(1)
    await service.submit(id, 'new explicit input', new AbortController().signal)
    expect(sends).toBe(1); expect(transformations).toBe(1)
    const final = (await backend.read(id)).events
    expect(final.filter(event => event.type === 'agent/input/promoted' && event.inputId === 'old-steer')).toHaveLength(0)
    expect(final.filter(event => event.type === 'agent/input/cancelled' && event.inputId === 'old-steer')).toHaveLength(1)
  } finally { resolverRelease.resolve(); release.resolve(); await run.catch(() => {}); await service.close().catch(() => {}); await coordinator.close().catch(() => {}) }
})

it.each(['committed', 'absent', 'absent-cancel-unknown'] as const)('uncertain steer promotion settles its exact original %s disposition before cleanup', async disposition => {
  const root = await mkdtemp(join(tmpdir(), 'ih-steer-promotion-unknown-')), backend = createJsonlBackend(root)
  const append = backend.appendOwnedBatch!.bind(backend), resolverEntered = Promise.withResolvers<void>(), resolverRelease = Promise.withResolvers<void>()
  let writes = 0, cancellations = 0, cancellationKey: import('@i-harness/core-session').BatchKey | undefined, transformations = 0, sends = 0
  backend.appendOwnedBatch = async (...args) => {
    const events = JSON.parse(Buffer.from(args[3].bytes).toString('utf8')).events as { type: string; inputId?: string }[]
    if (events.some(event => event.type === 'agent/input/promoted' && event.inputId === 'uncertain-steer')) {
      writes++
      if (disposition === 'committed') await append(...args)
      return { kind: 'unknown', key: args[3].key }
    }
    const outcome = await append(...args)
    if (events.some(event => event.type === 'agent/input/cancelled' && event.inputId === 'uncertain-steer')) {
      cancellations++
      if (disposition === 'absent-cancel-unknown') { cancellationKey = args[3].key; return { kind: 'unknown', key: args[3].key } }
    }
    return outcome
  }
  vi.stubGlobal('fetch', async (url: string) => { if (url !== 'https://steer-promotion-unknown.fixture.invalid/v1/chat/completions') throw new Error('Unexpected network destination'); sends++; return success() })
  const coordinator = createSessionCoordinator(backend, { lock: { enabled: true } }), { id } = await coordinator.create()
  const document = await coordinator.openManagedDocument(id), beginAction = document.beginAction.bind(document)
  let closeCaptures = 0
  vi.spyOn(document, 'beginAction').mockImplementation(signal => {
    const action = beginAction(signal), register = action.registerSettlementSource.bind(action)
    action.registerSettlementSource = (drain, reconcilePending) => {
      const source = register(drain, reconcilePending), capture = source.generation.capture.bind(source.generation)
      source.generation.capture = event => { if (event.op === 'close') closeCaptures++; return capture(event) }
      return source
    }
    return action
  })
  const model = createOpenAICompatibleClient({ apiKey: 'fixture-only', model: 'fixture', baseUrl: 'https://steer-promotion-unknown.fixture.invalid' })
  const service = createSessionService({ workspace: root, coordinator, codeMode: { mode: 'off' }, modelBindingFor: async () => { resolverEntered.resolve(); await resolverRelease.promise; return { status: 'ready', binding: { model, modelId: 'fixture', providerId: 'fixture', label: 'fixture' } } }, transformPrompt: async (_assembly, text) => { if (text === '/uncertain-steer') { transformations++; return 'derived uncertain steer' } return text } })
  const run = service.submit(id, 'original main request', new AbortController().signal); void run.catch(() => {})
  try {
    await resolverEntered.promise
    await (await service.receivedInputFor(id)).admit({ inputId: 'uncertain-steer', text: '/uncertain-steer', delivery: 'steer', intent: 'user', preparationPolicy: 'human-host', provenance: { kind: 'human', authority: 'request', scope: 'turn', producer: 'desktop.input' } })
    resolverRelease.resolve(); await expect(run).rejects.toThrow()
    expect([sends, transformations, writes]).toEqual([0, 1, 1])
    expect(closeCaptures).toBe(1)
    if (disposition === 'absent-cancel-unknown') {
      expect(cancellationKey).toBeDefined()
      await expect(service.submit(id, 'blocked until cancellation settles', new AbortController().signal)).rejects.toThrow()
      expect(sends).toBe(0)
      expect(await (await coordinator.openManagedDocument(id)).reconcile(cancellationKey!)).toMatchObject({ kind: 'committed' })
      await service.closeSession(id)
    }
    const events = (await backend.read(id)).events
    expect(events.filter(event => event.type === 'agent/input/promoted' && event.inputId === 'uncertain-steer')).toHaveLength(disposition === 'committed' ? 1 : 0)
    expect(events.filter(event => event.type === 'agent/input/cancelled' && event.inputId === 'uncertain-steer')).toHaveLength(disposition === 'committed' ? 0 : 1)
    await service.submit(id, 'new explicit input after settled promotion', new AbortController().signal)
    expect(sends).toBe(1); expect(transformations).toBe(1); expect(writes).toBe(1)
    expect(cancellations).toBe(disposition === 'committed' ? 0 : 1)
  } finally { resolverRelease.resolve(); await run.catch(() => {}); await service.close().catch(() => {}); await coordinator.close().catch(() => {}) }
})
