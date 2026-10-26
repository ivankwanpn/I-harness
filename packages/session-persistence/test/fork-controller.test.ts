import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { createJsonlBackend } from '@i-harness/session-persistence-jsonl'
import { createSessionCoordinator, forkSession, retryForkSession } from '../src/index.ts'
import * as controllerApi from '../src/fork-controller.ts'
import { createInlineForkHost } from '../src/fork-inline-host.ts'
import { createForkOperation, ForkOperationError } from '../src/fork-contract.ts'

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
it('retains known outcome and cleanup debt until same-operation successful continuation', async () => {
  const f = await fixture()
  try {
    const host = createInlineForkHost(f.c), handoff = host.withHandoff.bind(host)
    host.withHandoff = async (...args) => { const result = await handoff(...args); throw new AggregateError([undefined], 'original release fault', { cause: result }) }
    const controller = controllerApi.createForkSessionController(f.c, host), op = await operation(controller)
    const error = await controller.execute({ operation: op, mode: 'begin' }).catch(error => error)
    expect(error).toBeInstanceOf(ForkOperationError)
    expect(error.hostError).toMatchObject({ reason: 'cleanup-incomplete', lastOutcome: { kind: 'ready', sessionId: 'target' } })
    await expect(controller.close()).rejects.toThrow('Fork cleanup unresolved')
    host.withHandoff = handoff
    expect((await controller.execute({ operation: op, mode: 'retry' })).kind).toBe('adopted')
    await controller.close()
  } finally { await f.close() }
})
