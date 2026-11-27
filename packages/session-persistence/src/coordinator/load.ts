import { CURRENT_FORMAT_VERSION, copyConversationData, freezeJsonData, readInbox, stringifyJsonData, validContextEvent, validateSubagentHeader, type JournalPrefix, type OwnedSessionHistoryPage, type Session, type SessionView, type SessionEvent, type SessionEventView, type SessionHistoryPageOptions } from "@i-harness/core-session"
import { deriveLastProviderInput, materializeSessionHistoryPage, planSessionHistoryPage, sessionHistoryFact, type SessionHistoryFact } from '@i-harness/core-session/internal/archive'
import { prepareManagedSessionClone, type ManagedSessionClone } from '@i-harness/core-session/internal/restoration'
import { repairTurnTail } from "../repair.ts"
import { preflightSessionFormat, preflightBatchShape, preflightDecodedFactHistory, migrate, guardIgnorable, buildSession } from "../format/validation.ts"
import { originalColdArchiveHistoryReader, originalDecodedArchiveRead, readArchiveHistoryPrefix, recognizesOriginalCleanHistoryMaterialization, type ColdArchiveHistoryReader } from '../archive-read-internal.ts'
import { assertUpgradeCapability, ensureWritableFormatUnlocked } from "./writable-format.ts"
import { pendingInputSummary, type PendingInputSummary, type PersistenceBackend, type SavedContextBinding, type SavedContextFacts, type SessionMeta } from "./types.ts"
import { savedContextFromSession } from './saved-context.ts'
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
type ColdSnapshotFallback = (session: SessionView, isCurrent: () => boolean) => void
type ColdHistoryPageResult = { page: OwnedSessionHistoryPage; originalSealCurrent?: () => boolean }
export type ColdCommittedObservation<T> = { value: T; originalSealCurrent?: () => boolean }
type InitialArchive = Awaited<ReturnType<NonNullable<ColdArchiveHistoryReader['readFullForHistoryPage']>>>

const MAX_COLD_HISTORY_SESSIONS = 2
const MAX_COLD_HISTORY_FACTS = 16_384
const MAX_COLD_HISTORY_IMAGE_ID_UNITS = 262_144
const MAX_COLD_PENDING_ORDINALS = 256
const MAX_COLD_CONTEXT_RECOVERY_ORDINALS = 256
type ColdContextOrdinals = { budget?: number; provider?: { accepted: number; sample: number }; selected: readonly number[] }
type ColdHistoryCoordinates = { facts: readonly SessionHistoryFact[]; context?: ColdContextOrdinals }
type ColdHistory = ColdHistoryCoordinates & { evidence: object; pendingOrdinals?: readonly number[] }
type InitialColdHistory = {
  decoded: NonNullable<InitialArchive>
  unchanged: boolean
  snapshot(): Promise<Session>
  pending(): Promise<readonly PendingInputSummary[]>
}

function pendingOrdinals(pending: readonly PendingInputSummary[]): readonly number[] | undefined {
  if (pending.length > MAX_COLD_PENDING_ORDINALS) return undefined
  return pending.map(input => input.admittedSeq)
}

function historyCoordinates(sessionId: string, events: readonly SessionEvent[]): ColdHistoryCoordinates | undefined {
  if (events.length > MAX_COLD_HISTORY_FACTS) return undefined
  const facts: SessionHistoryFact[] = []
  const admissions = new Set<string>()
  let imageIdUnits = 0
  let budget: number | undefined
  let recoveries: number[] | undefined = []
  for (const event of events) {
    const fact = sessionHistoryFact(event)
    imageIdUnits += (fact.inputId?.length ?? 0) + (fact.imageInputId?.length ?? 0)
    if (fact.seq !== facts.length || imageIdUnits > MAX_COLD_HISTORY_IMAGE_ID_UNITS) return undefined
    // An unresolved address must be checked by the ordinary snapshot path,
    // where its error cannot prevent a changed file from being read afresh.
    if (fact.imageInputId !== undefined && !admissions.has(fact.imageInputId)) return undefined
    if (fact.inputId !== undefined) admissions.add(fact.inputId)
    if (event.type === 'context/budget' && event.snapshot.ownerSessionId === sessionId) budget = fact.seq
    if (event.type === 'context/recovery' && event.ownerSessionId === sessionId && recoveries) {
      if (recoveries.length === MAX_COLD_CONTEXT_RECOVERY_ORDINALS) recoveries = undefined
      else recoveries.push(fact.seq)
    }
    facts.push(fact)
  }
  // The ordinary decoder already validated these events. A narrower cached
  // lookup also verifies its last budget explicitly before dropping older ones.
  if (!recoveries || budget !== undefined && !validContextEvent(events[budget])) return { facts }
  if (budget !== undefined) recoveries.push(budget)
  const report = deriveLastProviderInput(events, sessionId)
  const provider = report && report.budgetSeq === budget ? { accepted: report.acceptedSeq, sample: report.usageSeq } : undefined
  if (provider) recoveries.push(provider.accepted, provider.sample)
  return { facts, context: { budget, provider, selected: recoveries.sort((a, b) => a - b) } }
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
  const initialColdReads = new Map<string, { reader: ColdArchiveHistoryReader; read: Promise<InitialColdHistory | undefined> }>()
  let coldHistoryRetired = false
  const materialize = (proof: HistoryProof) => materializeHistory(backend, proof)

  function rememberColdHistory(sessionId: string, history: ColdHistory) {
    coldHistory.delete(sessionId)
    coldHistory.set(sessionId, history)
    if (coldHistory.size > MAX_COLD_HISTORY_SESSIONS) coldHistory.delete(coldHistory.keys().next().value!)
  }
  function originalSealCurrent(reader: ColdArchiveHistoryReader) {
    return () => !coldHistoryRetired && originalColdArchiveHistoryReader(backend) === reader
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
  function translateReadFailure(cause: unknown): never {
    if (['SESSION_CONTEXT_REPLACEMENT_FORMAT', 'SESSION_CONVERSATION_FORMAT'].includes((cause as { code?: string })?.code ?? ''))
      throw new SessionFormatUnsupportedError('unsupported conversation history', { cause })
    throw cause
  }
  const read = async (sessionId: string, original?: ColdArchiveHistoryReader['readFull']): ReturnType<ColdArchiveHistoryReader['readFull']> => {
    try { return await (original ? Reflect.apply(original, backend, [sessionId]) : backend.read(sessionId)) }
    catch (cause) { return translateReadFailure(cause) }
  }
  function visibleHistory({version, events, meta}: Awaited<ReturnType<ColdArchiveHistoryReader['readFull']>>) {
    const current = originalDecodedArchiveRead(backend) !== undefined && version === CURRENT_FORMAT_VERSION
    if (current) preflightDecodedFactHistory(version, events)
    else preflightSessionFormat(version, events, meta)
    const visible = guardIgnorable(events)
    return { visible, unchanged: current && visible.length === events.length }
  }
  async function asSnapshot({version, meta}: Awaited<ReturnType<ColdArchiveHistoryReader['readFull']>>, {visible, unchanged}: ReturnType<typeof visibleHistory>): Promise<Session> {
    return {
      formatVersion: CURRENT_FORMAT_VERSION,
      events: unchanged ? visible : await migrate(version, visible, meta),
      ...(meta === undefined ? {} : { header: meta }),
    }
  }
  function readInitialColdHistory(sessionId: string, original: ColdArchiveHistoryReader) {
    const existing = initialColdReads.get(sessionId)
    if (existing?.reader === original) return existing.read
    const isCurrent = originalSealCurrent(original)
    const read = (async (): Promise<InitialColdHistory | undefined> => {
      let decoded: InitialArchive
      try { decoded = await original.readFullForHistoryPage?.(sessionId) }
      catch (cause) {
        if ((cause as NodeJS.ErrnoException)?.code === 'ENOENT') return undefined
        return translateReadFailure(cause)
      }
      if (!decoded || !isCurrent()) return undefined
      const qualified = visibleHistory(decoded)
      let internalSnapshot: Promise<Session> | undefined
      let pendingItems: Promise<readonly PendingInputSummary[]> | undefined
      const snapshot = () => internalSnapshot ??= asSnapshot(decoded, qualified)
      return { decoded, unchanged: qualified.unchanged, snapshot,
        pending: () => pendingItems ??= snapshot().then(session => readInbox(session).pending().map(pendingInputSummary)) }
    })()
    if (initialColdReads.size < MAX_COLD_HISTORY_SESSIONS) {
      const flight = { reader: original, read }
      initialColdReads.set(sessionId, flight)
      const clear = () => { if (initialColdReads.get(sessionId) === flight) initialColdReads.delete(sessionId) }
      void read.then(clear, clear)
    }
    return read
  }
  async function readInitialColdHistoryPage(sessionId: string, options: SessionHistoryPageOptions, original: ColdArchiveHistoryReader, onSnapshotFallback?: ColdSnapshotFallback): Promise<ColdHistoryPageResult | undefined> {
    const reading = await readInitialColdHistory(sessionId, original), isCurrent = originalSealCurrent(original)
    if (!reading || !isCurrent()) return undefined
    const { decoded, unchanged } = reading, { events, evidence } = decoded
    const snapshotFallback = async () => {
      if (onSnapshotFallback) {
        const session = await reading.snapshot()
        if (isCurrent()) onSnapshotFallback(copyConversationData(session), isCurrent)
      }
      return undefined
    }
    const coordinates = unchanged && evidence ? historyCoordinates(sessionId, events) : undefined
    if (!coordinates || !evidence) return snapshotFallback()
    const plan = planSessionHistoryPage(coordinates.facts, options)
    if (!plan) return snapshotFallback()
    // Public callers can retain and modify the returned page. Copy only its
    // selected records and any external image admissions, not the entire log.
    const serialized = stringifyJsonData(plan.ordinals.map(ordinal => events[ordinal]))
    if (serialized === undefined) return snapshotFallback()
    const records: SessionEvent[] = JSON.parse(serialized)
    const page = materializeSessionHistoryPage(plan, records)
    if (!coldHistory.has(sessionId)) {
      decoded.retainDecoded?.()
      rememberColdHistory(sessionId, { evidence, ...coordinates })
    }
    return { page, ...(decoded.retainDecoded ? { originalSealCurrent: isCurrent } : {}) }
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
      const decoded = await read(sessionId, cold?.readFull.bind(cold) ?? originalDecodedArchiveRead(backend))
      const qualified = visibleHistory(decoded), { visible, unchanged } = qualified
      const { evidence } = decoded
      if (cold && !coldHistoryRetired && originalColdArchiveHistoryReader(backend) === cold) {
        const coordinates = unchanged && evidence ? historyCoordinates(sessionId, visible) : undefined
        if (coordinates && evidence) rememberColdHistory(sessionId, { evidence, ...coordinates })
        else if (coldHistory.get(sessionId) === previous) coldHistory.delete(sessionId)
      }
      return { session: await asSnapshot(decoded, qualified) }
    },
    async readColdPendingInputs(sessionId: string): Promise<ColdCommittedObservation<readonly PendingInputSummary[]> | undefined> {
      if (coldHistoryRetired) return undefined
      const original = originalColdArchiveHistoryReader(backend)
      if (!original) return undefined
      const isCurrent = originalSealCurrent(original), history = coldHistory.get(sessionId)
      if (history?.pendingOrdinals) {
        // The original reader seals the full committed prefix even when the
        // mailbox is empty. Only selected pending payloads are decoded.
        const records = await original.readWindow(sessionId, history.evidence, new Set(history.pendingOrdinals))
        if (!isCurrent()) return undefined
        if (records) {
          const byOrdinal = new Map(records.map(event => [event.seq, event]))
          const items = history.pendingOrdinals.map(ordinal => {
            const event = byOrdinal.get(ordinal)
            if (event?.type !== 'agent/input/admitted') throw new Error('History pending input ordinal mismatch')
            return pendingInputSummary({ ...event, admittedSeq: ordinal })
          })
          if (coldHistory.get(sessionId) === history) rememberColdHistory(sessionId, history)
          return { value: items, originalSealCurrent: isCurrent }
        }
        if (coldHistory.get(sessionId) === history) coldHistory.delete(sessionId)
      }
      const reading = await readInitialColdHistory(sessionId, original)
      if (!reading || !isCurrent()) return undefined
      const items = await reading.pending()
      if (!isCurrent()) return undefined
      const { decoded, unchanged } = reading
      const { evidence, retainDecoded } = decoded
      if (retainDecoded && unchanged && evidence) {
        const ordinals = pendingOrdinals(items)
        const cached = coldHistory.get(sessionId)
        if (ordinals && cached?.evidence === evidence) cached.pendingOrdinals = ordinals
        else if (ordinals && history && (!cached || cached === history)) {
          // A previously returned page can predate this verified read. Keep
          // pending coordinates tied to the exact current evidence.
          const coordinates = historyCoordinates(sessionId, decoded.events)
          if (coordinates) rememberColdHistory(sessionId, { evidence, ...coordinates, pendingOrdinals: ordinals })
        }
      }
      return { value: items, ...(retainDecoded ? { originalSealCurrent: isCurrent } : {}) }
    },
    async readColdHistoryPage(sessionId: string, options: SessionHistoryPageOptions, onSnapshotFallback?: ColdSnapshotFallback): Promise<ColdHistoryPageResult | undefined> {
      if (coldHistoryRetired) return undefined
      const original = originalColdArchiveHistoryReader(backend)
      if (!original) return undefined
      const history = coldHistory.get(sessionId)
      if (!history) return await readInitialColdHistoryPage(sessionId, options, original, onSnapshotFallback)
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
      return { page }
    },
    async readColdSavedContext(sessionId: string, binding?: SavedContextBinding): Promise<ColdCommittedObservation<SavedContextFacts> | undefined> {
      if (coldHistoryRetired) return undefined
      const original = originalColdArchiveHistoryReader(backend)
      if (!original) return undefined
      const isCurrent = originalSealCurrent(original)
      const history = coldHistory.get(sessionId), context = history?.context
      if (history && context) {
        // Every page-local coordinate belongs to this exact verified prefix.
        // With no saved facts, the empty selection still verifies that prefix.
        const records = await original.readWindow(sessionId, history.evidence, new Set(context.selected))
        if (!isCurrent()) return undefined
        if (records) {
          const ordered = [...records].sort((a, b) => a.seq! - b.seq!)
          const ownedContextRecord = (event: SessionEvent) => {
            if (event.seq === context.budget) return event.type === 'context/budget' && event.snapshot.ownerSessionId === sessionId
            if (event.seq === context.provider?.accepted) return event.type === 'model/exchange-accepted' && event.version === 2 && event.request.ownerSessionId === sessionId
            if (event.seq === context.provider?.sample) return event.type === 'context/usage' && event.version === 2 && event.op === 'sample' && event.checkpoint.request.ownerSessionId === sessionId
            return event.type === 'context/recovery' && event.ownerSessionId === sessionId
          }
          if (ordered.length !== context.selected.length || ordered.some((event, index) => event.seq !== context.selected[index] || !ownedContextRecord(event)))
            throw new Error('History context ordinal mismatch')
          const facts = savedContextFromSession({ formatVersion: CURRENT_FORMAT_VERSION, events: ordered }, sessionId, binding)
          if (coldHistory.get(sessionId) === history) rememberColdHistory(sessionId, history)
          return { value: facts, originalSealCurrent: isCurrent }
        }
        if (coldHistory.get(sessionId) === history) coldHistory.delete(sessionId)
      }
      const reading = await readInitialColdHistory(sessionId, original)
      if (!reading || !isCurrent()) return undefined
      const snapshot = await reading.snapshot()
      if (!isCurrent()) return undefined
      const facts = savedContextFromSession(snapshot, sessionId, binding)
      return { value: facts, ...(reading.decoded.retainDecoded ? { originalSealCurrent: isCurrent } : {}) }
    },
    retireColdHistory() {
      coldHistoryRetired = true
      coldHistory.clear()
      initialColdReads.clear()
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
