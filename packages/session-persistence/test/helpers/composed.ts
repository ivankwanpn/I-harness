import type { CoordinatorOptions, PersistenceBackend, SessionCoordinator } from '../../src/index.ts'
import { composeJsonlTaskTransitionCoordinator } from '../../../session-persistence-jsonl/src/internal-transition.ts'
import { taskDocumentStorageContract } from '../../../subagent/src/task/storage-contract.ts'

/**
 * Explicit native composition for tests that exercise the underlying ownership
 * modules. The public factory now selects this same composition through the
 * JSONL constructor-owned capability. Keeping the explicit helper lets tests
 * supply their existing controlled backend without replacing guarded methods.
 *
 * Test-only sibling imports avoid a production dependency from persistence to
 * its concrete JSONL storage package.
 */
export function createSessionCoordinator(backend: PersistenceBackend, options?: CoordinatorOptions): SessionCoordinator {
  return composeJsonlTaskTransitionCoordinator(backend, { lock: { enabled: true }, ...options }, taskDocumentStorageContract)
}

import { createJsonlBackend } from '../../../session-persistence-jsonl/src/backend-factory.ts'
type AppendOwned = NonNullable<PersistenceBackend['appendOwnedBatch']>
type ReconcileOwned = NonNullable<PersistenceBackend['reconcileOwnedBatch']>
type OwnedControls = { append: AppendOwned; reconcile: ReconcileOwned; readonly originalAppend: AppendOwned; readonly originalReconcile: ReconcileOwned }
const controls = new WeakMap<PersistenceBackend, OwnedControls>()
const methodControls = new WeakMap<PersistenceBackend, { original: Readonly<PersistenceBackend>; methods: PersistenceBackend }>()

/** Fault injection belongs inside the original constructor boundary. Updating
 * these dispatch leaves never replaces a nominal backend capability method. */
export function createControlledJsonlBackend(root: string, configure?: (backend: PersistenceBackend) => void): PersistenceBackend {
  let append!: AppendOwned, originalAppend!: AppendOwned
  let reconcile!: ReconcileOwned, originalReconcile!: ReconcileOwned
  const backend = createJsonlBackend(root, {
    wrap(backend) {
      configure?.(backend)
      const methods = { ...backend }, original = { ...backend }
      const target = backend as unknown as Record<string, unknown>
      const dispatch = methods as unknown as Record<string, unknown>
      for (const [key, value] of Object.entries(backend)) {
        if (typeof value !== 'function' || key === 'createCoordinator' || key === 'appendOwnedBatch' || key === 'reconcileOwnedBatch') continue
        target[key] = function(this: PersistenceBackend, ...args: unknown[]) {
          const next = dispatch[key]
          if (typeof next !== 'function') throw new TypeError('Missing controlled method ' + key)
          return Reflect.apply(next, this, args)
        }
      }
      methodControls.set(backend, { original, methods })
    },
    wrapOwnedBatch(original) { append = originalAppend = original; return (...args) => append(...args) },
    wrapOwnedReconcile(original) { reconcile = originalReconcile = original; return (...args) => reconcile(...args) },
  })
  controls.set(backend, {
    get append() { return append }, set append(value) { append = value },
    get reconcile() { return reconcile }, set reconcile(value) { reconcile = value },
    get originalAppend() { return originalAppend }, get originalReconcile() { return originalReconcile },
  })
  return backend
}
export function ownedControls(backend: PersistenceBackend): OwnedControls {
  const original = controls.get(backend)
  if (!original) throw new TypeError('Controlled original JSONL fixture required')
  return original
}

export function backendControls(backend: PersistenceBackend) {
  const original = methodControls.get(backend)
  if (!original) throw new TypeError('Controlled original JSONL fixture required')
  return original
}
