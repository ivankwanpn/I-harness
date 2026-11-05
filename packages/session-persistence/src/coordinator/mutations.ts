import type { createColdExecutionWrites } from './cold-execution-writes.ts'
import { CURRENT_FORMAT_VERSION, validateLineageHeader, validateSubagentHeader, type SessionEvent } from "@i-harness/core-session"
import { SessionWriteBehind } from "../write-behind.ts"
import type { PersistenceBackend, SessionMeta } from "./types.ts"
import type { Ownership } from "./ownership.ts"
import type { BindingObservations } from './binding-observation.ts'
import { ensureWritableFormatUnlocked } from "./writable-format.ts"
import { preflightBatchShape } from "../format/validation.ts"
import { createConversationIndexes } from "./conversation-index.ts"
import type { createProcessReadLatches } from './process-read-latches.ts'
import { notIssuedFailure } from './not-issued.ts'
import type { createTaskDocumentTransitions } from './task-document-transition.ts'

export function createMutations(
  backend: Pick<PersistenceBackend, "create" | "append" | "updateMeta" | "read" | "id" | "upgradeSessionFormat">,
  { withSessionOperation, ensureOwnership, borrowOwnership, releaseOwnershipUnlocked }:
    Pick<Ownership, "withSessionOperation" | "ensureOwnership" | "borrowOwnership" | "releaseOwnershipUnlocked">,
  maxDelayMs: number,
  report: (error: unknown) => void,
  assertManagedMutation: (id: string) => void = () => {},
  observations?: BindingObservations,
  processLatches?: ReturnType<typeof createProcessReadLatches>,
  transitions?: ReturnType<typeof createTaskDocumentTransitions>,
  transitionWrite?: (id: string, events: SessionEvent[]) => Promise<void>,
  coldWrites?: ReturnType<typeof createColdExecutionWrites>,
) {
  const writeBehinds = new Map<string, SessionWriteBehind>()
  const deleted = new Set<string>()
  const conversation = createConversationIndexes(backend)
  async function appendUnlocked(sessionId: string, events: SessionEvent[], check?: (events: readonly import('@i-harness/core-session').SessionEventView[]) => void, markIssue?: () => void, preservePhysical = false) {
    let issued = false, changed: (() => Promise<boolean>) | undefined
    try {
      const staged = await conversation.stage(sessionId, events, preservePhysical)
      changed = staged.historyChanged
      check?.(staged.events.map((event, position) => event.seq === undefined ? { ...event, seq: staged.baseLength + position } : event))
      if (staged.events.length || events.length === 0) { markIssue?.(); issued = true; await backend.append(sessionId, staged.events) }
      staged.commit()
      if (staged.events.length) coldWrites?.committed(sessionId)
    } catch (error) {
      conversation.invalidate(sessionId)
      if (issued && changed) {
        // A rejected acknowledgement can follow durable writes. Recheck only
        // within this original mutation, never from a listener/read route.
        // Confirmed rollback stays quiet; uncertainty is a conservative dirty
        // edge and never a snapshot-ready or successful-operation promise.
        let dirty = true
        try { dirty = await changed() } catch { /* unchanged history cannot be confirmed */ }
        if (dirty) coldWrites?.invalidated(sessionId)
      }
      throw error
    }
  }
  function assertWritableBootstrap(id: string) { if (deleted.has(id)) throw new Error("Session is deleting or deleted") }

  function assertWritable(id: string) { assertWritableBootstrap(id); assertManagedMutation(id) }

  const writeBehindFor = (sessionId: string): SessionWriteBehind => {
    let wb = writeBehinds.get(sessionId)
    if (!wb) {
      wb = new SessionWriteBehind({
        maxDelayMs,
        beginWrite: () => processLatches?.beginMutation({ sessionIds: [sessionId], documentKeys: [], kind: 'other' }),
        // M23-P4 (binding): enqueue stays synchronous — the lease is acquired
        // inside the write callback (flush → backend.append). A failed acquire
        // retains the batch for the next enqueue/flush attempt; a held lease
        // survives background write failures for the same reason.
        write: async (events) => {
          // A closed admission means the session is being deleted: the only
          // remaining writer is that deletion draining the records it already
          // accepted. It must append directly — a task transition started
          // inside the deletion's own admission is a conflict — and the
          // records are about to be removed anyway.
          if (transitionWrite && !deleted.has(sessionId)) return transitionWrite(sessionId, events)
          await withSessionOperation(sessionId, async () => {
            assertManagedMutation(sessionId)
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

  async function metadataMutation<T>(id: string, run: () => Promise<T>): Promise<T> {
    const admission = observations?.beginMutation([id], [])
    try { await admission?.join(); return await run() } finally { admission?.finish() }
  }
  async function processMutation<T>(id: string, run: () => Promise<T>): Promise<T> {
    observations?.assertOutsideOwnedOperations([id])
    const token = processLatches?.beginMutation({ sessionIds: [id], documentKeys: [], kind: 'other' })
    let outcome: 'settled' | 'unknown' = 'unknown'
    try { const value = await run(); outcome = 'settled'; return value }
    catch (error) { if (notIssuedFailure(error)) outcome = 'settled'; throw error }
    finally { token?.end(outcome) }
  }
  return {
    ensureWritableFormat(sessionId: string) { observations?.assertOutsideObservedSession(sessionId); return processMutation(sessionId, () => withSessionOperation(sessionId, async () => { assertWritable(sessionId); await ensureOwnership(sessionId); await ensureWritableFormatUnlocked(backend, sessionId); conversation.invalidate(sessionId); return { formatVersion: CURRENT_FORMAT_VERSION } })) },
    assertWritable, assertWritableBootstrap,
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
      observations?.assertSessionAdmission(id)
      if (transitions) {
        const fullMeta: SessionMeta = { sessionId: id, createdAt: new Date().toISOString(), ...meta, formatVersion: CURRENT_FORMAT_VERSION }
        validateSubagentHeader(fullMeta)
        validateLineageHeader(fullMeta)
        await transitions.create(id, fullMeta)
        return { id }
      }
      return processMutation(id, () => metadataMutation(id, () => withSessionOperation(id, async () => {
        assertWritable(id)
        // Acquire-at-live (M23): the lease is taken BEFORE the store write so a
        // conflicting writer can never clobber the session; the typed Conflict/
        // Unsupported error propagates fail-closed.
        const acquired = await borrowOwnership(id)
        const fullMeta: SessionMeta = {
          sessionId: id,
          createdAt: new Date().toISOString(),
          ...meta,
          formatVersion: CURRENT_FORMAT_VERSION,
        }
        try {
          validateSubagentHeader(fullMeta)
          validateLineageHeader(fullMeta)
          await backend.create(id, fullMeta)
          acquired.retainLive()
        } catch (err) {
          try { await acquired.release() } catch { /* preserve original error and retained cleanup debt */ }
          throw err
        }
        await acquired.release()
        return { id }
      })))
    },
    async appendQueuedDrainUnlocked(sessionId: string, events: SessionEvent[]) {
      assertManagedMutation(sessionId)
      await ensureOwnership(sessionId)
      await appendUnlocked(sessionId, events, undefined, undefined, true)
    },
    async appendTransitionUnlocked(sessionId: string, events: SessionEvent[], check: (events: readonly import('@i-harness/core-session').SessionEventView[]) => void, markIssue: () => void) {
      assertWritable(sessionId)
      await appendUnlocked(sessionId, events, check, markIssue)
    },
    async updateMetaTransitionUnlocked(sessionId: string, patch: Partial<SessionMeta>, markIssue: () => void, metadata?:{before(meta:unknown):void;after(meta:unknown):void}) {
      assertWritable(sessionId)
      if (Object.hasOwn(patch, 'formatVersion') && patch.formatVersion !== CURRENT_FORMAT_VERSION) throw new Error('cannot downgrade session format')
      const previous = await ensureWritableFormatUnlocked(backend, sessionId)
      if (Object.hasOwn(patch, 'subagentProtocolVersion') && patch.subagentProtocolVersion !== previous.meta?.subagentProtocolVersion) throw new Error('Subagent protocol is immutable creation metadata')
      validateSubagentHeader({ ...previous.meta, ...patch })
      metadata?.before(previous.meta)
      markIssue(); const updated=await backend.updateMeta(sessionId, patch);metadata?.after(updated);return updated
    },
    async append(sessionId: string, events: SessionEvent[]) {
      assertWritable(sessionId)
      observations?.assertOutsideOwnedOperations([sessionId])
      const token = processLatches?.beginMutation({ sessionIds: [sessionId], documentKeys: [], kind: 'other' })
      let outcome: 'settled' | 'unknown' = 'unknown'
      try {
        await withSessionOperation(sessionId, async () => {
          assertManagedMutation(sessionId)
          await ensureOwnership(sessionId) // acquire-at-first-use (M23)
          await appendUnlocked(sessionId, events)
        })
        outcome = 'settled'
      } finally { token?.end(outcome) }
    },
    enqueue(sessionId: string, events: SessionEvent[]) {
      assertWritable(sessionId)
      if (transitionWrite) observations?.assertSessionAdmission(sessionId)
      observations?.assertOutsideOwnedOperations([sessionId])
      preflightBatchShape(CURRENT_FORMAT_VERSION, events)
      const wb = writeBehindFor(sessionId)
      for (const ev of events) {
        const token = processLatches?.beginMutation({ sessionIds: [sessionId], documentKeys: [], kind: 'other' })
        try { wb.enqueue(ev, token) } catch (error) { token?.end('settled'); throw error }
      }
    },
    async updateMeta(sessionId: string, patch: Partial<SessionMeta>) {
      assertWritable(sessionId)
      if (Object.hasOwn(patch, "formatVersion") && patch.formatVersion !== CURRENT_FORMAT_VERSION) throw new Error("cannot downgrade session format")
      // Mutating path (M23 discipline, same as append): the rewrite must be
      // serialized with appends/write-behind flushes on the same session.
      return processMutation(sessionId, () => metadataMutation(sessionId, () => withSessionOperation(sessionId, async () => {
        assertWritable(sessionId)
        await ensureOwnership(sessionId)
        const previous = await ensureWritableFormatUnlocked(backend, sessionId)
        if (Object.hasOwn(patch, "subagentProtocolVersion") && patch.subagentProtocolVersion !== previous.meta?.subagentProtocolVersion) throw new Error("Subagent protocol is immutable creation metadata")
        validateSubagentHeader({ ...previous.meta, ...patch })
        return backend.updateMeta(sessionId, patch)
      })))
    },
    async flush(sessionId: string) {
      observations?.assertOutsideOwnedOperations([sessionId])
      const wb = writeBehinds.get(sessionId)
      if (wb) await wb.flush()
    },
    async adoptOwnership(sessionId: string) {
      assertWritable(sessionId)
      observations?.assertSessionAdmission(sessionId)
      return processMutation(sessionId, async () => {
      // CLI resume path: after a successful load(), hold the lease until
      // close(). Conflict → SessionLockConflictError (fail-closed).
      const pending = writeBehinds.get(sessionId)
      if (pending) await pending.flush()
      await withSessionOperation(sessionId, async () => {
        assertManagedMutation(sessionId)
        observations?.assertSessionAdmission(sessionId)
        const acquired = await borrowOwnership(sessionId)
        try { await ensureWritableFormatUnlocked(backend, sessionId); acquired.retainLive() }
        finally { await acquired.release() }
      })
      })
    },
    async releaseOwnership(sessionId: string) {
      await processMutation(sessionId, () => withSessionOperation(sessionId, async () => { conversation.invalidate(sessionId); await releaseOwnershipUnlocked(sessionId) }))
    },
  }
}

export type Mutations = ReturnType<typeof createMutations>
