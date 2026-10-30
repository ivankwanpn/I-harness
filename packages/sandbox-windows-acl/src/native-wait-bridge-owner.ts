import type { WaitDrainReservation, WaitDrainService } from './native-wait-bridge.ts'
export interface WaitDrainBridgeClient { readonly ready: Promise<void>; reserve(): WaitDrainReservation; release(): Promise<void> }
/** Construction must explicitly retain its original cleanup, including before readiness. */
export interface WaitBridgeStartup { service: Promise<WaitDrainService>; cleanup(): Promise<void> }
export class WaitBridgeStartupFailure extends AggregateError {
  private readonly retry!: () => Promise<void>
  constructor(original: unknown, cleanup: unknown, retry: () => Promise<void>) {
    super([original, cleanup], 'wait bridge startup failed and original cleanup is incomplete', { cause: original })
    Object.defineProperty(this, 'retry', { value: retry })
  }
  retryCleanup(): Promise<void> { return this.retry() }
}
/** One original singleton incarnation. Only acknowledged startup/exit cleanup permits replacement. */
export function createWaitBridgeOwner(start: (root: string) => WaitBridgeStartup) {
  type Entry = { root: string; service: Promise<WaitDrainService>; startup?: WaitBridgeStartup; clients: number; closing: boolean; close?: Promise<void>; startupCleanup?: Promise<void>; startupSettled?: boolean }
  let current: Entry | undefined
  function cleanupStartup(e: Entry): Promise<void> {
    if (e.startupSettled) return Promise.resolve()
    if (e.startupCleanup) return e.startupCleanup
    const attempt = Promise.resolve().then(async () => {
      if (!e.startup) throw new Error('startup construction outcome unknown; original entry remains owned')
      await e.startup.cleanup()
      e.startupSettled = true
      if (current === e) current = undefined
    })
    e.startupCleanup = attempt
    void attempt.catch(() => { if (e.startupCleanup === attempt) e.startupCleanup = undefined })
    return attempt
  }
  function entry(root: string): Entry {
    if (current) {
      if (current.root !== root) throw new Error('ACL wait worker already owns another asset identity')
      if (current.closing) throw new Error('ACL wait worker is closing')
      return current
    }
    const e: Entry = { root, service: undefined!, clients: 0, closing: false }
    current = e
    e.service = Promise.resolve().then(async () => { e.startup = start(root); const service = await e.startup.service; await service.ready; return service }).catch(async original => {
      e.closing = true
      try { await cleanupStartup(e) } catch (cleanup) { throw new WaitBridgeStartupFailure(original, cleanup, () => cleanupStartup(e)) }
      throw original
    })
    return e
  }
  function close(e: Entry): Promise<void> {
    if (e.close) return e.close
    e.closing = true
    const attempt = e.service.then(service => service.close()).then(() => { if (current === e) current = undefined })
    e.close = attempt
    void attempt.catch(() => { if (e.close === attempt) e.close = undefined })
    return attempt
  }
  function receiver(actual: unknown, expected: object) { if (actual !== expected) throw new TypeError('Invalid wait bridge receiver') }
  return {
    async get(root: string): Promise<WaitDrainService> {
      const e = entry(root), service = await e.service
      const raw: WaitDrainService = { ready: service.ready,
        reserve() { receiver(this, raw); return service.reserve() },
        close() { receiver(this, raw); if (e.clients) return Promise.reject(new Error('active wait bridge clients prevent shutdown')); return close(e) },
      }
      return Object.freeze(raw)
    },
    async acquire(root: string): Promise<WaitDrainBridgeClient> {
      const e = entry(root); e.clients++
      let service: WaitDrainService
      try { service = await e.service } catch (error) { e.clients--; throw error }
      let fenced = false, released = false, debt = 0, attempt: Promise<void> | undefined
      const client: WaitDrainBridgeClient = {
        ready: service.ready,
        reserve() {
          receiver(this, client)
          if (fenced) throw new Error('wait bridge client is released')
          const original = service.reserve(); debt++
          let settled = false
          const reservation: WaitDrainReservation = {
            unregister(registration) { receiver(this, reservation); if (settled) return Promise.reject(new Error('wait bridge reservation is released')); return original.unregister(registration) },
            rejoin() { receiver(this, reservation); if (!settled) original.rejoin() },
            release() { receiver(this, reservation); if (settled) return; original.release(); settled = true; debt-- },
          }
          return Object.freeze(reservation)
        },
        release() {
          receiver(this, client)
          fenced = true
          if (released) return Promise.resolve()
          if (attempt) return attempt
          if (debt) return Promise.reject(new Error('unresolved wait bridge client reservations'))
          if (e.clients > 1) { e.clients--; released = true; return Promise.resolve() }
          attempt = close(e).then(() => { e.clients--; released = true })
          void attempt.catch(() => { attempt = undefined })
          return attempt
        },
      }
      return Object.freeze(client)
    },
  }
}
