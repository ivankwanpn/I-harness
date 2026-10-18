import { afterEach, expect, it, vi } from 'vitest'
import { mkdtemp, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createSessionCoordinator } from '@i-harness/session-persistence'
import { createJsonlBackend } from '../../../packages/session-persistence-jsonl/src/index.ts'
import { controlledModel } from '../../../packages/session-executor/test/controlled-model.ts'
import { runHeadless } from '../src/run.ts'

const originalConfig = process.env.IH_CONFIG_DIR
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); if (originalConfig === undefined) delete process.env.IH_CONFIG_DIR; else process.env.IH_CONFIG_DIR = originalConfig })
it.each(['stop', 'expiry', 'lower-expiry', 'fifo', 'failure', 'delegated'] as const)('opens the actual oldest CLI origin before resolution and preserves %s', async mode => {
  const root = await mkdtemp(join(tmpdir(), 'ih-f4-cli-origin-')), config = join(root, 'config')
  await mkdir(config); process.env.IH_CONFIG_DIR = config
  const backend = createJsonlBackend(join(root, 'sessions')), coordinator = createSessionCoordinator(backend, { lock: { enabled: true } })
  const parent = mode === 'delegated' ? await coordinator.create() : undefined
  const { id } = await coordinator.create(parent ? { parentSession: parent.id, seedLength: 0, origin: 'subagent' } : undefined), document = await coordinator.openManagedDocument(id)
  await document.metadata.admit({ type: 'session/title', title: 'Existing fixture title', source: 'user', messageSeqs: [] })
  if (mode === 'fifo' || mode === 'failure' || mode === 'delegated') await document.inputs.admit({ type: 'agent/input/admitted', version: 1, inputId: 'older', text: 'older pending request', delivery: 'queue', intent: 'user', provenance: mode === 'delegated' ? { kind: 'inherited', authority: 'observation', scope: 'turn', producer: 'subagent.initial', originSessionId: parent!.id } : { kind: 'human', authority: 'request', scope: 'turn', producer: 'cli.prompt' } })
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>(), stop = new AbortController(), requests: string[] = []
  let monotonic = 100
  vi.spyOn(performance, 'now').mockImplementation(() => monotonic)
  const model = controlledModel(async function* (request) {
    requests.push(String(request.messages.findLast(message => message.role === 'user' && ['older pending request', 'new CLI request'].includes(String(message.content)))?.content))
    if (mode === 'failure') { yield { type: 'error', error: new Error('original pending request failed') }; return }
    yield { type: 'text/chunk', text: 'controlled answer' }; yield { type: 'end' }
  })
  const runtime = { resolveModel: async () => { entered.resolve(); await release.promise; return { status: 'ready' as const, binding: { client: model, providerId: 'fixture', modelId: 'fixture', label: 'Fixture', protocol: 'openai-compatible', contextWindow: 100000, maxOutputTokens: 2048 } } } } as unknown as import('@i-harness/provider-runtime').ProviderRuntime
  const running = runHeadless('new CLI request', { workspace: root, sessionId: id, coordinator, providerRuntime: runtime, signal: stop.signal, ...(mode === 'lower-expiry' ? { modelActionTimeoutMs: 1000, modelActionMaxAttempts: 1 } : {}) })
  try {
    await Promise.race([entered.promise, running.then(value => { throw new Error('Resolver was not reached: ' + value.error) })])
    const held = (await backend.read(id)).events, admissions = held.filter(event => event.type === 'agent/input/admitted'), opens = held.filter(event => event.type === 'context/action' && event.op === 'open')
    expect(admissions.map(event => event.text)).toEqual(mode === 'fifo' || mode === 'failure' || mode === 'delegated' ? ['older pending request', 'new CLI request'] : ['new CLI request'])
    expect(opens).toHaveLength(1)
    expect(opens[0]).toMatchObject({ origin: mode === 'delegated' ? { kind: 'delegated-input', ref: 'admitted', seq: admissions[0]!.seq, inputId: 'older' } : { kind: 'input', seq: admissions[0]!.seq }, purpose: 'main' })
    expect(held.some(event => event.type === 'agent/input/promoted' || event.type === 'context/attempt')).toBe(false)
    expect(requests).toEqual([])
    if (mode === 'stop') stop.abort(new Error('CLI Stop during original resolve'))
    if (mode === 'expiry') { expect(opens[0]!.expiresAt - opens[0]!.startedAt).toBe(3600000); monotonic += 3600000 }
    if (mode === 'lower-expiry') { expect(opens[0]!.expiresAt - opens[0]!.startedAt).toBe(1000); monotonic += 1000 }
    release.resolve()
    const result = await running
    if (mode === 'fifo' || mode === 'delegated') {
      expect(result.exitCode, result.error).toBe(0); expect(requests).toEqual(['older pending request', 'new CLI request'])
    } else {
      expect(result.exitCode).toBe(1)
      expect(requests).toHaveLength(mode === 'failure' ? 1 : 0)
      const final = (await backend.read(id)).events
      expect(final.filter(event => event.type === 'context/action' && event.op === 'open')).toHaveLength(1)
      expect(final.filter(event => event.type === 'context/action' && event.op === 'close')).toHaveLength(1)
      if (mode === 'failure') {
        expect(final.filter(event => event.type === 'agent/input/promoted')).toEqual([expect.objectContaining({ inputId: 'older' })])
        expect(final.filter(event => event.type === 'agent/input/cancelled')).toEqual([])
      } else expect(final.filter(event => event.type === 'agent/input/promoted')).toEqual([])
    }
  } finally { release.resolve(); await running; await coordinator.close().catch(() => {}) }
})


it.each([false, true])('uses one effective mock policy before ingress and title, explicit required=%s', async required => {
  const root = await mkdtemp(join(tmpdir(), 'ih-f4-cli-local-policy-')), config = join(root, 'config')
  await mkdir(config); process.env.IH_CONFIG_DIR = config
  const backend = createJsonlBackend(join(root, 'sessions')), coordinator = createSessionCoordinator(backend, { lock: { enabled: true } })
  const { id } = await coordinator.create(), script = [{ role: 'assistant' as const, text: 'ordinary local answer' }, { role: 'assistant' as const, text: 'Local title' }]
  const { createMockClient } = await import('@i-harness/llm-mock')
  let network = 0
  vi.stubGlobal('fetch', async () => { network++; throw new Error('Unexpected network destination') })
  const result = await runHeadless('literal local task', { workspace: root, sessionId: id, coordinator, mockScript: script, ...(required ? { modelPolicy: 'required' as const, model: createMockClient(script) } : {}) })
  try {
    expect(result.exitCode).toBe(required ? 1 : 0)
    const events = (await backend.read(id)).events
    expect(events.filter(event => event.type === 'context/attempt')).toEqual([])
    expect(network).toBe(0)
    if (required) expect(events.filter(event => event.type === 'context/action' && event.op === 'local-invocation')).toEqual([])
    else {
      expect(events.filter(event => event.type === 'context/action' && event.op === 'bind').map(event => event.executionDomain)).toEqual(['local-test', 'local-test'])
      expect(events.filter(event => event.type === 'context/action' && event.op === 'local-invocation')).toHaveLength(2)
      expect(events.find(event => event.type === 'session/title')).toMatchObject({ title: 'Local title', source: 'provider' })
    }
  } finally { await coordinator.close().catch(() => {}) }
})
