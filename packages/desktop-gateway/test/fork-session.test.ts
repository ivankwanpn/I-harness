import { expect, it, vi } from 'vitest'
import { mkdtemp, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createSessionCoordinator, createForkSessionController, createForkOperation, ForkOperationError, type ExistingSessionBindingObservation } from '@i-harness/session-persistence'
import { createJsonlBackend } from '@i-harness/session-persistence-jsonl'
import { createProjectScopeBroker } from '../src/project-scope.ts'
import { createNativeContextRuntime } from '../src/context-runtime.ts'
import { createResultObservationScope, legacyObservationFor, createSessionService, createDurableSessionLoader, createCliForkHost, type ResultObservationScope, type ResultObservationCapture } from '@i-harness/session-executor'
import { createSdkServer } from '@i-harness/sdk/server'
import { createDesktopRouter, createGatewayWrite } from '../src/router.ts'
import { createSessionManagement } from '../src/session-management.ts'
import { createSessionManagementFence } from '../src/session-management-fence.ts'
import { controlledModel } from '../../session-executor/test/controlled-model.ts'
import type { DesktopHandlers } from '../src/types.ts'
import type { RpcMessage } from '@i-harness/sdk'
import { createDesktopHost } from '../src/host.ts'
import { writeFile, readFile } from 'node:fs/promises'
import { createGatewayForkFixture } from './helpers/fork-fixture.ts'
import * as gatewayFork from '../src/fork-session.ts'

// Until the production adapter exists, exercise the unchanged original call
// inside the real owner callback so RED records the actual policy reentry.
function observed<T>(broker: ReturnType<typeof createProjectScopeBroker>, ids: readonly string[], observation: ExistingSessionBindingObservation, use: () => Promise<T>): Promise<T> {
  const run = Reflect.get(broker, 'withBindingObservation') as undefined | (<R>(ids: readonly string[], observation: ExistingSessionBindingObservation, use: () => Promise<R>) => Promise<R>)
  return run ? run(ids, observation, use) : use()
}

it('uses the actual held broker metadata/binding and complete inherited lineage without profile/document recursion', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ih-c-broker-')), workspace = join(root, 'workspace'); await mkdir(workspace)
  const c = createSessionCoordinator(createJsonlBackend(join(root, 'sessions')), { lock: { enabled: true } })
  const broker = createProjectScopeBroker(c, workspace), project = { id: 'p', name: 'Project', roots: [workspace], primaryRoot: workspace }
  let escaped!: () => unknown
  try {
    await c.create({ sessionId: 'source' }); await c.create({ sessionId: 'child', origin: 'subagent', subagentProtocolVersion: 1, parentSession: 'source' })
    await broker.configure(project); await broker.bind('source', 'p')
    await c.withExistingSessionBindingObservation!({ sessionIds: ['child', 'source'] }, observation => observed(broker, ['child', 'source'], observation, async () => {
      const profile = vi.spyOn(c, 'profile').mockRejectedValue(new Error('observed source profile recursion'))
      const document = vi.spyOn(c, 'getDocument').mockRejectedValue(new Error('observed binding recursion'))
      try {
        expect(await broker.nativeScopeFor('child')).toMatchObject({ projectId: 'p', scope: { id: 'p', roots: project.roots } })
        const getter = await broker.resultReadScopeFor('child')
        expect(getter).toBeTypeOf('function'); escaped = getter!
        expect(getter!()).toMatchObject({ projectId: 'p', scope: { id: 'p' } })
        expect(profile).not.toHaveBeenCalled(); expect(document).not.toHaveBeenCalled()
        expect(Reflect.get(broker, 'withBindingObservation')).toBeTypeOf('function')
      } finally { profile.mockRestore(); document.mockRestore() }
    }))
    expect(() => escaped()).toThrow(/expired|revoked/i)
    await c.withExistingSessionBindingObservation!({ sessionIds: ['child'] }, observation => observed(broker, ['child'], observation,
      () => expect(broker.nativeScopeFor('child')).rejects.toThrow(/held|observ|lineage/i)))
  } finally { await broker.close(); await c.close() }
})

it('refuses a genuinely pending broker operation instead of waiting behind its held observation', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ih-c-broker-pending-')), workspace = join(root, 'workspace'); await mkdir(workspace)
  const c = createSessionCoordinator(createJsonlBackend(join(root, 'sessions')), { lock: { enabled: true } })
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>(), start = Promise.withResolvers<void>()
  let hold = false
  const broker = createProjectScopeBroker(c, workspace, async () => { if (hold) { entered.resolve(); await release.promise } return true })
  const external = start.promise.then(() => broker.bind('source', 'p')); void external.catch(() => {})
  try {
    await c.create({ sessionId: 'source' }); await broker.configure({ id: 'p', name: 'P', roots: [workspace], primaryRoot: workspace }); await broker.bind('source', 'p')
    await expect(c.withExistingSessionBindingObservation!({ sessionIds: ['source'] }, observation => observed(broker, ['source'], observation, async () => {
      const getter = (await broker.resultReadScopeFor('source'))!
      hold = true; start.resolve(); await entered.promise
      expect(() => getter()).toThrow(/pending|changed|revoked/i)
      await expect(broker.nativeScopeFor('source')).rejects.toThrow(/pending|changed|revoked/i)
    }))).rejects.toThrow(/pending|changed|revoked/i)
  } finally { release.resolve(); start.resolve(); await external; await broker.close(); await c.close() }
})

it('native runtime reads actual managed and typed legacy bodies under original held source policy', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ih-c-native-observed-')), workspace = join(root, 'workspace'); await mkdir(workspace)
  const c = createSessionCoordinator(createJsonlBackend(join(root, 'sessions')), { lock: { enabled: true } })
  const broker = createProjectScopeBroker(c, workspace)
  await c.create({ sessionId: 'source' }); await broker.configure({ id: 'p', name: 'P', roots: [workspace], primaryRoot: workspace }); await broker.bind('source', 'p')
  const runtime = await createNativeContextRuntime({ workspace, storageRoot: join(root, 'native'), coordinator: c,
    projectFor: broker.nativeScopeFor, resultReadScopeFor: broker.resultReadScopeFor,
    ...{ withBindingObservation: broker.withBindingObservation },
    visibleRefsFor: async () => { throw new Error('public visibility fallback') } })
  try {
    const owner = runtime.contextOutput; await owner.configure({ enabled: true })
    const source = await runtime.sourceFor('source')
    const ref = await owner.capture({ sessionId: 'source', callId: 'legacy', label: 'real', text: 'VISIBLE native legacy', complete: true, source })
    if (!ref) throw new Error('Actual native legacy capture refused')
    const scope = owner.registerResultScope({ operationId: 'real-managed', sessionId: 'source', callId: 'managed', source }, () => true)
    const sink = await owner.beginResult(scope, 'text-utf8-v1'); await sink.write(Buffer.from('VISIBLE native managed'))
    const saved = await sink.finish('complete'); if (saved.kind !== 'committed') throw new Error('Actual native managed capture refused')
    await c.append('source', [{ type: 'context/result-ref', ref }])
    const document = await c.openManagedDocument('source')
    const fallback = createResultObservationScope()
    const observations = (Reflect.get(runtime, 'observations') as ResultObservationScope | undefined) ?? fallback
    await c.withExistingSessionBindingObservation!({ sessionIds: ['source'] }, observation => {
      const capture = { sessionId: 'source', sessionIds: ['source'], observation, document, assertHostCurrent() {} }
      const use = async () => {
        const profile = vi.spyOn(c, 'profile').mockRejectedValue(new Error('native observed profile recursion'))
        const getDocument = vi.spyOn(c, 'getDocument').mockRejectedValue(new Error('native observed binding recursion'))
        const originalSnapshot = c.snapshot, snapshot = vi.fn(async () => { throw new Error('native snapshot fallback') }); c.snapshot = snapshot
        try {
          expect(await runtime.sourceFor('source')).toEqual(source)
          expect(await owner.readResult({ sessionId: 'source' }, { ref: saved.ref })).toMatchObject({ data: { text: 'VISIBLE native managed' } })
          const read = legacyObservationFor(observations.current('source')!)
          expect((await owner.readLegacyObserved({ sessionId: 'source' }, { refId: ref.id }, read)).text).toBe('VISIBLE native legacy')
          expect((await owner.searchLegacyObserved({ sessionId: 'source' }, { query: 'VISIBLE' }, read)).hits.map(hit => hit.ref.id)).toEqual([ref.id])
          expect(profile).not.toHaveBeenCalled(); expect(getDocument).not.toHaveBeenCalled(); expect(snapshot).not.toHaveBeenCalled()
          expect(Reflect.get(runtime, 'withResultObservation')).toBeTypeOf('function')
        } finally { profile.mockRestore(); getDocument.mockRestore(); c.snapshot = originalSnapshot }
      }
      const run = Reflect.get(runtime, 'withResultObservation') as undefined | (<T>(capture: Omit<ResultObservationCapture, 'currentSource'>, use: () => Promise<T>) => Promise<T>)
      return run ? run(capture, use) : broker.withBindingObservation(['source'], observation, () => fallback.run({ ...capture, currentSource: () => source }, use))
    })
    await runtime.withLegacyReadObservation({ sessionId: 'source' }, async read => {
      const profile = vi.spyOn(c, 'profile').mockRejectedValue(new Error('strict reader policy recursion'))
      try {
        expect((await owner.readLegacyObserved({ sessionId: 'source' }, { refId: ref.id }, read)).text).toBe('VISIBLE native legacy')
        expect((await owner.searchLegacyObserved({ sessionId: 'source' }, { query: 'VISIBLE' }, read)).hits.map(hit => hit.ref.id)).toEqual([ref.id])
        expect(profile).not.toHaveBeenCalled()
      } finally { profile.mockRestore() }
    })
    await expect(runtime.withLegacyReadObservation({ sessionId: 'source' }, async read => {
      expect((await document.metadata.admit({ type: 'plan/mode', mode: 'on' })).kind).toBe('committed')
      return owner.searchLegacyObserved({ sessionId: 'source' }, { query: 'VISIBLE' }, read)
    })).rejects.toThrow(/view changed/)
  } finally { await runtime.close(); await broker.close(); await c.close() }
})

it('project withdrawal and restoration cannot revive an original held broker getter', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ih-c-broker-aba-')), workspace = join(root, 'workspace'); await mkdir(workspace)
  const c = createSessionCoordinator(createJsonlBackend(join(root, 'sessions')), { lock: { enabled: true } }), broker = createProjectScopeBroker(c, workspace)
  const project = { id: 'p', name: 'P', roots: [workspace], primaryRoot: workspace }
  try {
    await c.create({ sessionId: 'source' }); await broker.configure(project); await broker.bind('source', 'p')
    await expect(c.withExistingSessionBindingObservation!({ sessionIds: ['source'] }, observation => broker.withBindingObservation(['source'], observation, async () => {
      const original = (await broker.resultReadScopeFor('source'))!
      expect(original()).toMatchObject({ projectId: 'p' })
      await broker.revoke('p'); await broker.configure(project)
      expect(() => original()).toThrow(/changed|revoked/)
    }))).rejects.toThrow(/changed|revoked/)
    expect((await broker.resultReadScopeFor('source'))!()).toMatchObject({ projectId: 'p' })
  } finally { await broker.close(); await c.close() }
})

async function routerFixture() {
  const root = await mkdtemp(join(tmpdir(), 'ih-c-router-')), c = createSessionCoordinator(createJsonlBackend(join(root, 'sessions')), { lock: { enabled: true } })
  await c.create({ sessionId: 'source' }); await c.append('source', [{ type: 'turn/start' }, { type: 'user/message', text: 'completed source' }, { type: 'turn/end' }])
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>(), fence = createSessionManagementFence()
  const service = createSessionService({ workspace: root, coordinator: c, sessionFor: createDurableSessionLoader(c), sessionOperation: fence,
    model: controlledModel(async function* () { entered.resolve(); await release.promise; yield { type: 'text/chunk', text: 'original input' }; yield { type: 'end' } }), approveAll: true, codeMode: { mode: 'off' } })
  const manager = createSessionManagement(c, service, undefined, { fence }), handlers: DesktopHandlers = { sessions: manager }
  // The accepted full CLI host isolates the router's source-only gate. The
  // decisive Gateway project/result fixture separately uses its native host.
  const controller = createForkSessionController(c, createCliForkHost({ workspace: root, coordinator: c }))
  const sent: RpcMessage[] = [], send = (frame: RpcMessage) => { sent.push(frame) }
  const base = createSdkServer(service, { coordinator: c, onWrite: createGatewayWrite(send, handlers), prepareForkSession: input => controller.prepare(input), executeForkSession: (input, control) => controller.execute(input, control) })
  const router = createDesktopRouter(base, send, handlers)
  let serial = 0, captures = 0
  const capture = c.bootstrapSemanticTargetWithCapture!.bind(c)
  c.bootstrapSemanticTargetWithCapture = (input, guards, use) => capture(input, guards, async () => { captures++; return use() })
  const call = async (method: string, params: unknown = {}) => {
    const id = ++serial
    await router.handleLine(JSON.stringify({ jsonrpc: '2.0', id, method, params }))
    return sent.findLast(frame => 'id' in frame && frame.id === id) as { result?: any; error?: { code: number; message: string } }
  }
  await call('initialize')
  return { c, service, manager, call, captures: () => captures, entered: entered.promise, release: () => release.resolve(), async close() { release.resolve(); await router.close(); await controller.close(); await service.close(); await c.close() } }
}

it('Gateway router refuses new source work before reservation while the real prompt is active', async () => {
  const f = await routerFixture()
  let prompt: ReturnType<typeof f.call> | undefined
  try {
    const prepared = (await f.call('session/fork/prepare', { version: 1, sourceSessionId: 'source' })).result
    if (prepared.kind !== 'prepared') throw new Error('Actual preparation refused')
    const operation = createForkOperation(prepared.prepared, { operationId: 'busy-first', targetSessionId: 'child', createdAt: new Date().toISOString() })
    prompt = f.call('session/prompt', { sessionId: 'source', prompt: 'held real input' }); await f.entered
    const reply = await f.call('session/fork/begin', { operation })
    console.info(JSON.stringify({ control: 'Gateway real busy before reservation', reply, captures: f.captures(), sessions: await f.c.list() }))
    expect(reply.result).toMatchObject({ kind: 'not-issued', reason: 'busy' })
    expect(f.captures()).toBe(0); expect(await f.c.list()).toEqual(['source'])
  } finally { f.release(); await prompt; await f.close() }
})

it('Gateway retires old raw manage fork before the actual manager can create a target', async () => {
  const f = await routerFixture(), mutation = vi.spyOn(f.manager, 'mutate')
  try {
    const reply = await f.call('desktop/session/manage', { sessionId: 'source', action: 'fork' })
    console.info(JSON.stringify({ control: 'Gateway raw manage fork retirement', reply, mutations: mutation.mock.calls.length, sessions: await f.c.list() }))
    expect(reply.error).toBeDefined(); expect(mutation).not.toHaveBeenCalled(); expect(await f.c.list()).toEqual(['source'])
  } finally { await f.close() }
})

it('actual Desktop host wires new Gateway fork routes and nested recovery without provider assembly', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ih-c-real-host-')), workspace = join(root, 'workspace'), sessionDir = join(root, 'sessions'), settingsPath = join(root, 'settings.json')
  await mkdir(workspace); await writeFile(settingsPath, '{}')
  const seed = createSessionCoordinator(createJsonlBackend(sessionDir), { lock: { enabled: true } })
  await seed.create({ sessionId: 'source' }); await seed.append('source', [{ type: 'turn/start' }, { type: 'user/message', text: 'real Gateway source' }, { type: 'turn/end' }]); await seed.close()
  const original = await readFile(join(sessionDir, 'source.jsonl')), frames: RpcMessage[] = []
  let builds = 0, serial = 0
  const host = await createDesktopHost({ workspace, sessionDir, settingsPath, onWrite: frame => frames.push(frame), buildProviderClient() { builds++; throw new Error('Fork must not assemble a provider') } })
  const call = async (method: string, params: unknown = {}) => {
    const id = ++serial; await host.handleLine(JSON.stringify({ jsonrpc: '2.0', id, method, params }))
    const frame = frames.findLast(frame => 'id' in frame && frame.id === id) as { result?: any; error?: unknown }
    if (frame.error) throw new Error(JSON.stringify(frame.error))
    return frame.result
  }
  try {
    expect((await call('initialize')).capabilities['session-fork-bootstrap']).toEqual(['1'])
    await call('desktop/project/configure', { project: { id: 'p', name: 'P', roots: [workspace], primaryRoot: workspace } })
    await call('desktop/session/project/bind', { sessionId: 'source', projectId: 'p' })
    const prepared = await call('session/fork/prepare', { version: 1, sourceSessionId: 'source' })
    if (prepared.kind !== 'prepared') throw new Error('Real host preparation refused')
    const operation = createForkOperation(prepared.prepared, { operationId: 'real-gateway', targetSessionId: 'child', createdAt: new Date().toISOString() })
    expect(await call('session/fork/begin', { operation })).toMatchObject({ kind: 'ready', sessionId: 'child' })
    const nested = await call('session/fork/prepare', { version: 1, sourceSessionId: 'child' })
    if (nested.kind !== 'prepared') throw new Error('Nested real host preparation refused')
    const grandchild = createForkOperation(nested.prepared, { operationId: 'real-gateway-nested', targetSessionId: 'grandchild', createdAt: new Date().toISOString() })
    expect(await call('session/fork/begin', { operation: grandchild })).toMatchObject({ kind: 'ready', sessionId: 'grandchild' })
    expect(await call('session/fork/retry', { operation })).toMatchObject({ kind: 'adopted', sessionId: 'child' })
    expect(builds).toBe(0); expect(await readFile(join(sessionDir, 'source.jsonl'))).toEqual(original)
  } finally { await host.close() }
})

it('the original confirmed target scope stays revoked after project ABA and same-operation recovery uses a fresh real scope', async () => {
  const f = await createGatewayForkFixture(), entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>()
  const original = f.runtime.prepareBootstrapTransfer.bind(f.runtime)
  let held = false, get!: () => unknown, captures = 0
  const capture = f.coordinator.bootstrapSemanticTargetWithCapture!.bind(f.coordinator)
  f.coordinator.bootstrapSemanticTargetWithCapture = (input, guards, use) => capture(input, guards, async () => { captures++; return use() })
  vi.spyOn(f.runtime, 'prepareBootstrapTransfer').mockImplementation((...args) => {
    const transfer = original(...args), confirm = transfer.targetPreparation.confirm.bind(transfer.targetPreparation)
    expect(() => transfer.targetScope()).toThrow()
    transfer.targetPreparation.confirm = async (...args) => {
      const result = await confirm(...args)
      if (!held && result.kind === 'confirmed') {
        held = true; get = () => transfer.targetScope()
        expect(get()).toMatchObject({ projectId: 'p' }); entered.resolve(); await release.promise
      }
      return result
    }
    return transfer
  })
  let running: ReturnType<typeof f.controller.execute> | undefined
  try {
    await f.coordinator.append('source', [{ type: 'turn/start' }, { type: 'user/message', text: 'scope source' }, { type: 'turn/end' }])
    const operation = await f.prepare('source', 'child', 'target-scope-aba')
    running = f.controller.execute({ operation, mode: 'begin' }); void running.catch(() => {})
    await entered.promise
    await f.projects.revoke('p'); expect(() => get()).toThrow()
    await f.projects.configure(f.project); expect(() => get()).toThrow()
    release.resolve()
    const failure = await running.catch(error => error)
    expect(failure).toBeInstanceOf(ForkOperationError)
    expect(failure.hostError).toMatchObject({ reason: 'internal', capture: 'unknown', lastOutcome: { kind: 'blocked', reason: 'dependency-unavailable' } })
    expect(captures).toBe(1)
    expect((await f.execute(operation, 'retry')).kind).toBe('ready')
    expect(captures).toBe(1); expect(() => get()).toThrow()
  } finally { release.resolve(); await running?.catch(() => {}); await f.close() }
})

it.each(['prepare', 'target'] as const)('Gateway router repeated close joins the exact admitted %s request', async phase => {
  const f = await createGatewayForkFixture(), entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>()
  await f.coordinator.append('source', [{ type: 'turn/start' }, { type: 'user/message', text: 'whole request' }, { type: 'turn/end' }])
  let calls = 0, running: Promise<unknown> | undefined, closing: Promise<void> | undefined, second: Promise<void> | undefined
  if (phase === 'prepare') {
    const prepare = f.host.resolvePreparation.bind(f.host)
    f.host.resolvePreparation = async (...args) => { calls++; entered.resolve(); await release.promise; return prepare(...args) }
  } else {
    const target = f.host.withReadyTarget.bind(f.host)
    f.host.withReadyTarget = async (...args) => { calls++; entered.resolve(); await release.promise; return target(...args) }
  }
  try {
    if (phase === 'prepare') running = f.call('session/fork/prepare', { version: 1, sourceSessionId: 'source' })
    else running = f.execute(await f.prepare('source', 'child', 'whole-target'))
    await entered.promise
    let firstDone = false, secondDone = false
    closing = f.router.close(); void closing.then(() => { firstDone = true })
    await new Promise(resolve => setTimeout(resolve, 0))
    second = f.router.close(); void second.then(() => { secondDone = true })
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(firstDone).toBe(false); expect(secondDone).toBe(false)
    release.resolve(); expect(await running).toMatchObject({ kind: phase === 'prepare' ? 'prepared' : 'ready' })
    await closing; await second; expect(calls).toBe(1)
  } finally { release.resolve(); await running?.catch(() => {}); await closing; await second; await f.close() }
})

it('Gateway actual host rejects reentrant close before retiring its own real preparation', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ih-c-self-host-')), workspace = join(root, 'workspace'), sessionDir = join(root, 'sessions'), settingsPath = join(root, 'settings.json')
  await mkdir(workspace); await writeFile(settingsPath, '{}')
  const seed = createSessionCoordinator(createJsonlBackend(sessionDir), { lock: { enabled: true } })
  await seed.create({ sessionId: 'source' }); await seed.close()
  const original = gatewayFork.createGatewayForkHost, frames: RpcMessage[] = []
  let host!: Awaited<ReturnType<typeof createDesktopHost>>, selfError: unknown
  const factory = vi.spyOn(gatewayFork, 'createGatewayForkHost').mockImplementation(options => {
    const actual = original(options), prepare = actual.resolvePreparation.bind(actual)
    actual.resolvePreparation = async (...args) => {
      try { await host.close() } catch (error) { selfError = error }
      return prepare(...args)
    }
    return actual
  })
  try {
    host = await createDesktopHost({ workspace, sessionDir, settingsPath, onWrite: frame => frames.push(frame) })
    await host.handleLine(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }))
    await host.handleLine(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'session/fork/prepare', params: { version: 1, sourceSessionId: 'source' } }))
    console.info(JSON.stringify({ control: 'actual Gateway host reentrant close', selfError: selfError instanceof Error ? { name: selfError.name, message: selfError.message } : selfError, reply: frames.find(frame => 'id' in frame && frame.id === 2) }))
    expect(selfError).toMatchObject({ message: expect.stringMatching(/own/) })
    expect(frames.find(frame => 'id' in frame && frame.id === 2)).toMatchObject({ result: { kind: 'prepared' } })
    await host.handleLine(JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'session/status', params: { sessionId: 'source' } }))
    expect(frames.find(frame => 'id' in frame && frame.id === 3)).toMatchObject({ result: { running: false, queued: 0 } })
  } finally { factory.mockRestore(); await host?.close() }
})

async function actualHostFixture(configure: (host: ReturnType<typeof gatewayFork.createGatewayForkHost>, owners: Parameters<typeof gatewayFork.createGatewayForkHost>[0]) => void) {
  const root = await mkdtemp(join(tmpdir(), 'ih-c-owned-host-')), workspace = join(root, 'workspace'), sessionDir = join(root, 'sessions'), settingsPath = join(root, 'settings.json')
  await mkdir(workspace); await writeFile(settingsPath, '{}')
  const seed = createSessionCoordinator(createJsonlBackend(sessionDir), { lock: { enabled: true } })
  await seed.create({ sessionId: 'source' }); await seed.append('source', [{ type: 'turn/start' }, { type: 'user/message', text: 'actual lifetime source' }, { type: 'turn/end' }]); await seed.close()
  const original = gatewayFork.createGatewayForkHost, frames: RpcMessage[] = []
  const factory = vi.spyOn(gatewayFork, 'createGatewayForkHost').mockImplementation(options => { const host = original(options); configure(host, options); return host })
  let host: Awaited<ReturnType<typeof createDesktopHost>>
  try { host = await createDesktopHost({ workspace, sessionDir, settingsPath, onWrite: frame => frames.push(frame) }) }
  catch (error) { factory.mockRestore(); throw error }
  let serial = 0
  const call = async (method: string, params: unknown = {}) => {
    const id = ++serial; await host.handleLine(JSON.stringify({ jsonrpc: '2.0', id, method, params }))
    return frames.find(frame => 'id' in frame && frame.id === id) as { result?: any; error?: { code: number; data?: any } }
  }
  await call('initialize'); await call('desktop/project/configure', { project: { id: 'p', name: 'P', roots: [workspace], primaryRoot: workspace } }); await call('desktop/session/project/bind', { sessionId: 'source', projectId: 'p' })
  return { host, root, sessionDir, frames, call, async prepare() {
    const reply = await call('session/fork/prepare', { version: 1, sourceSessionId: 'source' })
    if (reply.result?.kind !== 'prepared') throw new Error('Actual lifetime preparation refused: ' + JSON.stringify(reply))
    return createForkOperation(reply.result.prepared, { operationId: 'actual-host-lifetime', targetSessionId: 'child', createdAt: new Date().toISOString() })
  }, async close() { try { await host.close() } finally { factory.mockRestore() } } }
}

it.each(['prepare', 'target'] as const)('actual Gateway host retains project/native/coordinator owners through held %s cleanup', async phase => {
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>()
  let nativeCloses = 0, projectCloses = 0, coordinatorCloses = 0, callbacks = 0
  const f = await actualHostFixture((host, owners) => {
    const nativeClose = owners.nativeContext.close.bind(owners.nativeContext), projectClose = owners.projects.close.bind(owners.projects), coordinatorClose = owners.coordinator.close.bind(owners.coordinator)
    owners.nativeContext.close = async () => { nativeCloses++; return nativeClose() }
    owners.projects.close = async () => { projectCloses++; return projectClose() }
    owners.coordinator.close = async () => { coordinatorCloses++; return coordinatorClose() }
    if (phase === 'prepare') { const original = host.resolvePreparation.bind(host); host.resolvePreparation = async (...args) => { callbacks++; entered.resolve(); await release.promise; return original(...args) } }
    else { const original = host.withReadyTarget.bind(host); host.withReadyTarget = async (...args) => { callbacks++; entered.resolve(); await release.promise; return original(...args) } }
  })
  let running: ReturnType<typeof f.call> | undefined, closing: Promise<void> | undefined
  try {
    if (phase === 'prepare') running = f.call('session/fork/prepare', { version: 1, sourceSessionId: 'source' })
    else running = f.call('session/fork/begin', { operation: await f.prepare() })
    await entered.promise
    let closed = false; closing = f.host.close(); void closing.then(() => { closed = true })
    expect(f.host.close()).toBe(closing)
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(closed).toBe(false); expect([projectCloses, nativeCloses, coordinatorCloses]).toEqual([0, 0, 0])
    release.resolve(); const reply = await running
    expect(reply.error).toMatchObject({ code: -32603 })
    if (phase === 'target') expect(reply.error?.data).toMatchObject({ kind: 'session-fork-error', capture: 'captured', lastOutcome: { kind: 'ready', sessionId: 'child' } })
    await closing; expect(callbacks).toBe(1); expect([projectCloses, nativeCloses, coordinatorCloses]).toEqual([1, 1, 1])
  } finally { release.resolve(); await running; await closing; await f.close() }
})

it('actual Gateway host retains the exact original L1 cleanup debt and its dependencies until acknowledgment', async () => {
  let fail = true, captures = 0, nativeCloses = 0, coordinatorCloses = 0
  const scopes: unknown[] = []
  const f = await actualHostFixture((_host, owners) => {
    const close = owners.nativeContext.contextOutput.closeLegacyForkTransfer.bind(owners.nativeContext.contextOutput)
    owners.nativeContext.contextOutput.closeLegacyForkTransfer = async scope => { scopes.push(scope); if (fail) throw new Error('Actual original Gateway L1 cleanup held'); return close(scope) }
    const nativeClose = owners.nativeContext.close.bind(owners.nativeContext), coordinatorClose = owners.coordinator.close.bind(owners.coordinator)
    owners.nativeContext.close = async () => { nativeCloses++; return nativeClose() }
    owners.coordinator.close = async () => { coordinatorCloses++; return coordinatorClose() }
    const capture = owners.coordinator.bootstrapSemanticTargetWithCapture!.bind(owners.coordinator)
    owners.coordinator.bootstrapSemanticTargetWithCapture = (input, guards, use) => capture(input, guards, async () => { captures++; return use() })
  })
  try {
    const operation = await f.prepare(), response = await f.call('session/fork/begin', { operation })
    expect(response.error?.data).toMatchObject({ kind: 'session-fork-error', reason: 'cleanup-incomplete', lastOutcome: { kind: 'ready', sessionId: 'child' } })
    await expect(f.host.close()).rejects.toThrow(/cleanup incomplete/i)
    expect([nativeCloses, coordinatorCloses]).toEqual([0, 0]); expect(scopes).toHaveLength(2); expect(new Set(scopes).size).toBe(1)
    fail = false; await f.host.close()
    expect(scopes).toHaveLength(3); expect(new Set(scopes).size).toBe(1); expect(captures).toBe(1)
    expect([nativeCloses, coordinatorCloses]).toEqual([1, 1])
  } finally { fail = false; await f.close() }
})
