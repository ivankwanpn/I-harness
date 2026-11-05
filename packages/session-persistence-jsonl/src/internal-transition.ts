/**
 * Assembly/test entry for the composed task-transition coordinator.
 *
 * The composed coordinator is not part of the storage package's public
 * coordinator surface yet (the legacy `createSessionCoordinator` remains the
 * documented one), but tests and downstream assembly code must not reach into
 * `src/backend-factory.ts` by path. This subpath is the declared seam; it can
 * disappear without notice once the composed lane becomes the public export.
 */
export { composeJsonlTaskTransitionCoordinator } from './backend-factory.ts'
export type { CoordinatorOptions } from '@i-harness/session-persistence'
