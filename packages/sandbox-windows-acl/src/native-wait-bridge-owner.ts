import type { WaitDrainReservation, WaitDrainService } from './native-wait-bridge.ts'

export interface WaitDrainBridgeClient {
  readonly ready: Promise<void>
  reserve(): WaitDrainReservation
  release(): Promise<void>
}

/** Owns one original service incarnation; failed startup or shutdown remains owned. */
export function createWaitBridgeOwner(start: (root: string) => Promise<WaitDrainService>) {
  type Entry = { root: string; service: Promise<WaitDrainService>; clients: number; closing: boolean; close?: Promise<void> }
  let current: Entry | undefined
  function entry(root: string): Entry {
    if (current) {
      if (current.root !== root) throw new Error('ACL wait worker already owns another asset identity')
      if (current.closing) throw new Error('ACL wait worker is closing')
      return current
    }
    const e: Entry = { root, service: Promise.resolve().then(() => start(root)), clients: 0, closing: false }
    current = e
    return e
  }
  function close(e: Entry): Promise<void> {
    if (e.close) return e.close
    e.closing = true
    const attempt = e.service.then(service => service.close()).then(() => { if (current === e) current = undefined })
    e.close = attempt
    // A failed close stays attached to this incarnation, but the same owner can retry it.
    void attempt.catch(() => { if (e.close === attempt) e.close = undefined })
    return attempt
  }
  return {
    async get(root: string): Promise<WaitDrainService> {
      const e = entry(root)
      const service = await e.service
      return { ready: service.ready, reserve: () => service.reserve(), close() {
        if (e.clients) return Promise.reject(new Error('active wait bridge clients prevent shutdown'))
        return close(e)
      } }
    },
    async acquire(root: string): Promise<WaitDrainBridgeClient> {
      const e = entry(root)
      e.clients++
      let service: WaitDrainService
      try { service = await e.service } catch (error) { e.clients--; throw error }
      let fenced = false, released = false, debt = 0, attempt: Promise<void> | undefined
      return {
        ready: service.ready,
        reserve() {
          if (fenced) throw new Error('wait bridge client is released')
          const original = service.reserve(); debt++
          let settled = false
          return { unregister: registration => original.unregister(registration), rejoin: () => original.rejoin(), release() {
            if (settled) return
            original.release()
            settled = true; debt--
          } }
        },
        release() {
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
    },
  }
}
