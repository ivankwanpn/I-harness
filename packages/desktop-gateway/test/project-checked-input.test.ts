import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import * as executor from '@i-harness/session-executor'
import type { SessionCoordinator } from '@i-harness/session-persistence'
import { INVALID_PARAMS, isRpcSuccess, type RpcMessage } from '@i-harness/sdk'
import { createSdkServer } from '@i-harness/sdk/server'
import { fromJSONL } from '@i-harness/core-session'
import { controlledModel } from '../../session-executor/test/controlled-model.ts'
import * as projectScope from '../src/project-scope.ts'
import { createDesktopHost } from '../src/host.ts'
import { createDesktopRouter, createGatewayWrite } from '../src/router.ts'
import type { DesktopHandlers } from '../src/types.ts'

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'ih-project-checked-input-'))
  const workspace = join(root, 'workspace'), other = join(root, 'other'), sessionDir = join(root, 'sessions')
  await Promise.all([mkdir(workspace), mkdir(other)])
  const settingsPath = join(root, 'settings.json'), credentialsPath = join(root, 'credentials.json')
  await writeFile(settingsPath, JSON.stringify({ autoTitle: false, sandboxMode: 'read-only', codeMode: { mode: 'off' },
    compaction: { auto: false }, llm: { providers: { fixture: { protocol: 'openai-completions', baseURL: 'http://127.0.0.1:1',
      apiKeyEnv: 'IH_PROJECT_CHECK_FIXTURE', models: [{ id: 'fixture', contextWindow: 32000 }] } },
    defaultModel: { provider: 'fixture', model: 'fixture' } } }))
  await writeFile(credentialsPath, JSON.stringify({ refs: { IH_PROJECT_CHECK_FIXTURE: 'fixture-only' } }))

  let coordinator: SessionCoordinator | undefined, service: executor.SessionService | undefined
  const makeProjectScope = projectScope.createProjectScopeBroker, makeService = executor.createSessionService
  const scopeFactory = vi.spyOn(projectScope, 'createProjectScopeBroker').mockImplementation((store, ...rest) => {
    coordinator = store
    return makeProjectScope(store, ...rest)
  })
  const serviceFactory = vi.spyOn(executor, 'createSessionService').mockImplementation(options => service = makeService(options))
  const frames: RpcMessage[] = []
  const produceReply = vi.fn(async function* () {
    yield { type: 'text/chunk' as const, text: 'fixture answer' }
    yield { type: 'end' as const }
  })
  let host: Awaited<ReturnType<typeof createDesktopHost>> | undefined
  async function close() {
    try { await host?.close() }
    finally { scopeFactory.mockRestore(); serviceFactory.mockRestore(); await rm(root, { recursive: true, force: true }) }
  }
  try {
    host = await createDesktopHost({ workspace, sessionDir, settingsPath, credentialsPath, sessionStore: 'jsonl',
      experimentalUsageObservations: false, onWrite: frame => frames.push(frame),
      buildProviderClient: (profile, model) => controlledModel(produceReply, { modelId: model ?? profile.defaultModel,
        providerId: profile.name, executionIdentity: profile.executionIdentity }) })
    if (!coordinator || !service) throw new Error('Missing real host owners')
    let serial = 0
    const call = async (method: string, params: unknown = {}) => {
      const id = ++serial
      await host!.handleLine(JSON.stringify({ jsonrpc: '2.0', id, method, params }))
      const reply = frames.findLast(frame => 'id' in frame && frame.id === id)
      if (!reply) throw Error(`Missing reply for ${method}`)
      return reply
    }
    const succeed = async (method: string, params?: unknown) => {
      const result = await call(method, params)
      if (!isRpcSuccess(result)) throw Error(JSON.stringify(result))
      return result.result
    }
    const saved = (id: string) => readFile(join(sessionDir, `${id}.jsonl`))
    const finished = async (id: string) => {
      const terminal = await vi.waitFor(() => {
        const reply = frames.findLast(frame => {
          if (!('method' in frame) || frame.method !== 'session/status') return false
          const { sessionId, status } = frame.params as { sessionId: string; status: string }
          return sessionId === id && (status === 'completed' || status === 'error')
        })
        expect(reply).toBeDefined()
        return reply
      }, { timeout: 20_000 })
      expect(terminal).toMatchObject({ params: { status: 'completed' } })
    }
    return { workspace, other, coordinator, service, produceReply, call, succeed, saved, finished, close }
  } catch (error) { await close(); throw error }
}

const submit = (sessionId: string, clientToken = 'checked-input-token') => ({ sessionId, clientToken, text: 'fixture input', delivery: 'queue' })

it('checks the original project root once before attaching public input and preserves durable retries', async () => {
  const f = await fixture()
  try {
    expect(await f.succeed('initialize')).toMatchObject({ capabilities: { 'desktop-input': ['1', 'project-checked'] } })
    await f.coordinator.create({ sessionId: 'visible' })
    await f.coordinator.create({ sessionId: 'review', origin: 'approval-review' })
    await f.coordinator.create({ sessionId: 'legacy' })
    await f.succeed('desktop/project/configure', { project: { id: 'p', name: 'Project', roots: [f.workspace], primaryRoot: f.workspace } })
    await f.succeed('desktop/session/project/bind', { sessionId: 'visible', projectId: 'p' })

    const visits: string[] = []
    const readProfile = f.coordinator.profile.bind(f.coordinator), prepareInput = f.service.managedInputFor!.bind(f.service)
    const profile = vi.spyOn(f.coordinator, 'profile').mockImplementation(async id => {
      if (id === 'visible') visits.push('profile')
      return readProfile(id)
    })
    const attach = vi.spyOn(f.service, 'managedInputFor').mockImplementation((id, options) => {
      if (id === 'visible') visits.push('attach')
      return prepareInput(id, options)
    })
    try {
      const before = await f.saved('review')
      expect(await f.call('desktop/session/input/submit', submit('review'))).toMatchObject({ error: { code: INVALID_PARAMS } })
      expect(attach).not.toHaveBeenCalled()
      expect(await f.saved('review')).toEqual(before)
      expect(f.produceReply).not.toHaveBeenCalled()

      const first = await f.succeed('desktop/session/input/submit', submit('visible'))
      expect(first).toMatchObject({ accepted: true, inputId: expect.any(String), delivery: 'queue' })
      const preparation = visits.indexOf('attach')
      expect(preparation).toBeGreaterThanOrEqual(0)
      expect(visits.slice(0, preparation)).toEqual(['profile'])
      await f.finished('visible')
      expect(await f.succeed('desktop/session/input/submit', submit('visible'))).toEqual(first)
      const saved = fromJSONL((await f.saved('visible')).toString()).events
      expect(saved.filter(event => event.type === 'agent/input/admitted')).toHaveLength(1)
      expect(saved.filter(event => event.type === 'assistant/message' && event.text === 'fixture answer')).toHaveLength(1)
      expect(f.produceReply).toHaveBeenCalledOnce()

      expect(await f.succeed('session/prompt', { sessionId: 'legacy', prompt: 'ordinary legacy prompt' })).toMatchObject({ ok: true })
      expect(f.produceReply).toHaveBeenCalledTimes(2)
    } finally { profile.mockRestore(); attach.mockRestore() }
  } finally { await f.close() }
}, 45_000)

it('refuses public input during a project move and accepts it after the new scope is saved', async () => {
  const f = await fixture()
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>()
  let moving: Promise<unknown> | undefined
  try {
    await f.succeed('initialize')
    await f.coordinator.create({ sessionId: 'moving' })
    for (const [id, roots] of [['p', [f.workspace]], ['q', [f.workspace, f.other]]] as const) {
      await f.succeed('desktop/project/configure', { project: { id, name: id, roots, primaryRoot: f.workspace } })
    }
    await f.succeed('desktop/session/project/bind', { sessionId: 'moving', projectId: 'p' })
    const before = await f.saved('moving')
    const adopt = f.coordinator.adoptOwnership.bind(f.coordinator)
    const holding = vi.spyOn(f.coordinator, 'adoptOwnership').mockImplementation(async id => {
      if (id === 'moving') { entered.resolve(); await release.promise }
      return adopt(id)
    })
    try {
      moving = f.succeed('desktop/session/batch', { command: { action: 'move', sessionIds: ['moving'], projectId: 'q', expectedOwners: { moving: 'p' } } })
      const reachedFence = await Promise.race([entered.promise.then(() => true), moving.then(() => false)])
      expect(reachedFence).toBe(true)
      expect(await f.call('desktop/session/input/submit', submit('moving'))).toMatchObject({ error: { code: INVALID_PARAMS } })
      expect(await f.saved('moving')).toEqual(before)
      expect(f.produceReply).not.toHaveBeenCalled()
    } finally { release.resolve(); holding.mockRestore() }
    expect(await moving).toMatchObject({ results: [{ sessionId: 'moving', ok: true }] })
    expect(await f.succeed('desktop/session/project/state', { sessionId: 'moving' })).toMatchObject({ projectId: 'q' })
    expect(await f.succeed('desktop/session/input/submit', submit('moving'))).toMatchObject({ accepted: true })
    await f.finished('moving')
    expect(f.produceReply).toHaveBeenCalledOnce()
  } finally { release.resolve(); await moving?.catch(() => {}); await f.close() }
}, 45_000)

it('keeps the unchecked input handler on the original v1 capability and call shape', async () => {
  const frames: RpcMessage[] = []
  const service = executor.createSessionService({ workspace: process.cwd(), modelPolicy: 'required' })
  const admit = vi.fn(async () => ({ accepted: true, inputId: 'old-input', delivery: 'queue' }))
  const handlers: DesktopHandlers = { input: { admit } as unknown as NonNullable<DesktopHandlers['input']> }
  const send = (frame: RpcMessage) => frames.push(frame)
  const router = createDesktopRouter(createSdkServer(service, { onWrite: createGatewayWrite(send, handlers) }), send, handlers)
  try {
    await router.handleLine(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }))
    expect(frames.at(-1)).toMatchObject({ result: { capabilities: { 'desktop-input': ['1'] } } })
    await router.handleLine(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'desktop/session/input/submit', params: submit('plain') }))
    expect(admit).toHaveBeenCalledExactlyOnceWith('plain', { text: 'fixture input', delivery: 'queue', clientToken: 'checked-input-token' })
    expect(frames.at(-1)).toMatchObject({ result: { accepted: true, inputId: 'old-input' } })
  } finally { await router.close(); await service.close() }
})
