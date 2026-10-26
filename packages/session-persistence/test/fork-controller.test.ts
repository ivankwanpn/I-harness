import { mkdtemp, rm, unlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { acquireSessionLock } from '@i-harness/fs-lock'
import { createJsonlBackend } from '@i-harness/session-persistence-jsonl'
import { createSessionCoordinator, forkSession, retryForkSession } from '../src/index.ts'
import * as controllerApi from '../src/fork-controller.ts'
import { createInlineForkHost } from '../src/fork-inline-host.ts'
import { createForkOperation, ForkOperationError } from '../src/fork-contract.ts'
import { observationCleanupFor } from '../src/coordinator/binding-observation.ts'
import { createContextOutputService } from '../../context-output/src/index.ts'
import { bootstrapPaths } from '../../session-persistence-jsonl/src/backend/bootstrap-header.ts'

vi.mock('@i-harness/fs-lock', async original => {
  const actual = await original<typeof import('@i-harness/fs-lock')>()
  return { ...actual, acquireSessionLock: vi.fn(actual.acquireSessionLock) }
})
const nativeAcquire = (await vi.importActual<typeof import('@i-harness/fs-lock')>('@i-harness/fs-lock')).acquireSessionLock
afterEach(() => { vi.restoreAllMocks(); vi.mocked(acquireSessionLock).mockImplementation(nativeAcquire) })

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'ih-fc-'))
  const backend = createJsonlBackend(root), c = createSessionCoordinator(backend, { lock: { enabled: true } })
  await c.create({ sessionId: 'source', title: 'original' })
  await c.append('source', [{ type: 'turn/start' }, { type: 'user/message', text: 'first' }, { type: 'turn/end' }])
  return { root, backend, c, async close() { await c.close(); await rm(root, { recursive: true, force: true }) } }
}
async function operation(controller: controllerApi.ForkSessionController) {
  const prepared = await controller.prepare({ version: 1, sourceSessionId: 'source' })
  if (prepared.kind !== 'prepared') throw new Error('preparation unavailable')
  return createForkOperation(prepared.prepared, { operationId: 'original', targetSessionId: 'target', createdAt: '2026-10-26T00:00:00.000Z' })
}
it('joins exact duplicate whole flights before await and passively adopts before source hooks', async () => {
  const f = await fixture()
  try {
    const host = createInlineForkHost(f.c), entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>()
    const target = host.withReadyTarget.bind(host)
    host.withReadyTarget = async (...args) => { entered.resolve(); await release.promise; return target(...args) }
    const handoff = vi.spyOn(host, 'withHandoff'), controller = controllerApi.createForkSessionController(f.c, host), op = await operation(controller)
    const one = controller.execute({ operation: op, mode: 'begin' }), two = controller.execute({ operation: op, mode: 'begin' })
    expect(one).toBe(two)
    await entered.promise
    expect(handoff).toHaveBeenCalledTimes(1)
    let closed = false
    const closing = controller.close().then(() => { closed = true })
    await Promise.resolve(); expect(closed).toBe(false)
    release.resolve(); expect((await one).kind).toBe('ready'); await closing
    const fresh = controllerApi.createForkSessionController(f.c, createInlineForkHost(f.c))
    await f.c.updateMeta('source', { archived: true })
    const source = vi.spyOn(f.c, 'profile').mockRejectedValue(new Error('source profile trap'))
    expect((await fresh.execute({ operation: op, mode: 'retry' })).kind).toBe('adopted')
    expect(source).not.toHaveBeenCalled()
  } finally { await f.close() }
})
it('busy before B2 keeps prepared metadata and selects the then-current completed cut', async () => {
  const f = await fixture()
  try {
    const controller = controllerApi.createForkSessionController(f.c, createInlineForkHost(f.c)), op = await operation(controller)
    const blocked = await controller.execute({ operation: op, mode: 'begin' }, { async withNewWork() { throw new controllerApi.ForkAdmissionError('busy') } })
    expect(blocked).toMatchObject({ kind: 'not-issued', reason: 'busy', capture: 'uncaptured' })
    await f.c.updateMeta('source', { title: 'later' })
    await f.c.append('source', [{ type: 'turn/start' }, { type: 'user/message', text: 'later' }, { type: 'turn/end' }])
    const ready = await controller.execute({ operation: op, mode: 'retry' })
    expect(ready).toMatchObject({ kind: 'ready', title: 'original' })
    expect(JSON.stringify((await f.backend.read('target')).events)).toContain('later')
    expect((await f.backend.profile('target')).meta.title).toBe('original')
  } finally { await f.close() }
})
it('preserves falsy local causes and original operation on post-admission host faults', async () => {
  const f = await fixture()
  try {
    const host = createInlineForkHost(f.c), controller = controllerApi.createForkSessionController(f.c, host), op = await operation(controller)
    host.withHandoff = async () => { throw undefined }
    const error = await controller.execute({ operation: op, mode: 'begin' }).catch(error => error)
    expect(error).toBeInstanceOf(ForkOperationError)
    expect(error.operation).toEqual(op)
    expect(Object.hasOwn(error, 'cause')).toBe(true)
    expect(error.cause).toBeUndefined()
  } finally { await f.close() }
})
it('keeps a spent native reservation passive across a cold controller and source changes', async () => {
  const f = await fixture()
  try {
    const controller = controllerApi.createForkSessionController(f.c, createInlineForkHost(f.c)), op = await operation(controller)
    const reserve = f.backend.prepareBootstrapCapture!.bind(f.backend)
    let reservations = 0
    f.backend.prepareBootstrapCapture = async (...args) => { const result = await reserve(...args); reservations++; if (result.kind === 'committed-new') throw undefined; return result }
    const error = await controller.execute({ operation: op, mode: 'begin' }).catch(error => error)
    expect(error).toBeInstanceOf(ForkOperationError); expect(error.cause).toBeUndefined()
    expect(reservations).toBe(1)
    await f.c.close()
    const cold = createSessionCoordinator(createJsonlBackend(f.root), { lock: { enabled: true } })
    try {
      const coldController = controllerApi.createForkSessionController(cold, createInlineForkHost(cold))
      const sourceProfile = vi.spyOn(cold, 'profile').mockRejectedValue(new Error('source trap'))
      const result = await coldController.execute({ operation: op, mode: 'retry' })
      expect(result).toMatchObject({ kind: 'blocked', reason: 'payload-required', token: { invocation: op.invocation } })
      expect(sourceProfile).not.toHaveBeenCalled()
      expect(await cold.list()).toEqual(['source'])
    } finally { await cold.close() }
  } finally { await f.close() }
})
it('joins preparation before coordinator resources close and rejects callback self-close before revocation', async () => {
  const f = await fixture()
  try {
    const host = createInlineForkHost(f.c), resolve = host.resolvePreparation.bind(host)
    let selfClose: unknown
    const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>()
    host.resolvePreparation = async (...args) => {
      const prepared = await resolve(...args)
      selfClose = await f.c.close().catch(error => error)
      entered.resolve(); await release.promise; return prepared
    }
    const controller = controllerApi.createForkSessionController(f.c, host)
    const preparing = controller.prepare({ version: 1, sourceSessionId: 'source' })
    await entered.promise
    expect(selfClose).toBeInstanceOf(Error)
    expect((selfClose as Error).message).toContain('own lifetime')
    let closed = false
    const closing = f.c.close().then(() => { closed = true })
    await Promise.resolve(); expect(closed).toBe(false)
    release.resolve()
    expect(await preparing).toEqual({ kind: 'unavailable', reason: 'unavailable' })
    await closing
  } finally { await f.close() }
})
it('distinguishes known current target denial from an unknown final target fault', async () => {
  const f = await fixture()
  try {
    const host = createInlineForkHost(f.c), controller = controllerApi.createForkSessionController(f.c, host), op = await operation(controller)
    host.withReadyTarget = async () => { throw new controllerApi.ForkTargetPolicyDeniedError() }
    expect(await controller.execute({ operation: op, mode: 'begin' })).toMatchObject({ kind: 'refused', reason: 'target-policy', capture: 'captured' })
    host.withReadyTarget = async () => { throw new Error('private path must stay local') }
    const error = await controller.execute({ operation: op, mode: 'retry' }).catch(error => error)
    expect(error).toBeInstanceOf(ForkOperationError)
    expect(error.hostError).toMatchObject({ reason: 'internal', lastOutcome: { kind: 'adopted' } })
    expect(JSON.stringify(error.hostError)).not.toContain('private path')
  } finally { await f.close() }
})
it('retirement prevents first capture but preserves passive recovery of an issued target', async () => {
  const f = await fixture()
  try {
    const controller = controllerApi.createForkSessionController(f.c, createInlineForkHost(f.c)), op = await operation(controller)
    expect((await controller.execute({ operation: op, mode: 'begin' })).kind).toBe('ready')
    await controller.retire(op)
    expect((await controller.execute({ operation: op, mode: 'retry' })).kind).toBe('adopted')
    const second = createForkOperation(op.prepared, { operationId: 'second', targetSessionId: 'second-target', createdAt: op.invocation.createdAt })
    const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>()
    const running = controller.execute({ operation: second, mode: 'begin' }, { async withNewWork(_source, _id, use) { entered.resolve(); await release.promise; return use() } })
    await entered.promise
    const retiring = controller.retire(second); release.resolve(); await retiring
    expect(await running).toMatchObject({ kind: 'not-issued', reason: 'cancelled', capture: 'uncaptured' })
    expect((await f.c.list()).sort()).toEqual(['source', 'target'])
  } finally { await f.close() }
})
it('retires a valid operation before its first execute without issuing a reservation', async () => {
  const f = await fixture()
  try {
    const controller = controllerApi.createForkSessionController(f.c, createInlineForkHost(f.c)), op = await operation(controller)
    await controller.retire(op)
    expect(await controller.execute({ operation: op, mode: 'begin' })).toMatchObject({ kind: 'not-issued', reason: 'cancelled', capture: 'uncaptured' })
    const capture = { invocation: op.invocation, core: op.prepared.core, requestIntent: op.prepared.requestIntent }
    expect(await f.c.inspectBootstrapCapture!(capture)).toEqual({ kind: 'absent' })
  } finally { await f.close() }
})
it.each([false, true])('incomplete original payload requires fresh warm witness before issuance (source changed=%s)', async changed => {
  const f = await fixture()
  try {
    const host = createInlineForkHost(f.c), handoffs: string[] = [], originalHandoff = host.withHandoff.bind(host)
    host.withHandoff = async (op, mode, control, use) => { handoffs.push(mode.kind); return originalHandoff(op, mode, control, use) }
    const controller = controllerApi.createForkSessionController(f.c, host), op = await operation(controller)
    const prepare = f.backend.prepareBootstrapHeader!.bind(f.backend)
    let headers = 0, callbacks = 0
    f.backend.prepareBootstrapHeader = async (...args) => ++headers === 1 ? { kind: 'unknown' } : prepare(...args)
    const capture = f.c.bootstrapSemanticTargetWithCapture!.bind(f.c)
    f.c.bootstrapSemanticTargetWithCapture = (request, guards, callback) => capture(request, guards, async () => { callbacks++; return callback() })
    expect(await controller.execute({ operation: op, mode: 'begin' })).toMatchObject({ kind: 'blocked', reason: 'unknown' })
    expect(callbacks).toBe(1)
    if (changed) {
      const source = await f.c.openManagedDocument('source')
      await source.inputs.start(undefined, { type: 'user/message', text: 'changed later' })
      await source.agent.lifecycle({ type: 'turn/end' })
    }
    const result = await controller.execute({ operation: op, mode: 'retry' })
    if (changed) {
      expect(result).toMatchObject({ kind: 'blocked', reason: 'source-changed' })
      expect(handoffs).toEqual(['first', 'passive'])
      expect(await f.c.list()).toEqual(['source'])
    } else {
      expect(result.kind).toBe('ready')
      expect(handoffs).toEqual(['first', 'passive', 'warm'])
      expect(JSON.stringify((await f.backend.read('target')).events)).toContain('first')
    }
    expect(callbacks).toBe(1)
  } finally { await f.close() }
})
it('convenience reports preparation failure before mint and preserves its minted operation across retry', async () => {
  const f = await fixture()
  try {
    await expect(forkSession(f.c, 'missing')).rejects.toMatchObject({ name: 'ForkPreparationError', kind: 'unavailable' })
    const host = createInlineForkHost(f.c), controller = controllerApi.createForkSessionController(f.c, host)
    const ready = host.withReadyTarget.bind(host)
    host.withReadyTarget = async () => { throw new Error('reply lost after receipt') }
    const error = await forkSession(f.c, 'source', { controller }).catch(error => error)
    expect(error).toBeInstanceOf(ForkOperationError)
    expect(error.hostError.lastOutcome.operation).toEqual(error.operation)
    host.withReadyTarget = ready
    const retry = await retryForkSession(f.c, error.operation, { controller })
    expect(retry).toMatchObject({ kind: 'adopted', operation: error.operation })
    expect(retry.sessionId).toBe(error.operation.invocation.targetSessionId)
    expect((await f.c.list()).length).toBe(2)
  } finally { await f.close() }
})
it('joins the final target barrier before coordinator resource disposal', async () => {
  const f = await fixture()
  try {
    const host = createInlineForkHost(f.c), target = host.withReadyTarget.bind(host)
    const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>()
    host.withReadyTarget = async (...args) => { entered.resolve(); await release.promise; return target(...args) }
    const controller = controllerApi.createForkSessionController(f.c, host), op = await operation(controller)
    const running = controller.execute({ operation: op, mode: 'begin' }).catch(error => error)
    await entered.promise
    let closed = false
    const closing = f.c.close().then(() => { closed = true })
    await Promise.resolve()
    expect(closed).toBe(false); expect(f.c.ownerOf('target')).toBe(true)
    release.resolve()
    const error = await running
    expect(error).toBeInstanceOf(ForkOperationError)
    expect(error.hostError.lastOutcome).toMatchObject({ kind: 'ready', sessionId: 'target' })
    await closing; expect(f.c.ownerOf('target')).toBe(false)
  } finally { await f.close() }
})
it('does not classify an arbitrary post-handoff aggregate as original cleanup debt', async () => {
  const f = await fixture()
  try {
    const host = createInlineForkHost(f.c), handoff = host.withHandoff.bind(host)
    host.withHandoff = async (...args) => { const result = await handoff(...args); throw new AggregateError([undefined], 'original release fault', { cause: result }) }
    const controller = controllerApi.createForkSessionController(f.c, host), op = await operation(controller)
    const error = await controller.execute({ operation: op, mode: 'begin' }).catch(error => error)
    expect(error).toBeInstanceOf(ForkOperationError)
    expect(error.hostError).toMatchObject({ reason: 'internal', lastOutcome: { kind: 'ready', sessionId: 'target' } })
    await controller.close()
    host.withHandoff = handoff
    expect((await controller.execute({ operation: op, mode: 'retry' })).kind).toBe('adopted')
    await controller.close()
  } finally { await f.close() }
})
it('retains the exact real final target release debt through controller close and original retry', async () => {
  const f = await fixture()
  let fault = true, finalBarrier = false, attempts = 0, callbacks = 0
  let originalHandle: Awaited<ReturnType<typeof nativeAcquire>> | undefined
  let originalLockPath: string | undefined
  try {
    const host = createInlineForkHost(f.c), target = host.withReadyTarget.bind(host)
    host.withReadyTarget = async (...args) => { finalBarrier = true; try { return await target(...args) } finally { finalBarrier = false } }
    const controller = controllerApi.createForkSessionController(f.c, host), op = await operation(controller)
    const capture = f.c.bootstrapSemanticTargetWithCapture!.bind(f.c)
    f.c.bootstrapSemanticTargetWithCapture = (request, guards, use) => capture(request, guards, async () => { callbacks++; return use() })
    vi.mocked(acquireSessionLock).mockImplementation(async options => {
      const raw = await nativeAcquire(options), held = finalBarrier
      if (held && !originalHandle) { originalHandle = raw; originalLockPath = options.lockPath }
      return { get held() { return raw.held }, async release() {
        if (raw === originalHandle) { attempts++; if (fault) throw new Error('real final observation release before action') }
        await raw.release()
      } }
    })
    const error = await controller.execute({ operation: op, mode: 'begin' }).catch(error => error)
    expect(error).toBeInstanceOf(ForkOperationError)
    expect(error).toMatchObject({ kind: 'cleanup', hostError: { reason: 'cleanup-incomplete', lastOutcome: { kind: 'ready', sessionId: 'target' } } })
    expect(originalHandle?.held).toBe(true); expect(attempts).toBe(1)
    await expect(nativeAcquire({ lockPath: originalLockPath!, deadlineMs: 10 })).rejects.toThrow()
    await expect(controller.close()).rejects.toThrow('Fork cleanup unresolved')
    expect(originalHandle?.held).toBe(true); expect(attempts).toBe(2)
    fault = false
    const outcome = await controller.execute({ operation: op, mode: 'retry' })
    expect(outcome).toMatchObject({ kind: 'adopted', sessionId: 'target', operation: op })
    expect(originalHandle?.held).toBe(false); expect(attempts).toBe(3)
    expect(callbacks).toBe(1)
    const originalCleanup = observationCleanupFor(f.c, error.cause)!
    await f.c.withExistingSessionBindingObservation!({ sessionIds: ['target'] }, async () => {
      await expect(originalCleanup.retry()).rejects.toMatchObject({ reason: 'conflict' })
    })
    await controller.close()
    console.info(JSON.stringify({ control: 'FC07 final target same native handle', attempts, callbacks, held: originalHandle?.held }))
  } finally { fault = false; await f.close() }
})
it.each([undefined, null, false, 0])('nominal release failure preserves literal final callback cause %s', async literal => {
  const f = await fixture()
  let fault = true, finalBarrier = false, callbackCalls = 0
  try {
    const host = createInlineForkHost(f.c), ready = host.withReadyTarget.bind(host)
    host.withReadyTarget = async (op, document, use) => {
      finalBarrier = true
      try { return await ready(op, document, async () => { await use(); callbackCalls++; throw literal }) }
      finally { finalBarrier = false }
    }
    const controller = controllerApi.createForkSessionController(f.c, host), op = await operation(controller)
    vi.mocked(acquireSessionLock).mockImplementation(async options => {
      const raw = await nativeAcquire(options), selected = finalBarrier
      return { get held() { return raw.held }, async release() { if (selected && fault) throw new Error('actual cleanup fault'); await raw.release() } }
    })
    const error = await controller.execute({ operation: op, mode: 'begin' }).catch(error => error)
    expect(error).toMatchObject({ kind: 'cleanup', hostError: { reason: 'cleanup-incomplete', lastOutcome: { kind: 'ready' } } })
    expect(error.cause.callbackError).toBe(literal); expect(error.cause.errors[0]).toBe(literal)
    expect(observationCleanupFor(f.c, error.cause)).toBeDefined()
    fault = false; await controller.close(); expect(callbackCalls).toBe(1)
  } finally { fault = false; await f.close() }
})
it('never recognizes fabricated, wrapped or foreign-coordinator cleanup errors', async () => {
  const f = await fixture(), other = await fixture()
  let fault = true
  try {
    vi.mocked(acquireSessionLock).mockImplementation(async options => {
      const raw = await nativeAcquire(options)
      return { get held() { return raw.held }, async release() { if (fault) throw new Error('foreign actual release'); await raw.release() } }
    })
    const original = await other.c.withExistingSessionBindingObservation!({ sessionIds: ['source'] }, async () => 'actual result').catch(error => error)
    const handle = observationCleanupFor(other.c, original)!
    expect(handle).toBeDefined(); expect(observationCleanupFor(f.c, original)).toBeUndefined()
    const fake = Object.assign(new AggregateError(original.errors, original.message), { callbackResult: original.callbackResult, callbackError: original.callbackError, sessionIds: original.sessionIds })
    expect(observationCleanupFor(other.c, fake)).toBeUndefined()
    expect(observationCleanupFor(other.c, new AggregateError([original], 'wrapper'))).toBeUndefined()
    fault = false
    // Another original close acknowledges disposal; nominal origin persists.
    await other.c.close()
    expect(observationCleanupFor(other.c, original)).toBe(handle)
    await handle.retry()
    const host = createInlineForkHost(f.c), controller = controllerApi.createForkSessionController(f.c, host), op = await operation(controller)
    host.withReadyTarget = async () => { throw original }
    const error = await controller.execute({ operation: op, mode: 'begin' }).catch(error => error)
    expect(error).toMatchObject({ kind: 'host', hostError: { reason: 'internal', lastOutcome: { kind: 'ready' } } })
    await controller.close()
  } finally { fault = false; await other.close(); await f.close() }
})
it('consumed native release failure stays unresolved without reacquisition or no-op success', async () => {
  const raws: Awaited<ReturnType<typeof nativeAcquire>>[] = []
  let finalBarrier = false, selected: Awaited<ReturnType<typeof nativeAcquire>> | undefined, attempts = 0
  vi.mocked(acquireSessionLock).mockImplementation(async options => {
    const raw = await nativeAcquire(options); raws.push(raw)
    if (finalBarrier) selected ??= raw
    return { get held() { return raw.held }, async release() {
      if (raw === selected) { attempts++; await raw.release(); throw new Error('consumed native unknown') }
      await raw.release()
    } }
  })
  const f = await fixture()
  try {
    const host = createInlineForkHost(f.c), ready = host.withReadyTarget.bind(host)
    host.withReadyTarget = async (...args) => { finalBarrier = true; try { return await ready(...args) } finally { finalBarrier = false } }
    const controller = controllerApi.createForkSessionController(f.c, host), op = await operation(controller)
    const error = await controller.execute({ operation: op, mode: 'begin' }).catch(error => error)
    expect(error).toMatchObject({ kind: 'cleanup', hostError: { reason: 'cleanup-incomplete', lastOutcome: { kind: 'ready' } } })
    const acquired = raws.length
    expect(selected?.held).toBe(false); expect(f.c.ownerOf('target')).toBe(true)
    await expect(controller.close()).rejects.toThrow('Fork cleanup unresolved')
    await expect(controller.close()).rejects.toThrow('Fork cleanup unresolved')
    expect(raws.length).toBe(acquired); expect(attempts).toBe(1); expect(f.c.ownerOf('target')).toBe(true)
    console.info(JSON.stringify({ control: 'FC07 consumed native debt', acquired, attempts, consumedHeld: selected?.held, dependentHeld: f.c.ownerOf('target') }))
  } finally {
    // Test-only teardown releases recorded raw OS handles; production debt
    // remains unresolved and no coordinator/controller success is claimed.
    for (const raw of raws) await raw.release()
    await rm(f.root, { recursive: true, force: true })
  }
})
it.each(['prepared', 'acquiring'] as const)('controller close retains real preparation cleanup debt (%s)', async phase => {
  const f = await fixture()
  let fault = true, attempts = 0
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>()
  let originalHandle: Awaited<ReturnType<typeof nativeAcquire>> | undefined
  try {
    const controller = controllerApi.createForkSessionController(f.c, createInlineForkHost(f.c))
    vi.mocked(acquireSessionLock).mockImplementation(async options => {
      const raw = await nativeAcquire(options); originalHandle ??= raw
      if (phase === 'acquiring') { entered.resolve(); await release.promise }
      return { get held() { return raw.held }, async release() { attempts++; if (fault) throw new Error('real preparation release before action'); await raw.release() } }
    })
    const preparing = controller.prepare({ version: 1, sourceSessionId: 'source' }).catch(error => error)
    let closing: Promise<void>
    if (phase === 'acquiring') { await entered.promise; closing = controller.close(); release.resolve() }
    else { const error = await preparing; expect(error).toBeInstanceOf(AggregateError); closing = controller.close() }
    await expect(closing).rejects.toThrow('Fork cleanup unresolved')
    expect(originalHandle?.held).toBe(true)
    expect(await preparing).toBeInstanceOf(AggregateError)
    fault = false; await controller.close()
    expect(originalHandle?.held).toBe(false); expect(attempts).toBeGreaterThanOrEqual(2)
  } finally { fault = false; release.resolve(); await f.close() }
})
it('settles retained preparation cleanup before a new execute or explicit prepare retry', async () => {
  const f = await fixture()
  let fault = false, attempts = 0
  let selected: Awaited<ReturnType<typeof nativeAcquire>> | undefined
  try {
    const host = createInlineForkHost(f.c), controller = controllerApi.createForkSessionController(f.c, host), op = await operation(controller)
    vi.mocked(acquireSessionLock).mockImplementation(async options => {
      const raw = await nativeAcquire(options)
      selected ??= raw
      return { get held() { return raw.held }, async release() { if (raw === selected) { attempts++; if (fault) throw new Error('prepare prerequisite release fault') }; await raw.release() } }
    })
    fault = true
    expect(await controller.prepare({ version: 1, sourceSessionId: 'source' }).catch(error => error)).toBeInstanceOf(AggregateError)
    const execution = await controller.execute({ operation: op, mode: 'begin' }).catch(error => error)
    expect(execution).toMatchObject({ kind: 'cleanup', hostError: { reason: 'cleanup-incomplete', capture: 'unknown' } })
    expect(await f.c.inspectBootstrapCapture!({ invocation: op.invocation, core: op.prepared.core, requestIntent: op.prepared.requestIntent })).toEqual({ kind: 'absent' })
    fault = false
    expect((await controller.prepare({ version: 1, sourceSessionId: 'source' })).kind).toBe('prepared')
    expect((await controller.execute({ operation: op, mode: 'retry' })).kind).toBe('ready')
    expect(attempts).toBeGreaterThan(2)
  } finally { fault = false; await f.close() }
})
it('close attempts every independent original preparation cleanup and retains only unresolved handles', async () => {
  const f = await fixture()
  const handles: { raw: Awaited<ReturnType<typeof nativeAcquire>>; fault: boolean; attempts: number }[] = []
  try {
    await f.c.create({ sessionId: 'other-source' })
    const controller = controllerApi.createForkSessionController(f.c, createInlineForkHost(f.c))
    vi.mocked(acquireSessionLock).mockImplementation(async options => {
      const raw = await nativeAcquire(options), record = { raw, fault: true, attempts: 0 }; handles.push(record)
      return { get held() { return raw.held }, async release() { record.attempts++; if (record.fault) throw new Error('independent original release'); await raw.release() } }
    })
    const results = await Promise.all(['source','other-source'].map(sourceSessionId => controller.prepare({ version: 1, sourceSessionId }).catch(error => error)))
    expect(results.every(error => error instanceof AggregateError)).toBe(true)
    expect(handles.length).toBe(2)
    handles[0]!.fault = false
    await expect(controller.close()).rejects.toThrow('Fork cleanup unresolved')
    expect(handles.map(value => [value.raw.held, value.attempts])).toEqual([[false, 2], [true, 2]])
    handles[1]!.fault = false; await controller.close()
    expect(handles.map(value => [value.raw.held, value.attempts])).toEqual([[false, 2], [false, 3]])
  } finally { for (const value of handles) value.fault = false; await f.close() }
})
it('cold target conflict carries unknown capture evidence without source admission', async () => {
  const f = await fixture()
  try {
    const original = await forkSession(f.c, 'source')
    const changed = createForkOperation(original.operation.prepared, { targetSessionId: original.sessionId, createdAt: original.operation.invocation.createdAt, operationId: 'different-operation' })
    const host = createInlineForkHost(f.c), handoff = vi.spyOn(host, 'withHandoff'), controller = controllerApi.createForkSessionController(f.c, host)
    expect(await controller.execute({ operation: changed, mode: 'retry' })).toMatchObject({ kind: 'refused', reason: 'conflict', capture: 'unknown' })
    expect(handoff).not.toHaveBeenCalled()
  } finally { await f.close() }
})
it('unavailable cold inspection never asserts uncaptured or invokes source work', async () => {
  const f = await fixture()
  try {
    const host = createInlineForkHost(f.c), handoff = vi.spyOn(host, 'withHandoff'), controller = controllerApi.createForkSessionController(f.c, host), op = await operation(controller)
    f.c.inspectBootstrapCapture = vi.fn(f.c.inspectBootstrapCapture!).mockResolvedValue({ kind: 'unavailable' })
    const error = await controller.execute({ operation: op, mode: 'retry' }).catch(error => error)
    expect(error).toMatchObject({ name: 'ForkOperationError', hostError: { capture: 'unknown', reason: 'host-unavailable' } })
    expect(handoff).not.toHaveBeenCalled()
  } finally { await f.close() }
})
it('a passive host failure after a real reserved indication keeps unknown evidence', async () => {
  const f = await fixture()
  try {
    const first = controllerApi.createForkSessionController(f.c, createInlineForkHost(f.c)), op = await operation(first)
    const reserve = f.backend.prepareBootstrapCapture!.bind(f.backend)
    f.backend.prepareBootstrapCapture = async (...args) => { const result = await reserve(...args); if (result.kind === 'committed-new') throw undefined; return result }
    await first.execute({ operation: op, mode: 'begin' }).catch(() => {})
    const host = createInlineForkHost(f.c), cold = controllerApi.createForkSessionController(f.c, host)
    host.withHandoff = async () => { throw new Error('actual passive host unavailable') }
    const error = await cold.execute({ operation: op, mode: 'retry' }).catch(error => error)
    expect(error).toMatchObject({ name: 'ForkOperationError', hostError: { capture: 'unknown' } })
  } finally { await f.close() }
})
it('a previously observed real reservation never becomes first capture after later namespace loss', async () => {
  const f = await fixture()
  let issuer: ReturnType<typeof createSessionCoordinator> | undefined
  try {
    const host = createInlineForkHost(f.c), handoff = host.withHandoff.bind(host), controller = controllerApi.createForkSessionController(f.c, host), op = await operation(controller)
    await f.c.releaseOwnership('source')
    const backend = createJsonlBackend(f.root), reserve = backend.prepareBootstrapCapture!.bind(backend)
    backend.prepareBootstrapCapture = async (...args) => { const result = await reserve(...args); if (result.kind === 'committed-new') throw undefined; return result }
    issuer = createSessionCoordinator(backend, { lock: { enabled: true } })
    const issued = controllerApi.createForkSessionController(issuer, createInlineForkHost(issuer))
    await issued.execute({ operation: op, mode: 'begin' }).catch(() => {})
    await issuer.close(); issuer = undefined
    const request = { invocation: op.invocation, core: op.prepared.core, requestIntent: op.prepared.requestIntent }
    expect((await f.c.inspectBootstrapCapture!(request)).kind).toBe('reserved')
    host.withHandoff = async () => { throw new Error('passive host temporarily unavailable before B2') }
    await controller.execute({ operation: op, mode: 'retry' }).catch(() => {})
    // Controlled external loss of this test's exact minted reservation file.
    // No backend format/owner is replaced; both routing facts are genuine IO.
    await unlink(bootstrapPaths(join(f.root, 'target.jsonl'), op.invocation).stage)
    expect((await f.c.inspectBootstrapCapture!(request)).kind).toBe('absent')
    host.withHandoff = handoff
    let sourceGates = 0
    const result = await controller.execute({ operation: op, mode: 'retry' }, { async withNewWork() { sourceGates++; throw new controllerApi.ForkAdmissionError('busy') } })
    console.info(JSON.stringify({ control: 'FC08 known reservation then actual namespace absence', sourceGates, result: result.kind }))
    expect(sourceGates).toBe(0)
    expect(result.kind).toBe('blocked')
  } finally { await issuer?.close(); await f.close() }
})
it('inspection ambiguity alone permits first capture after later genuine strict absence', async () => {
  const f = await fixture()
  try {
    const host = createInlineForkHost(f.c), controller = controllerApi.createForkSessionController(f.c, host), op = await operation(controller)
    const nativeInspection = f.c.inspectBootstrapCapture!
    f.c.inspectBootstrapCapture = vi.fn(nativeInspection).mockResolvedValueOnce({ kind: 'unavailable' })
    const error = await controller.execute({ operation: op, mode: 'begin' }).catch(error => error)
    expect(error).toMatchObject({ hostError: { capture: 'unknown' } })
    f.c.inspectBootstrapCapture = nativeInspection
    await f.c.append('source', [{ type: 'turn/start' }, { type: 'user/message', text: 'after unavailable' }, { type: 'turn/end' }])
    let newWork = 0
    const result = await controller.execute({ operation: op, mode: 'retry' }, { async withNewWork(_source, _operation, use) { newWork++; return use() } })
    expect(result).toMatchObject({ kind: 'ready', operation: op, capture: 'captured' })
    expect(newWork).toBe(1)
    expect(JSON.stringify((await f.backend.read('target')).events)).toContain('after unavailable')
  } finally { await f.close() }
})
it.each(['managed', 'legacy', 'seed'] as const)('standalone refuses actual typed %s source before a new target header', async kind => {
  const f = await fixture(), service = createContextOutputService({ root: join(f.root, 'results'), workspaceId: 'workspace', config: { enabled: true } })
  try {
    if (kind === 'seed') {
      const child = await forkSession(f.c, 'source')
      await expect(forkSession(f.c, child.sessionId)).rejects.toMatchObject({ name: 'ForkPreparationError', result: { kind: 'unavailable', reason: 'unsupported' } })
      expect((await f.c.list()).sort()).toEqual(['source', child.sessionId].sort())
    } else {
      if (kind === 'legacy') {
        const ref = await service.capture({ sessionId: 'source', callId: 'call', label: 'actual', text: 'actual retained legacy', complete: true })
        if (!ref) throw new Error('Legacy actual capture refused')
        await f.c.append('source', [{ type: 'context/result-ref', ref }])
      } else {
        const scope = service.registerResultScope({ operationId: 'actual-managed', sessionId: 'source', callId: 'call' }, () => true)
        const sink = await service.beginResult(scope, 'text-utf8-v1'); await sink.write(Buffer.from('actual retained artifact'))
        const saved = await sink.finish('complete'); if (saved.kind !== 'committed') throw new Error('Actual managed publication refused')
        await f.c.append('source', [{ type: 'turn/start' }, { type: 'user/message', text: 'result' }, { type: 'step/start' }, { type: 'tool/call', callId: 'call', name: 'read', args: {} },
          { type: 'assistant/message', text: '' }, { type: 'tool/dispatch', callId: 'call', eventSeq: 6 },
          { type: 'tool/result', callId: 'call', name: 'read', envelope: { version: 1, execution: { outcome: 'succeeded', dispatch: 'dispatched' }, preview: 'bounded', media: [], retention: { kind: 'artifact', ref: saved.ref } } },
          { type: 'step/end' }, { type: 'turn/end' }, { type: 'compaction/summary', text: 'hidden result', shadowedSeqs: [9] }])
      }
      const error = await forkSession(f.c, 'source').catch(error => error)
      expect(error).toMatchObject({ name: 'ForkOperationError', kind: 'outcome', outcome: { kind: 'not-issued', reason: 'unsupported', capture: 'uncaptured' } })
      const op = error.operation
      expect(await f.c.inspectBootstrapCapture!({ invocation: op.invocation, core: op.prepared.core, requestIntent: op.prepared.requestIntent })).toEqual({ kind: 'absent' })
      expect(await f.c.list()).toEqual(['source'])
    }
  } finally { await service.close(); await f.close() }
})
