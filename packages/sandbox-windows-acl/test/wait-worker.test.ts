import { EventEmitter } from 'node:events'
import { Worker } from 'node:worker_threads'
import { expect, it } from 'vitest'
import { createWaitDrainService } from '../src/native-wait-bridge.ts'
import { createDrainWorkerProtocol } from '../src/native-wait-protocol.mjs'
import type { NativePtr } from '../src/ffi.ts'
import { createRegisteredWait } from '../src/native-wait.ts'

function fixture() {
  const worker = new EventEmitter() as EventEmitter & { postMessage(message: unknown): void }
  const requests: unknown[] = []
  const results: unknown[] = []
  let calls = 0
  let drop = false
  const handle = createDrainWorkerProtocol({
    epoch: 'epoch', capacity: 2, drain: () => { calls++; return 0 },
    send: message => { results.push(message); if (!drop) queueMicrotask(() => worker.emit('message', message)) },
    shutdown: () => { queueMicrotask(() => worker.emit('exit', 0)) },
  })
  worker.postMessage = message => { requests.push(message); queueMicrotask(() => handle(message)) }
  const service = createWaitDrainService(worker, 'epoch', 2)
  worker.emit('message', { type: 'ready', epoch: 'epoch' })
  return { worker, service, requests, results, calls: () => calls, drop: (value: boolean) => { drop = value } }
}

it('reserves capacity before registration, receives exact status, acknowledges it, then joins shutdown exit', async () => {
  const f = fixture()
  await f.service.ready
  const first = f.service.reserve(), second = f.service.reserve()
  expect(() => f.service.reserve()).toThrow(/capacity/)
  const result = await first.unregister(42n as NativePtr)
  expect(result.status).toBe(0)
  expect(f.calls()).toBe(1)
  await result.acknowledge()
  first.release(); second.release()
  await f.service.close()
  expect(f.requests).toContainEqual({ type: 'shutdown', epoch: 'epoch' })
})

it('keeps unknown native results pinned after worker exit and forbids replacement resubmission', async () => {
  const f = fixture(); await f.service.ready
  const reservation = f.service.reserve()
  f.worker.postMessage = message => { f.requests.push(message); f.worker.emit('exit', 1) }
  await expect(reservation.unregister(42n as NativePtr)).rejects.toMatchObject({ outcome: 'unknown' })
  await expect(reservation.unregister(42n as NativePtr)).rejects.toMatchObject({ outcome: 'unknown' })
  expect(f.requests).toHaveLength(1)
  expect(() => reservation.release()).toThrow(/unresolved/)
  await expect(f.service.close()).rejects.toThrow(/unresolved/)
})

it('refuses wrong epoch, changed-address replay and retired id without another native call', () => {
  const replies: unknown[] = []
  let calls = 0
  const run = createDrainWorkerProtocol({ epoch: 'e', capacity: 1, send: m => { replies.push(m) }, drain: () => { calls++; return 5 }, shutdown: () => {} })
  run({ type: 'drain', epoch: 'wrong', id: '1', registration: 42n })
  run({ type: 'drain', epoch: 'e', id: '1', registration: 42n })
  run({ type: 'drain', epoch: 'e', id: '1', registration: 42n })
  run({ type: 'drain', epoch: 'e', id: '1', registration: 43n })
  run({ type: 'ack', epoch: 'e', id: '1', registration: 42n })
  run({ type: 'drain', epoch: 'e', id: '1', registration: 42n })
  expect(calls).toBe(1)
  expect(replies.filter(m => (m as { type: string }).type === 'protocol-error')).toHaveLength(3)
})

it('caches an unknown native call outcome and refuses its discard or reexecution', () => {
  const replies: any[] = []
  let calls = 0
  const run = createDrainWorkerProtocol({ epoch: 'e', capacity: 1, send: m => { replies.push(m) }, drain: () => { calls++; throw new Error('native result unavailable') }, shutdown: () => {} })
  const request = { type: 'drain', epoch: 'e', id: '1', registration: 42n }
  run(request); run(request)
  run({ ...request, type: 'ack' })
  run({ type: 'shutdown', epoch: 'e' })
  expect(calls).toBe(1)
  expect(replies.map(m => m.type)).toEqual(['unknown', 'unknown', 'protocol-error', 'protocol-error'])
})

it('rejoins a lost live-worker result by the original id and never repeats native unregister', async () => {
  const f = fixture(); await f.service.ready
  f.drop(true)
  const reservation = f.service.reserve()
  let releases = 0
  const wait = createRegisteredWait({ register: () => 42n as NativePtr, unregister: p => reservation.unregister(p), rejoin: () => reservation.rejoin(), release: () => { reservation.release(); releases++ } })
  const first = wait.close()
  await new Promise<void>(resolve => setImmediate(resolve))
  await Promise.resolve()
  expect(f.calls()).toBe(1)
  expect(releases).toBe(0)
  f.drop(false)
  const second = wait.close()
  await Promise.all([first, second])
  expect(f.calls()).toBe(1)
  expect(releases).toBe(1)
  const ids = f.requests.filter((m: any) => m.type === 'drain').map((m: any) => m.id)
  expect(ids).toEqual(['1', '1'])
  await f.service.close()
})

it('handles a known not-dispatched post failure with explicit retry on the original service', async () => {
  const f = fixture(); await f.service.ready
  const post = f.worker.postMessage
  let fail = true
  f.worker.postMessage = message => { if (fail) { fail = false; throw Object.assign(new Error('clone refused'), { name: 'DataCloneError' }) } post(message) }
  const reservation = f.service.reserve()
  await expect(reservation.unregister(42n as NativePtr)).rejects.toMatchObject({ outcome: 'not-dispatched' })
  const result = await reservation.unregister(42n as NativePtr)
  await result.acknowledge(); reservation.release()
  expect(f.calls()).toBe(1)
  await f.service.close()
})

it('rejoins a lost result-handoff acknowledgment without reexecuting native unregister', async () => {
  const f = fixture(); await f.service.ready
  const reservation = f.service.reserve()
  const result = await reservation.unregister(42n as NativePtr)
  f.drop(true)
  const handoff = result.acknowledge()
  await Promise.resolve(); await Promise.resolve()
  expect(() => reservation.release()).toThrow(/unresolved/)
  f.drop(false); reservation.rejoin()
  await handoff
  reservation.release()
  expect(f.calls()).toBe(1)
  await f.service.close()
})

it('retains an unclassified throwing post as unknown instead of claiming it was not delivered', async () => {
  const f = fixture(); await f.service.ready
  f.worker.postMessage = () => { throw new Error('transport outcome unavailable') }
  const reservation = f.service.reserve()
  await expect(reservation.unregister(42n as NativePtr)).rejects.toMatchObject({ outcome: 'unknown' })
  await expect(reservation.unregister(42n as NativePtr)).rejects.toMatchObject({ outcome: 'unknown' })
  expect(() => reservation.release()).toThrow(/unresolved/)
})

it.each([
  { type: 'result', epoch: 'wrong', id: '1', status: 0 },
  { type: 'result', epoch: 'epoch', id: 'unknown', status: 0 },
  { type: 'result', epoch: 'epoch', id: '1', status: -1 },
])('retains the original owner on invalid transport reply $epoch/$id/$status', async reply => {
  const f = fixture(); await f.service.ready
  f.drop(true)
  const reservation = f.service.reserve()
  const result = reservation.unregister(42n as NativePtr)
  await new Promise<void>(resolve => setImmediate(resolve))
  f.worker.emit('message', reply)
  await expect(result).rejects.toMatchObject({ outcome: 'unknown' })
  expect(() => reservation.release()).toThrow(/unresolved/)
  expect(f.calls()).toBe(1)
})

it('runs the protocol on a real Node Worker and joins its exit using an injected nonnative drain', async () => {
  const nativeWorker = new Worker(new URL('./fixtures/wait-protocol-worker.mjs', import.meta.url), { execArgv: [], workerData: { epoch: 'actual', status: 0 } })
  let calls = 0
  // The count message is fixture-only instrumentation, not admitted by production transport.
  const port = new EventEmitter() as EventEmitter & { postMessage(message: unknown): void }
  port.postMessage = message => nativeWorker.postMessage(message)
  nativeWorker.on('message', message => { if (message.type === 'count') calls = message.calls; else port.emit('message', message) })
  nativeWorker.on('error', error => port.emit('error', error))
  nativeWorker.on('exit', code => port.emit('exit', code))
  const service = createWaitDrainService(port, 'actual', 2)
  await service.ready
  const reservation = service.reserve()
  const result = await reservation.unregister(123456789012345n as NativePtr)
  expect(result.status).toBe(0)
  await result.acknowledge(); reservation.release()
  await service.close()
  expect(calls).toBe(1)
  expect(nativeWorker.threadId).toBe(-1)
})
