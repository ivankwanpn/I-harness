import { createHash } from 'node:crypto'
import { CURRENT_FORMAT_VERSION, canonicalJsonData, decodeFactBatch, encodeFactBatch, legacyPrefixDigest, stringifyJsonData, type FactReceipt, type Session, type SessionEvent } from '@i-harness/core-session'
import { COMMIT_LOG_GENERATION, CommitLogConflictError, CommitLogClosedError, createCommitLog, openCommitLog, CommitLogNotFoundError, type CommitLog, type CommitLogMode } from '@i-harness/session-commit-log'
import { readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { buildSession, migrate, preflightSessionFormat } from '../format/validation.ts'
import type { SessionMeta } from '../coordinator/types.ts'
import type { LegacySessionStore } from './legacy.ts'
import type { ManagedDocument } from '../coordinator/fact-types.ts'
import { createCommitObservations } from './observations.ts'
import { bootstrapManifest, buildBootstrapHeader, captureBootstrapRequest } from '../coordinator/bootstrap-header.ts'
import type { BootstrapRequest } from '../coordinator/bootstrap-types.ts'
import { openCommitManagedDocument } from './managed.ts'
import { openCommitExecution } from './execution.ts'
import { withCommitProcessReadObservation } from './process-read.ts'
import { createCommitOwnershipPorts, type CommitOwnershipPorts } from './capabilities.ts'
import { createRetainedCleanupOperation, finishRetainedCleanupOperation } from '../coordinator/retained-cleanup.ts'

/**
 * v1 commit-log coordinator: the session view is a fold of one commit log.
 * Legacy (format 13/14) sessions are readable and migrate to a format-15
 * generation on their first write; the old bytes are never modified.
 * Managed documents, task documents and birth intents arrive in later slices.
 */

export type CommitCoordinatorOptions = {
  readonly root: string
  readonly lock?: { readonly enabled?: boolean; readonly lockRoot?: string }
  readonly acquireRetryMs?: number
  readonly acquireDeadlineMs?: number
  readonly now?: () => Date
  /** Pre-commit-log generations, read-only; a write migrates to format 15 first. */
  readonly legacy?: LegacySessionStore
  /** Metadata folds restored into the execution state (owned metadata context). */
  readonly originalExecutionFoldFactory?: Parameters<typeof import('@i-harness/core-session/internal/execution').restoreManagedExecutionState>[2]
  /** Where background failures (enqueued appends, deletion listeners) go. */
  readonly reportBackgroundFailure?: (error: unknown) => void
}

export type ForkOptions = {
  readonly cut?: number
  readonly sessionId?: string
  readonly meta?: Partial<SessionMeta>
}

export type CommitIntent = Readonly<Record<string, unknown>>

export class CommitSessionDeletedError extends CommitLogNotFoundError {
  constructor(sessionId: string) { super(sessionId); this.name = 'CommitSessionDeletedError' }
}

export type CommitCoordinator = {
  readonly storageRoot: string
  create(meta?: Partial<SessionMeta>): Promise<{ id: string }>
  createChildSession(request: BootstrapRequest, options: { closure: string }): Promise<{ id: string; document: ManagedDocument; receipt: import('../coordinator/bootstrap-types.ts').BootstrapReceipt }>
  bootstrapChildTargetWithCapture(request: import('../coordinator/child-bootstrap-intent.ts').ChildBootstrapCaptureRequest, guards: import('../coordinator/bootstrap-types.ts').BootstrapGuards, capture: () => Promise<BootstrapRequest>): Promise<import('../coordinator/bootstrap-types.ts').BootstrapOutcome>
  resumeChildTarget(request: import('../coordinator/child-bootstrap-intent.ts').ChildBootstrapCaptureRequest, guards: import('../coordinator/bootstrap-types.ts').BootstrapGuards, payload?: BootstrapRequest): Promise<import('../coordinator/bootstrap-types.ts').BootstrapOutcome>
  fork(parentId: string, options?: ForkOptions): Promise<{ id: string }>
  beginIntent(sessionId: string, id: string, intent: CommitIntent): Promise<void>
  endIntent(sessionId: string, id: string, outcome: 'committed' | 'failed'): Promise<void>
  intents(sessionId: string): Promise<ReadonlyMap<string, CommitIntent>>
  load(sessionId: string): Promise<{ session: Session }>
  snapshot(sessionId: string): Promise<{ session: Session }>
  loadOwned(sessionId: string): Promise<{ session: Session }>
  append(sessionId: string, events: SessionEvent[]): Promise<void>
  openManagedDocument(sessionId: string): Promise<ManagedDocument>
  /** Detached read-only document that must not disturb the owner's document. */
  openReadOnlyManagedDocument?(sessionId: string): Promise<{ document: ManagedDocument; close(): Promise<void> }>
  acquireExecution(sessionId: string): Promise<import('../execution-internal.ts').ManagedExecutionAttachment>
  sessionOfDocument(document: object): string | undefined
  capabilities(): CommitOwnershipPorts
  withProcessReadObservation<T, U>(id: string, options: import('../coordinator/process-read-owner.ts').ProcessReadOptions, work: (observation: import('../coordinator/process-read-owner.ts').ProcessReadObservation) => Promise<T>, publish: (candidate: T, observation: import('../coordinator/process-read-owner.ts').ProcessReadObservation, last: import('../coordinator/process-read-owner.ts').ProcessReadUpdate) => Promise<U>): Promise<U>
  closeManagedDocument(sessionId: string): Promise<void>
  revokeManagedDocumentNewWork(sessionId: string): void
  list(): Promise<string[]>
  profile(sessionId: string): Promise<{ meta: SessionMeta; blank: boolean; updatedAt?: number }>
  updateMeta(sessionId: string, patch: Partial<SessionMeta>): Promise<SessionMeta>
  putDocument(key: string, data: unknown): Promise<void>
  putDocumentStrict(key: string, data: unknown): Promise<void>
  getDocument(key: string): Promise<unknown | undefined>
  flush(sessionId: string): Promise<void>
  enqueue(sessionId: string, events: SessionEvent[]): void
  deleteOwnedSession(sessionId: string, manifest: { documents: string[]; files?: string[] }): Promise<void>
  deletionReceipt(sessionId: string): Promise<{ visibility: { origin?: string; parentSession?: string }; manifest: { documents: string[]; files?: string[] } } | undefined>
  onDocumentDeleted(listener: (sessionId: string, manifest: { documents: string[]; files?: string[] }) => Promise<void>): () => void
  ownerOf(sessionId: string): boolean
  hasLiveOwnership(sessionId: string): boolean
  withExistingSessionBindingObservation<T>(request: import('../coordinator/types.ts').ExistingSessionBindingObservationRequest, run: (observation: import('../coordinator/types.ts').ExistingSessionBindingObservation) => Promise<T>): Promise<T>
  withSessionBindingObservation<T>(request: import('../coordinator/types.ts').SessionBindingObservationRequest, run: (observation: import('../coordinator/types.ts').SessionBindingObservation) => Promise<T>): Promise<T>
  adoptOwnership(sessionId: string): Promise<void>
  releaseOwnership(sessionId: string): Promise<void>
  close(): Promise<void>
}

type Header = SessionMeta & { readonly commitFormatVersion?: number }

const DOCUMENT_SESSION = '__documents__'

function randomSessionId(): string {
  return `sess-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}

function toHeader(meta: Partial<SessionMeta> | undefined, sessionId: string, now: () => Date): Header {
  return {
    createdAt: meta?.createdAt ?? now().toISOString(),
    ...meta,
    sessionId,
    formatVersion: meta?.formatVersion ?? CURRENT_FORMAT_VERSION,
  } as unknown as Header
}

function toMeta(header: Readonly<Record<string, unknown>>, meta: Readonly<Record<string, unknown>> = {}): SessionMeta {
  const value = { ...header, ...meta } as unknown as SessionMeta & { commitFormatVersion?: number }
  delete value.commitFormatVersion
  return value
}

function metaOf(log: CommitLog): SessionMeta { return toMeta(log.header(), log.metadata()) }

/** Synthesize the bootstrap receipt over the exact events the birth commit wrote:
 *  a seed batch (when the seed has records) then the completion batch. */
function receiptOf(request: BootstrapRequest, stage: ReturnType<typeof buildBootstrapHeader>['stage'], closure: string, id: string, initial?: SessionEvent): import('../coordinator/bootstrap-types.ts').BootstrapReceipt {
  const owner = { sessionId: id, incarnation: 'birth' }
  const seedLength = stage.seed.seedLength
  let previous = legacyPrefixDigest(0, new Uint8Array())
  let seed: FactReceipt | undefined
  const records = request.seed.records
  if (records.length) {
    const batch = encodeFactBatch(`bootstrap:${request.invocation.operationId}:seed`, previous, records)
    seed = { owner, key: batch.key, lastSeq: batch.key.firstSeq + batch.key.count - 1, prefixDigest: decodeFactBatch(batch.bytes).prefixDigest }
    previous = seed.prefixDigest
  }
  const completion = { type: 'session/bootstrap' as const, version: 1 as const, seq: seedLength, operationId: request.invocation.operationId, manifestDigest: bootstrapManifest(stage, records), dependencyClosureDigest: closure, seedLength }
  const completionEvents: SessionEvent[] = [completion as unknown as SessionEvent]
  if (initial) completionEvents.push({ ...initial, seq: seedLength + 1 } as SessionEvent)
  const complete = encodeFactBatch(`bootstrap:${request.invocation.operationId}:complete`, previous, completionEvents)
  return {
    version: 1,
    invocation: request.invocation,
    manifestDigest: bootstrapManifest(stage, records),
    seedLength,
    dependencyClosureDigest: closure,
    ...(seed ? { seed } : {}),
    completion: { owner, key: complete.key, lastSeq: complete.key.firstSeq + complete.key.count - 1, prefixDigest: decodeFactBatch(complete.bytes).prefixDigest },
    ...(stage.initial ? { initial: { inputId: stage.initial.inputId, seq: seedLength + 1, startedAt: stage.initial.startedAt, expiresAt: stage.initial.expiresAt } } : {}),
  }
}

export function createCommitCoordinator(options: CommitCoordinatorOptions): CommitCoordinator {
  const root = options.root
  const now = options.now ?? (() => new Date())
  const reportFailure = options.reportBackgroundFailure ?? ((error: unknown) => console.warn('[i-harness] background persistence failure:', error))
  if (options.lock?.enabled === false) throw new Error('Commit coordinator requires the writer lease')
  const logOptions = (sessionId: string) => ({ root, sessionId, now, compactDocuments: sessionId === DOCUMENT_SESSION, lockRoot: options.lock?.lockRoot ?? root, lease: { retryMs: options.acquireRetryMs, deadlineMs: options.acquireDeadlineMs } })
  const open = (sessionId: string, mode: CommitLogMode): Promise<CommitLog> => openCommitLog(logOptions(sessionId), mode)
  const owned = new Map<string, CommitLog>()
  let ownedAdmissionClosed = false
  let closeFlight: Promise<void> | undefined
  const ownedWork = new Set<Promise<unknown>>()
  const writes = new Set<Promise<unknown>>()
  const track = <T>(flights: Set<Promise<unknown>>, work: () => Promise<T>): Promise<T> => {
    const flight = work()
    flights.add(flight)
    void flight.finally(() => flights.delete(flight)).catch(() => {})
    return flight
  }
  const ownedOperation = <T>(work: () => Promise<T>): Promise<T> => {
    if (ownedAdmissionClosed) return Promise.reject(new CommitLogClosedError())
    return track(ownedWork, work)
  }
  const pending = new Map<string, Set<Promise<void>>>()
  const managed = new Map<string, ManagedDocument>()
  const documentSessions = new WeakMap<object, string>()
  const deletedListeners = new Set<(sessionId: string, manifest: { documents: string[]; files?: string[] }) => Promise<void>>()

  const build = (log: CommitLog): Session => {
    const meta = metaOf(log)
    const version = typeof meta.formatVersion === 'number' ? meta.formatVersion : CURRENT_FORMAT_VERSION
    const events = log.view().entries.map(event => ({ ...event }))
    preflightSessionFormat(version, events, meta)
    return buildSession(meta, events)
  }

  const readLegacy = async (sessionId: string): Promise<{ meta?: SessionMeta; events: SessionEvent[]; version: number }> => {
    if (await getDocumentOf('deletion:' + sessionId)) throw new CommitSessionDeletedError(sessionId)
    if (!options.legacy) throw new CommitLogNotFoundError(sessionId)
    let raw
    try { raw = await options.legacy.read(sessionId) } catch (error) {
      // Only a genuinely absent legacy file is "not found"; a corrupt or
      // unsupported one must surface its real error instead of hiding it.
      if ((error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT') throw new CommitLogNotFoundError(sessionId)
      throw error
    }
    const events = await migrate(raw.version, [...raw.events], raw.meta)
    return { meta: raw.meta, events, version: raw.version }
  }

  const readState = async (sessionId: string): Promise<{ meta?: SessionMeta; events: SessionEvent[] }> => {
    try {
      const log = await open(sessionId, 'read')
      try { if (log.view().deleted) throw new CommitSessionDeletedError(sessionId); return { meta: metaOf(log), events: log.view().entries.map(event => ({ ...event })) } } finally { await log.close() }
    } catch (error) {
      if (error instanceof CommitSessionDeletedError || !(error instanceof CommitLogNotFoundError)) throw error
      const legacy = await readLegacy(sessionId)
      return { meta: legacy.meta, events: legacy.events }
    }
  }

  const readSession = async (sessionId: string): Promise<Session> => {
    const state = await readState(sessionId)
    preflightSessionFormat(CURRENT_FORMAT_VERSION, state.events, state.meta)
    return buildSession(state.meta, state.events)
  }

  /** Open a writable handle; a legacy-only session first publishes a format-15
   *  generation carrying its exact migrated history, then reopens that. */
  const ensureWritable = async (sessionId: string): Promise<CommitLog> => {
    try {
      const log = await open(sessionId, 'write')
      if (log.view().deleted) {
        await log.close()
        throw new CommitSessionDeletedError(sessionId)
      }
      return log
    }
    catch (error) {
      if (error instanceof CommitSessionDeletedError || !(error instanceof CommitLogNotFoundError)) throw error
      const legacy = await readLegacy(sessionId)
      const header = toHeader({ ...legacy.meta, formatVersion: CURRENT_FORMAT_VERSION }, sessionId, now)
      const log = await createCommitLog(logOptions(sessionId), { header: header as unknown as Record<string, unknown>, entries: legacy.events })
      return log
    }
  }

  const withWrite = <T>(sessionId: string, work: (log: CommitLog) => Promise<T>): Promise<T> => track(writes, async () => {
    const held = owned.get(sessionId)
    if (held) return work(held)
    const log = await ensureWritable(sessionId)
    try { return await work(log) } finally { await log.close() }
  })

  const documentLog = async (): Promise<CommitLog> => {
    try { return await open(DOCUMENT_SESSION, 'write') }
    catch (error) {
      if (!(error instanceof CommitLogNotFoundError)) throw error
      return createCommitLog(logOptions(DOCUMENT_SESSION), { header: { sessionId: DOCUMENT_SESSION, kind: 'document-store' } })
    }
  }

  const profileOf = async (sessionId: string): Promise<{ meta: SessionMeta; blank: boolean; updatedAt?: number }> => {
    try {
      const log = await open(sessionId, 'read')
      try {
        if (log.view().deleted) throw new CommitSessionDeletedError(sessionId)
        const meta = metaOf(log)
        const updatedAt = Date.parse(log.records().at(-1)!.at)
        const blank = !log.view().entries.some(event => event.type === 'turn/start')
        return { meta, blank, updatedAt }
      } finally { await log.close() }
    } catch (error) {
      if (!(error instanceof CommitLogNotFoundError)) throw error
      const legacy = await readLegacy(sessionId)
      // Never invent a createdAt for an existing session: a readable legacy
      // session without metadata is a contract violation, not a blank one.
      if (!legacy.meta) throw new Error(`legacy session "${sessionId}" has no metadata`)
      return { meta: legacy.meta, blank: !legacy.events.some(event => event.type === 'turn/start') }
    }
  }
  const getDocumentOf = async (key: string): Promise<unknown | undefined> => {
    const legacyDocument = () => options.legacy?.readDocument ? options.legacy.readDocument(key) : undefined
    let log: CommitLog
    try { log = await open(DOCUMENT_SESSION, 'read') } catch (error) { if (error instanceof CommitLogNotFoundError) return legacyDocument(); throw error }
    try {
      const side = log.view().documents.get(key)
      if (!side) {
        const cleared = log.records().some(record => record.ops.some(op => op.kind === 'doc-clear' && op.key === key))
        return cleared ? undefined : legacyDocument()
      }
      return JSON.parse(new TextDecoder().decode(await log.readSidecar(side.digest))) as unknown
    } finally { await log.close() }
  }
  const clearDocumentsOf = (keys: readonly string[]): Promise<void> => track(writes, async () => {
    if (!keys.length) return
    const log = await documentLog()
    try { await log.append({ ops: keys.map(key => ({ kind: 'doc-clear' as const, key })) }) } finally { await log.close() }
  })
  const putDocumentOf = (key: string, data: unknown): Promise<void> => track(writes, async () => {
    const text = stringifyJsonData(data)
    if (text === undefined) throw new TypeError('document must be losslessly JSON-serializable')
    const log = await documentLog()
    try {
      const side = await log.writeSidecar(new TextEncoder().encode(text))
      await log.append({ ops: [{ kind: 'doc', key, side }] })
    } finally { await log.close() }
  })
  const ownershipPorts = createCommitOwnershipPorts(root, { putDocument: putDocumentOf, getDocument: getDocumentOf, profile: profileOf })
  const ownershipPins = new Map<string, { release(): Promise<void> }>()
  const pinSession = async (sessionId: string) => {
    if (ownershipPins.has(sessionId)) return
    ownershipPins.set(sessionId, await ownershipPorts.ownership.pinOwnership(sessionId))
  }
  const unpinSession = async (sessionId: string) => {
    const pin = ownershipPins.get(sessionId)
    if (!pin) return
    await pin.release()
    ownershipPins.delete(sessionId)
  }
  const observations = createCommitObservations({ profile: profileOf, getDocument: getDocumentOf })

  return {
    storageRoot: root,
    create(meta) {
      return track(writes, async () => {
        const sessionId = meta?.sessionId ?? randomSessionId()
        const header = toHeader(meta, sessionId, now)
        const log = await createCommitLog({ ...logOptions(sessionId), recreateDeleted: true }, { header: header as unknown as Record<string, unknown> })
        await log.close()
        await clearDocumentsOf(['deletion:' + sessionId])
        return { id: sessionId }
      })
    },
    async load(sessionId) { return { session: await readSession(sessionId) } },
    createChildSession(request, options) {
      return track(writes, async () => {
        const captured = captureBootstrapRequest(request)
        const { stage, initial } = buildBootstrapHeader(captured)
        const id = captured.invocation.targetSessionId
        const existing = await open(id, 'read').then(async (log) => { try { if (log.view().deleted) throw new CommitLogConflictError(id); return log.header() } finally { await log.close() } }, error => { if (error instanceof CommitLogNotFoundError) return undefined; throw error })
        if (existing) {
          const seed = (existing as { semanticSeed?: { operationId?: string } }).semanticSeed
          if (seed?.operationId !== captured.invocation.operationId) throw new CommitLogConflictError(id)
          const rebuilt = buildBootstrapHeader(captured)
          return { id, document: await this.openManagedDocument(id), receipt: receiptOf(captured, rebuilt.stage, options.closure, id, rebuilt.initial) }
        }
        const header = JSON.parse(Buffer.from(stage.headerBytes).toString('utf8')) as Record<string, unknown>
        const seedLength = stage.seed.seedLength
        const completion = {
          type: 'session/bootstrap' as const, version: 1 as const, seq: seedLength,
          operationId: captured.invocation.operationId,
          manifestDigest: bootstrapManifest(stage, captured.seed.records),
          dependencyClosureDigest: options.closure,
          seedLength,
          ...(stage.initial ? { initialInputId: stage.initial.inputId, initialStartedAt: stage.initial.startedAt, initialExpiresAt: stage.initial.expiresAt } : {}),
        }
        const entries = [
          ...captured.seed.records.map(event => ({ ...event })),
          completion as unknown as SessionEvent,
          ...(initial ? [{ ...initial, seq: seedLength + 1 } as SessionEvent] : []),
        ]
        const parent = captured.lineage.parentSession
        const intentId = `child:${captured.invocation.operationId}`
        let parentIntent = false
        if (parent) {
          parentIntent = await this.beginIntent(parent, intentId, { kind: 'child-birth', childId: id, requestDigest: captured.invocation.requestDigest }).then(() => true, () => false)
        }
        const log = await createCommitLog(logOptions(id), { header, entries })
        await log.close()
        if (parentIntent && parent) await this.endIntent(parent, intentId, 'committed').catch(() => {})
        return { id, document: await this.openManagedDocument(id), receipt: receiptOf(captured, stage, options.closure, id, initial) }
      })
    },
    async bootstrapChildTargetWithCapture(request, guards, capture) {
      guards.assertCurrent()
      const payload: BootstrapRequest = await capture()
      if (canonicalJsonData(payload.invocation) !== canonicalJsonData(request.invocation)) throw new TypeError('captured child payload does not match the child request')
      guards.assertCurrent()
      return this.createChildSession(payload, { closure: payload.seed.dependencyDigest }).then(
        ({ document, receipt }) => ({ kind: 'ready' as const, document, receipt }),
        (error) => {
          if (error instanceof CommitLogConflictError) return { kind: 'refused' as const, reason: 'conflict' as const }
          throw error
        },
      )
    },
    async resumeChildTarget(request, guards, payload) {
      if (!payload) return { kind: 'blocked', token: { version: 1, invocation: request.invocation, phase: 'header', manifestDigest: 'unknown' }, reason: 'payload-required' }
      return this.bootstrapChildTargetWithCapture(request, guards, async () => payload)
    },
    fork(parentId, options = {}) {
      return track(writes, async () => {
        const parent = await readState(parentId)
        const cut = options.cut ?? parent.events.length
        if (!Number.isSafeInteger(cut) || cut < 0 || cut > parent.events.length) throw new Error(`fork cut ${cut} is outside the committed history of ${parentId}`)
        const childId = options.sessionId ?? randomSessionId()
        const header = { ...toHeader(parent.meta, childId, now), parentSession: parentId, seedLength: cut, ...options.meta, sessionId: childId } as unknown as Record<string, unknown>
        const digest = createHash('sha256').update(stringifyJsonData(parent.events.slice(0, cut)) ?? '[]').digest('hex')
        const log = await createCommitLog(logOptions(childId), { header, entries: parent.events.slice(0, cut), ops: [{ kind: 'seed', parent: parentId, cut, digest }] })
        await log.close()
        return { id: childId }
      })
    },
    async beginIntent(sessionId, id, intent) {
      await withWrite(sessionId, log => log.append({ ops: [{ kind: 'intent', id, intent }] }))
    },
    async endIntent(sessionId, id, outcome) {
      await withWrite(sessionId, log => log.append({ ops: [{ kind: 'intent-done', id, outcome }] }))
    },
    async intents(sessionId) {
      const log = await open(sessionId, 'read')
      try { return new Map(log.view().intents) } finally { await log.close() }
    },
    async snapshot(sessionId) { return { session: await readSession(sessionId) } },
    loadOwned(sessionId) {
      return ownedOperation(async () => {
        const held = owned.get(sessionId)
        if (held) return { session: build(held) }
        const log = await ensureWritable(sessionId)
        if (ownedAdmissionClosed) { await log.close(); throw new CommitLogClosedError() }
        owned.set(sessionId, log)
        return { session: build(log) }
      })
    },
    async append(sessionId, events) {
      const captured = structuredClone(events)
      await withWrite(sessionId, async (log) => {
        await log.append(({ entryCount: base }) => {
          const staged = captured.map((event, index) => {
            const seq = event.seq ?? base + index
            if (seq !== base + index) throw new Error(`session sequence invariant failed for ${sessionId}: event ${index} has seq ${seq}`)
            return { ...event, seq }
          })
          return { entries: staged }
        })
      })
    },
    openManagedDocument(sessionId) {
      return ownedOperation(async () => {
        const existing = managed.get(sessionId)
        if (existing) return existing
        let log = owned.get(sessionId)
        if (!log) {
          log = await ensureWritable(sessionId)
          if (ownedAdmissionClosed) {
            await log.close()
            throw new CommitLogClosedError()
          }
          owned.set(sessionId, log)
        }
        await pinSession(sessionId)
        const document = openCommitManagedDocument(sessionId, log, { logs: owned, metaOf, ownership: ownershipPorts.ownership })
        documentSessions.set(document as object, sessionId)
        managed.set(sessionId, document)
        return document
      })
    },
    sessionOfDocument(document) { return documentSessions.get(document) },
    capabilities() { return ownershipPorts },
    withProcessReadObservation(id, options, work, publish) {
      return withCommitProcessReadObservation({ open: sessionId => open(sessionId, 'read'), getDocument: getDocumentOf, metaOf }, id, options, work, publish)
    },
    async openReadOnlyManagedDocument(sessionId: string) {
      // A read-only document for observers that need a session view but must not
      // disturb (or close) the owner's cached document (the fork witness).
      const log = await open(sessionId, 'read')
      try {
        const document = openCommitManagedDocument(sessionId, log, { logs: owned, metaOf, ownership: ownershipPorts.ownership })
        return Object.freeze({ document, async close() { await document.close().catch(() => {}); await log.close().catch(() => {}) } })
      } catch (error) { await log.close().catch(() => {}); throw error }
    },
    acquireExecution(sessionId) {
      return ownedOperation(async () => {
        let log = owned.get(sessionId)
        if (!log) { log = await ensureWritable(sessionId); owned.set(sessionId, log) }
        await pinSession(sessionId)
        const attachment = await openCommitExecution(sessionId, log, { logs: owned, metaOf, ownership: ownershipPorts.ownership }, options.originalExecutionFoldFactory)
        documentSessions.set(attachment.owner as object, sessionId)
        managed.set(sessionId, attachment.owner as unknown as ManagedDocument)
        return attachment
      })
    },
    async closeManagedDocument(sessionId) {
      const document = managed.get(sessionId)
      if (!document) return
      await document.close()
      managed.delete(sessionId)
      const log = owned.get(sessionId)
      if (log) { await log.close(); owned.delete(sessionId) }
      await unpinSession(sessionId)
    },
    revokeManagedDocumentNewWork(sessionId) { managed.get(sessionId)?.revokeNewWork() },
    async list() {
      const ids = new Set<string>()
      for (const entry of await readdir(root, { withFileTypes: true })) {
        if (entry.isDirectory() && !entry.name.startsWith('.') && entry.name !== DOCUMENT_SESSION) {
          const exists = await stat(join(root, entry.name, `session.v${COMMIT_LOG_GENERATION}.jsonl`)).then(() => true, () => false)
          if (exists) ids.add(entry.name)
        } else if (entry.isFile() && entry.name.endsWith('.jsonl') && !entry.name.includes('.doc.')) {
          ids.add(entry.name.slice(0, -'.jsonl'.length))
        }
      }
      // A broken legacy store must not silently look like an empty store.
      if (options.legacy) for (const id of await options.legacy.list()) ids.add(id)
      const visible: string[] = []
      for (const id of ids) {
        try { const log = await open(id, 'read'); try { if (!log.view().deleted) visible.push(id) } finally { await log.close() } }
        catch (error) {
          if (!(error instanceof CommitLogNotFoundError)) throw error
          if (!await getDocumentOf('deletion:' + id)) visible.push(id)
        }
      }
      return visible.sort()
    },
    profile: profileOf,
    withExistingSessionBindingObservation: observations.withExistingSessionBindingObservation,
    withSessionBindingObservation: observations.withSessionBindingObservation,
    async updateMeta(sessionId, patch) {
      if (Object.hasOwn(patch, 'formatVersion') && patch.formatVersion !== CURRENT_FORMAT_VERSION) throw new Error('cannot downgrade session format')
      return withWrite(sessionId, async (log) => {
        await log.append({ ops: [{ kind: 'meta', patch: patch as Readonly<Record<string, unknown>> }] })
        return metaOf(log)
      })
    },
    putDocument: putDocumentOf,
    putDocumentStrict: putDocumentOf,
    getDocument: getDocumentOf,
    async flush(sessionId) { while (pending.get(sessionId)?.size) await Promise.all([...pending.get(sessionId)!]) },
    enqueue(sessionId, events) {
      const work = this.append(sessionId, events)
      const tasks = pending.get(sessionId) ?? new Set<Promise<void>>()
      pending.set(sessionId, tasks); tasks.add(work)
      void work.catch(reportFailure).finally(() => { tasks.delete(work); if (!tasks.size) pending.delete(sessionId) })
    },
    ownerOf(sessionId) { return owned.get(sessionId)?.open === true },
    hasLiveOwnership(sessionId) { return owned.get(sessionId)?.open === true },
    async deleteOwnedSession(sessionId, manifest) {
      await this.flush(sessionId)
      if (managed.has(sessionId)) await this.closeManagedDocument(sessionId)
      const held = owned.get(sessionId)
      let log: CommitLog
      try { log = held ?? await ensureWritable(sessionId) } catch (error) { if (error instanceof CommitSessionDeletedError) return; throw error }
      owned.delete(sessionId)
      try {
      // Persist the receipt before the delete commit. The generation tombstone
      // suppresses legacy fallback until an explicit recreation is published.
      const meta = metaOf(log)
      await this.putDocument(`deletion:${sessionId}`, { visibility: { ...(meta.origin ? { origin: meta.origin } : {}), ...(meta.parentSession ? { parentSession: meta.parentSession } : {}) }, manifest })
      // Retained references must stop being current as soon as the deletion is
      // durable, before publishing its logical tombstone.
      ownershipPorts.observations.markDeleted([sessionId], [...manifest.documents].filter(key => !key.startsWith('deletion:')))
      // The manifest's documents belong to the deleted session; clear them so a
      // recreation cannot read the old task/title/binding state.
      await clearDocumentsOf([...new Set(manifest.documents)].filter(key => !key.startsWith('deletion:')))
      await log.append({ ops: [{ kind: 'delete' }] })
      } finally { await log.close() }
      for (const listener of [...deletedListeners]) await listener(sessionId, manifest).catch(reportFailure)
    },
    async deletionReceipt(sessionId) {
      const value = await this.getDocument(`deletion:${sessionId}`)
      if (value && typeof value === 'object' && 'documents' in value) return { visibility: {}, manifest: value as { documents: string[]; files?: string[] } }
      return value as { visibility: { origin?: string; parentSession?: string }; manifest: { documents: string[]; files?: string[] } } | undefined
    },
    onDocumentDeleted(listener) {
      deletedListeners.add(listener)
      return () => { deletedListeners.delete(listener) }
    },
    adoptOwnership(sessionId) {
      return ownedOperation(async () => {
        if (owned.has(sessionId)) return
        const log = await ensureWritable(sessionId)
        if (ownedAdmissionClosed) { await log.close(); throw new CommitLogClosedError() }
        owned.set(sessionId, log)
      })
    },
    async releaseOwnership(sessionId) {
      if (managed.has(sessionId)) await this.closeManagedDocument(sessionId)
      const log = owned.get(sessionId)
      if (!log) return
      await log.close()
      owned.delete(sessionId)
    },
    close() {
      if (closeFlight) return closeFlight
      ownedAdmissionClosed = true
      const flight = (async () => {
        const failures: unknown[] = []
        const accepted = await Promise.allSettled([...ownedWork, ...writes])
        for (const result of accepted) if (result.status === 'rejected' && !(result.reason instanceof CommitLogClosedError)) failures.push(result.reason)
        for (const id of [...pending.keys()]) {
          try { await this.flush(id) } catch (error) { failures.push(error) }
        }
        // Closing the retained documents also releases their ownership pins; the
        // host may close with an execution still attached (a cold management
        // write), and a leaked pin keeps the capability-store lock held.
        for (const sessionId of [...managed.keys()]) await this.closeManagedDocument(sessionId).catch(error => { failures.push(error) })
        const cleanup = createRetainedCleanupOperation()
        try { await ownershipPorts.observations.closeRetained(cleanup).catch(error => { failures.push(error) }) } finally { finishRetainedCleanupOperation(cleanup) }
        for (const sessionId of [...ownershipPins.keys()]) {
          if (managed.has(sessionId)) continue
          try { await unpinSession(sessionId) } catch (error) { failures.push(error) }
        }
        for (const [id, handle] of owned) {
          if (managed.has(id)) continue // Failed document cleanup still owns this lease.
          try { await handle.close(); owned.delete(id) } catch (error) { failures.push(error) }
        }
        if (failures.length) throw new AggregateError(failures, 'Commit coordinator close failed')
      })()
      closeFlight = flight
      void flight.finally(() => { if (closeFlight === flight) closeFlight = undefined }).catch(() => {})
      return flight
    },
  }
}
