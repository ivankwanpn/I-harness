import type { CoordinatorOptions, PersistenceBackend, SessionCoordinator } from '@i-harness/session-persistence'
import { composeJsonlTaskTransitionCoordinator } from '@i-harness/session-persistence-jsonl/internal/transition'
import { createJsonlBackend } from '../../src/index.ts'
import { taskDocumentStorageContract } from '../../../subagent/src/task/storage-contract.ts'

/**
 * D-12 test migration helper.
 *
 * The legacy `createSessionCoordinator` refuses format-14 sessions by design
 * (`TASK_TRANSITION_UNSUPPORTED`): durable task transitions are mandatory for
 * current-format session creation. Tests that only need a working coordinator
 * use this helper instead of relaxing that product guard.
 *
 * The signature intentionally matches the legacy factory
 * `(backend, options?) => coordinator` so call sites stay unchanged; the
 * composed coordinator is constructed with the production storage contract and
 * the ownership lock enabled (override through `options.lock` when a test needs
 * a different lock root or must prove the unlocked path).
 */
export function createSessionCoordinator(backend: PersistenceBackend, options?: CoordinatorOptions): SessionCoordinator {
  return composeJsonlTaskTransitionCoordinator(backend, { lock: { enabled: true }, ...options }, taskDocumentStorageContract)
}

/** Convenience for tests that build the backend from a root directory. */
export function createSessionCoordinatorAt(root: string, options?: CoordinatorOptions): SessionCoordinator {
  return createSessionCoordinator(createJsonlBackend(root), options)
}
