import { controlledModel } from '../../session-executor/test/controlled-model.ts'
import { expect, it, vi } from 'vitest'
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { isRpcSuccess, type RpcMessage } from '@i-harness/sdk'
import { createDesktopHost } from '../src/host.ts'

const captured = vi.hoisted(() => ({ coordinators: [] as import('@i-harness/session-persistence').SessionCoordinator[], services: [] as import('@i-harness/session-executor').SessionService[] }))
vi.mock('@i-harness/session-persistence', async importOriginal => {
  const actual = await importOriginal<typeof import('@i-harness/session-persistence')>()
  return { ...actual, createSessionCoordinator(...args: Parameters<typeof actual.createSessionCoordinator>) { const coordinator = actual.createSessionCoordinator(...args); captured.coordinators.push(coordinator); return coordinator } }
})
vi.mock('@i-harness/session-executor', async importOriginal => {
  const actual = await importOriginal<typeof import('@i-harness/session-executor')>()
  return { ...actual, createSessionService(...args: Parameters<typeof actual.createSessionService>) { const service = actual.createSessionService(...args); captured.services.push(service); return service } }
})

it('cancels the actual Gateway title action while its original profile lookup is held, before any title send', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ih-f1-gateway-title-')), workspace = join(root, 'workspace')
  await mkdir(workspace)
  const settingsPath = join(root, 'settings.json'), credentialsPath = join(root, 'credentials.json')
  await writeFile(settingsPath, JSON.stringify({ autoTitle: true, sandboxMode: 'read-only', compaction: { auto: false }, codeMode: { mode: 'off' }, llm: { providers: { fixture: { protocol: 'openai-completions', baseURL: 'http://127.0.0.1:1', apiKeyEnv: 'IH_TITLE_CONTROL_KEY', models: [{ id: 'fixture', contextWindow: 32000 }] } }, defaultModel: { provider: 'fixture', model: 'fixture' } } }))
  await writeFile(credentialsPath, JSON.stringify({ refs: { IH_TITLE_CONTROL_KEY: 'controlled' } }))
  const frames: RpcMessage[] = [], entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>()
  let main = 0, titles = 0, denied = 0, held = false
  const fetch = globalThis.fetch
  globalThis.fetch = async () => { denied++; throw new Error('No actual transport is authorized in Gateway title control') }
  let host: Awaited<ReturnType<typeof createDesktopHost>> | undefined
  let running: Promise<void> | undefined
  try {
    host = await createDesktopHost({ workspace, sessionDir: join(root, 'sessions'), settingsPath, credentialsPath, onWrite: frame => frames.push(frame), buildProviderClient: profile => {
      expect(profile.apiKey === 'controlled').toBe(true)
      return controlledModel(request => ({ async *stream(request) {
        request.signal?.throwIfAborted()
        request.validateBeforeTransport?.()
        if (request.systemPrompt.includes('You produce ONLY a short session title')) titles++
        else main++
        yield { type: 'text/chunk', text: 'controlled answer' }
        yield { type: 'end' }
      } } as import('@i-harness/llm-seam').ModelClient).stream(request))
    } })
    const request = (id: number, method: string, params: unknown) => host!.handleLine(JSON.stringify({ jsonrpc: '2.0', id, method, params }))
    await request(1, 'initialize', {})
    await request(2, 'session/create', {})
    const created = frames.find(frame => 'id' in frame && frame.id === 2)
    if (!isRpcSuccess(created)) throw new Error('Actual Gateway session creation failed')
    const id = (created.result as { sessionId: string }).sessionId, service = captured.services.at(-1)!, coordinator = captured.coordinators[0]!
    const assembly = await service.assemblyFor(id), begin = assembly.factOwner.beginAction.bind(assembly.factOwner), profile = coordinator.profile.bind(coordinator)
    let auxiliary: ReturnType<typeof begin> | undefined
    vi.spyOn(assembly.factOwner, 'beginAction').mockImplementation(signal => { const action = begin(signal); if (assembly.session.events.some(event => event.type === 'turn/end')) auxiliary = action; return action })
    vi.spyOn(coordinator, 'profile').mockImplementation(async sessionId => {
      const result = await profile(sessionId)
      if (!held && sessionId === id && assembly.session.events.some(event => event.type === 'turn/end')) { held = true; entered.resolve(); await release.promise }
      return result
    })
    running = request(3, 'session/prompt', { sessionId: id, prompt: 'original controlled prompt' })
    void running.catch(() => {})
    await Promise.race([entered.promise, running.then(() => { throw new Error('No actual title profile hold') })])
    expect(auxiliary).toBeDefined()
    await request(4, 'session/cancel', { sessionId: id })
    const cancelled = frames.find(frame => 'id' in frame && frame.id === 4)
    expect(cancelled).toMatchObject({ result: { cancelled: true } })
    expect(auxiliary!.signal.aborted).toBe(true)
    release.resolve()
    await running
    expect([main, titles, denied]).toEqual([1, 0, 0])
    expect(assembly.session.events.some(event => event.type === 'session/title')).toBe(false)
  } finally {
    release.resolve()
    await running?.catch(() => {})
    try { await host?.close() } finally { globalThis.fetch = fetch }
  }
})
