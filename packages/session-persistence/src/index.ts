import type { PersistenceBackend, CoordinatorOptions, SessionCoordinator } from "./coordinator/types.ts"
import { createOwnership } from "./coordinator/ownership.ts"
import { createMutations } from "./coordinator/mutations.ts"
import { createDocuments } from "./coordinator/documents.ts"
import { createLoads } from "./coordinator/load.ts"
import { createLifecycle } from "./coordinator/lifecycle.ts"
import { createManagedDocuments } from './coordinator/managed-documents.ts'
import { SessionWriteBehind, type SessionWriteBehindOptions } from "./write-behind.ts"

export type {
  SessionMeta, SessionModelSelection, PersistenceBackend, SessionArtifactManifest,
  CoordinatorOptions, SessionCoordinator,
} from "./coordinator/types.ts"
export { SessionFormatUnsupportedError, registerUpgrade, registerEventType } from "./format/registry.ts"

export { SessionWriteBehind, type SessionWriteBehindOptions }
export { resolveSessionStoreRoot } from "./store-root.ts"
export { remapConversationSeed, SessionForkUnavailableError } from "./seed.ts"
export { repairTurnTail, TOOL_ABORTED_BEFORE_DISPATCH, TOOL_ABORTED_RECOVERY_RESULT } from "./repair.ts"
export {
  forkSession,
  materializeMissingImageAdmissions,
  remapSeedEvent,
  type ForkSessionOptions,
} from "./fork.ts"

// M23: the ownership lease's typed errors are part of the coordinator's
// fail-closed surface (create/append/adopt/load/flush propagate them), so
// consumers can catch them without depending on @i-harness/fs-lock directly.
export { SessionLockConflictError, SessionLockUnsupportedError } from "@i-harness/fs-lock"

export function createSessionCoordinator(backend: PersistenceBackend, opts?: CoordinatorOptions): SessionCoordinator {
  const report = opts?.reportBackgroundFailure
    ?? ((error: unknown) => { console.warn("[i-harness] background persistence failure:", error) })
  const maxDelayMs = opts?.maxDelayMs ?? 200
  const ownership = createOwnership(backend, opts)
  const mutations = createMutations(backend, ownership, maxDelayMs, report)
  const documents = createDocuments(backend, ownership, report)
  const loads = createLoads(backend, ownership, mutations)
  const lifecycle = createLifecycle(backend, ownership, mutations, documents)
  const managed = createManagedDocuments(backend, ownership, loads.loadOwned, opts, report)

  return {
    openManagedDocument: managed.open,
    revokeManagedDocumentNewWork: managed.revoke,
    closeManagedDocument: managed.closeOne,
    ...(backend.deletionReceipt ? { deletionReceipt: (sessionId: string) => backend.deletionReceipt!(sessionId) } : {}),
    ...(backend.deleteOwnedSession ? { deleteOwnedSession: lifecycle.deleteOwnedSession } : {}),
    ensureWritableFormat: mutations.ensureWritableFormat,
    create: mutations.create,
    append(sessionId, events) {
      if (managed.has(sessionId)) return Promise.reject(new Error('Managed document requires fact admission'))
      return mutations.append(sessionId, events)
    },
    enqueue(sessionId, events) {
      if (managed.has(sessionId)) throw new Error('Managed document requires fact admission')
      mutations.enqueue(sessionId, events)
    },
    async snapshot(sessionId) { const session = await managed.snapshot(sessionId); return session ? { session } : loads.snapshot(sessionId) },
    async load(sessionId) { const session = await managed.snapshot(sessionId); return session ? { session } : loads.load(sessionId) },
    async loadOwned(sessionId) { const session = await managed.snapshot(sessionId); return session ? { session } : loads.loadOwned(sessionId) },
    async list() { return backend.list() },
    async profile(sessionId) { return backend.profile(sessionId) },
    updateMeta: mutations.updateMeta,
    flush: mutations.flush,
    async close() { await managed.close(); await lifecycle.close() },
    putDocument: documents.putDocument,
    putDocumentStrict: documents.putDocumentStrict,
    getDocument: documents.getDocument,
    ownerOf: ownership.ownerOf,
    adoptOwnership: mutations.adoptOwnership,
    async releaseOwnership(sessionId) { await managed.closeOne(sessionId); await mutations.releaseOwnership(sessionId) },
  }
}

export { ownedContextReadiness } from "./context-readiness.ts"
export type { HeldFactOwner, IssuingFactOwner, BackendFactOutcome, OwnedFactBackend, ManagedDocument } from './coordinator/fact-types.ts'
export { isHeldFactOwner } from './coordinator/fact-owner.ts'
