import { CURRENT_FORMAT_VERSION, type SessionEvent } from "@i-harness/core-session"
import { repairTurnTail } from "../repair.ts"
import { assertVersionSupported, migrate, guardIgnorable, buildSession } from "../format/validation.ts"
import type { PersistenceBackend, SessionMeta } from "./types.ts"
import type { Ownership } from "./ownership.ts"
import type { Mutations } from "./mutations.ts"

export function createLoads(
  backend: Pick<PersistenceBackend, "read" | "repair" | "replaceEvents" | "id">,
  { withSessionOperation, borrowOwnership, releaseOwnershipUnlocked }:
    Pick<Ownership, "withSessionOperation" | "borrowOwnership" | "releaseOwnershipUnlocked">,
  { assertWritable, pendingWriteBehind }: Pick<Mutations, "assertWritable" | "pendingWriteBehind">,
) {
  return {
    async snapshot(sessionId: string) {
      const { version, events, meta } = await backend.read(sessionId)
      assertVersionSupported(version)
      return { session: {
        formatVersion: CURRENT_FORMAT_VERSION,
        events: await migrate(version, guardIgnorable(events)),
        ...(meta === undefined ? {} : { header: meta }),
      } }
    },
    async load(sessionId: string) {
      return withSessionOperation(sessionId, async () => {
        const peeked = await backend.read(sessionId)
        assertVersionSupported(peeked.version)
        const borrowed = await borrowOwnership(sessionId)
        let repaired: { version: number; events: SessionEvent[]; meta?: SessionMeta }
        try {
          repaired = await backend.repair(sessionId)
        } finally {
          if (borrowed) await releaseOwnershipUnlocked(sessionId)
        }
        const { version, events, meta } = repaired
        const guarded = guardIgnorable(events)
        const migrated = await migrate(version, guarded)
        const repairedTail = repairTurnTail(migrated)
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
        return { session: buildSession(meta, canonical) }
      })
    },
    async loadOwned(sessionId: string) {
      assertWritable(sessionId)
      const pendingWrites = pendingWriteBehind(sessionId)
      if (pendingWrites !== undefined) await pendingWrites.flush()
      return withSessionOperation(sessionId, async () => {
        const acquired = await borrowOwnership(sessionId)
        try {
          const peeked = await backend.read(sessionId)
          assertVersionSupported(peeked.version)
          const repaired = await backend.repair(sessionId)
          const guarded = guardIgnorable(repaired.events, true)
          const migrated = await migrate(repaired.version, guarded)
          const semantic = repairTurnTail(migrated)
          const canonical = semantic.map((event, index): SessionEvent => {
            if (event.seq !== undefined && event.seq !== index) {
              throw new Error(`session sequence invariant failed for ${sessionId}: event ${index} has seq ${event.seq}`)
            }
            return event.seq === index ? event : { ...event, seq: index }
          })
          const needsRewrite = canonical.length !== repaired.events.length
            || canonical.some((event, index) => JSON.stringify(event) !== JSON.stringify(repaired.events[index]))
          if (needsRewrite) {
            if (backend.replaceEvents === undefined) {
              throw new Error(`session backend '${backend.id}' cannot persist owned recovery for ${sessionId}`)
            }
            await backend.replaceEvents(sessionId, canonical)
          }
          return { session: buildSession(repaired.meta, canonical) }
        } catch (error) {
          if (acquired) {
            try { await releaseOwnershipUnlocked(sessionId) } catch { /* preserve load error */ }
          }
          throw error
        }
      })
    },
  }
}
