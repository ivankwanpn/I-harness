import type { PersistenceBackend } from '../../src/index.ts'
import { createOwnership } from '../../src/coordinator/ownership.ts'
import { createMutations } from '../../src/coordinator/mutations.ts'
import { createLoads } from '../../src/coordinator/load.ts'
import { createDocuments } from '../../src/coordinator/documents.ts'
import { createLifecycle } from '../../src/coordinator/lifecycle.ts'
import type { CoordinatorOptions } from '../../src/index.ts'

// These storage/queue tests exercise the actual structural units. A fake backend
// is deliberately never represented as an original task-transition owner.
export function createStorageUnits(backend: PersistenceBackend, options: CoordinatorOptions = {}) {
  const report = options.reportBackgroundFailure ?? (() => {})
  const ownership = createOwnership(backend, options)
  const documents = createDocuments(backend, ownership, report)
  const mutations = createMutations(backend, ownership, options.maxDelayMs ?? 200, report, undefined, documents.observations)
  const loads = createLoads(backend, ownership, mutations)
  const lifecycle = createLifecycle(backend, ownership, mutations, documents, { revoke() {}, async closeOne() {} })
  return {
    create: mutations.create, append: mutations.append, enqueue: mutations.enqueue,
    updateMeta: mutations.updateMeta, profile: backend.profile?.bind(backend),
    ownerOf: ownership.ownerOf, hasLiveOwnership: ownership.hasLiveOwnership,
    adoptOwnership: mutations.adoptOwnership, releaseOwnership: mutations.releaseOwnership,
    async flush(id: string) { await mutations.flush(id); await documents.joinTaskDocumentIO() },
    load: loads.load, loadOwned: loads.loadOwned, snapshot: loads.snapshot,
    putDocument: documents.putDocument, getDocument: documents.getDocument,
    close: () => lifecycle.close(),
  }
}
