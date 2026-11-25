import { CURRENT_FORMAT_VERSION, stringifyJsonData, validateSubagentHeader, type Session, type SessionEvent, type SessionEventView } from "@i-harness/core-session"
import { repairTurnTail } from "../repair.ts"
import { preflightSessionFormat, preflightBatchShape, preflightDecodedFactHistory, migrate, guardIgnorable, buildSession } from "../format/validation.ts"
import { originalDecodedArchiveRead } from '../archive-read-internal.ts'
import { assertUpgradeCapability, ensureWritableFormatUnlocked } from "./writable-format.ts"
import type { PersistenceBackend, SessionMeta } from "./types.ts"
import type { Ownership } from "./ownership.ts"
import type { Mutations } from "./mutations.ts"
import { SessionFormatUnsupportedError } from '../format/registry.ts'
import type { createProcessReadLatches } from './process-read-latches.ts'
import { notIssuedFailure } from './not-issued.ts'
import type { createColdExecutionWrites } from './cold-execution-writes.ts'
import type { createTaskDocumentTransitions, HistoryProof } from './task-document-transition.ts'

export type LoadOwnedExecution = ReturnType<typeof createLoads>['loadOwnedExecution']
type AfterTransition = (check: (events: readonly SessionEventView[]) => void, markIssue: () => void) => Promise<void>

async function materializeHistory(proof: HistoryProof): Promise<{session: Session}> {
  const meta = proof.initial.header as SessionMeta | undefined
  let physical: SessionEvent[]
  try { physical = JSON.parse(JSON.stringify(proof.initial.events)) as SessionEvent[] }
  catch (error) {
    if (!(error instanceof RangeError)) throw error
    throw Object.assign(new Error('Session events exceed the supported nesting depth', { cause: error }), { code: 'SESSION_EVENTS_TOO_DEEP' })
  }
  return { session: buildSession(meta, await migrate(proof.initial.formatVersion, guardIgnorable(physical, true), meta)) }
}

export function createLoads(
  backend: Pick<PersistenceBackend, "read" | "repair" | "replaceEvents" | "append" | "id" | "upgradeSessionFormat">,
  { withSessionOperation, borrowOwnership }:
    Pick<Ownership, "withSessionOperation" | "borrowOwnership">,
  { assertWritable, pendingWriteBehind, invalidateConversation }: Pick<Mutations, "assertWritable" | "pendingWriteBehind" | "invalidateConversation">,
  processLatches?: ReturnType<typeof createProcessReadLatches>,
  transitions?: ReturnType<typeof createTaskDocumentTransitions>,
  executionChanges?: ReturnType<typeof createColdExecutionWrites>,
  withMutationRead?: <T>(sessionId: string, work: () => Promise<T>) => Promise<T>,
) {
  async function processMutation<T>(id: string, work: () => Promise<T>): Promise<T> {
    const token = processLatches?.beginMutation({ sessionIds: [id], documentKeys: [], kind: 'other' })
    let outcome: 'settled' | 'unknown' = 'unknown'
    try {
      const value = await work()
      outcome = 'settled'
      // A successful load/mutation proves the session reads from a consistent
      // durable prefix; an earlier unknown write is no longer a reason to keep
      // the process-wide poison that blocked every later spawn and cold read.
      processLatches?.clear(id)
      return value
    } catch (error) {
      if (notIssuedFailure(error)) outcome = 'settled'
      throw error
    } finally { token?.end(outcome) }
  }
  const read = async (sessionId: string, original?: PersistenceBackend['read']) => {
    try { return await (original ? Reflect.apply(original, backend, [sessionId]) : backend.read(sessionId)) }
    catch (cause) {
      if (['SESSION_CONTEXT_REPLACEMENT_FORMAT', 'SESSION_CONVERSATION_FORMAT'].includes((cause as { code?: string })?.code ?? '')) throw new SessionFormatUnsupportedError('unsupported conversation history', { cause })
      throw cause
    }
  }
  function loadThroughTransition<T>(sessionId: string, finalize: (proof: HistoryProof) => Promise<T>, after?: AfterTransition, skipPending = false, allowClean = false) {
    const run = () => transitionLoadOriginal(sessionId, finalize, after, skipPending, allowClean)
    return withMutationRead ? withMutationRead(sessionId, run) : run()
  }
  function transitionLoad(sessionId: string, after?: AfterTransition, skipPending = false) {
    return loadThroughTransition(sessionId, materializeHistory, after, skipPending)
  }
  async function transitionLoadOriginal<T>(sessionId: string, finalize: (proof: HistoryProof) => Promise<T>, after?: AfterTransition, skipPending = false, allowClean = false) {
      if (!transitions) throw new Error('TASK_TRANSITION_UNSUPPORTED')
        assertWritable(sessionId)
        let pending = skipPending ? undefined : pendingWriteBehind(sessionId)
        // A current-format queued batch must cross its own task transition.
        // Only predecessor work can be drained before the historical proof.
        if (pending?.hasWork && (await read(sessionId)).version >= 14) { await pending.flush(); pending = undefined }
        return transitions.existing(sessionId, async (beforeRepair,markRepair) => {
          invalidateConversation(sessionId)
          const peeked = await read(sessionId)
          preflightSessionFormat(peeked.version, peeked.events, peeked.meta)
          if (peeked.version !== CURRENT_FORMAT_VERSION)
            await migrate(peeked.version, guardIgnorable(peeked.events, true), peeked.meta)
          await beforeRepair(peeked.version,peeked.events,peeked.meta?.seedLength ?? 0)
          markRepair()
          executionChanges?.invalidated(sessionId)
          const repaired = await backend.repair(sessionId)
          preflightSessionFormat(repaired.version, repaired.events, repaired.meta)
          if (stringifyJsonData(peeked.events) !== stringifyJsonData(repaired.events)) executionChanges?.committed(sessionId)
          const migrated = repaired.version === CURRENT_FORMAT_VERSION ? repaired.events
            : await migrate(repaired.version, guardIgnorable(repaired.events, true), repaired.meta)
          const canonical = repairTurnTail(migrated, { appendOnly: repaired.meta?.journal !== undefined }).map((event, index): SessionEvent => {
            if (event.seq !== undefined && event.seq !== index) throw new Error(`session sequence invariant failed for ${sessionId}`)
            return event.seq === index ? event : { ...event, seq: index }
          })
          const needsRewrite = canonical.length !== repaired.events.length || canonical.some((event, index) => stringifyJsonData(event) !== stringifyJsonData(repaired.events[index]))
          // The repaired current-format prefix has already passed full validation.
          // Re-run it for a changed recovery result or a format conversion.
          if (needsRewrite || repaired.version !== CURRENT_FORMAT_VERSION)
            preflightSessionFormat(CURRENT_FORMAT_VERSION, canonical, repaired.meta)
          if (needsRewrite) {
            const unchanged = canonical.slice(0, repaired.events.length).every((event, index) => stringifyJsonData(event) === stringifyJsonData(repaired.events[index]))
            if (unchanged) {
              preflightBatchShape(repaired.version, canonical.slice(repaired.events.length))
              executionChanges?.invalidated(sessionId)
              await backend.append(sessionId, canonical.slice(repaired.events.length))
              executionChanges?.committed(sessionId)
            } else {
              if (repaired.meta?.journal !== undefined || repaired.events.some(event => event.type === 'conversation/semantics') || !backend.replaceEvents) throw new Error('TASK_TRANSITION_RECOVERY_UNSUPPORTED')
              preflightSessionFormat(repaired.version, canonical, repaired.meta)
              executionChanges?.invalidated(sessionId)
              await backend.replaceEvents(sessionId, canonical)
              executionChanges?.committed(sessionId)
            }
          }
          validateSubagentHeader(repaired.meta)
        }, pending ? () => pending.flush() : undefined, finalize, after, allowClean && !pending?.hasWork ? () => {
          invalidateConversation(sessionId)
          executionChanges?.invalidated(sessionId)
        } : undefined)
      }
  async function loadOwnedExecution<T>(sessionId: string, restore: (proof: HistoryProof) => Promise<T>): Promise<T> {
    if (!transitions) throw new Error('TASK_TRANSITION_UNSUPPORTED')
    let legacy: Session | undefined
    const result = await loadThroughTransition(sessionId, async proof => {
      if (proof.initial.formatVersion === CURRENT_FORMAT_VERSION) return { value: await restore(proof) }
      // The transition upgrades the header after capturing this history proof.
      // Only a fresh proof can attach a writer to the replacement artifact.
      legacy = (await materializeHistory(proof)).session
      return undefined
    }, undefined, false, true)
    if (result) return result.value
    return transitions.existing(sessionId, async beforeRepair => {
      if (!legacy) throw new Error('TASK_TRANSITION_RECOVERY_REQUIRED')
      await beforeRepair(legacy.formatVersion, legacy.events, legacy.header?.seedLength ?? 0)
      legacy = undefined
    }, undefined, restore)
  }
  return {
    transitionLoad,
    loadOwnedExecution,
    async snapshot(sessionId: string) {
      const original = originalDecodedArchiveRead(backend)
      const { version, events, meta } = await read(sessionId, original)
      const currentDecoded = original !== undefined && version === CURRENT_FORMAT_VERSION
      if (currentDecoded) preflightDecodedFactHistory(version, events)
      else preflightSessionFormat(version, events, meta)
      const visible = guardIgnorable(events)
      return { session: {
        formatVersion: CURRENT_FORMAT_VERSION,
        // Dropping ignorable records can change the effective conversation.
        events: currentDecoded && visible.length === events.length ? visible : await migrate(version, visible, meta),
        ...(meta === undefined ? {} : { header: meta }),
      } }
    },
    async load(sessionId: string) {
      // Physical14 recovery is a parent mutation owned by the retained task
      // transition. Historical public loads retain their original semantics.
      if (transitions) {
        const source = await read(sessionId)
        preflightSessionFormat(source.version, source.events, source.meta)
        if (source.version >= 14) return transitionLoad(sessionId)
      }
      return processMutation(sessionId, () => withSessionOperation(sessionId, async () => {
        invalidateConversation(sessionId)
        const peeked = await read(sessionId)
        preflightSessionFormat(peeked.version, peeked.events, peeked.meta)
        await migrate(peeked.version, guardIgnorable(peeked.events, true), peeked.meta)
        const borrowed = await borrowOwnership(sessionId)
        let repaired: { version: number; events: SessionEvent[]; meta?: SessionMeta }, originalEvents: SessionEvent[] | undefined
        try {
          const owned = await read(sessionId)
          preflightSessionFormat(owned.version, owned.events, owned.meta)
          await migrate(owned.version, guardIgnorable(owned.events, true), owned.meta)
          // A concurrent upgrade must reenter with the transition's task lease.
          if (transitions && owned.version >= 14) throw new Error('TASK_TRANSITION_RETRY_REQUIRED')
          originalEvents = owned.events
          executionChanges?.invalidated(sessionId)
          repaired = await backend.repair(sessionId)

        } finally {
          await borrowed.release()
        }
        const { version, events, meta } = repaired
        preflightSessionFormat(version, events, meta)
        const guarded = guardIgnorable(events)
        const migrated = await migrate(version, guarded, meta)
        if (originalEvents && stringifyJsonData(originalEvents) !== stringifyJsonData(events)) executionChanges?.committed(sessionId)
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
          executionChanges?.invalidated(sessionId)
          const repaired = await backend.repair(sessionId)
          preflightSessionFormat(repaired.version, repaired.events, repaired.meta)
          if (stringifyJsonData(peeked.events) !== stringifyJsonData(repaired.events)) executionChanges?.committed(sessionId)
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
            executionChanges?.invalidated(sessionId)
            await backend.append(sessionId, canonical.slice(repaired.events.length))
            executionChanges?.committed(sessionId)
            } else {
              if (backend.replaceEvents === undefined) {
                throw new Error(`session backend '${backend.id}' cannot persist owned recovery for ${sessionId}`)
              }
              executionChanges?.invalidated(sessionId)
              await backend.replaceEvents(sessionId, canonical)
              executionChanges?.committed(sessionId)
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
