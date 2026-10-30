import { AsyncLocalStorage } from "node:async_hooks"
import { runRetainedRetirementSink, joinRetainedRetirementSinks, assertOutsideRetirementSink, assertRetainedCleanupOperation, createRetainedCleanupOperation, finishRetainedCleanupOperation, type RetainedCleanupOperation } from '@i-harness/session-persistence/internal/retained-inspection'

/** Shared by input admission, runtime starts and structural management. Holding
 * this fence drains already admitted producers and refuses new ones. */
export function createSessionManagementFence() {
  let domain: object = Object.freeze({}), associated = false
  const blocked = new Set<string>()
  const retired = new Set<string>()
  const work = new Map<string, Set<Promise<unknown>>>()
  const admitted = new AsyncLocalStorage<ReadonlyMap<string, { active: boolean }>>()
  type Observer = { id: string; active: boolean; charged: boolean; preflight?(): void; prepare?(operation: RetainedCleanupOperation): void; retired(operation: RetainedCleanupOperation): void | Promise<void> }
  const observers = new Set<Observer>()
  let count = 0
  function assertOpen(id: string) {
    if (blocked.has(id) || retired.has(id)) throw new Error("Session management is in progress or session is deleted")
  }
  function uncharge(observer: Observer) { if (observer.charged) { observer.charged = false; count--; observers.delete(observer) } }
  function preflightObservers(id: string) { for (const observer of observers) if (observer.id === id) observer.preflight?.() }
  function notify(id: string, operation: RetainedCleanupOperation) {
    const selected = [...observers].filter(observer => observer.id === id && observer.active)
    for (const observer of selected) observer.active = false
    return selected.map(observer => {
      let job: Promise<void>
      try { observer.prepare?.(operation); job = runRetainedRetirementSink(operation, domain, observer, () => observer.retired(operation)) } catch (error) { job = Promise.reject(error) }
      const done = job.finally(() => uncharge(observer))
      void done.catch(() => {})
      return done
    })
  }
  async function join(jobs: readonly Promise<void>[]) {
    const results = await Promise.allSettled(jobs)
    return [...new Set(results.flatMap(result => result.status === 'rejected' ? [result.reason] : []))]
  }
  return {
    associateRetainedDomain(owner: object) { if (associated && domain !== owner) throw new TypeError('Foreign fence lifecycle domain'); domain = owner; associated = true },
    assertOpen,
    observe(id: string, onRetired: (operation: RetainedCleanupOperation) => void | Promise<void>, preflight?: () => void, prepare?: (operation: RetainedCleanupOperation) => void) {
      if (typeof id !== 'string' || !id || id.length > 256 || typeof onRetired !== 'function') throw new TypeError('Invalid management observation')
      assertOpen(id)
      if (count >= 64) throw new Error('Management observation capacity reached')
      const observer: Observer = { id, active: true, charged: true, retired: onRetired, preflight, prepare }
      count++; observers.add(observer)
      return Object.freeze({
        assertCurrent() { if (!observer.active) throw new Error('Management observation retired'); assertOpen(id) },
        release() { if (!observer.active) return; observer.active = false; uncharge(observer) },
      })
    },
    retire(id: string, supplied?: RetainedCleanupOperation): Promise<void> {
      preflightObservers(id); assertOutsideRetirementSink(domain)
      const operation = supplied ?? createRetainedCleanupOperation()
      assertRetainedCleanupOperation(operation)
      retired.add(id)
      const done = join([...notify(id, operation), joinRetainedRetirementSinks(operation)]).then(errors => { if (errors.length) throw new AggregateError(errors, 'Management observation cleanup failed') })
      const result = supplied ? done : done.finally(() => finishRetainedCleanupOperation(operation))
      void result.catch(() => {})
      return result
    },
    async run<T>(id: string, operation: () => Promise<T>): Promise<T> {
      // Already registered producers may finish their nested service calls
      // while management drains them. No new outer admission gets this grant.
      if (!admitted.getStore()?.get(id)?.active || retired.has(id)) assertOpen(id)
      // Registration precedes the operation's first await.
      const token = { active: true }
      const context = new Map(admitted.getStore()); context.set(id, token)
      const pending = Promise.resolve().then(() => admitted.run(context, operation))
      let jobs = work.get(id)
      if (!jobs) { jobs = new Set(); work.set(id, jobs) }
      jobs.add(pending)
      try { return await pending } finally { token.active = false; jobs.delete(pending); if (!jobs.size) work.delete(id) }
    },
    async exclusive<T>(id: string, operation: (cleanup: RetainedCleanupOperation) => Promise<T>, preflight?: () => Promise<void>, supplied?: RetainedCleanupOperation): Promise<T> {
      preflightObservers(id); assertOutsideRetirementSink(domain); assertOpen(id)
      const cleanup = supplied ?? createRetainedCleanupOperation()
      assertRetainedCleanupOperation(cleanup)
      blocked.add(id)
      const cleanupResult = join([...notify(id, cleanup), joinRetainedRetirementSinks(cleanup)])
      let primary: { error: unknown } | undefined
      try {
        // Refuse live turns/approval waits immediately before draining short
        // admitted writers. The blocked flag closes the check/admission race.
        await preflight?.()
        const errors = await cleanupResult
        if (errors.length) throw new AggregateError(errors, 'Management observation cleanup failed')
        // An admitted operation may schedule a separately drained child before
        // it settles. Keep draining until no registered producer remains.
        while (work.get(id)?.size) {
          await preflight?.()
          await Promise.allSettled([...(work.get(id) ?? [])])
        }
        return await operation(cleanup)
      }
      catch (error) { primary = { error }; throw error }
      finally {
        const errors = await cleanupResult
        blocked.delete(id); if (!supplied) finishRetainedCleanupOperation(cleanup)
        // Preserve a literal preflight/operation failure and any independent
        // observer cleanup debt without retrying the selected attempt.
        if (primary && errors.length && !(primary.error instanceof AggregateError && primary.error.errors.length === errors.length && primary.error.errors.every((error, index) => error === errors[index]))) throw new AggregateError([primary.error, ...errors], 'Management and observation cleanup failed')
      }
    },
  }
}
export type SessionManagementFence = ReturnType<typeof createSessionManagementFence>
