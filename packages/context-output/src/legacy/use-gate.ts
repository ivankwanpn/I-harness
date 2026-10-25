import { AsyncLocalStorage } from 'node:async_hooks'

export interface LegacyUseLease {
  assertHeld(): void;
  assertExclusive(): void;
}
export interface LegacyUseGate {
  shared<T>(signal: AbortSignal | undefined, work: (lease: LegacyUseLease) => Promise<T>): Promise<T>;
  exclusive<T>(signal: AbortSignal | undefined, work: (lease: LegacyUseLease) => Promise<T>): Promise<T>;
  assertLease(lease: LegacyUseLease, requirement?: 'exclusive'): void;
}

type Mode = 'shared' | 'exclusive'
type Admission = { mode: Mode; active: boolean }
type Waiter = {
  mode: Mode;
  grant(record: Admission): void;
  reject(reason: unknown): void;
  signal?: AbortSignal;
  abort?: () => void;
}

/** Private admission only. Cancellation after entry never retires executing work. */
export function createLegacyUseGate(): LegacyUseGate {
  const scope = new AsyncLocalStorage<Admission>()
  const leases = new WeakMap<LegacyUseLease, Admission>()
  const waiting: Waiter[] = []
  let readers = 0, writer = false

  function assertLease(lease: LegacyUseLease, requirement?: 'exclusive'): void {
    const record = leases.get(lease)
    if (!record?.active || scope.getStore() !== record) throw new Error('Stale or foreign legacy use lease')
    if (requirement === 'exclusive' && record.mode !== 'exclusive') throw new Error('Exclusive legacy use lease required')
  }
  function detach(waiter: Waiter): void {
    if (waiter.signal && waiter.abort) waiter.signal.removeEventListener('abort', waiter.abort)
  }
  function pump(): void {
    if (writer) return
    while (waiting.length) {
      const next = waiting[0]!
      if (next.mode === 'exclusive' && readers !== 0) return
      waiting.shift(); detach(next)
      if (next.mode === 'exclusive') writer = true
      else readers++
      next.grant({ mode: next.mode, active: false })
      if (writer) return
    }
  }
  function acquire(mode: Mode, signal?: AbortSignal): Promise<Admission> {
    if (scope.getStore()?.active) return Promise.reject(new Error('Legacy use gate reentry'))
    if (signal?.aborted) return Promise.reject(new DOMException('Legacy use admission aborted', 'AbortError'))
    return new Promise((grant, reject) => {
      const waiter: Waiter = { mode, grant, reject, signal }
      if (signal) {
        waiter.abort = () => {
          const index = waiting.indexOf(waiter)
          if (index < 0) return
          waiting.splice(index, 1); detach(waiter)
          reject(new DOMException('Legacy use admission aborted', 'AbortError'))
          pump()
        }
        signal.addEventListener('abort', waiter.abort, { once: true })
      }
      waiting.push(waiter); pump()
    })
  }
  async function run<T>(mode: Mode, signal: AbortSignal | undefined, work: (lease: LegacyUseLease) => Promise<T>): Promise<T> {
    const record = await acquire(mode, signal)
    try {
      // Let the public settlement handoff observe cancellation before entry.
      await Promise.resolve()
      if (signal?.aborted) throw new DOMException('Legacy use admission aborted', 'AbortError')
      const lease: LegacyUseLease = Object.freeze({
        assertHeld: () => assertLease(lease),
        assertExclusive: () => assertLease(lease, 'exclusive'),
      })
      leases.set(lease, record); record.active = true
      return await scope.run(record, () => work(lease))
    } finally {
      record.active = false
      if (record.mode === 'exclusive') writer = false
      else readers--
      pump()
    }
  }
  return {
    shared: (signal, work) => run('shared', signal, work),
    exclusive: (signal, work) => run('exclusive', signal, work),
    assertLease,
  }
}
