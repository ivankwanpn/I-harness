import { EventEmitter } from 'node:events'
import { Worker } from 'node:worker_threads'
import { expect, it } from 'vitest'
import { createWaitDrainService } from '../src/native-wait-bridge.ts'
import { createDrainWorkerProtocol, type WorkerMessage } from '../src/native-wait-protocol.mjs'
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

function delayedFixture() {
  const worker = new EventEmitter() as EventEmitter & { postMessage(message: unknown): void }
  const replies: WorkerMessage[] = []
  const commands: WorkerMessage[] = []
  let calls = 0
  const handle = createDrainWorkerProtocol({ epoch: 'delayed', capacity: 2,
    drain: () => { calls++; return 0 }, send: reply => { replies.push(reply) }, shutdown: () => {},
  })
  worker.postMessage = message => { commands.push(message as WorkerMessage); handle(message) }
  const service = createWaitDrainService(worker, 'delayed', 2)
  worker.emit('message', { type: 'ready', epoch: 'delayed' })
  function deliver(type: string) {
    const reply = replies.shift()
    expect(reply?.type).toBe(type)
    worker.emit('message', reply)
    if (type === 'shutdown') queueMicrotask(() => worker.emit('exit', 0))
    return reply!
  }
  return { worker, service, replies, commands, deliver, calls: () => calls }
}
const turn = () => new Promise<void>(resolve => setImmediate(resolve))

it('accepts both delayed close/rejoin ACKs and a late exact result while unrelated retirement still completes', async () => {
  const f = delayedFixture(); await f.service.ready
  const first = f.service.reserve(), unrelated = f.service.reserve()
  let releases = 0
  const wait = createRegisteredWait({ register: () => 42n as NativePtr,
    unregister: p => first.unregister(p), rejoin: () => first.rejoin(),
    release: () => { first.release(); releases++ },
  })
  const closing = wait.close()
  await turn()
  const originalResult = f.deliver('result')
  await turn() // Original close has retained result and sent its first ACK.
  const joining = wait.close() // Rejoin sends a second ACK; neither reply is dropped.
  const otherResult = unrelated.unregister(43n as NativePtr)
  void otherResult.catch(() => {})
  await turn()
  expect(f.replies.map(reply => reply.type)).toEqual(['acknowledged', 'acknowledged', 'result'])
  f.deliver('acknowledged')
  await Promise.all([closing, joining])
  expect(releases).toBe(1)
  await turn() // First acknowledgment's continuation has removed its active request.
  f.deliver('acknowledged')
  await turn() // The second reply is a separate event after retirement.
  f.worker.emit('message', { ...originalResult }) // Exact cached result also arrives after handoff.
  f.deliver('result')
  const receipt = await otherResult
  const handoff = receipt.acknowledge()
  f.deliver('acknowledged')
  await handoff; unrelated.release()
  const newReservation = f.service.reserve(); newReservation.release()
  const shutdown = f.service.close()
  await turn(); f.deliver('shutdown'); await shutdown
  expect(f.calls()).toBe(2)
})

it.each([
  { type: 'result', epoch: 'delayed', id: '1', status: 5 },
  { type: 'result', epoch: 'delayed', id: '1', status: -1 },
  { type: 'acknowledged', epoch: 'wrong', id: '1' },
  { type: 'acknowledged', epoch: 'delayed', id: '99' },
  { type: 'acknowledged', epoch: 'delayed', id: '1', status: 0 },
])('keeps retired replay validation exact for $type/$epoch/$id/$status', async reply => {
  const f = delayedFixture(); await f.service.ready
  const owner = f.service.reserve()
  const reading = owner.unregister(42n as NativePtr)
  await turn(); f.deliver('result')
  const receipt = await reading
  const handoff = receipt.acknowledge()
  f.deliver('acknowledged'); await handoff; owner.release()
  f.worker.emit('message', reply)
  expect(() => f.service.reserve()).toThrow(/not ready/)
})

it('retains the replay identity across every already-admitted handoff without blocking new capacity', async () => {
  const f = delayedFixture(); await f.service.ready
  const first = f.service.reserve(), second = f.service.reserve()
  const result1 = first.unregister(42n as NativePtr)
  await turn(); f.deliver('result')
  const receipt1 = await result1
  const result2 = second.unregister(43n as NativePtr)
  await turn(); f.deliver('result')
  const receipt2 = await result2
  const ack1 = receipt1.acknowledge(), ack2 = receipt2.acknowledge()
  first.rejoin() // Its duplicate will follow both already-admitted ACK replies.
  f.deliver('acknowledged'); await ack1; first.release()
  f.deliver('acknowledged'); await ack2; second.release()
  await turn(); f.deliver('acknowledged')
  const next = f.service.reserve()
  const result3 = next.unregister(44n as NativePtr)
  await turn(); f.deliver('result')
  const receipt3 = await result3
  const ack3 = receipt3.acknowledge()
  f.deliver('acknowledged'); await ack3; next.release()
  const closing = f.service.close()
  await turn(); f.deliver('shutdown'); await closing
  expect(f.calls()).toBe(3)
})

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
