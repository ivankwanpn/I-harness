import { expect, it, vi } from 'vitest'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { decodeFactBatch, type BatchKey } from '@i-harness/core-session'
import { createForkSessionController } from '@i-harness/session-persistence'
import { composeJsonlTaskTransitionCoordinator } from '../../session-persistence-jsonl/src/task-document-factory.ts'
import { taskDocumentStorageContract } from '../../subagent/src/task/storage-contract.ts'
import { createJsonlBackend } from '../../session-persistence-jsonl/src/index.ts'
import { createContextOutputService } from '../../context-output/src/index.ts'
import { createSessionService, createDurableSessionLoader, createCliForkHost } from '@i-harness/session-executor'
import { controlledModel } from '../../session-executor/test/controlled-model.ts'
import { createSdkServer, type SdkServer } from '../src/server.ts'
import { encodeFrame, makeRequest, INTERNAL_ERROR } from '../src/protocol.ts'
import { createForkOperation } from '../src/fork.ts'

async function request(server: SdkServer, method: string, params: unknown = {}) {
  return JSON.parse((await server.handleLine(encodeFrame(makeRequest(1, method, params))))!)
}
async function boundary<T>(work: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout>
  try { return await Promise.race([work, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('Original Stop boundary pending')), 4000) })]) }
  finally { clearTimeout(timer!) }
}
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'ih-sdk-stop-')), sessions = join(root, 'sessions')
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>()
  let unknown = false, allow = false, armed = false, key: BatchKey | undefined, reconciles = 0
  const closeKeys: string[] = [], receipts: unknown[] = []
  const backend = createJsonlBackend(sessions, {
    wrapOwnedBatch: append => async (...args) => {
      if (!armed) return append(...args)
      const closes = decodeFactBatch(args[3].bytes).events.some(event => event.type === 'agent/delivery-generation' && event.op === 'close')
      if (closes) { key = args[3].key; closeKeys.push(key.batchId); entered.resolve(); await release.promise }
      const outcome = await append(...args)
      if (closes) { receipts.push(outcome); if (unknown && !allow) return { kind: 'unknown', key: args[3].key } }
      return outcome
    },
    wrapOwnedReconcile: reconcile => async (...args) => {
      if (!armed) return reconcile(...args)
      if (args[3].key.batchId === key?.batchId) { reconciles++; if (unknown && !allow) return { kind: 'unknown', key: args[3].key } }
      return reconcile(...args)
    },
  }), coordinator = composeJsonlTaskTransitionCoordinator(backend, { lock: { enabled: true } }, taskDocumentStorageContract)
  await coordinator.create({ sessionId: 'stop' })
  const modelEntered = Promise.withResolvers<void>(), modelRelease = Promise.withResolvers<void>()
  let calls = 0, signal: AbortSignal | undefined
  const model = controlledModel(async function* (input) {
    if (++calls === 2) { signal = input.signal; modelEntered.resolve(); await modelRelease.promise }
    yield { type: 'text/chunk', text: 'actual completed turn' }; yield { type: 'end' }
  })
  const output = createContextOutputService({ root, workspaceId: 'sdk-stop', config: { enabled: false } })
  const service = createSessionService({ workspace: root, coordinator, sessionFor: createDurableSessionLoader(coordinator), contextOutput: output,
    model, approveAll: true, modelPolicy: 'test-mock', codeMode: { mode: 'off' } })
  await service.submit('stop', 'first completed turn', new AbortController().signal)
  armed = true
  const options = { coordinator, async listSessions() {
    const { session } = await coordinator.snapshot!('stop')
    return { sessions: [{ id: 'stop', turnCount: session.events.filter(event => event.type === 'turn/start').length }] }
  } }
  return { root, backend, coordinator, service, options, closeKeys, receipts,
    entered: () => boundary(entered.promise), release: () => release.resolve(), unknown: () => { unknown = true }, allow: () => { allow = true },
    modelEntered: () => boundary(modelEntered.promise), releaseModel: () => modelRelease.resolve(), signal: () => signal, calls: () => calls, reconciles: () => reconciles,
    async close() {
      release.resolve(); modelRelease.resolve(); allow = true
      await service.awaitDeliveryStop('stop'); await service.close(); await coordinator.close(); await output.close()
      await writeFile(join(root, 'stop-receipts.json'), JSON.stringify({ root, calls, closeKeys, reconciles, receipts, events: (await backend.read('stop')).events }, null, 2))
    } }
}

it('idle cancel waits for its real Stop receipt before the numeric nonempty list read', async () => {
  const f = await fixture(), server = createSdkServer(f.service, f.options)
  let cancelling: Promise<unknown> | undefined
  try {
    await request(server, 'initialize')
    expect((await request(server, 'session/cancel', { sessionId: 'ghost' })).result).toEqual({ cancelled: false, reason: 'not-found' })
    let replied = false
    cancelling = request(server, 'session/cancel', { sessionId: 'stop' }).then(reply => { replied = true; return reply })
    await f.entered(); await Promise.resolve()
    expect(replied).toBe(false)
    f.release()
    expect(await cancelling).toMatchObject({ result: { cancelled: false, reason: 'not-running' } })
    const list = await request(server, 'session/list')
    expect(list.result.sessions[0].turnCount).toBeTypeOf('number')
    expect(list.result.sessions[0].turnCount).toBeGreaterThanOrEqual(1)
    expect(f.closeKeys).toHaveLength(1); expect(f.receipts).toMatchObject([{ kind: 'committed' }]); expect(f.calls()).toBe(1)
  } finally { f.release(); await cancelling; await server.close(); await f.close() }
})

it('active cancellation aborts before its held receipt, rejects self-close and joins external close', async () => {
  const f = await fixture(), server = createSdkServer(f.service, f.options)
  let running: Promise<unknown> | undefined, cancelling: Promise<unknown> | undefined, closing: Promise<void> | undefined
  const original = f.service.awaitDeliveryStop.bind(f.service)
  let selfClose: Promise<unknown> | undefined
  f.service.awaitDeliveryStop = id => {
    const settling = original(id)
    selfClose = server.close().then(() => ({ closed: true }), error => error)
    return settling
  }
  try {
    await request(server, 'initialize')
    running = request(server, 'session/prompt', { sessionId: 'stop', prompt: 'held original prompt' })
    await f.modelEntered()
    let replied = false
    cancelling = request(server, 'session/cancel', { sessionId: 'stop' }).then(reply => { replied = true; return reply })
    await f.entered(); await Promise.resolve()
    expect(f.signal()?.aborted).toBe(true); expect(replied).toBe(false)
    expect(await selfClose).toMatchObject({ message: expect.stringContaining('own request') })
    let closed = false; closing = server.close(); void closing.then(() => { closed = true })
    expect(server.close()).toBe(closing); await Promise.resolve(); expect(closed).toBe(false)
    f.release()
    expect(await boundary(cancelling)).toMatchObject({ result: { cancelled: true } })
    await boundary(closing); expect(closed).toBe(true)
    expect(f.closeKeys).toHaveLength(1); expect(f.receipts).toMatchObject([{ kind: 'committed' }])
  } finally {
    f.release(); f.releaseModel(); await running; await cancelling; await closing; f.service.awaitDeliveryStop = original
    await server.close(); await f.close()
  }
})

it('unknown Stop is an RPC failure with original debt retained and reads cannot reconcile it', async () => {
  const f = await fixture(), server = createSdkServer(f.service, f.options), warnings = vi.spyOn(console, 'warn').mockImplementation(() => {})
  let cancelling: Promise<unknown> | undefined
  try {
    await request(server, 'initialize'); f.unknown()
    cancelling = request(server, 'session/cancel', { sessionId: 'stop' })
    await f.entered(); f.release()
    expect(await boundary(cancelling)).toMatchObject({ error: { code: INTERNAL_ERROR, message: expect.stringMatching(/session\/cancel.*reconciliation/i) } })
    expect(f.closeKeys).toHaveLength(1)
    const attempts = f.reconciles()
    expect((await request(server, 'session/list')).error).toMatchObject({ code: INTERNAL_ERROR })
    await expect(f.coordinator.snapshot!('stop')).rejects.toMatchObject({ code: 'FACT_RECOVERY_REQUIRED' })
    expect(f.reconciles()).toBe(attempts); expect(f.calls()).toBe(1)
    f.allow()
    expect(await f.service.awaitDeliveryStop('stop')).toMatchObject({ durability: 'durable' })
    expect(f.closeKeys).toHaveLength(1); expect(f.reconciles()).toBeGreaterThan(attempts)
    expect((await request(server, 'session/list')).result.sessions[0].turnCount).toBeGreaterThanOrEqual(1)
  } finally { f.release(); f.allow(); await cancelling; await server.close(); await f.close(); warnings.mockRestore() }
})

it('custom missing settlement fails after requesting abort while legacy FIFO remains explicit', async () => {
  const f = await fixture(), abort = vi.fn(() => ({ cancelled: true })), settle = vi.fn(async () => { throw new Error('Legacy FIFO has no Stop owner') })
  const missing = new Proxy(f.service, { get(target, property, receiver) { return property === 'awaitDeliveryStop' ? undefined : property === 'cancelRunning' ? abort : Reflect.get(target, property, receiver) } })
  const server = createSdkServer(missing)
  const legacy = createSdkServer({ ...f.service, cancelRunning: undefined, awaitDeliveryStop: settle })
  try {
    await request(server, 'initialize'); await request(legacy, 'initialize')
    expect((await request(server, 'session/cancel', { sessionId: 'stop' })).error).toMatchObject({ code: INTERNAL_ERROR, message: expect.stringMatching(/settlement unavailable/i) })
    expect(abort).toHaveBeenCalledOnce()
    expect((await request(legacy, 'session/cancel', { sessionId: 'stop' })).result).toEqual({ cancelled: false, reason: 'not-running' })
    expect(settle).not.toHaveBeenCalled(); expect(f.closeKeys).toHaveLength(0)
  } finally { await server.close(); await legacy.close(); await f.close() }
})

it('an independent actual fork finishes while the original cancel Stop remains held', async () => {
  const f = await fixture()
  await f.coordinator.create({ sessionId: 'fork-source' })
  await f.coordinator.append('fork-source', [{ type: 'turn/start' }, { type: 'user/message', text: 'independent source' }, { type: 'turn/end' }])
  const host = createCliForkHost({ workspace: f.root, coordinator: f.coordinator }), target = host.withReadyTarget.bind(host)
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>()
  host.withReadyTarget = async (...args) => { entered.resolve(); await release.promise; return target(...args) }
  const controller = createForkSessionController(f.coordinator, host)
  let forkSignal: AbortSignal | undefined
  const server = createSdkServer(f.service, { ...f.options, prepareForkSession: input => controller.prepare(input),
    executeForkSession(command, control) { forkSignal = control?.signal; return controller.execute(command, control) } })
  let forking: ReturnType<typeof request> | undefined, cancelling: ReturnType<typeof request> | undefined
  try {
    await request(server, 'initialize')
    const prepared = (await request(server, 'session/fork/prepare', { version: 1, sourceSessionId: 'fork-source' })).result
    if (prepared.kind !== 'prepared') throw new Error('Actual independent fork preparation refused')
    const actualOperation = createForkOperation(prepared.prepared, { operationId: 'independent-stop', targetSessionId: 'independent-child', createdAt: new Date().toISOString() })
    forking = request(server, 'session/fork/begin', { operation: actualOperation })
    // Preparation precedes Stop admission; its native/durable work is bounded
    // by the suite deadline, not the short Stop-settlement watchdog below.
    await entered.promise
    let replied = false
    cancelling = request(server, 'session/cancel', { sessionId: 'stop' }).then(reply => { replied = true; return reply })
    await f.entered(); expect(forkSignal?.aborted).toBe(false)
    release.resolve()
    expect(await boundary(forking)).toMatchObject({ result: { kind: 'ready', sessionId: 'independent-child' } })
    expect(replied).toBe(false); expect(forkSignal?.aborted).toBe(false); expect(f.calls()).toBe(1)
    f.release(); expect(await cancelling).toMatchObject({ result: { cancelled: false, reason: 'not-running' } })
  } finally { release.resolve(); f.release(); await forking; await cancelling; await server.close(); await controller.close(); await f.close() }
})
