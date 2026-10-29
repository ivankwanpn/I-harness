import type { PersistenceBackend, SessionArtifactManifest } from "./types.ts"
import type { Ownership } from "./ownership.ts"
import type { Mutations } from "./mutations.ts"
import type { Documents } from "./documents.ts"
import type { createProcessReadLatches } from './process-read-latches.ts'

export function createLifecycle(
  backend: Pick<PersistenceBackend, "deleteOwnedSession">,
  { withSessionOperation, ensureOwnership, releaseOwnershipUnlocked, pendingOperations, releaseHeldLocks }:
    Pick<Ownership, "withSessionOperation" | "ensureOwnership" | "releaseOwnershipUnlocked" | "pendingOperations" | "releaseHeldLocks">,
  { closeAdmission, pendingWriteBehind, removeWriteBehind, flushWriteBehinds, cancelAutomaticWaits, clearConversationIndexes }:
    Pick<Mutations, "closeAdmission" | "pendingWriteBehind" | "removeWriteBehind" | "flushWriteBehinds" | "cancelAutomaticWaits" | "clearConversationIndexes">,
  { closeAdmissions: closeDocumentAdmissions, pendingWrites: pendingDocuments, observations, withDocumentLeases, retryDisposals }:
    Pick<Documents, "closeAdmissions" | "pendingWrites" | "observations" | "withDocumentLeases" | "retryDisposals">,
  managed: { revoke(sessionId: string): void; closeOne(sessionId: string): Promise<void> },
  processLatches?: ReturnType<typeof createProcessReadLatches>,
) {
  const deletedListeners = new Set<(sessionId: string, manifest: SessionArtifactManifest) => Promise<void>>()
  return {
    onDocumentDeleted(listener: (sessionId: string, manifest: SessionArtifactManifest) => Promise<void>) {
      deletedListeners.add(listener)
      return () => { deletedListeners.delete(listener) }
    },
    async deleteOwnedSession(sessionId: string, manifest: SessionArtifactManifest) {
      // Admission, keyed leases and the backend must consume one captured set.
      manifest = { documents: [...manifest.documents], ...(manifest.files === undefined ? {} : { files: [...manifest.files] }) }
      const token = processLatches?.beginMutation({ sessionIds: [sessionId], documentKeys: manifest.documents, kind: 'other' })
      let outcome: 'settled' | 'unknown' = 'unknown'
      try {
      // Close local admissions synchronously, before awaiting the existing writes.
      const admission = observations.beginMutation([sessionId], manifest.documents, true)
      closeAdmission(sessionId)
      closeDocumentAdmissions(manifest.documents)
      managed.revoke(sessionId)
      try {
        await admission.join()
        await managed.closeOne(sessionId)
        const wb = pendingWriteBehind(sessionId)
        if (wb) { wb.cancelAutomaticWait(); await wb.flush(); removeWriteBehind(sessionId) }
        await pendingDocuments()
        await withSessionOperation(sessionId, async () => {
          await ensureOwnership(sessionId)
          try {
            await withDocumentLeases(manifest.documents, async () => {
              await backend.deleteOwnedSession!(sessionId, manifest)
              for (const listener of deletedListeners) await listener(sessionId, manifest)
            })
          }
          finally { await releaseOwnershipUnlocked(sessionId) }
        })
      } finally { admission.finish() }
      outcome = 'settled'
      } finally { token?.end(outcome) }
    },
    async close(releaseOwners = true) {
      processLatches?.closeAdmission()
      const flushed = await Promise.allSettled(flushWriteBehinds())
      cancelAutomaticWaits()
      await pendingDocuments()
      await Promise.allSettled(pendingOperations())
      // Unknown managed/observation work still depends on its original actual
      // owners. Independent drainage may proceed without retiring those leases.
      const released = releaseOwners ? await Promise.allSettled(releaseHeldLocks()) : []
      const disposed = await Promise.allSettled([retryDisposals()])
      clearConversationIndexes()
      const failures = [...flushed, ...released, ...disposed].flatMap(result => result.status === "rejected" ? [result.reason] : [])
      if (failures.length > 0) throw new AggregateError(failures, "Failed to persist sessions during shutdown")
    },
  }
}
