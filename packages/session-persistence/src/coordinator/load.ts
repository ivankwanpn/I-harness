import { CURRENT_FORMAT_VERSION, stringifyJsonData, type SessionEvent, type SessionEventView } from "@i-harness/core-session"
import { repairTurnTail } from "../repair.ts"
import { preflightSessionFormat, preflightBatchShape, migrate, guardIgnorable, buildSession } from "../format/validation.ts"
import { assertUpgradeCapability, ensureWritableFormatUnlocked } from "./writable-format.ts"
import type { PersistenceBackend, SessionMeta } from "./types.ts"
import type { Ownership } from "./ownership.ts"
import type { Mutations } from "./mutations.ts"
import { SessionFormatUnsupportedError } from '../format/registry.ts'
import type { createProcessReadLatches } from './process-read-latches.ts'
import type { createTaskDocumentTransitions } from './task-document-transition.ts'

export function createLoads(
  backend: Pick<PersistenceBackend, "read" | "repair" | "replaceEvents" | "append" | "id" | "upgradeSessionFormat">,
  { withSessionOperation, borrowOwnership }:
    Pick<Ownership, "withSessionOperation" | "borrowOwnership">,
  { assertWritable, pendingWriteBehind, invalidateConversation }: Pick<Mutations, "assertWritable" | "pendingWriteBehind" | "invalidateConversation">,
  processLatches?: ReturnType<typeof createProcessReadLatches>,
  transitions?: ReturnType<typeof createTaskDocumentTransitions>,
) {
  async function processMutation<T>(id: string, work: () => Promise<T>): Promise<T> {
    const token = processLatches?.beginMutation({ sessionIds: [id], documentKeys: [], kind: 'other' })
    let outcome: 'settled' | 'unknown' = 'unknown'
    try { const value = await work(); outcome = 'settled'; return value } finally { token?.end(outcome) }
  }
  const read = async (sessionId: string) => {
    try { return await backend.read(sessionId) }
    catch (cause) {
      if (['SESSION_CONTEXT_REPLACEMENT_FORMAT', 'SESSION_CONVERSATION_FORMAT'].includes((cause as { code?: string })?.code ?? '')) throw new SessionFormatUnsupportedError('unsupported conversation history', { cause })
      throw cause
    }
  }
  async function transitionLoad(sessionId: string, after?: (check: (events: readonly SessionEventView[]) => void, markIssue: () => void) => Promise<void>, skipPending = false) {
      if (!transitions) throw new Error('TASK_TRANSITION_UNSUPPORTED')
        assertWritable(sessionId)
        let pending = skipPending ? undefined : pendingWriteBehind(sessionId)
        // A current-format queued batch must cross its own task transition.
        // Only predecessor work can be drained before the historical proof.
        if (pending?.hasWork && (await read(sessionId)).version >= 14) { await pending.flush(); pending = undefined }
        return transitions.existing(sessionId, async () => {
          invalidateConversation(sessionId)
          const peeked = await read(sessionId)
          preflightSessionFormat(peeked.version, peeked.events, peeked.meta)
          await migrate(peeked.version, guardIgnorable(peeked.events, true), peeked.meta)
          const repaired = await backend.repair(sessionId)
          preflightSessionFormat(repaired.version, repaired.events, repaired.meta)
          const migrated = await migrate(repaired.version, guardIgnorable(repaired.events, true), repaired.meta)
          const canonical = repairTurnTail(migrated, { appendOnly: repaired.meta?.journal !== undefined }).map((event, index): SessionEvent => {
            if (event.seq !== undefined && event.seq !== index) throw new Error(`session sequence invariant failed for ${sessionId}`)
            return event.seq === index ? event : { ...event, seq: index }
          })
          preflightSessionFormat(CURRENT_FORMAT_VERSION, canonical, repaired.meta)
          const needsRewrite = canonical.length !== repaired.events.length || canonical.some((event, index) => stringifyJsonData(event) !== stringifyJsonData(repaired.events[index]))
          if (needsRewrite) {
            const unchanged = canonical.slice(0, repaired.events.length).every((event, index) => stringifyJsonData(event) === stringifyJsonData(repaired.events[index]))
            if (unchanged) {
              preflightBatchShape(repaired.version, canonical.slice(repaired.events.length))
              await backend.append(sessionId, canonical.slice(repaired.events.length))
            } else {
              if (repaired.meta?.journal !== undefined || repaired.events.some(event => event.type === 'conversation/semantics') || !backend.replaceEvents) throw new Error('TASK_TRANSITION_RECOVERY_UNSUPPORTED')
              preflightSessionFormat(repaired.version, canonical, repaired.meta)
              await backend.replaceEvents(sessionId, canonical)
            }
          }
          return { session: buildSession(repaired.meta, canonical) }
        }, pending ? () => pending.flush() : undefined, async proof => { const meta = proof.initial.header as SessionMeta | undefined; const physical = JSON.parse(JSON.stringify(proof.initial.events)) as SessionEvent[]; return { session: buildSession(meta, await migrate(proof.initial.formatVersion, guardIgnorable(physical, true), meta)) } }, after)
      }
  return {
    transitionLoad,
    async snapshot(sessionId: string) {
      const { version, events, meta } = await read(sessionId)
      preflightSessionFormat(version, events, meta)
      return { session: {
        formatVersion: CURRENT_FORMAT_VERSION,
        events: await migrate(version, guardIgnorable(events), meta),
        ...(meta === undefined ? {} : { header: meta }),
      } }
    },
    async load(sessionId: string) {
      return processMutation(sessionId, () => withSessionOperation(sessionId, async () => {
        invalidateConversation(sessionId)
        const peeked = await read(sessionId)
        preflightSessionFormat(peeked.version, peeked.events, peeked.meta)
        await migrate(peeked.version, guardIgnorable(peeked.events, true), peeked.meta)
        const borrowed = await borrowOwnership(sessionId)
        let repaired: { version: number; events: SessionEvent[]; meta?: SessionMeta }
        try {
          const owned = await read(sessionId)
          preflightSessionFormat(owned.version, owned.events, owned.meta)
          await migrate(owned.version, guardIgnorable(owned.events, true), owned.meta)
          repaired = await backend.repair(sessionId)
        } finally {
          await borrowed.release()
        }
        const { version, events, meta } = repaired
        preflightSessionFormat(version, events, meta)
        const guarded = guardIgnorable(events)
        const migrated = await migrate(version, guarded, meta)
        const repairedTail = repairTurnTail(migrated, { appendOnly: meta?.journal !== undefined })
        // M51 B5: canonicalize UNDEFINED seqs to their array index (in-memory
        // only — load() stays read-only) so load() agrees with loadOwned() for
        // the repair shape. DEFINED seqs are never renumbered (shadowedSeqs /
        // rewind / messageSeqs references must stay valid) and this is NOT
        // loadOwned's strict invariant check — a non-positional established log
        // still loads.
        // M51 F1: guardIgnorable() DROPS ignorable events, so a later index can
        // sit BELOW a defined seq (a dropped mid-log event shifts every later
        // index down) and a synthetic closer would alias an existing seq for
        // shadowedSeqs/rewind windows and afterSeq pagination. Anchor synthetic
        // seqs above the highest DEFINED seq instead: max(index, maxDefined+1+k)
        // — identical to the bare index for the positional repair shape.
        // M52 L4: UNIQUENESS IS PRIORITIZED OVER MONOTONICITY, deliberately.
        // A synthetic closer inserted mid-array (its index below a later
        // DEFINED seq) gets maxDefined+1+k, so the resulting seqs can be
        // non-monotonic w.r.t. array order. Renumbering DEFINED seqs would
        // restore monotonicity but break every reference to them (shadowedSeqs,
        // rewind windows, messageSeqs/afterSeq cursors), so the trade is fixed:
        // uniqueness (no aliasing for those references) wins, and consumers
        // must not assume seq === index on a repaired log — loadOwned() is the
        // strict invariant path that enforces it.
        let maxDefinedSeq = -1
        for (const event of repairedTail) {
          if (event.seq !== undefined && event.seq > maxDefinedSeq) maxDefinedSeq = event.seq
        }
        let syntheticCount = 0
        const canonical = repairedTail.map((event, index): SessionEvent => {
          if (event.seq !== undefined) return event
          const seq = Math.max(index, maxDefinedSeq + 1 + syntheticCount)
          syntheticCount += 1
          return { ...event, seq }
        })
        preflightSessionFormat(CURRENT_FORMAT_VERSION, canonical, meta)
        return { session: buildSession(meta, canonical) }
      }))
    },
    async loadOwned(sessionId: string) {
      if (transitions) return transitionLoad(sessionId)
      assertWritable(sessionId)
      return processMutation(sessionId, async () => {
      const pendingWrites = pendingWriteBehind(sessionId)
      if (pendingWrites !== undefined) await pendingWrites.flush()
      return withSessionOperation(sessionId, async () => {
        invalidateConversation(sessionId)
        const acquired = await borrowOwnership(sessionId)
        try {
          const peeked = await read(sessionId)
          preflightSessionFormat(peeked.version, peeked.events, peeked.meta)
          assertUpgradeCapability(backend, peeked.version)
          if (backend.replaceEvents === undefined && !peeked.events.some(event => event.type === "conversation/semantics") && repairTurnTail(peeked.events).some((event, index) => event.seq !== index || JSON.stringify(event) !== JSON.stringify(peeked.events[index]))) throw new Error(`session backend '${backend.id}' cannot persist owned recovery for ${sessionId}`)
          const checked = await read(sessionId)
          preflightSessionFormat(checked.version, checked.events, checked.meta)
          await migrate(checked.version, guardIgnorable(checked.events, true), checked.meta)
          assertUpgradeCapability(backend, checked.version)
          const repaired = await backend.repair(sessionId)
          preflightSessionFormat(repaired.version, repaired.events, repaired.meta)
          const guarded = guardIgnorable(repaired.events, true)
          const migrated = await migrate(repaired.version, guarded, repaired.meta)
          const semantic = repairTurnTail(migrated, { appendOnly: repaired.meta?.journal !== undefined })
          const canonical = semantic.map((event, index): SessionEvent => {
            if (event.seq !== undefined && event.seq !== index) {
              throw new Error(`session sequence invariant failed for ${sessionId}: event ${index} has seq ${event.seq}`)
            }
            return event.seq === index ? event : { ...event, seq: index }
          })
          const needsRewrite = canonical.length !== repaired.events.length
            || canonical.some((event, index) => stringifyJsonData(event) !== stringifyJsonData(repaired.events[index]))
          preflightSessionFormat(CURRENT_FORMAT_VERSION, canonical, repaired.meta)
          if (needsRewrite) {
            const fenced = repaired.meta?.journal !== undefined || repaired.events.some(event => event.type === "conversation/semantics")
            const unchangedPrefix = canonical.slice(0, repaired.events.length).every((event, index) => stringifyJsonData(event) === stringifyJsonData(repaired.events[index]))
            if (fenced && unchangedPrefix) {
              await ensureWritableFormatUnlocked(backend, sessionId)
              preflightBatchShape(repaired.version, canonical.slice(repaired.events.length))
            await backend.append(sessionId, canonical.slice(repaired.events.length))
            } else {
              if (backend.replaceEvents === undefined) {
                throw new Error(`session backend '${backend.id}' cannot persist owned recovery for ${sessionId}`)
              }
              await backend.replaceEvents(sessionId, canonical)
            }
          }
          await ensureWritableFormatUnlocked(backend, sessionId)
          acquired.retainLive()
          await acquired.release()
          return { session: buildSession(repaired.meta, canonical) }
        } catch (error) {
          try { await acquired.release() } catch { /* preserve load error and retained cleanup debt */ }
          throw error
        }
      })
      })
    },
  }
}
