import { CURRENT_FORMAT_VERSION, freezeJsonData, stringifyJsonData, validateSubagentHeader, type JournalPrefix, type Session, type SessionEvent, type SessionEventView, type SessionHistoryPageOptions } from "@i-harness/core-session"
import { materializeSessionHistoryPage, planSessionHistoryPage, sessionHistoryFact, type SessionHistoryFact } from '@i-harness/core-session/internal/archive'
import { prepareManagedSessionClone, type ManagedSessionClone } from '@i-harness/core-session/internal/restoration'
import { repairTurnTail } from "../repair.ts"
import { preflightSessionFormat, preflightBatchShape, preflightDecodedFactHistory, migrate, guardIgnorable, buildSession } from "../format/validation.ts"
import { originalColdArchiveHistoryReader, originalDecodedArchiveRead, readArchiveHistoryPrefix, recognizesOriginalCleanHistoryMaterialization, type ColdArchiveHistoryReader } from '../archive-read-internal.ts'
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
export type LoadOwned = ReturnType<typeof createLoads>['loadOwned']
type AfterTransition = (check: (events: readonly SessionEventView[]) => void, markIssue: () => void) => Promise<void>
type MaterializedHistory = { session: Session; readonly archivePrefix?: Readonly<JournalPrefix>; readonly managedClone?: ManagedSessionClone }

const MAX_COLD_HISTORY_SESSIONS = 2
const MAX_COLD_HISTORY_FACTS = 16_384
const MAX_COLD_HISTORY_IMAGE_ID_UNITS = 262_144
type ColdHistory = { evidence: object; facts: readonly SessionHistoryFact[] }

function historyFacts(events: readonly SessionEvent[]): SessionHistoryFact[] | undefined {
  if (events.length > MAX_COLD_HISTORY_FACTS) return undefined
  const facts: SessionHistoryFact[] = []
  const admissions = new Set<string>()
  let imageIdUnits = 0
  for (const event of events) {
    const fact = sessionHistoryFact(event)
    imageIdUnits += (fact.inputId?.length ?? 0) + (fact.imageInputId?.length ?? 0)
    if (fact.seq !== facts.length || imageIdUnits > MAX_COLD_HISTORY_IMAGE_ID_UNITS) return undefined
    // An unresolved address must be checked by the ordinary snapshot path,
    // where its error cannot prevent a changed file from being read afresh.
    if (fact.imageInputId !== undefined && !admissions.has(fact.imageInputId)) return undefined
    if (fact.inputId !== undefined) admissions.add(fact.inputId)
    facts.push(fact)
  }
  return facts
}

async function materializeHistory(backend: object, proof: HistoryProof, retainArchivePrefix = false): Promise<MaterializedHistory> {
  const meta = proof.initial.header as SessionMeta | undefined
  const clean = recognizesOriginalCleanHistoryMaterialization(backend, proof)
  let physical: SessionEvent[]
  try { physical = JSON.parse(JSON.stringify(proof.initial.events)) as SessionEvent[] }
  catch (error) {
    if (!(error instanceof RangeError)) throw error
    throw Object.assign(new Error('Session events exceed the supported nesting depth', { cause: error }), { code: 'SESSION_EVENTS_TOO_DEEP' })
  }
  const formatVersion = proof.initial.formatVersion
  const qualifiedClone = clean && formatVersion === CURRENT_FORMAT_VERSION && recognizesOriginalCleanHistoryMaterialization(backend, proof)
  let events: SessionEvent[]
  if (qualifiedClone) {
    // The exact current-format data survived the unchanged JSON copy. Recheck
    // the local registry and operational payloads on the detached events.
    preflightDecodedFactHistory(formatVersion, physical)
    events = physical
  } else events = await migrate(formatVersion, guardIgnorable(physical, true), meta)
  const session = buildSession(meta, events)
  if (retainArchivePrefix && formatVersion === CURRENT_FORMAT_VERSION && originalDecodedArchiveRead(backend)) {
    const observed = readArchiveHistoryPrefix(backend, proof)
    if (observed.kind === 'available') {
      if (qualifiedClone && meta && typeof meta.sessionId === 'string') {
        const managedClone = prepareManagedSessionClone(freezeJsonData(session), meta.sessionId)
        if (managedClone) return { session, archivePrefix: observed.prefix, managedClone }
      }
      // A detached fallback copy can still compare prefix values. Only the
      // exact qualified clone forwards the decoder's original witness key.
      return { session, archivePrefix: qualifiedClone ? observed.prefix : Object.freeze({ ...observed.prefix }) }
    }
  }
  return { session }
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
  const coldHistory = new Map<string, ColdHistory>()
  let coldHistoryRetired = false
  const materialize = (proof: HistoryProof) => materializeHistory(backend, proof)

  function rememberColdHistory(sessionId: string, history: ColdHistory) {
    coldHistory.delete(sessionId)
    coldHistory.set(sessionId, history)
    if (coldHistory.size > MAX_COLD_HISTORY_SESSIONS) coldHistory.delete(coldHistory.keys().next().value!)
  }

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
  const read = async (sessionId: string, original?: ColdArchiveHistoryReader['readFull']): ReturnType<ColdArchiveHistoryReader['readFull']> => {
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
    return loadThroughTransition(sessionId, materialize, after, skipPending)
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
      legacy = (await materialize(proof)).session
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
    async snapshot(sessionId: string, prepareHistoryPages = false) {
      const cold = prepareHistoryPages && !coldHistoryRetired ? originalColdArchiveHistoryReader(backend) : undefined
      const previous = cold ? coldHistory.get(sessionId) : undefined
      const original = originalDecodedArchiveRead(backend)
      const { version, events, meta, evidence } = await read(sessionId, cold?.readFull.bind(cold) ?? original)
      const currentDecoded = original !== undefined && version === CURRENT_FORMAT_VERSION
      if (currentDecoded) preflightDecodedFactHistory(version, events)
      else preflightSessionFormat(version, events, meta)
      const visible = guardIgnorable(events)
      const unchanged = currentDecoded && visible.length === events.length
      if (cold && !coldHistoryRetired && originalColdArchiveHistoryReader(backend) === cold) {
        const facts = unchanged && evidence ? historyFacts(visible) : undefined
        if (facts && evidence) rememberColdHistory(sessionId, { evidence, facts })
        else if (coldHistory.get(sessionId) === previous) coldHistory.delete(sessionId)
      }
      return { session: {
        formatVersion: CURRENT_FORMAT_VERSION,
        // Dropping ignorable records can change the effective conversation.
        events: unchanged ? visible : await migrate(version, visible, meta),
        ...(meta === undefined ? {} : { header: meta }),
      } }
    },
    async readColdHistoryPage(sessionId: string, options: SessionHistoryPageOptions) {
      const history = coldHistory.get(sessionId)
      if (!history) return undefined
      const original = originalColdArchiveHistoryReader(backend)
      if (!original) return undefined
      const plan = planSessionHistoryPage(history.facts, options)
      if (!plan) return undefined
      const records = await original.readWindow(sessionId, history.evidence, new Set(plan.ordinals))
      if (!records) {
        if (coldHistory.get(sessionId) === history) coldHistory.delete(sessionId)
        return undefined
      }
      if (originalColdArchiveHistoryReader(backend) !== original) return undefined
      const byOrdinal = new Map(records.map(event => [event.seq, event]))
      const ordered = plan.ordinals.map(ordinal => {
        const event = byOrdinal.get(ordinal)
        if (!event) throw new Error('History page archive ordinal mismatch')
        return event
      })
      const page = materializeSessionHistoryPage(plan, ordered)
      if (coldHistory.get(sessionId) === history) rememberColdHistory(sessionId, history)
      return page
    },
    retireColdHistory() {
      coldHistoryRetired = true
      coldHistory.clear()
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
    async loadOwned(sessionId: string, retainArchivePrefix = false): Promise<MaterializedHistory> {
      // A clean original history proof can also populate the compatibility
      // writer. Keep the same materialization and historical recovery fallback.
      if (transitions) return loadThroughTransition(sessionId, proof => materializeHistory(backend, proof, retainArchivePrefix), undefined, false, true)
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
