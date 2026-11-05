import type { CoordinatorOptions, PersistenceBackend, SessionCoordinator } from '../../src/index.ts'
import { composeJsonlTaskTransitionCoordinator } from '../../../session-persistence-jsonl/src/internal-transition.ts'
import { taskDocumentStorageContract } from '../../../subagent/src/task/storage-contract.ts'

/**
 * D-12 test migration helper for the persistence package.
 *
 * `createSessionCoordinator` from `src/index.ts` is the legacy factory and
 * refuses format-14 sessions by design (`TASK_TRANSITION_UNSUPPORTED`). The
 * composed coordinator is the production path; tests that need a working
 * coordinator construct it through this helper, with the same
 * `(backend, options?) => coordinator` call shape as the legacy factory.
 *
 * The import crosses into the sibling storage package by relative path on
 * purpose: `session-persistence` cannot declare a dependency on the JSONL
 * storage that depends on it, and the boundary gate scans only `src/`.
 */
export function createSessionCoordinator(backend: PersistenceBackend, options?: CoordinatorOptions): SessionCoordinator {
  return composeJsonlTaskTransitionCoordinator(backend, { lock: { enabled: true }, ...options }, taskDocumentStorageContract)
}
