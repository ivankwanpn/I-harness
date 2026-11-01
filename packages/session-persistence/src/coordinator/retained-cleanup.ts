import { AsyncLocalStorage } from 'node:async_hooks'
import type { SessionCoordinator } from './types.ts'

declare const operationBrand: unique symbol
export interface RetainedCleanupOperation { readonly [operationBrand]: true }
type Attempt = { done: Promise<void>; settled: boolean; succeeded: boolean; selectors: Set<Operation> }
type Operation = { active: boolean; selections: Map<object, Attempt>; sinks: Map<object, Promise<void>> }
const operations = new WeakMap<object, Operation>()
const coordinatorClosers = new WeakMap<SessionCoordinator, (operation: RetainedCleanupOperation) => Promise<void>>()

export function assertRetainedCleanupOperation(operation: RetainedCleanupOperation): void {
  if (!operations.get(operation)?.active) throw new TypeError('Inactive retained cleanup operation')
}

export function createRetainedCleanupOperation(): RetainedCleanupOperation {
  const token = Object.freeze({}) as RetainedCleanupOperation
  operations.set(token, { active: true, selections: new Map(), sinks: new Map() })
  return token
}

export function finishRetainedCleanupOperation(token: RetainedCleanupOperation): void {
  const operation = operations.get(token)
  if (!operation) throw new TypeError('Unknown retained cleanup operation')
  if (!operation.active) return
  operation.active = false
  for (const attempt of operation.selections.values()) attempt.selectors.delete(operation)
  operation.selections.clear(); operation.sinks.clear()
}

export class RetainedRetirementSinkConflict extends Error {
  constructor() { super('Full lifecycle reentry from an active retirement sink'); this.name = 'RetainedRetirementSinkConflict' }
}
type SinkFrame = { operation: RetainedCleanupOperation; domain: object; active: boolean; parent?: SinkFrame }
const sinkContext = new AsyncLocalStorage<SinkFrame>()
export function assertOutsideRetirementSink(domain: object): void {
  for (let frame = sinkContext.getStore(); frame; frame = frame.parent) if (frame.active && frame.domain === domain) throw new RetainedRetirementSinkConflict()
}
export function inRetainedRetirementSink(domain: object, operation?: RetainedCleanupOperation): boolean {
  let frame = sinkContext.getStore()
  while (frame && (!frame.active || frame.domain !== domain)) frame = frame.parent
  if (!frame) return false
  if (!operation || frame.operation !== operation) throw new RetainedRetirementSinkConflict()
  assertRetainedCleanupOperation(operation)
  return true
}
export function runRetainedRetirementSink(operation: RetainedCleanupOperation, domain: object, identity: object, invoke: () => void | Promise<void>): Promise<void> {
  assertRetainedCleanupOperation(operation)
  const owner = operations.get(operation)!
  const existing = owner.sinks.get(identity)
  if (existing) return existing
  const result = Promise.withResolvers<void>()
  owner.sinks.set(identity, result.promise); void result.promise.catch(() => {})
  const frame: SinkFrame = { operation, domain, active: true, parent: sinkContext.getStore() }
  let returned: void | Promise<void>
  try { returned = sinkContext.run(frame, invoke) }
  catch (error) { frame.active = false; result.reject(error); return result.promise }
  void Promise.resolve(returned).then(() => { frame.active = false; result.resolve() }, error => { frame.active = false; result.reject(error) })
  return result.promise
}
/** Outer lifecycle only. Resource joins never call this sink boundary. */
export async function joinRetainedRetirementSinks(operation: RetainedCleanupOperation): Promise<void> {
  for (let frame = sinkContext.getStore(); frame; frame = frame.parent) if (frame.active && frame.operation === operation) throw new RetainedRetirementSinkConflict()
  assertRetainedCleanupOperation(operation)
  const owner = operations.get(operation)!, joined = new Set<Promise<void>>(), errors: unknown[] = []
  while ([...owner.sinks.values()].some(flight => !joined.has(flight))) {
    const batch = [...owner.sinks.values()].filter(flight => !joined.has(flight))
    batch.forEach(flight => joined.add(flight))
    const results = await Promise.allSettled(batch)
    errors.push(...results.flatMap(result => result.status === 'rejected' ? [result.reason] : []))
  }
  if (errors.length === 1) throw errors[0]
  if (errors.length) throw new AggregateError(errors, 'Retirement sinks failed')
}

/** One disposal ledger owned by one original retained binding. The operation
 * selects its attempt before retirement callbacks can reenter the owner. */
export function createRetainedCleanupTarget(dispose: () => Promise<void>, retire: (operation: RetainedCleanupOperation) => void) {
  const identity = Object.freeze({})
  let current: Attempt | undefined
  return Object.freeze({
    joinSelected(token: RetainedCleanupOperation): Promise<void> {
      assertRetainedCleanupOperation(token)
      const attempt = operations.get(token)!.selections.get(identity)
      if (!attempt) throw new TypeError('Retained resource attempt was not selected')
      return attempt.done
    },
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

export async function closeCoordinatorWithRetainedCleanupOperation(coordinator: SessionCoordinator, operation: RetainedCleanupOperation): Promise<void> {
  assertOutsideRetirementSink(coordinator)
  assertRetainedCleanupOperation(operation)
  const close = coordinatorClosers.get(coordinator)
  if (!close) throw new TypeError('Original retained coordinator required')
  return close(operation)
}
