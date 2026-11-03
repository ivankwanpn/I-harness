/** Register an original before calling it, including synchronous reentry. Only
 * live work is retained; a delivered rejection is history, not resource debt. */
export interface Operation<T = unknown> {
  work: Promise<T>
  result?: PromiseSettledResult<T>
}

export function trackOperation<T>(live: Set<Operation>, invoke: () => T | PromiseLike<T>): Operation<T> {
  const deferred = Promise.withResolvers<T>()
  const operation: Operation<T> = { work: deferred.promise }
  live.add(operation)
  void operation.work.then(value => {
    operation.result = { status: 'fulfilled', value }; live.delete(operation)
  }, reason => {
    operation.result = { status: 'rejected', reason }; live.delete(operation)
  })
  try { deferred.resolve(invoke()) } catch (error) { deferred.reject(error) }
  return operation
}

export function observedRejection(error: unknown): Promise<never> {
  const rejected = Promise.reject(error)
  void rejected.catch(() => {})
  return rejected
}

export const unavailable = () => Object.assign(new Error('Observed instructions unavailable'), { code: 'CONTEXT_INPUT_STALE' })
export const reentrantClose = () => new Error('Reentrant instruction close cannot join its own original invocation')
