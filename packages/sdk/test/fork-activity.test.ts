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
  return { onAssembly: () => () => {}, activitySessionIds: () => [], hasAssembly: () => false, queueState: () => ({ running: false, queued: 0 }), tasks: () => [] } as unknown as SessionService
}
const phases = [1, 2].flatMap(version => ['prepare', 'begin', 'retry'].map(phase => ({ version, phase })))

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
    work = call('session/fork/' + phase, params)
    await entered.promise
    for (let i = 0; i < 2; i++) expect((await call('session/dashboard')).result).toEqual({ sessions: [], active: true })
    release.resolve()
    expect(await work).toHaveProperty('result')
    for (let i = 0; i < 3; i++) expect((await call('session/dashboard')).result).toEqual({ sessions: [], active: false })
  } finally { release.resolve(); await work; await server.close() }
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
