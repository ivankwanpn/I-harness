import { parseResultPageQuery, readManagedResultPage, resultPageFailure, type ResultPageQuery, type ResultPageResult } from '@i-harness/context-output'
import { acquireResultReadStore, type ResultStoreOptions } from '../lifecycle/result-store.ts'

/** Lifecycle joins only. Committed identity, pins and source remain store-owned. */
export function createResultPageReader(options: ResultStoreOptions, available: (sessionId: string) => boolean) {
  const pending = new Map<Promise<ResultPageResult>, string>()
  const unavailable = (): ResultPageResult => ({ kind: 'unavailable', reason: 'unavailable' })
  function read(sessionId: string, input: ResultPageQuery): Promise<ResultPageResult> {
    if (!sessionId || typeof sessionId !== 'string' || !available(sessionId)) return Promise.resolve(unavailable())
    const query = parseResultPageQuery(input)
    if (!query) return Promise.resolve({ kind: 'unavailable', reason: 'range' })
    // Schedule work only after its complete lifetime is registered. In
    // particular close must join profile/settings/acquisition and release.
    const operation = Promise.resolve().then(async (): Promise<ResultPageResult> => {
      let lease: Awaited<ReturnType<typeof acquireResultReadStore>> | undefined
      let result: ResultPageResult = unavailable()
      try {
        if (!available(sessionId)) return result
        if (options.coordinator) {
          const { meta } = await options.coordinator.profile(sessionId)
          if (meta.archived || !available(sessionId)) return result
        }
        lease = await acquireResultReadStore({ ...options, sessionId, readCallerAvailable: () => available(sessionId) })
        if (lease.service && available(sessionId)) result = await readManagedResultPage(lease.service, { sessionId }, query)
      } catch (cause) { result = resultPageFailure(cause) }
      finally {
        try { await lease?.release() }
        catch (cause) { result = resultPageFailure(cause) }
      }
      return available(sessionId) ? result : unavailable()
    })
    pending.set(operation, sessionId)
    void operation.then(() => pending.delete(operation), () => pending.delete(operation))
    return operation
  }
  return { read, get size() { return pending.size }, async join(sessionId?: string) {
    await Promise.allSettled([...pending].filter(([, id]) => sessionId === undefined || id === sessionId).map(([job]) => job))
  } }
}
