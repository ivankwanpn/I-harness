import type { FactCode } from '@i-harness/core-session'

type Ticket = { release(): void }
type Waiter = { grant(ticket: Ticket): void; refuse(code: FactCode): void; signal?: AbortSignal; abort?: () => void; required: boolean }
/** Scheduling only. Sources retain their facts while waiting; no event bodies
 * or producer callbacks enter this FIFO. Issued groups keep their ticket. */
export function createFactCapacity(limit: number) {
  let active = 0, closed: FactCode | undefined, optionalBlocked: FactCode | undefined
  const waiting: Waiter[] = []
  const ticket = (): Ticket => {
    active++
    let released = false
    return { release() {
      if (released) return
      released = true; active--
      grant()
    } }
  }
  const removeAbort = (waiter: Waiter) => {
    if (waiter.abort) waiter.signal?.removeEventListener('abort', waiter.abort)
  }
  const grant = () => {
    while (!closed && active < limit && waiting.length) {
      const next = waiting.shift()!
      removeAbort(next)
      if (!next.required && optionalBlocked) next.refuse(optionalBlocked)
      else if (next.signal?.aborted) next.refuse('FACT_CANCELLED')
      else next.grant(ticket())
    }
  }
  return {
    acquire(signal?: AbortSignal, required = false): Promise<Ticket | FactCode> {
      if (closed) return Promise.resolve(closed)
      if (optionalBlocked && !required) return Promise.resolve(optionalBlocked)
      if (signal?.aborted) return Promise.resolve('FACT_CANCELLED')
      if (active < limit && !waiting.length) return Promise.resolve(ticket())
      return new Promise(resolve => {
        const waiter: Waiter = { grant: resolve, refuse: resolve, signal, required }
        waiter.abort = () => {
          const index = waiting.indexOf(waiter)
          if (index < 0) return
          waiting.splice(index, 1); removeAbort(waiter)
          resolve('FACT_CANCELLED'); grant()
        }
        waiting.push(waiter)
        signal?.addEventListener('abort', waiter.abort, { once: true })
      })
    },
    stop(code: FactCode) {
      closed = code
      for (const waiter of waiting.splice(0)) { removeAbort(waiter); waiter.refuse(code) }
    },
    blockOptional(code: FactCode) {
      optionalBlocked = code
      for (let index = waiting.length - 1; index >= 0; index--) {
        const waiter = waiting[index]!
        if (waiter.required) continue
        waiting.splice(index, 1); removeAbort(waiter); waiter.refuse(code)
      }
    },
    revokeNewWork() { this.blockOptional('FACT_CLOSED') },
    resume() { closed = undefined; grant() },
  }
}
