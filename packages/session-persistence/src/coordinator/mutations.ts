import { CURRENT_FORMAT_VERSION, type SessionEvent } from "@i-harness/core-session"
import { SessionWriteBehind } from "../write-behind.ts"
import type { PersistenceBackend, SessionMeta } from "./types.ts"
import type { Ownership } from "./ownership.ts"
import { ensureWritableFormatUnlocked } from "./writable-format.ts"
import { preflightBatchShape } from "../format/validation.ts"
import { createConversationIndexes } from "./conversation-index.ts"

export function createMutations(
  backend: Pick<PersistenceBackend, "create" | "append" | "updateMeta" | "read" | "id" | "upgradeSessionFormat">,
  { lockEnabled, ownerOf, withSessionOperation, ensureOwnership, releaseOwnershipUnlocked }:
    Pick<Ownership, "lockEnabled" | "ownerOf" | "withSessionOperation" | "ensureOwnership" | "releaseOwnershipUnlocked">,
  maxDelayMs: number,
  report: (error: unknown) => void,
) {
  const writeBehinds = new Map<string, SessionWriteBehind>()
  const deleted = new Set<string>()
  const conversation = createConversationIndexes(backend)
  async function appendUnlocked(sessionId: string, events: SessionEvent[]) {
    try {
      const staged = await conversation.stage(sessionId, events)
      if (staged.events.length || events.length === 0) await backend.append(sessionId, staged.events)
      staged.commit()
    } catch (error) { conversation.invalidate(sessionId); throw error }
  }
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
            await appendUnlocked(sessionId, events)
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
    invalidateConversation: (sessionId: string) => conversation.invalidate(sessionId),
    clearConversationIndexes: () => conversation.clear(),
    closeAdmission: (sessionId: string) => { deleted.add(sessionId); conversation.invalidate(sessionId) },
    pendingWriteBehind: (sessionId: string) => writeBehinds.get(sessionId),
    removeWriteBehind: (sessionId: string) => { writeBehinds.delete(sessionId) },
    flushWriteBehinds: () => [...writeBehinds.values()].map((wb) => wb.flush()),
    cancelAutomaticWaits() { for (const wb of writeBehinds.values()) wb.cancelAutomaticWait() },
    async create(meta?: Partial<SessionMeta>) {
      if (meta?.formatVersion !== undefined && meta.formatVersion !== CURRENT_FORMAT_VERSION) throw new Error("cannot create a downgraded session format")
      const id = meta?.sessionId ?? `sess-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
      assertWritable(id)
      return withSessionOperation(id, async () => {
        // Acquire-at-live (M23): the lease is taken BEFORE the store write so a
        // conflicting writer can never clobber the session; the typed Conflict/
        // Unsupported error propagates fail-closed.
        const acquired = lockEnabled && !ownerOf(id)
        await ensureOwnership(id)
        const fullMeta: SessionMeta = {
          sessionId: id,
          createdAt: new Date().toISOString(),
          ...meta,
          formatVersion: CURRENT_FORMAT_VERSION,
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
        await appendUnlocked(sessionId, events)
      })
    },
    enqueue(sessionId: string, events: SessionEvent[]) {
      assertWritable(sessionId)
      preflightBatchShape(CURRENT_FORMAT_VERSION, events)
      const wb = writeBehindFor(sessionId)
      for (const ev of events) wb.enqueue(ev)
    },
    async updateMeta(sessionId: string, patch: Partial<SessionMeta>) {
      assertWritable(sessionId)
      if (Object.hasOwn(patch, "formatVersion") && patch.formatVersion !== CURRENT_FORMAT_VERSION) throw new Error("cannot downgrade session format")
      // Mutating path (M23 discipline, same as append): the rewrite must be
      // serialized with appends/write-behind flushes on the same session.
      return withSessionOperation(sessionId, async () => {
        await ensureOwnership(sessionId)
        await ensureWritableFormatUnlocked(backend, sessionId)
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
      const pending = writeBehinds.get(sessionId)
      if (pending) await pending.flush()
      await withSessionOperation(sessionId, async () => {
        const acquired = lockEnabled && !ownerOf(sessionId)
        await ensureOwnership(sessionId)
        try { await ensureWritableFormatUnlocked(backend, sessionId) }
        catch (error) { if (acquired) await releaseOwnershipUnlocked(sessionId).catch(() => {}); throw error }
      })
    },
    async releaseOwnership(sessionId: string) {
      await withSessionOperation(sessionId, async () => { conversation.invalidate(sessionId); await releaseOwnershipUnlocked(sessionId) })
    },
  }
}

export type Mutations = ReturnType<typeof createMutations>
