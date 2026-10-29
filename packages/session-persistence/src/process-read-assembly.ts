import type { CoordinatorOptions, PersistenceBackend } from './coordinator/types.ts'
import type { ProcessReadStorage } from './coordinator/process-read-storage.ts'
import { createSessionCoordinatorCore } from './coordinator-factory.ts'
import { AsyncLocalStorage } from 'node:async_hooks'
import type { ManagedArtifactRef } from '@i-harness/core-session'
import { createColdProcessReadOwner, type ProcessReadObservation, type ProcessReadOptions, type ProcessReadScopeRunner, type ProcessReadUpdate, type ProcessReadScopeControl } from './coordinator/process-read-owner.ts'
import { createManagedProcessReadOwner } from './coordinator/process-read-managed-owner.ts'
import type { createProcessReadVisibility } from './coordinator/process-read-visibility.ts'
import type { SessionCoordinator } from './coordinator/types.ts'
import type { TaskDocumentConfiguration } from './coordinator/task-document-operation.ts'

type Scope = { coordinator: SessionCoordinator; id: string; observation: ProcessReadObservation; visibility: ReturnType<typeof createProcessReadVisibility>; control: ProcessReadScopeControl; assertOriginal(): void; failed: boolean }
const active = new AsyncLocalStorage<Scope>()
/** Checked lookup only; no caller can install a view or predicate. */
export function lookupProcessReadContext(coordinator: SessionCoordinator, id: string) {
  const scope = active.getStore()
  if (!scope) return undefined
  const check = () => {
    try {
      if (scope.failed || scope.coordinator !== coordinator || scope.id !== id) throw new Error('PROCESS_READ_UNAVAILABLE')
      scope.assertOriginal(); scope.observation.assertCurrent()
    } catch (error) { scope.failed = true; throw error }
  }
  check()
  const predicate = Object.freeze({
    assertPageAdmission() {
      try { if (this !== predicate) throw new TypeError('Invalid process context receiver'); check(); scope.control.assertPageAdmission() }
      catch (error) { scope.failed = true; throw error }
    },
    assertCurrent() { if (this !== predicate) { scope.failed = true; throw new TypeError('Invalid process context receiver') }; check() },
    containsVisibleResult(ref: ManagedArtifactRef) { if (this !== predicate) { scope.failed = true; throw new TypeError('Invalid process context receiver') }; check(); return scope.visibility.contains(ref) },
  })
  return predicate
}

/** Trusted construction seam; it creates the coordinator and all owners once. */
export function assembleSessionCoordinatorWithProcessStorage(backend: PersistenceBackend, options: CoordinatorOptions | undefined, storage: ProcessReadStorage, taskStorage?: Omit<TaskDocumentConfiguration, 'captureParent'>) {
  let owners: Parameters<NonNullable<Parameters<typeof createSessionCoordinatorCore>[3]>>[0] | undefined
  const coordinator = createSessionCoordinatorCore(backend, options, storage, value => { owners = value }, taskStorage)
  const original = owners!
  const cold = createColdProcessReadOwner(storage, original.latches), managed = createManagedProcessReadOwner(storage, original.managed)
  let originalMethod: SessionCoordinator['withProcessReadObservation']
  let originalDescriptors: PropertyDescriptorMap
  const method: NonNullable<SessionCoordinator['withProcessReadObservation']> = async function<T, U>(this: SessionCoordinator, id: string, options: ProcessReadOptions, work: (observation: ProcessReadObservation) => Promise<T>, publish: (candidate: T, observation: ProcessReadObservation, last: ProcessReadUpdate) => Promise<U>) {
    if (this !== coordinator || originalMethod !== method) {
      const originalScope = active.getStore(); if (originalScope) originalScope.failed = true
      throw new Error('PROCESS_READ_UNAVAILABLE')
    }
    const scopes = new WeakMap<ProcessReadObservation, Scope>()
    const assertOriginal = () => {
      for (const [key, expected] of Object.entries(originalDescriptors)) {
        const descriptor = Object.getOwnPropertyDescriptor(coordinator, key)
        if (!descriptor || !('value' in descriptor) || !('value' in expected) || descriptor.value !== expected.value) throw new Error('PROCESS_READ_UNAVAILABLE')
      }
    }
    const within: ProcessReadScopeRunner = (observation, visibility, run, control) => {
      let scope = scopes.get(observation)
      if (!scope) { scope = { coordinator, id, observation, visibility, control, assertOriginal, failed: false }; scopes.set(observation, scope) }
      const current = scope
      return active.run(current, async () => {
        try { const result = await run(); if (current.failed) throw new Error('PROCESS_READ_UNAVAILABLE'); current.assertOriginal(); current.control.assertExit(); return result }
        catch (error) { current.failed = true; throw error }
      })
    }
    try { assertOriginal() } catch (error) { const originalScope = active.getStore(); if (originalScope) originalScope.failed = true; throw error }
    return (original.managed.has(id) ? managed : cold).run(id, options, work, publish, within)
  }
  // Only genuine JSONL composition installs this optional method. Generic
  // coordinator construction does not acquire storage authority from options.
  const capabilityReady = true
  if (capabilityReady) { originalMethod = method; Object.defineProperty(coordinator, 'withProcessReadObservation', { value: method, configurable: true, writable: true, enumerable: true }) }
  originalDescriptors = Object.getOwnPropertyDescriptors(coordinator)
  return coordinator
}
