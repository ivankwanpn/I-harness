import { expect, it } from 'vitest'
import type { SessionService } from '@i-harness/session-executor'
import { createBootstrapRequestIntent, createForkSessionController, type ForkHost, type SessionCoordinator } from '@i-harness/session-persistence'
import { createSelectedResultsIntent, readSelectedResultsPrepared, readSelectedResultsOperation } from '@i-harness/session-persistence/selected-results-fork-contract'
import { createSdkServer } from '../src/server.ts'
import { encodeFrame, makeRequest } from '../src/protocol.ts'
import { createForkOperation, readForkRequestCore } from '../src/fork.ts'

function forkFixtures() {
  const core = readForkRequestCore({ version: 1, kind: 'session-fork-core', sourceSessionId: 'source', selection: { kind: 'completed' }, sourceCapture: 'first-authorized-capture', metadata: {} })
  const legacyIntent = createBootstrapRequestIntent(core, { kind: 'unmanaged' })
  const legacy = { version: 1, kind: 'session-fork-prepared', core, requestIntent: legacyIntent.intent, requestDigest: legacyIntent.requestDigest } as const
  const selectedCore = { ...core, version: 2, results: 'selected-results-v1' } as const
  const selectedIntent = createSelectedResultsIntent(selectedCore, { kind: 'unmanaged' })
  const selected = readSelectedResultsPrepared({ version: 2, kind: 'session-fork-prepared', core: selectedCore, requestIntent: selectedIntent.intent, requestDigest: selectedIntent.requestDigest })
  const identity = { operationId: 'activity-fixture', targetSessionId: 'target', createdAt: new Date().toISOString() }
  return {
    legacy, selected,
    legacyOperation: createForkOperation(legacy, identity),
    selectedOperation: readSelectedResultsOperation({ version: 2, kind: 'session-fork-operation', prepared: selected, invocation: { version: 1, ...identity, requestDigest: selected.requestDigest } }),
  }
}
function idleService() {
  return { onAssembly: () => () => {}, activitySessionIds: () => [], inspectActivity: () => ({ active: false }), hasAssembly: () => false, queueState: () => ({ running: false, queued: 0 }), tasks: () => [] } as unknown as SessionService
}
const phases = [1, 2].flatMap(version => ['prepare', 'begin', 'retry'].map(phase => ({ version, phase })))

it("inspects live owners without listing saved sessions and retains unknown owners", async () => {
  const service = idleService()
  service.activitySessionIds = () => ["background"]
  const server = createSdkServer(service, { listSessions: async () => { throw Error("Unexpected history listing") } })
  try {
    expect(server.hasActiveWork()).toBe(false)
    service.inspectActivity = () => ({ live: true, active: true, running: false, tasks: 1, queued: 0 })
    expect(server.hasActiveWork()).toBe(true)
    service.inspectActivity = () => { throw Error("Unavailable") }
    expect(server.hasActiveWork()).toBe(true)
    service.inspectActivity = undefined
    expect(server.hasActiveWork()).toBe(true)
  } finally { await server.close() }
})

it.each(phases)('reports held v$version fork $phase activity and returns to idle without dashboard self-activity', async ({ version, phase }) => {
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>()
  const f = forkFixtures()
  const hold = async () => { entered.resolve(); await release.promise }
  const server = createSdkServer(idleService(), {
    listSessions: async () => ({ sessions: [] }),
    prepareForkSession: async () => { await hold(); return { kind: 'prepared', prepared: f.legacy } },
    executeForkSession: async command => { await hold(); return { version: 1, kind: 'not-issued', operation: command.operation, capture: 'uncaptured', reason: 'cancelled' } },
    prepareSelectedForkSession: async () => { await hold(); return { kind: 'prepared', prepared: f.selected } },
    executeSelectedForkSession: async command => { await hold(); return { version: 2, kind: 'not-issued', operation: command.operation, capture: 'uncaptured', reason: 'cancelled' } },
  })
  let sequence = 0, work: Promise<unknown> | undefined
  const call = async (method: string, params: unknown = {}) => JSON.parse((await server.handleLine(encodeFrame(makeRequest(++sequence, method, params))))!)
  try {
    await call('initialize')
    expect((await call('session/dashboard')).result).toEqual({ sessions: [], active: false })
    const params = phase === 'prepare'
      ? { version, sourceSessionId: 'source', ...(version === 2 ? { results: 'selected-results-v1' } : {}) }
      : { operation: version === 1 ? f.legacyOperation : f.selectedOperation }
    work = call((version === 1 ? 'session/fork/' : 'session/fork/results/') + phase, params)
    await entered.promise
    expect(server.hasActiveWork()).toBe(true)
    for (let i = 0; i < 2; i++) expect((await call('session/dashboard')).result).toEqual({ sessions: [], active: true })
    release.resolve()
    expect(await work).toHaveProperty('result')
    expect(server.hasActiveWork()).toBe(false)
    for (let i = 0; i < 3; i++) expect((await call('session/dashboard')).result).toEqual({ sessions: [], active: false })
  } finally { release.resolve(); await work; await server.close() }
})

it.each([false, true])('serves the explicit selected-results routes with legacy fork enabled=%s', async legacy => {
  const f = forkFixtures()
  const server = createSdkServer(idleService(), {
    ...(legacy ? {
      prepareForkSession: async () => ({ kind: 'prepared' as const, prepared: f.legacy }),
      executeForkSession: async () => { throw new Error('Unexpected legacy fork dispatch') },
    } : {}),
    prepareSelectedForkSession: async () => ({ kind: 'prepared', prepared: f.selected }),
    executeSelectedForkSession: async ({ operation }) => ({
      version: 2, kind: 'not-issued', operation, capture: 'uncaptured', reason: 'cancelled',
    }),
  })
  let sequence = 0
  const call = async (method: string, params: unknown = {}) => JSON.parse((await server.handleLine(encodeFrame(makeRequest(++sequence, method, params))))!)
  const selectedRequest = { version: 2, sourceSessionId: 'source', results: 'selected-results-v1' }
  try {
    const initialized = await call('initialize')
    expect(initialized.result.capabilities['session-fork-selected-results']).toEqual(['1'])
    expect(initialized.result.capabilities['session-fork-bootstrap']).toEqual(legacy ? ['1'] : undefined)
    expect(initialized.result.capabilities['session-fork-selected-results-default']).toBeUndefined()
    expect((await call('session/fork/results/prepare', selectedRequest)).result).toEqual({ kind: 'prepared', prepared: f.selected })
    expect((await call('session/fork/results/begin', { operation: f.selectedOperation })).result).toMatchObject({
      kind: 'not-issued', operation: f.selectedOperation, reason: 'cancelled',
    })
    expect((await call('session/fork/results/retry', { operation: f.legacyOperation })).error.code).toBe(-32602)
    expect((await call('session/fork/prepare', selectedRequest)).error.code).toBe(legacy ? -32602 : -32601)
    expect((await call('session/fork/begin', { operation: f.selectedOperation })).error.code).toBe(legacy ? -32602 : -32601)
  } finally { await server.close() }
})

it('retains factual owned activity when session listing is unavailable', async () => {
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>()
  const f = forkFixtures()
  const server = createSdkServer(idleService(), {
    prepareForkSession: async () => { entered.resolve(); await release.promise; return { kind: 'prepared', prepared: f.legacy } },
    executeForkSession: async () => { throw new Error('Unused execute') },
  })
  let sequence = 0, preparing: Promise<unknown> | undefined
  const call = async (method: string, params: unknown = {}) => JSON.parse((await server.handleLine(encodeFrame(makeRequest(++sequence, method, params))))!)
  try {
    await call('initialize')
    preparing = call('session/fork/prepare', { version: 1, sourceSessionId: 'source' })
    await entered.promise
    expect((await call('session/dashboard')).result).toEqual({ sessions: [], listingUnavailable: true, active: true })
    release.resolve(); await preparing
    expect((await call('session/dashboard')).result).toEqual({ sessions: [], listingUnavailable: true, active: false })
  } finally { release.resolve(); await preparing; await server.close() }
})

it('includes an original controller flight owned by the exact coordinator outside the SDK request set', async () => {
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>()
  const coordinator = { inspectBootstrapCapture: async () => {}, bootstrapSemanticTargetWithCapture: async () => {} } as unknown as SessionCoordinator
  const host: ForkHost = {
    assertAvailable() {},
    async resolvePreparation() { entered.resolve(); await release.promise; return { metadata: {}, project: { kind: 'unmanaged' } } },
    async withHandoff() { throw new Error('Unused handoff') },
    async withReadyTarget() { throw new Error('Unused target') },
  }
  const controller = createForkSessionController(coordinator, host)
  const server = createSdkServer(idleService(), { coordinator, listSessions: async () => ({ sessions: [] }) })
  let sequence = 0, preparing: ReturnType<typeof controller.prepare> | undefined
  const call = async (method: string) => JSON.parse((await server.handleLine(encodeFrame(makeRequest(++sequence, method, {}))))!)
  try {
    await call('initialize')
    preparing = controller.prepare({ version: 1, sourceSessionId: 'source' })
    await entered.promise
    expect((await call('session/dashboard')).result).toEqual({ sessions: [], active: true })
    release.resolve(); await preparing
    expect((await call('session/dashboard')).result).toEqual({ sessions: [], active: false })
  } finally { release.resolve(); await preparing; await server.close(); await controller.close() }
})

it.each(['available', 'unavailable'] as const)('reports a held SDK prompt with %s listing when service activity hooks are absent', async listing => {
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>()
  const service = {
    ...idleService(),
    activitySessionIds: undefined,
    inspectActivity: undefined,
    async submit() { entered.resolve(); await release.promise },
  } as unknown as SessionService
  const server = createSdkServer(service, listing === 'available' ? { listSessions: async () => ({ sessions: [] }) } : {})
  let sequence = 0, prompting: Promise<unknown> | undefined
  const call = async (method: string, params: unknown = {}) => JSON.parse((await server.handleLine(encodeFrame(makeRequest(++sequence, method, params))))!)
  const empty = { sessions: [], ...(listing === 'unavailable' ? { listingUnavailable: true } : {}) }
  try {
    await call('initialize')
    expect((await call('session/dashboard')).result).toEqual({ ...empty, active: false })
    prompting = call('session/prompt', { sessionId: 'hidden-prompt', prompt: 'Held submission' })
    await entered.promise
    expect((await call('session/dashboard')).result).toEqual({ ...empty, active: true })
    release.resolve(); await prompting
    expect((await call('session/dashboard')).result).toEqual({ ...empty, active: false })
  } finally { release.resolve(); await prompting; await server.close() }
})
