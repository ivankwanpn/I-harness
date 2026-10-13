import { CURRENT_FORMAT_VERSION, type SessionEvent } from "@i-harness/core-session"
import { SessionWriteBehind } from "../write-behind.ts"
import type { PersistenceBackend, SessionMeta } from "./types.ts"
import type { Ownership } from "./ownership.ts"

export function createMutations(
  backend: Pick<PersistenceBackend, "create" | "append" | "updateMeta">,
  { lockEnabled, ownerOf, withSessionOperation, ensureOwnership, releaseOwnershipUnlocked }:
    Pick<Ownership, "lockEnabled" | "ownerOf" | "withSessionOperation" | "ensureOwnership" | "releaseOwnershipUnlocked">,
  maxDelayMs: number,
  report: (error: unknown) => void,
) {
  const writeBehinds = new Map<string, SessionWriteBehind>()
  const deleted = new Set<string>()
  function assertWritable(id: string) { if (deleted.has(id)) throw new Error("Session is deleting or deleted") }

  const writeBehindFor = (sessionId: string): SessionWriteBehind => {
    let wb = writeBehinds.get(sessionId)
    if (!wb) {
      wb = new SessionWriteBehind({
        maxDelayMs,
        // M23-P4 (binding): enqueue stays synchronous — the lease is acquired
        // inside the write callback (flush → backend.append). A failed acquire
        // retains the batch for the next enqueue/flush attempt; a held lease
        // survives background write failures for the same reason.
        write: async (events) => {
          await withSessionOperation(sessionId, async () => {
            await ensureOwnership(sessionId)
            await backend.append(sessionId, events)
          })
        },
        reportBackgroundFailure: report,
      })
      writeBehinds.set(sessionId, wb)
    }
    return wb
  }

  return {
    assertWritable,
    closeAdmission: (sessionId: string) => { deleted.add(sessionId) },
    pendingWriteBehind: (sessionId: string) => writeBehinds.get(sessionId),
    removeWriteBehind: (sessionId: string) => { writeBehinds.delete(sessionId) },
    flushWriteBehinds: () => [...writeBehinds.values()].map((wb) => wb.flush()),
    cancelAutomaticWaits() { for (const wb of writeBehinds.values()) wb.cancelAutomaticWait() },
    async create(meta?: Partial<SessionMeta>) {
      const id = meta?.sessionId ?? `sess-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
      assertWritable(id)
      return withSessionOperation(id, async () => {
        // Acquire-at-live (M23): the lease is taken BEFORE the store write so a
        // conflicting writer can never clobber the session; the typed Conflict/
        // Unsupported error propagates fail-closed.
        const acquired = lockEnabled && !ownerOf(id)
        await ensureOwnership(id)
        const fullMeta: SessionMeta = {
          formatVersion: CURRENT_FORMAT_VERSION,
          sessionId: id,
          createdAt: new Date().toISOString(),
          ...meta,
        }
        try {
          await backend.create(id, fullMeta)
        } catch (err) {
          if (acquired) {
            try { await releaseOwnershipUnlocked(id) } catch { /* keep the original error */ }
          }
          throw err
        }
        return { id }
      })
    },
    async append(sessionId: string, events: SessionEvent[]) {
      assertWritable(sessionId)
      await withSessionOperation(sessionId, async () => {
        await ensureOwnership(sessionId) // acquire-at-first-use (M23)
        await backend.append(sessionId, events)
      })
    },
    enqueue(sessionId: string, events: SessionEvent[]) {
      assertWritable(sessionId)
      const wb = writeBehindFor(sessionId)
      for (const ev of events) wb.enqueue(ev)
    },
    async updateMeta(sessionId: string, patch: Partial<SessionMeta>) {
      assertWritable(sessionId)
      // Mutating path (M23 discipline, same as append): the rewrite must be
      // serialized with appends/write-behind flushes on the same session.
      return withSessionOperation(sessionId, async () => {
        await ensureOwnership(sessionId)
        return backend.updateMeta(sessionId, patch)
      })
    },
    async flush(sessionId: string) {
      const wb = writeBehinds.get(sessionId)
      if (wb) await wb.flush()
    },
    async adoptOwnership(sessionId: string) {
      assertWritable(sessionId)
      // CLI resume path: after a successful load(), hold the lease until
      // close(). Conflict → SessionLockConflictError (fail-closed).
      await withSessionOperation(sessionId, () => ensureOwnership(sessionId))
    },
    async releaseOwnership(sessionId: string) {
      await withSessionOperation(sessionId, () => releaseOwnershipUnlocked(sessionId))
    },
  }
}

export type Mutations = ReturnType<typeof createMutations>
