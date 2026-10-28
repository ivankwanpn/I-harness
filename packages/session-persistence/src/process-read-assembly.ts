import type { CoordinatorOptions, PersistenceBackend } from './coordinator/types.ts'
import type { ProcessReadStorage } from './coordinator/process-read-storage.ts'
import { createSessionCoordinatorCore } from './coordinator-factory.ts'

/** Trusted construction seam; it creates the coordinator and all owners once. */
export function assembleSessionCoordinatorWithProcessStorage(backend: PersistenceBackend, options: CoordinatorOptions | undefined, storage: ProcessReadStorage) {
  return createSessionCoordinatorCore(backend, options, storage)
}
