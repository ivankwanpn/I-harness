import { verifyWaitAssets } from './native-wait-assets.mjs'
export { verifyWaitAssets } from './native-wait-assets.mjs'
import { isAbsolute } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'
import { Worker } from 'node:worker_threads'
import { createRequire } from 'node:module'
import type { NativePtr } from './ffi.ts'

export interface WaitDrainReceipt { readonly status: number; acknowledge(): Promise<void> }
export class WaitDrainTransportError extends Error {
  constructor(readonly outcome: 'not-dispatched' | 'unknown', message: string) { super(message); this.name = 'WaitDrainTransportError' }
}
export interface WaitDrainReservation {
  unregister(registration: NativePtr): Promise<WaitDrainReceipt>
  rejoin(): void
  release(): void
}
export interface WaitDrainService {
  readonly ready: Promise<void>
  reserve(): WaitDrainReservation
  close(): Promise<void>
}
export interface DrainWorkerPort {
  postMessage(message: unknown): void
  on(event: string, listener: (...args: any[]) => void): unknown
}
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: unknown) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  void promise.catch(() => {})
  return { promise, resolve, reject }
}

/**
 * One service per owning Node environment. Capacity is reserved before native wait
 * creation. No main-instance Koffi async call, worker replacement, timer or polling.
 */
export function createWaitDrainService(worker: DrainWorkerPort, epoch: string, capacity = 256): WaitDrainService {
  if (!Number.isInteger(capacity) || capacity < 1 || capacity > 8192) throw new Error('invalid retirement capacity')
  const readiness = deferred<void>(), exit = deferred<void>(), shutdown = deferred<void>()
  type Request = {
    id: string; registration: NativePtr; phase: 'queued' | 'posted' | 'known' | 'unknown';
    result: ReturnType<typeof deferred<WaitDrainReceipt>>; handoff: ReturnType<typeof deferred<void>>;
    receipt?: WaitDrainReceipt; acked: boolean; fatal?: WaitDrainTransportError;
  }
  const requests = new Map<string, Request>()
  // Scalar replay history only: no native registration, callback or storage ownership.
  // Worker messages are FIFO. At most `capacity` already-admitted handoffs can
  // retire ahead of a delayed replay; replies from newly admitted work cannot
  // overtake it. Keep that many unique retirements without refreshing duplicates.
  const retired = new Map<string, number>()
  const queue: Request[] = []
  let nextId = 0n, reservations = 0
  let ready = false, closing = false, alive = true, shutdownIssued = false, shutdownSeen = false
  let inFlight: Request | undefined
  let schedulePending = false
  let closeAttempt: Promise<void> | undefined
  function fail(reason: string) {
    alive = false
    readiness.reject(new WaitDrainTransportError('not-dispatched', reason))
    for (const request of requests.values()) {
      const outcome = request.phase === 'queued' ? 'not-dispatched' : 'unknown'
      request.fatal = new WaitDrainTransportError(outcome, reason)
      if (request.phase !== 'known') { request.phase = 'unknown'; request.result.reject(request.fatal) }
      request.handoff.reject(request.fatal)
      if (outcome === 'not-dispatched') requests.delete(request.id)
    }
    queue.length = 0
    shutdown.reject(new WaitDrainTransportError('unknown', reason))
  }
  function send(request: Request, type: 'drain' | 'ack') {
    worker.postMessage({ type, epoch, id: request.id, registration: request.registration })
  }
  function pump() {
    if (!ready || !alive || inFlight || schedulePending || queue.length === 0) return
    schedulePending = true
    // Leave callback/native return stack before admitting blocking retirement.
    setImmediate(() => {
      schedulePending = false
      if (!alive || inFlight) return
      const request = queue.shift()
      if (!request) return
      inFlight = request
      request.phase = 'posted' // Persist original identity before any possible delivery.
      try { send(request, 'drain') } catch (error) {
        inFlight = undefined
        request.phase = 'unknown'
        // Structured clone refusal proves no message was enqueued. Any other
        // throwing transport boundary may have delivered and remains unknown.
        const outcome = error instanceof Error && error.name === 'DataCloneError' ? 'not-dispatched' : 'unknown'
        request.fatal = new WaitDrainTransportError(outcome, `worker post failed: ${String(error)}`)
        request.result.reject(request.fatal)
        if (outcome === 'not-dispatched') requests.delete(request.id)
        pump()
      }
    })
  }
  worker.on('message', (message: unknown) => {
    if (!message || typeof message !== 'object') { fail('invalid worker reply'); return }
    const reply = message as { type?: string; epoch?: string; id?: string; status?: number; reason?: string }
    if (reply.epoch !== epoch) { fail('wrong worker incarnation'); return }
    if (reply.type === 'ready') {
      if (ready || shutdownIssued) { fail('duplicate worker readiness'); return }
      ready = true; readiness.resolve(); pump(); return
    }
    if (reply.type === 'shutdown') {
      if (!shutdownIssued || requests.size) { fail('unexpected worker shutdown'); return }
      shutdownSeen = true; shutdown.resolve(); return
    }
    const request = reply.id === undefined ? undefined : requests.get(reply.id)
    if (!request) {
      const status = reply.id === undefined ? undefined : retired.get(reply.id)
      if (status !== undefined) {
        if (reply.type === 'acknowledged' && reply.status === undefined && reply.reason === undefined) return
        if (reply.type === 'result' && Number.isInteger(reply.status) && reply.status === status && reply.reason === undefined) return
        fail('invalid retired worker reply'); return
      }
      fail('uncorrelated worker reply'); return
    }
    if (reply.type === 'acknowledged') {
      if (!request.receipt || request.phase !== 'known') { fail('acknowledgment before retained result'); return }
      request.acked = true; request.handoff.resolve(); return
    }
    if (reply.type === 'result') {
      if (!Number.isInteger(reply.status) || reply.status! < 0 || reply.status! > 0xffffffff || request.phase === 'queued') { fail('invalid worker DWORD or dispatch'); return }
      if (request.receipt && request.receipt.status !== reply.status) { fail('changed worker result'); return }
      if (request.fatal) return // Once an outcome was declared unknown, a late reply cannot revive a dead service.
      request.phase = 'known'
      request.receipt ??= {
        status: reply.status!,
        acknowledge() {
          if (request.acked) return Promise.resolve()
          if (!alive) return Promise.reject(request.fatal ?? new WaitDrainTransportError('unknown', 'worker unavailable during handoff'))
          try { send(request, 'ack') } catch (error) { return Promise.reject(new WaitDrainTransportError('unknown', `result handoff failed: ${String(error)}`)) }
          return request.handoff.promise
        },
      }
      // Retain status/receipt in this original request before resolving its original owner.
      request.result.resolve(request.receipt)
      if (inFlight === request) inFlight = undefined
      pump(); return
    }
    if (reply.type === 'unknown') {
      request.phase = 'unknown'
      request.fatal = new WaitDrainTransportError('unknown', reply.reason ?? 'native unregister outcome unknown')
      request.result.reject(request.fatal)
      if (inFlight === request) inFlight = undefined
      pump(); return
    }
    fail(reply.reason ?? 'worker protocol failure')
  })
  worker.on('error', (error: Error) => { fail(`worker failed: ${error.message}`) })
  worker.on('exit', (code: number) => {
    alive = false
    if (!shutdownSeen || !shutdownIssued || requests.size || code !== 0) fail(`worker exited without complete handoff (${code})`)
    exit.resolve()
  })
  return {
    ready: readiness.promise,
    reserve() {
      if (!ready || !alive || closing) throw new Error('wait drain service is not ready or is closing')
      if (reservations >= capacity) throw new Error('wait retirement capacity exhausted')
      reservations++
      let released = false, active: Request | undefined, succeeded = false
      function join(request: Request) {
        return request.result.promise.then(receipt => ({
          status: receipt.status,
          async acknowledge() {
            await receipt.acknowledge()
            if (requests.get(request.id) === request) {
              requests.delete(request.id)
              retired.set(request.id, receipt.status)
              if (retired.size > capacity) retired.delete(retired.keys().next().value!)
            }
            if (receipt.status === 0) succeeded = true
            if (active === request) active = undefined
          },
        }))
      }
      return {
        unregister(registration) {
          if (released || succeeded) return Promise.reject(new Error('retired wait cannot be submitted again'))
          if (typeof registration !== 'bigint' || registration <= 0n || registration >= 0xffffffffffffffffn) return Promise.reject(new Error('invalid registration address'))
          if (active) {
            if (active.registration !== registration) return Promise.reject(new Error('changed registration identity'))
            if (active.fatal) return Promise.reject(active.fatal)
            // Rejoin an original live request only; the worker replays its retained result.
            if (active.phase === 'posted' && alive) { try { send(active, 'drain') } catch { /* original request still owned */ } }
            return join(active)
          }
          if (!alive) return Promise.reject(new WaitDrainTransportError('not-dispatched', 'worker unavailable before dispatch'))
          const request: Request = { id: String(++nextId), registration, phase: 'queued', result: deferred(), handoff: deferred(), acked: false }
          requests.set(request.id, request); active = request
          // Known false-post means no dispatch; explicit retry may allocate another request on this same service.
          void request.result.promise.catch(() => { if (request.fatal?.outcome === 'not-dispatched' && active === request) active = undefined })
          queue.push(request); pump()
          return join(request)
        },
        release() {
          if (released) return
          if (active) throw new Error('unresolved native wait retirement')
          reservations--; released = true
        },
        rejoin() {
          if (!active || !alive || active.fatal) return
          if (active.phase === 'posted') { try { send(active, 'drain') } catch { /* retain original request */ } }
          else if (active.receipt && !active.acked) void active.receipt.acknowledge().catch(() => {})
        },
      }
    },
    close() {
      closing = true
      if (closeAttempt) return closeAttempt
      const attempt = (async () => {
        if (reservations || requests.size || queue.length || inFlight) throw new Error('unresolved wait retirements prevent worker shutdown')
        if (!alive) { await exit.promise; return }
        try { await readiness.promise } catch { await exit.promise; return }
        if (!alive) { await exit.promise; return }
        shutdownIssued = true
        worker.postMessage({ type: 'shutdown', epoch })
        await shutdown.promise
        await exit.promise // Join actual Worker exit; no terminate/unref timeout fallback.
      })()
      closeAttempt = attempt
      void attempt.catch(() => { if (!shutdownIssued && closeAttempt === attempt) closeAttempt = undefined })
      return attempt
    },
  }
}

export function validateBridgePath(path: string, platform = process.platform, arch = process.arch): void {
  if (platform !== 'win32') throw new Error('ACL wait bridge requires Windows')
  if (arch !== 'x64') throw new Error('ACL wait bridge requires x64')
  if (!isAbsolute(path)) throw new Error('ACL wait bridge path must be absolute')
}
let ownedService: { root: string; service: Promise<WaitDrainService> } | undefined
/** Prewarm before native channel/wait creation. Fixed verified assets only; no arbitrary message-selected DLL/function. */
export function createWaitDrainBridge(root = fileURLToPath(new URL(process.env.I_HARNESS_DIST ? './' : '../native/runtime/', import.meta.url))): Promise<WaitDrainService> {
  validateBridgePath(root)
  if (ownedService) {
    if (ownedService.root !== root) return Promise.reject(new Error('ACL wait worker already owns another asset identity'))
    return ownedService.service
  }
  const assets = verifyWaitAssets(root)
  const service: Promise<WaitDrainService> = Promise.resolve().then(async () => {
    const epoch = randomUUID()
    let owner: WaitDrainService | undefined
    try {
      // Resolve from the original executable/package owner, not a fresh asset
      // candidate directory or CWD. Worker import still initializes a distinct N-API environment.
      const koffiEntry = createRequire(import.meta.url).resolve('koffi')
      const worker = new Worker(assets.workerPath, { execArgv: [], workerData: { protocol: 1, epoch, capacity: 256, bridgePath: assets.bridgePath, bridgeSha256: assets.manifest.files['ih-acl-wait-bridge.dll'], koffiVersion: assets.manifest.koffiVersion, koffiEntry } })
      owner = createWaitDrainService(worker, epoch)
      await owner.ready
    } catch (error) {
      // No wait can reserve capacity before ready. Join failed startup before
      // allowing a fresh service for new, known-unissued work.
      if (owner) await owner.close()
      if (ownedService?.service === service) ownedService = undefined
      throw error
    }
    const original = owner
    return { ready: original.ready, reserve: () => original.reserve(), async close() {
      await original.close()
      if (ownedService?.service === service) ownedService = undefined
    } }
  })
  // A failed or unresolved service is retained. Never create a replacement for old registration addresses.
  ownedService = { root, service }
  return service
}
