import type { PersistenceBackend, SessionArtifactManifest } from "./types.ts"
import type { Ownership } from "./ownership.ts"
import type { Mutations } from "./mutations.ts"
import type { Documents } from "./documents.ts"

export function createLifecycle(
  backend: Pick<PersistenceBackend, "deleteOwnedSession">,
  { withSessionOperation, ensureOwnership, releaseOwnershipUnlocked, pendingOperations, releaseHeldLocks, clearHeldLocks }:
    Pick<Ownership, "withSessionOperation" | "ensureOwnership" | "releaseOwnershipUnlocked" | "pendingOperations" | "releaseHeldLocks" | "clearHeldLocks">,
  { closeAdmission, pendingWriteBehind, removeWriteBehind, flushWriteBehinds, cancelAutomaticWaits, clearConversationIndexes }:
    Pick<Mutations, "closeAdmission" | "pendingWriteBehind" | "removeWriteBehind" | "flushWriteBehinds" | "cancelAutomaticWaits" | "clearConversationIndexes">,
  { closeAdmissions: closeDocumentAdmissions, pendingWrites: pendingDocuments }:
    Pick<Documents, "closeAdmissions" | "pendingWrites">,
) {
  return {
    async deleteOwnedSession(sessionId: string, manifest: SessionArtifactManifest) {
      // Close local admissions synchronously, before awaiting the existing writes.
      closeAdmission(sessionId)
      closeDocumentAdmissions(manifest.documents)
      const wb = pendingWriteBehind(sessionId)
      if (wb) { wb.cancelAutomaticWait(); await wb.flush(); removeWriteBehind(sessionId) }
      await pendingDocuments()
      await withSessionOperation(sessionId, async () => {
        await ensureOwnership(sessionId)
        try { await backend.deleteOwnedSession!(sessionId, manifest) }
        finally { await releaseOwnershipUnlocked(sessionId) }
      })
    },
    async close() {
      const flushed = await Promise.allSettled(flushWriteBehinds())
      cancelAutomaticWaits()
      await pendingDocuments()
      await Promise.allSettled(pendingOperations())
      // M23: the live cycle ends after the drain — release every held lease
      // (best-effort so one failed release cannot strand the others). M1:
      // fs-lock's release() is sync-throwing, so a bare `lock.release()` in
      // the map callback would escape Promise.allSettled's argument
      // evaluation — stranding every later lease and skipping heldLocks
      // .clear(). Promise.resolve().then() turns a sync throw into a
      // rejection allSettled swallows: every lease is attempted.
      await Promise.allSettled(releaseHeldLocks())
      clearHeldLocks()
      clearConversationIndexes()
      const failures = flushed.flatMap(result => result.status === "rejected" ? [result.reason] : [])
      if (failures.length > 0) throw new AggregateError(failures, "Failed to persist sessions during shutdown")
    },
  }
}
