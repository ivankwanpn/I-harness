import type { SessionCoordinator } from './types.ts'

declare const operationBrand: unique symbol
export interface RetainedCleanupOperation { readonly [operationBrand]: true }
type Attempt = { done: Promise<void>; settled: boolean; succeeded: boolean; selectors: Set<Operation> }
type Operation = { active: boolean; selections: Map<object, Attempt> }
const operations = new WeakMap<object, Operation>()
const coordinatorClosers = new WeakMap<SessionCoordinator, (operation: RetainedCleanupOperation) => Promise<void>>()

export function assertRetainedCleanupOperation(operation: RetainedCleanupOperation): void {
  if (!operations.get(operation)?.active) throw new TypeError('Inactive retained cleanup operation')
}

export function createRetainedCleanupOperation(): RetainedCleanupOperation {
  const token = Object.freeze({}) as RetainedCleanupOperation
  operations.set(token, { active: true, selections: new Map() })
  return token
}

export function finishRetainedCleanupOperation(token: RetainedCleanupOperation): void {
  const operation = operations.get(token)
  if (!operation) throw new TypeError('Unknown retained cleanup operation')
  if (!operation.active) return
  operation.active = false
  for (const attempt of operation.selections.values()) attempt.selectors.delete(operation)
  operation.selections.clear()
}

/** One disposal ledger owned by one original retained binding. The operation
 * selects its attempt before retirement callbacks can reenter the owner. */
export function createRetainedCleanupTarget(dispose: () => Promise<void>, retire: (operation: RetainedCleanupOperation) => void) {
  const identity = Object.freeze({})
  let current: Attempt | undefined
  return Object.freeze({
    select(token: RetainedCleanupOperation): Promise<void> {
      assertRetainedCleanupOperation(token)
      const operation = operations.get(token)!
      const selected = operation.selections.get(identity)
      if (selected) return selected.done
      if (current && (current.succeeded || !current.settled || current.selectors.size > 0)) {
        operation.selections.set(identity, current); current.selectors.add(operation)
        return current.done
      }
      const result = Promise.withResolvers<void>()
      const attempt: Attempt = { done: result.promise, settled: false, succeeded: false, selectors: new Set([operation]) }
      current = attempt; operation.selections.set(identity, attempt)
      // The caller may only retain the error later through a lifecycle join.
      void attempt.done.catch(() => {})
      try { retire(token) }
      catch (error) { attempt.settled = true; result.reject(error); return attempt.done }
      void Promise.resolve().then(dispose).then(() => {
        attempt.settled = true; attempt.succeeded = true; result.resolve()
      }, error => { attempt.settled = true; result.reject(error) })
      return attempt.done
    },
  })
}

/** Registered once by the original coordinator factory, not a public port. */
export function associateRetainedCoordinatorClose(coordinator: SessionCoordinator, close: (operation: RetainedCleanupOperation) => Promise<void>): void {
  if (coordinatorClosers.has(coordinator)) throw new TypeError('Retained close already associated')
  coordinatorClosers.set(coordinator, close)
}

export function closeCoordinatorWithRetainedCleanupOperation(coordinator: SessionCoordinator, operation: RetainedCleanupOperation): Promise<void> {
  assertRetainedCleanupOperation(operation)
  const close = coordinatorClosers.get(coordinator)
  if (!close) throw new TypeError('Original retained coordinator required')
  return close(operation)
}
