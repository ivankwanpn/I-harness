import { parseResultPageQuery, readManagedResultPage, resultPageFailure, type ResultPageQuery, type ResultPageResult } from '@i-harness/context-output'
import { acquireResultReadStore, type ResultStoreOptions, type ResultReadScope } from '../lifecycle/result-store.ts'
import { lookupProcessReadContext } from '@i-harness/session-persistence/internal/process-read-context'

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
    const deny = (result: ResultPageResult = unavailable()) => {
      // A matching active/expired scope remembers denial even when callers
      // catch the page result and retain an earlier private candidate.
      try { lookupProcessReadContext(undefined!, sessionId) } catch {}
      return result
    }
    if (!sessionId || typeof sessionId !== 'string' || !available(sessionId) || cleanups.size) return Promise.resolve(deny())
    const query = parseResultPageQuery(input)
    if (!query) return Promise.resolve(deny({ kind: 'unavailable', reason: 'range' }))
    // Schedule work only after its complete lifetime is registered. In
    // particular close must join profile/settings/acquisition and release.
    const operation = Promise.resolve().then(async (): Promise<ResultPageResult> => {
      let lease: Awaited<ReturnType<typeof acquireResultReadStore>> | undefined
      let result: ResultPageResult = unavailable()
      let assertScope = () => {}
      let getter: (() => ResultReadScope) | undefined
      try {
        if (!available(sessionId)) return deny(result)
        const process = lookupProcessReadContext(options.coordinator!, sessionId)
        process?.assertPageAdmission()
        if (process && !options.resultReadScopeFor) throw new Error('PROCESS_READ_UNAVAILABLE')
        getter = await options.resultReadScopeFor?.(sessionId)
        process?.assertCurrent()
        if (!available(sessionId)) return deny(result)
        const revision = getter?.().revision
        assertScope = () => {
          if (!available(sessionId) || getter && getter().revision !== revision) throw new Error('Result read scope changed')
        }
        assertScope()
        if (options.coordinator) {
          const { meta } = await options.coordinator.profile(sessionId)
          assertScope()
          if (meta.archived || !available(sessionId)) return deny(result)
        }
        try {
          const readScope = getter
          lease = await acquireResultReadStore({ ...options, sessionId, readCallerAvailable: () => available(sessionId) }, readScope ? () => { assertScope(); return readScope() } : undefined)
        } catch (cause) {
          // Acquisition may already own a failed final cleanup. Keep only the
          // original recovery closure supplied by that internal acquire path.
          const retry = cause instanceof AggregateError ? (cause as AggregateError & { retryCleanup?: Release }).retryCleanup : undefined
          if (typeof retry === 'function') retainCleanup(sessionId, retry)
          throw cause
        }
        assertScope()
        if (lease.service && available(sessionId)) {
          const service = lease.service
          result = 'withProcessReadContext' in lease ? await lease.withProcessReadContext(() => readManagedResultPage(service, { sessionId }, query)) : await readManagedResultPage(service, { sessionId }, query)
        }
        if ('kind' in result) deny(result)
        assertScope()
        if (process) {
          const currentGetter = await options.resultReadScopeFor!(sessionId)
          process.assertCurrent()
          if (!!currentGetter !== !!getter || currentGetter?.().revision !== getter?.().revision) throw new Error('Result read scope owner changed')
        }
      } catch (cause) { result = deny(resultPageFailure(cause)) }
      finally {
        try { await lease?.release() }
        catch (cause) { if (lease) retainCleanup(sessionId, lease.release); result = deny(resultPageFailure(cause)) }
      }
      // A denial has no body to revoke. Preserve its typed reason after release;
      // only a successfully read page needs the final currentness checks.
      if ('kind' in result) return deny(result)
      try {
        assertScope()
        if (options.coordinator) {
          const { meta } = await options.coordinator.profile(sessionId)
          assertScope()
          if (meta.archived) return deny()
        }
        const process = lookupProcessReadContext(options.coordinator!, sessionId)
        if (process) {
          const currentGetter = await options.resultReadScopeFor!(sessionId)
          process.assertCurrent(); assertScope()
          if (!!currentGetter !== !!getter || currentGetter?.().revision !== getter?.().revision) return deny()
        }
      } catch { return deny() }
      return available(sessionId) ? result : deny()
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
