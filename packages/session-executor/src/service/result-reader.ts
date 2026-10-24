import { parseResultPageQuery, readManagedResultPage, resultPageFailure, type ResultPageQuery, type ResultPageResult } from '@i-harness/context-output'
import { acquireResultReadStore, type ResultStoreOptions } from '../lifecycle/result-store.ts'

/** Lifecycle joins only. Committed identity, pins and source remain store-owned. */
export function createResultPageReader(options: ResultStoreOptions, available: (sessionId: string) => boolean) {
  const pending = new Map<Promise<ResultPageResult>, string>()
  type Release = () => Promise<void>
  interface Cleanup { sessionId: string; release: Release; flight?: Promise<void> }
  const cleanups = new Map<Release, Cleanup>()
  const unavailable = (): ResultPageResult => ({ kind: 'unavailable', reason: 'unavailable' })
  function retainCleanup(sessionId: string, release: Release) { cleanups.set(release, { sessionId, release }) }
  function retryCleanup(held: Cleanup): Promise<void> {
    if (!held.flight) held.flight = Promise.resolve().then(held.release).then(() => { cleanups.delete(held.release) }).finally(() => { held.flight = undefined })
    return held.flight
  }
  function read(sessionId: string, input: ResultPageQuery): Promise<ResultPageResult> {
    if (!sessionId || typeof sessionId !== 'string' || !available(sessionId) || cleanups.size) return Promise.resolve(unavailable())
    const query = parseResultPageQuery(input)
    if (!query) return Promise.resolve({ kind: 'unavailable', reason: 'range' })
    // Schedule work only after its complete lifetime is registered. In
    // particular close must join profile/settings/acquisition and release.
    const operation = Promise.resolve().then(async (): Promise<ResultPageResult> => {
      let lease: Awaited<ReturnType<typeof acquireResultReadStore>> | undefined
      let result: ResultPageResult = unavailable()
      let assertScope = () => {}
      try {
        if (!available(sessionId)) return result
        const getter = await options.resultReadScopeFor?.(sessionId)
        if (!available(sessionId)) return result
        const revision = getter?.().revision
        assertScope = () => {
          if (!available(sessionId) || getter && getter().revision !== revision) throw new Error('Result read scope changed')
        }
        assertScope()
        if (options.coordinator) {
          const { meta } = await options.coordinator.profile(sessionId)
          assertScope()
          if (meta.archived || !available(sessionId)) return result
        }
        try {
          lease = await acquireResultReadStore({ ...options, sessionId, readCallerAvailable: () => available(sessionId) }, getter ? () => { assertScope(); return getter() } : undefined)
        } catch (cause) {
          // Acquisition may already own a failed final cleanup. Keep only the
          // original recovery closure supplied by that internal acquire path.
          const retry = cause instanceof AggregateError ? (cause as AggregateError & { retryCleanup?: Release }).retryCleanup : undefined
          if (typeof retry === 'function') retainCleanup(sessionId, retry)
          throw cause
        }
        assertScope()
        if (lease.service && available(sessionId)) result = await readManagedResultPage(lease.service, { sessionId }, query)
        assertScope()
      } catch (cause) { result = resultPageFailure(cause) }
      finally {
        try { await lease?.release() }
        catch (cause) { if (lease) retainCleanup(sessionId, lease.release); result = resultPageFailure(cause) }
      }
      // A denial has no body to revoke. Preserve its typed reason after release;
      // only a successfully read page needs the final currentness checks.
      if ('kind' in result) return result
      try {
        assertScope()
        if (options.coordinator) {
          const { meta } = await options.coordinator.profile(sessionId)
          assertScope()
          if (meta.archived) return unavailable()
        }
      } catch { return unavailable() }
      return available(sessionId) ? result : unavailable()
    })
    pending.set(operation, sessionId)
    void operation.then(() => pending.delete(operation), () => pending.delete(operation))
    return operation
  }
  return { read, get size() { return pending.size + cleanups.size }, async join(sessionId?: string) {
    const joined = await Promise.allSettled([...pending].filter(([, id]) => sessionId === undefined || id === sessionId).map(([job]) => job))
    // One finite attempt per retained owner, only on an explicit lifecycle
    // join. Concurrent joins share its flight; ordinary reads never retry it.
    const released = await Promise.allSettled([...cleanups.values()].filter(held => sessionId === undefined || held.sessionId === sessionId).map(retryCleanup))
    const failures = [...joined, ...released].filter((result): result is PromiseRejectedResult => result.status === 'rejected')
    if (failures.length) throw new AggregateError(failures.map(result => result.reason), 'Result reader cleanup incomplete')
  } }
}
