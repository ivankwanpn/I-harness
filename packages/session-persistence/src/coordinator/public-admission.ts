import { AsyncLocalStorage } from 'node:async_hooks'

type Flights = Set<Promise<unknown>>

/** Public IO lifetime only. Storage, Task and recovery authority remain with
 * the original backend owners; this context never exempts a currentness check. */
export function createCoordinatorAdmission(accepted: Flights, related: readonly Flights[], closedError: () => Error, failureMessage: string) {
  let phase: 'open' | 'closing' | 'closed' = 'open'
  let closeFlight: Promise<void> | undefined
  const context = new AsyncLocalStorage<Promise<unknown>>()
  const sets = [accepted, ...related]
  const assertAdmission = () => { if (phase !== 'open') throw closedError() }
  const assertContinuation = () => { if (phase === 'closed') throw closedError() }

  function track<T>(flights: Flights, work: () => Promise<T>): Promise<T> {
    const result = Promise.withResolvers<T>()
    flights.add(result.promise)
    void result.promise.then(() => flights.delete(result.promise), () => flights.delete(result.promise))
    try { context.run(result.promise, () => Promise.resolve(work()).then(result.resolve, result.reject)) }
    catch (error) { result.reject(error) }
    return result.promise
  }

  function retire(cleanup: () => Promise<void>, preflight?: () => void): Promise<void> {
    if (phase === 'closed') return Promise.resolve()
    try { preflight?.() } catch (error) { return Promise.reject(error) }
    const current = context.getStore()
    if (current && (current === closeFlight || sets.some(set => set.has(current)))) {
      return Promise.reject(new Error('Cannot close a coordinator from its own accepted operation'))
    }
    if (closeFlight) return closeFlight
    phase = 'closing'
    const result = Promise.withResolvers<void>()
    closeFlight = result.promise
    context.run(result.promise, () => {
      void (async () => {
        const failures: unknown[] = []
        while (sets.some(set => set.size)) {
          const settled = await Promise.allSettled([...new Set(sets.flatMap(set => [...set]))])
          for (const item of settled) if (item.status === 'rejected') failures.push(item.reason)
        }
        let cleanupFailure: { value: unknown } | undefined
        try { await cleanup() } catch (value) { cleanupFailure = { value } }
        if (cleanupFailure && failures.length === 0) throw cleanupFailure.value
        if (cleanupFailure) failures.push(cleanupFailure.value)
        if (failures.length) throw new AggregateError(failures, failureMessage)
        phase = 'closed'
        context.disable()
      })().then(result.resolve, result.reject)
    })
    void result.promise.finally(() => { if (closeFlight === result.promise) closeFlight = undefined }).catch(() => {})
    return result.promise
  }

  /** Install before capability associations capture methods. Only the method
   * table is copied; every operation uses its original backend state. */
  function expose<T extends object>(target: T, memoryOrCleanup: ReadonlySet<string>, synchronousAdmission: ReadonlySet<string>): T {
    const original = { ...target }
    for (const [name, member] of Object.entries(original)) {
      if (typeof member !== 'function') continue
      const invoke = (...args: unknown[]) => Reflect.apply(member, original, args)
      let exposed: (...args: unknown[]) => unknown
      if (memoryOrCleanup.has(name)) exposed = invoke
      else if (synchronousAdmission.has(name)) exposed = (...args) => { assertAdmission(); return invoke(...args) }
      else exposed = (...args) => {
        try { assertAdmission() } catch (error) { return Promise.reject(error) }
        return track(accepted, () => Promise.resolve(invoke(...args)))
      }
      Object.defineProperty(target, name, { value: exposed, enumerable: true, configurable: true, writable: true })
    }
    return target
  }

  return { assertAdmission, assertContinuation, isClosed: () => phase === 'closed', track, retire, expose }
}
