import { associateArchiveReadResources, associateArchiveHistoryPrefixReader } from '@i-harness/session-persistence/internal/archive-read'
import {associateOriginalTeamTargetBackend,associateOriginalTeamBindingBackend} from '../../session-persistence/src/team-child-recovery-internal.ts'
import { createArchiveReadOwner } from './backend/archive-read-owner.ts'
import { readSessionArchive } from './backend/archive-reader.ts'
import { associateArtifactPaths, createOriginalJsonlPathResolution } from '@i-harness/session-persistence/internal/artifact-path'
import { createOriginalNativePrewriteOwner } from '@i-harness/session-persistence/internal/native-fact-writer'
import { createOriginalTaskNativeStage } from '@i-harness/session-persistence/internal/task-document-operations'
import {associateOwnedExecutionReader} from './backend/owned-execution-read.ts'
import { decodeFactBatch } from '@i-harness/core-session'
import { HEADER_READ_MAX_BYTES, assertHeaderLineReadable } from './backend/header-limit.ts'
import { lstat, mkdir, open, readFile, readdir, stat, unlink } from "node:fs/promises"
import { createHash, randomUUID } from "node:crypto"
import { basename, dirname } from "node:path"
import { canonicalJsonData, validateDeliveryFrame, CURRENT_FORMAT_VERSION, isContextEventType, validContextEvent, validateConversationEventShape, validateConversationHistory, validateSemanticBootstrapHistory, validateSemanticBootstrapAppend, validateSubagentHeader, legacyPrefixDigest, readFactJournal, encodeFactBatch, type SessionEvent } from "@i-harness/core-session"
import type { PersistenceBackend, SessionMeta } from "@i-harness/session-persistence"
import { serializeHeader, parseHeader, parseEventLines, hasTornTail, snapshotMetadataUpdate } from "./format.ts"
import { createSessionFile, stageOwnedSessionFile, replaceSessionFile, replaceRawSessionFile } from "./backend/session-io.ts"
import { createFactJournalBackend, preserveBootstrapBirth } from './backend/fact-journal.ts'
import { upgradeFactJournal, stageOwnedUpgrade } from './backend/format-upgrade.ts'
import { createBootstrapHeaderBackend, bootstrapArtifacts } from './backend/bootstrap-header.ts'
import { bootstrapNamespace } from './backend/bootstrap-capture.ts'
import { ordinaryStageIO } from './backend/bootstrap-stage.ts'
import { createBootstrapCaptureIO } from './backend/bootstrap-capture-io.ts'
import { resolveSelectedBirth, snapshotSelectedMetadataUpdate } from './backend/selected-birth.ts'
import { createSelectedFactJournalBackend } from './backend/selected-fact-journal.ts'
import { createJsonlProcessReadCapability } from './backend/process-read.ts'
import { assembleSessionCoordinatorWithProcessStorage, type TaskTransitionBackendSession, type TaskTransitionConfiguration } from '@i-harness/session-persistence/internal/process-read-assembly'
import { routeInvocation, type CoordinatorOptions, type SessionCoordinator, type BootstrapRoute, type BootstrapReadState } from '@i-harness/session-persistence'
import { createTaskDocumentObservation } from './backend/task-document-observation.ts'
import { writeLegacyDocument } from './backend/document-write.ts'
import type { HeldTaskDocumentScope, TaskDocumentBackendSession, HeldFactOwner } from '@i-harness/session-persistence'

// Only the original constructor below can associate a backend. Byte adapters
// and callers with structurally identical objects cannot mint this identity.
const processReadOwners = new WeakMap<object, { capability: ReturnType<typeof createJsonlProcessReadCapability>; assertOriginal(): void; openTask(scope: HeldTaskDocumentScope): TaskDocumentBackendSession; openTransitionTask(scope: HeldTaskDocumentScope): TaskTransitionBackendSession; stageCreateHeader(scope: HeldTaskDocumentScope, meta: SessionMeta, proof: Awaited<ReturnType<ReturnType<typeof createJsonlProcessReadCapability>['observeFreshTaskParent']>>): ReturnType<typeof stageOwnedSessionFile>; stageUpgradeHeader(scope: HeldTaskDocumentScope, proof: Awaited<ReturnType<ReturnType<ReturnType<typeof createJsonlProcessReadCapability>['openTaskHistory']>['observe']>>, held: HeldFactOwner): ReturnType<typeof stageOwnedUpgrade>; trackHeaderOwner(id: string, owner: HeldFactOwner): void; settleTrackedHeaderIO(id: string, owner: HeldFactOwner): Promise<void>; readTrackedState(route: BootstrapRoute, owner: HeldFactOwner): Promise<BootstrapReadState>; hasTrackedHeaderDebt(id: string, owner: HeldFactOwner): boolean; trackedStageIO(id: string, owner: HeldFactOwner): import('./backend/bootstrap-stage.ts').StageLookupIO; resolveTrackedBirth(id: string, owner: HeldFactOwner): ReturnType<ReturnType<typeof createBootstrapHeaderBackend>['resolveTrackedBirth']> }>()
export function lookupJsonlProcessRead(backend: object) {
  const owner = processReadOwners.get(backend)
  if (!owner) return undefined
  try { owner.assertOriginal(); return owner.capability } catch { return undefined }
}
export function createJsonlSessionCoordinator(root: string, options?: CoordinatorOptions): SessionCoordinator {
  const backend = createJsonlBackend(root)
  const owner = processReadOwners.get(backend)!
  return assembleSessionCoordinatorWithProcessStorage(backend, options, {
    capture(id, keys) { owner.assertOriginal(); return owner.capability.capture(id, keys) },
    captureManagedAuxiliary(id, keys) { owner.assertOriginal(); return owner.capability.captureManagedAuxiliary(id, keys) },
  })
}
export function composeJsonlTaskDocumentCoordinator(backend: PersistenceBackend, options: CoordinatorOptions | undefined, validator: { validate(value: unknown): void }): SessionCoordinator {
  const owner = processReadOwners.get(backend)
  if (!owner) throw new TypeError('Original JSONL backend required')
  owner.assertOriginal()
  return assembleSessionCoordinatorWithProcessStorage(backend, options, { capture(id, keys) { owner.assertOriginal(); return owner.capability.capture(id, keys) }, captureManagedAuxiliary(id, keys) { owner.assertOriginal(); return owner.capability.captureManagedAuxiliary(id, keys) } }, { validator, open(scope) { owner.assertOriginal(); return owner.openTask(scope) } })
}
export function createJsonlTaskDocumentCoordinator(root: string, options: CoordinatorOptions | undefined, validator: { validate(value: unknown): void }): SessionCoordinator {
  return composeJsonlTaskDocumentCoordinator(createJsonlBackend(root), options, validator)
}
/** Internal candidate: full transition wiring is not production-qualified. */
export function composeJsonlTaskTransitionCoordinator(backend: PersistenceBackend, options: CoordinatorOptions | undefined, validator: TaskTransitionConfiguration['validator']): SessionCoordinator {
  const owner = processReadOwners.get(backend); if (!owner) throw new TypeError('Original JSONL backend required'); owner.assertOriginal()
  return assembleSessionCoordinatorWithProcessStorage(backend, options,
    { capture(id, keys) { owner.assertOriginal(); return owner.capability.capture(id, keys) }, captureManagedAuxiliary(id, keys) { owner.assertOriginal(); return owner.capability.captureManagedAuxiliary(id, keys) } },
    { validator, open(scope) { owner.assertOriginal(); return owner.openTask(scope) } },
    { validator, open(scope) { owner.assertOriginal(); return owner.openTransitionTask(scope) }, observeFresh(scope) { owner.assertOriginal(); return owner.capability.observeFreshTaskParent(scope) },
      observeBootstrap(scope, route, held) {
        owner.assertOriginal(); if ((route.protocol === 'public-results-v1' ? route.request.invocation : routeInvocation(route)).targetSessionId !== scope.parentSessionId) throw new Error('Invalid bootstrap task route')
        if (route.protocol === 'public-results-v1') return owner.capability.observeReservedTaskParent(scope, async () => {
          owner.assertOriginal(); scope.assertActive()
          const selected = (backend as PersistenceBackend & {selectedCapture: ReturnType<typeof createBootstrapHeaderBackend>['selectedCapture']}).selectedCapture
          try {
            const state = await selected.readSelectedCapture(scope.parentSessionId,held,route)
            scope.assertActive(); owner.assertOriginal()
            if (state.kind !== 'reserved' || canonicalJsonData(state.reservation.request) !== canonicalJsonData(route.request)) throw new Error('Selected bootstrap target unavailable')
            return canonicalJsonData(state)
          } finally { await backend.settleBootstrapCaptureIO!(scope.parentSessionId,held) }
        })
        return owner.capability.observeReservedTaskParent(scope, async () => {
          owner.assertOriginal(); scope.assertActive(); const state = await owner.readTrackedState(route,held); scope.assertActive(); owner.assertOriginal()
          if (state.kind === 'unavailable' || state.foreign || state.meta || state.rawHeader || state.publicationPresent || state.promotionPresent || state.stagePresent && !state.stageBytes && !state.captureReservation) throw new Error('Bootstrap target unavailable')
          return canonicalJsonData({ kind: state.kind, stagePresent: !!state.stagePresent, stage: state.stageBytes ? Buffer.from(state.stageBytes).toString('base64') : null, reservation: state.captureReservation ?? null })
        })
      }, openHistory(scope, held) {
        owner.assertOriginal()
        return owner.capability.openTaskHistory(scope, async () => { owner.assertOriginal(); const birth = await owner.resolveTrackedBirth(scope.parentSessionId,held); scope.assertActive(); owner.assertOriginal(); return birth?.digest })
      },
      openBootstrapHistory(scope, route, held) {
        owner.assertOriginal(); if ((route.protocol === 'public-results-v1' ? route.request.invocation : routeInvocation(route)).targetSessionId !== scope.parentSessionId) throw new Error('Invalid bootstrap task route')
        let originalStage: string | undefined
        return owner.capability.openTaskHistory(scope, async () => {
          owner.assertOriginal(); const birth = await owner.resolveTrackedBirth(scope.parentSessionId,held); scope.assertActive(); owner.assertOriginal()
          if (!birth || canonicalJsonData(birth.route) !== canonicalJsonData(route)) throw new Error('Bootstrap history unavailable')
          const stage = canonicalJsonData(birth.stage); if (originalStage !== undefined && originalStage !== stage) throw new Error('Bootstrap stage changed'); originalStage ??= stage
          return birth.digest
        })
      },
      openHistoryHeader(scope, held, proof) {
        owner.assertOriginal(); owner.capability.originalHistory(proof,scope); scope.assertActive()
        let decided = false, operation: import('@i-harness/session-persistence').BootstrapHeaderOperation | undefined, captured = false, selectedRoute: import('@i-harness/session-persistence').SelectedResultsRoute | undefined
        let result: import('@i-harness/session-persistence').HeaderOutcome | {kind:'not-required'} | undefined, flight: Promise<import('@i-harness/session-persistence').HeaderOutcome | {kind:'not-required'}> | undefined, settling: Promise<void> | undefined
        const session = Object.freeze({
          confirm() {
            if (this !== session) return Promise.reject(new TypeError('Invalid history header receiver'))
            if (result?.kind === 'committed' || result?.kind === 'not-required' || result?.kind === 'conflict') return Promise.resolve(result)
            if (flight) return flight
            flight = Promise.resolve().then(async () => {
              owner.assertOriginal(); scope.assertActive()
              if (!decided) {
                const birth = await owner.resolveTrackedBirth(scope.parentSessionId,held); scope.assertActive(); await proof.assertCurrent(); scope.assertActive(); decided = true
                if (!birth) return result = {kind:'not-required' as const}
                operation = { invocation:birth.stage.invocation, target:birth.stage.originalTarget, stageBytes:birth.stageBytes, headerBytes:Buffer.from(birth.stage.headerBytes) }
                captured = !!birth.stage.captureReservation
                if (birth.route.protocol === 'public-results-v1') selectedRoute = birth.route
              }
              try { result = selectedRoute ? await (backend as PersistenceBackend & {selectedCapture: ReturnType<typeof createBootstrapHeaderBackend>['selectedCapture']}).selectedCapture.confirmSelectedBirthHeader(scope.parentSessionId,held,selectedRoute,operation!,proof.initial.formatVersion) : await backend.reconcileBootstrapHeader!(scope.parentSessionId,held,operation!); return result }
              catch { return result = {kind:'unknown' as const} }
            })
            void flight.then(() => { flight = undefined }, () => { flight = undefined }); return flight
          },
          settle() {
            if (this !== session) return Promise.reject(new TypeError('Invalid history header receiver'))
            if (settling) return settling
            settling = Promise.resolve().then(async () => { await flight?.catch(() => {}); await owner.settleTrackedHeaderIO(scope.parentSessionId,held); if (captured) await backend.settleBootstrapCaptureIO!(scope.parentSessionId,held) })
            void settling.then(() => { settling = undefined }, () => { settling = undefined }); return settling
          },
        })
        return session
      }, trackHeader(id, held) { owner.assertOriginal(); owner.trackHeaderOwner(id, held) }, settleHeader(id, held) { owner.assertOriginal(); return owner.settleTrackedHeaderIO(id, held) }, hasHeaderDebt(id, held) { owner.assertOriginal(); return owner.hasTrackedHeaderDebt(id, held) }, readBootstrapState(route, held) { owner.assertOriginal(); return owner.readTrackedState(route, held) }, stageUpgrade(scope, proof, held) { owner.assertOriginal(); return owner.stageUpgradeHeader(scope, proof, held) }, stageHeader(scope, meta, proof) { owner.assertOriginal(); return owner.stageCreateHeader(scope, meta, proof) } })
}
export function createJsonlTaskTransitionCoordinator(root: string, options: CoordinatorOptions | undefined, validator: TaskTransitionConfiguration['validator']): SessionCoordinator {
  return composeJsonlTaskTransitionCoordinator(createJsonlBackend(root), options, validator)
}
// C5 blank-probe cap (DSH coldBlankProbeMaxBytes parity, DSH default 1024): a
// session artifact at or under this size is read in full for the EXACT blank
// answer (no turn/start yet); a larger one is served non-blank without a read
// (honest-bounding: it may have content — never guessed blank).
const BLANK_PROBE_MAX_BYTES = 1024

export function createJsonlBackend(root: string, options?: {
  /** Test/instrumentation seam: wrap the owned-batch writer BEFORE the
   * canonical-path guard captures its descriptor. Patching the backend after
   * this call is rejected as PROCESS_READ_UNAVAILABLE by design. */
  wrapOwnedBatch?: (append: NonNullable<PersistenceBackend['appendOwnedBatch']>) => NonNullable<PersistenceBackend['appendOwnedBatch']>
  /** S-08/D-12: same pre-bind seam for the reconcile path. Tests need to inject
   * unknown/conflict outcomes without patching the guarded backend afterwards. */
  wrapOwnedReconcile?: (reconcile: NonNullable<PersistenceBackend['reconcileOwnedBatch']>) => NonNullable<PersistenceBackend['reconcileOwnedBatch']>
}): PersistenceBackend & { selectedJournal: ReturnType<typeof createSelectedFactJournalBackend>;selectedCapture:ReturnType<typeof createBootstrapHeaderBackend>['selectedCapture'] } {
  const nativePrewrite = createOriginalNativePrewriteOwner()
  const pathResolution = createOriginalJsonlPathResolution(root)
  const rootPath = pathResolution.rootPath
  const artifactPath = pathResolution.artifactPath
  const captureIO = createBootstrapCaptureIO()
  const archiveReads = createArchiveReadOwner()
  // S-06: every append used to read and re-hash the whole journal. The writer
  // owns the session, so a decoded-journal cache keyed by the exact file size is
  // safe: any append (ours or another writer's) changes the size and misses.
  type CachedJournal = { size: number; journal: ReturnType<typeof readFactJournal> }
  const journalCache = new Map<string, CachedJournal>()
  const JOURNAL_CACHE_LIMIT = 4
  // Retaining a decoded journal keeps its events (and the frames' bytes slice)
  // alive; never do that for a large session, where the read cost is acceptable
  // only once per append anyway.
  const JOURNAL_CACHE_MAX_BYTES = 8 * 1024 * 1024
  function rememberJournal(id: string, size: number, journal: CachedJournal['journal']) {
    if (size > JOURNAL_CACHE_MAX_BYTES) { journalCache.delete(id); return }
    journalCache.delete(id)
    journalCache.set(id, { size, journal })
    while (journalCache.size > JOURNAL_CACHE_LIMIT) journalCache.delete(journalCache.keys().next().value!)
  }
  function forgetJournal(id: string) { journalCache.delete(id) }
  const filePath = pathResolution.session
  async function assertPublicBootstrap(sessionId: string, creating = false, observed?: {header:SessionMeta;birth:Buffer}, stageIO?:import('./backend/bootstrap-stage.ts').StageLookupIO) {
    const path = filePath(sessionId)
    const namespace=await bootstrapNamespace(path).catch((error:NodeJS.ErrnoException)=>{if(error.code==='ENOENT')return [];throw error})
    if (!namespace.length) {
      if(creating)return
      // A retained semantic header does not become an ordinary replacement
      // merely because its sole birth stage is missing.
      const header=observed?.header ?? await archiveReads.run(path,async(handle,extent)=>(await readSessionArchive(handle,extent,true)).header,true)
      if(!header.semanticSeed)return
    }
    const prefix=basename(path)+'.bootstrap-'
    if(namespace.some(name=>!(/^[a-f0-9]{64}\.(stage|publish|promote)$/.test(name.slice(prefix.length)))))throw Object.assign(new Error('Unknown bootstrap artifact requires its original owner'),{code:'SESSION_BOOTSTRAP_INCOMPLETE'})
    if (creating) throw Object.assign(new Error('Bootstrap reservation requires its original owner'), { code: 'SESSION_BOOTSTRAP_INCOMPLETE' })
    const raw = observed?.birth ?? await archiveReads.run(path,async (handle,extent)=>(await readSessionArchive(handle,extent,true)).birth,true)
    const end = raw.indexOf(10), meta = parseHeader(raw.subarray(0, end).toString('utf8'))
    if (!meta.semanticSeed) throw Object.assign(new Error('Bootstrap reservation requires its original owner'), { code: 'SESSION_BOOTSTRAP_INCOMPLETE' })
    // Only the immutable bootstrap prefix is needed. Do not parse a live suffix
    // (including its torn tail) merely to update ordinary title/model metadata.
    let boundary = end
    const frames = meta.semanticSeed.seedLength ? 2 : 1
    for (let index = 0; index < frames; index++) { boundary = raw.indexOf(10, boundary + 1); if (boundary < 0) throw Object.assign(new Error('bootstrap-incomplete'), { code: 'SESSION_BOOTSTRAP_INCOMPLETE' }) }
    const birth=raw.subarray(0,boundary+1),decoded=readFactJournal(birth.subarray(end+1),meta.journal!,meta.formatVersion,meta)
    await preserveBootstrapBirth(path,birth,meta,decoded.events,stageIO)
  }
  const docPath = pathResolution.document
  const tombPath = (kind: string, id: string) => artifactPath(`desktop-deleted-${kind}-${createHash("sha256").update(id).digest("hex")}`, ".tombstone")
  async function assertNotDeleted(kind: string, id: string) {
    if (kind === "document") {
      const digest = /^(?:desktop-navigation-|desktop-session-project-|approval-history-|desktop-goal-|desktop-input-tokens-)([a-f0-9]{64})$/.exec(id)?.[1]
      if (digest) {
        try { await stat(artifactPath(`desktop-deleted-session-${digest}`, ".tombstone")); throw Object.assign(new Error("Session document is permanently deleted"), { code: 'SESSION_DELETED' }) }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error }
      } else {
        const owner = id.startsWith("session-title/") ? id.slice("session-title/".length) : id.startsWith("task-") ? id.slice("task-".length) : id
        await assertNotDeleted("session", owner)
      }
    }
    try { await stat(tombPath(kind, id)) } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error }
    throw Object.assign(new Error("Session or document is permanently deleted"), { code: 'SESSION_DELETED' })
  }
  async function confined(path: string) {
    const file = await lstat(path).catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return undefined; throw error })
    if (file?.isSymbolicLink()) throw new Error("Owned artifact is a symlink")
    for (let parent = dirname(path);;) {
      const row = await lstat(parent).catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return undefined; throw error })
      if (row?.isSymbolicLink()) throw new Error("Owned artifact parent is a symlink")
      if (parent === rootPath) break
      const next = dirname(parent)
      if (next === parent) throw new Error("Owned artifact is outside the store")
      parent = next
    }
  }
  async function deletionReceipt(sessionId: string) {
    if (!sessionId || /[\\/]/.test(sessionId) || sessionId.includes("..")) throw new Error("Invalid owned session identity")
    const path = tombPath("session", sessionId)
    await confined(path)
    const info = await lstat(path).catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return undefined; throw error })
    if (!info) return undefined
    if (!info.isFile() || info.size > 64 * 1024 * 1024) throw new Error("Invalid deletion receipt")
    const value = JSON.parse(await readFile(path, "utf8")) as { version?: unknown; sessionId?: unknown; visibility?: { origin?: string; parentSession?: string }; documents?: string[]; files?: string[] }
    // Older tombstones fence writes but lack the original visibility proof.
    if (value.version === 1) return undefined
    if (value.version !== 2 || value.sessionId !== sessionId || !value.visibility || typeof value.visibility !== "object" || Array.isArray(value.visibility)
      || Object.keys(value.visibility).some(key => !["origin", "parentSession"].includes(key))
      || Object.values(value.visibility).some(field => typeof field !== "string")
      || !Array.isArray(value.documents) || value.documents.some(key => typeof key !== "string") || !Array.isArray(value.files) || value.files.some(key => typeof key !== "string")) throw new Error("Invalid deletion receipt")
    return { visibility: value.visibility, manifest: { documents: value.documents, files: value.files } }
  }

  function initialHeader(meta: SessionMeta): string {
    const journal = { version: 1 as const, legacyBodyBytes: 0, legacyEventCount: 0, legacyPrefixDigest: legacyPrefixDigest(0, new Uint8Array()), separatorBytes: 0 as const }
    return serializeHeader({ ...meta, journal }) + '\n'
  }
  const { trackHeaderOwner, settleTrackedHeaderIO, readTrackedState, hasTrackedHeaderDebt, trackedStageIO, resolveTrackedBirth, ...bootstrapBackend } = createBootstrapHeaderBackend(filePath, assertNotDeleted, rootPath, captureIO)
  const factJournal = createFactJournalBackend(filePath, assertNotDeleted, Object.freeze({ filePath, assertNotDeleted, enter: (id, owner, batch) => nativePrewrite.enter(id, owner, batch) }))
  const wrappedAppend = options?.wrapOwnedBatch !== undefined && factJournal.appendOwnedBatch !== undefined
    ? options.wrapOwnedBatch(factJournal.appendOwnedBatch) : undefined
  const wrappedReconcile = options?.wrapOwnedReconcile !== undefined && factJournal.reconcileOwnedBatch !== undefined
    ? options.wrapOwnedReconcile(factJournal.reconcileOwnedBatch) : undefined
  const backend: PersistenceBackend & { selectedJournal: ReturnType<typeof createSelectedFactJournalBackend>; selectedCapture: ReturnType<typeof createBootstrapHeaderBackend>['selectedCapture'] } = {
    ...factJournal,
    ...(wrappedAppend !== undefined ? { appendOwnedBatch: wrappedAppend } : {}),
    ...(wrappedReconcile !== undefined ? { reconcileOwnedBatch: wrappedReconcile } : {}),
    ...bootstrapBackend,
    // Original private selected lane shares capture IO with bootstrap.
    selectedJournal: createSelectedFactJournalBackend(filePath, assertNotDeleted, captureIO),
    id: "jsonl",
    capabilities: { seekableRead: false, rawArtifacts: true },
    // M23: the coordinator's ownership lease defaults to the store root.
    lockRoot: root,
    storageRoot: rootPath,
    deletionReceipt,

    async create(sessionId: string, meta: SessionMeta): Promise<void> {
      validateSubagentHeader(meta)
      if (meta.semanticSeed?.version === 3) throw new TypeError('Legacy create cannot install selected results')
      await assertNotDeleted("session", sessionId)
      await assertPublicBootstrap(sessionId, true)
      if (meta.formatVersion !== CURRENT_FORMAT_VERSION) throw new Error("new session writers require current format; downgrade refused")
      await mkdir(rootPath, { recursive: true })
      // wx: fail if the session file already exists.
      await createSessionFile(filePath(sessionId), initialHeader(meta))
    },

    async append(sessionId: string, events: SessionEvent[]): Promise<void> {
      await assertNotDeleted("session", sessionId)
      await assertPublicBootstrap(sessionId)
      const path = filePath(sessionId)
      const header = await readHeader(path)
      if (header.formatVersion > CURRENT_FORMAT_VERSION) throw new Error('Future session format; upgrade the harness')
      for (const event of events) validateConversationEventShape(event, header.formatVersion)
      if (events.some(event => isContextEventType(event.type) && (header.formatVersion < 2 || !validContextEvent(event)))) throw new Error("operational context append requires format 2 and valid facts")
      const handle = await open(path, "r+")
      let committedBytes = 0
      try {
        committedBytes = (await handle.stat()).size
        const lastByte = Buffer.alloc(1)
        if (committedBytes > 0) await handle.read(lastByte, 0, 1, committedBytes - 1)
        const separator = events.length > 0 && committedBytes > 0 && lastByte[0] !== 0x0a ? "\n" : ""
        let cachedJournal: CachedJournal['journal'] | undefined
        let addressed: SessionEvent[] = []
        let encoded: ReturnType<typeof encodeFactBatch> | undefined
        const data = [6, 7, 8, 9, 10, 11, 12, 13, 14].includes(header.formatVersion)
          ? (() => {
            const cached = journalCache.get(sessionId)
            const reused = cached !== undefined && cached.size === committedBytes
            const raw = reused ? Promise.resolve(undefined) : readFile(path)
            return raw.then(bytes => {
              const journal = bytes === undefined ? cached!.journal : readFactJournal(bytes.subarray(bytes.indexOf(0x0a) + 1), header.journal!, header.formatVersion, header)
              if (journal.torn) throw Object.assign(new Error('Journal recovery required'), { code: 'JOURNAL_RECOVERY_REQUIRED', notIssued: true })
              cachedJournal = journal
              addressed = events.map((event, position) => event.seq === undefined ? { ...event, seq: journal.prefix.eventCount + position } : event)
              validateDeliveryFrame(addressed,header.formatVersion)
              if(addressed.some(event=>event.type.startsWith('agent/delivery-') || event.type==='agent/input/admitted' && event.provenance?.producer==='session.delivery.subagent'))validateConversationHistory([...journal.events,...addressed],header.formatVersion,header)
              // S-06 step 2: a cache hit means this exact prefix was already
              // validated; only the appended events need semantic validation.
              if (reused) validateSemanticBootstrapAppend(journal.prefix.eventCount, addressed, header.formatVersion, header)
              else validateSemanticBootstrapHistory([...journal.events, ...addressed], header.formatVersion, header)
              encoded = addressed.length ? encodeFactBatch(randomUUID(), journal.prefix.prefixDigest, addressed) : undefined
              return encoded?.bytes ?? new Uint8Array()
            })
          })()
          : Promise.resolve(Buffer.from(separator + events.map((e) => JSON.stringify(e)).join("\n") + "\n"))
        const bytes = await data
        let offset = 0
        while (offset < bytes.length) {
          const { bytesWritten } = await handle.write(bytes, offset, bytes.length - offset, committedBytes + offset)
          if (bytesWritten <= 0) throw new Error('Session write made no progress')
          offset += bytesWritten
        }
        await handle.sync()
        if (cachedJournal && bytes.length > 0) {
          const prefixDigest = encoded ? decodeFactBatch(encoded.bytes).prefixDigest : cachedJournal.prefix.prefixDigest
          rememberJournal(sessionId, committedBytes + bytes.length, {
            ...cachedJournal,
            events: [...cachedJournal.events, ...addressed],
            prefix: { eventCount: cachedJournal.prefix.eventCount + addressed.length, bodyBytes: cachedJournal.prefix.bodyBytes + bytes.length, prefixDigest },
          })
        }
      } catch (err) {
        // F01-2 rollback: truncate back to the committed byte length so a
        // clean retry never duplicates seqs. Only truncate when the file still
        // extends past that point: node's truncate() EXTENDS a shorter file
        // with zeros, so a concurrent shrink must not turn a failed append into
        // a padded journal.
        const sizeNow = await handle.stat().then((stat) => stat.size).catch(() => undefined)
        if (sizeNow !== undefined && sizeNow > committedBytes) await handle.truncate(committedBytes).catch(() => {})
        await handle.sync().catch(() => {})
        throw err
      } finally {
        await handle.close()
      }
    },

    async read(sessionId: string): Promise<{ version: number; events: SessionEvent[]; meta?: SessionMeta }> {
      await assertNotDeleted("session", sessionId)
      return archiveReads.run(filePath(sessionId),async(handle,extent)=>{
        const candidate=await readSessionArchive(handle,extent,false,prefix => assertPublicBootstrap(sessionId,false,prefix))
        await assertNotDeleted("session",sessionId)
        return {version:candidate.header.formatVersion,events:candidate.events,meta:candidate.header}
      },false,sessionId,true)
    },

    async list(): Promise<string[]> {
      const names = await readdir(rootPath).catch(() => [] as string[])
      // Skip `.doc.jsonl` document sidecars — they are not sessions.
      const ids = names
        .filter((n) => n.endsWith(".jsonl") && !n.endsWith(".doc.jsonl"))
        .map((n) => basename(n, ".jsonl"))
      return (await Promise.all(ids.map(async id => {
        try {
          await assertNotDeleted("session", id)
          // S-08: a zero-byte file is a create/fork that died before its first
          // durable write; it is not a session yet, so it must not appear.
          const info = await stat(filePath(id)).catch(() => undefined)
          if (info !== undefined && info.size === 0) return undefined
          return id
        } catch (error) { if ((error as Error).message.includes("permanently deleted")) return undefined; throw error }
      }))).filter((id): id is string => id !== undefined)
    },

    async repair(sessionId: string): Promise<{ version: number; events: SessionEvent[]; meta?: SessionMeta }> {
      forgetJournal(sessionId)
      await assertPublicBootstrap(sessionId)
      await assertNotDeleted("session", sessionId)
      const path = filePath(sessionId)
      const text = await readFile(path, "utf-8")
      const lines = text.split("\n")
      const headerLine = lines[0]!
      const header = parseHeader(headerLine)
      if (header.formatVersion > CURRENT_FORMAT_VERSION) throw new Error('Future session format; upgrade the harness')
      if ([6, 7, 8, 9, 10, 11, 12, 13, 14].includes(header.formatVersion)) {
        const decoded = readFactJournal(Buffer.from(lines.slice(1).join('\n')), header.journal!, header.formatVersion, header)
        const closers = missingClosers(decoded.events).map((event, position) => ({ ...event, seq: decoded.events.length + position }))
        if (decoded.torn || closers.length) {
          const raw = Buffer.from(lines.slice(1).join('\n')).subarray(0, decoded.prefix.bodyBytes)
          const addition = closers.length ? encodeFactBatch(randomUUID(), decoded.prefix.prefixDigest, closers).bytes : new Uint8Array()
          await replaceRawSessionFile(path, Buffer.concat([Buffer.from(headerLine + '\n'), raw, Buffer.from(addition)]))
        }
        return { version: header.formatVersion, events: [...decoded.events, ...closers], meta: header }
      }
      const events = parseEventLines(lines.slice(1))
      if (events.some(event => event.type === 'compaction/replacement')) validateConversationHistory(events, header.formatVersion, header)
      const torn = hasTornTail(lines.slice(1))
      const closers = missingClosers(events)
      if (events.some(event => event.type === "conversation/semantics")) {
        for (const [index, event] of closers.entries()) event.seq = events.length + index
        if (torn || closers.length) {
          let committed = lines[0]! + "\n"
          for (const line of lines.slice(1)) {
            if (line.trim()) { try { JSON.parse(line) } catch { break } }
            committed += line + "\n"
          }
          // Preserve every existing committed line, including whitespace. Only
          // the torn suffix is removed; repair facts get new coordinates.
          await replaceRawSessionFile(path, committed + closers.map(event => JSON.stringify(event) + "\n").join(""))
        }
        return { version: header.formatVersion, events: [...events, ...closers], meta: header }
      }
      if (torn || closers.length > 0) {
        await replaceSessionFile(path, headerLine, [...events, ...closers])
      }
      return { version: header.formatVersion, events: [...events, ...closers], meta: header }
    },

    async replaceEvents(sessionId, events) {
      forgetJournal(sessionId)
      await assertNotDeleted("session", sessionId)
      await assertPublicBootstrap(sessionId)
      const path = filePath(sessionId)
      const raw = await readFile(path), text = raw.toString('utf8')
      const headerLine = text.split("\n")[0]!
      const header = parseHeader(headerLine)
      if (header.formatVersion > CURRENT_FORMAT_VERSION) throw new Error('Future session format; upgrade the harness')
      if (events.some(event => event.type === 'compaction/replacement')) validateConversationHistory(events, header.formatVersion, header)
      validateDeliveryFrame(events,header.formatVersion)
      if(events.some(event=>event.type.startsWith('agent/delivery-')))validateConversationHistory(events,header.formatVersion,header)
      validateSemanticBootstrapHistory(events, header.formatVersion, header)
      if (header.semanticSeed) {
        validateConversationHistory(events, header.formatVersion, header)
        const birth = await preserveBootstrapBirth(path, raw, header, events)
        const suffix = events.slice(birth.eventCount)
        const frame = suffix.length ? encodeFactBatch(randomUUID(), birth.prefixDigest, suffix).bytes : new Uint8Array()
        await replaceRawSessionFile(path, Buffer.concat([raw.subarray(0, raw.indexOf(10) + 1), birth.bytes, Buffer.from(frame)]))
        return
      }
      if ([6, 7, 8, 9, 10, 11, 12, 13, 14].includes(header.formatVersion)) {
        const journal = { version: 1 as const, legacyBodyBytes: 0, legacyEventCount: 0, legacyPrefixDigest: legacyPrefixDigest(0, new Uint8Array()), separatorBytes: 0 as const }
        const frame = events.length ? encodeFactBatch(randomUUID(), journal.legacyPrefixDigest, events).bytes : new Uint8Array()
        await replaceRawSessionFile(path, Buffer.concat([Buffer.from(serializeHeader({ ...header, journal }) + '\n'), Buffer.from(frame)]))
        return
      }
      await replaceSessionFile(path, headerLine, events)
    },

    async upgradeSessionFormat(sessionId, expected, target) {
      forgetJournal(sessionId)
      await assertNotDeleted("session", sessionId)
      await assertPublicBootstrap(sessionId)
      if (target !== CURRENT_FORMAT_VERSION || ![1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, target].includes(expected)) throw new Error("unexpected session format upgrade or downgrade")
      const path = filePath(sessionId)
      return upgradeFactJournal(path, expected)
    },

    async profile(sessionId) {
      await assertNotDeleted("session", sessionId)
      const path = filePath(sessionId)
      const updatedAt = (await stat(path)).mtimeMs
      // Blank probe (coldBlankProbeMaxBytes policy): a small artifact is read
      // whole for the exact answer; a big one is served non-blank.
      if ((await stat(path)).size <= BLANK_PROBE_MAX_BYTES) {
        const lines = (await readFile(path, "utf-8")).split("\n")
        return {
          meta: parseHeader(lines[0]!),
          blank: ([6, 7, 8, 9, 10, 11, 12, 13, 14].includes(parseHeader(lines[0]!).formatVersion)
            ? readFactJournal(Buffer.from(lines.slice(1).join('\n')), parseHeader(lines[0]!).journal!, parseHeader(lines[0]!).formatVersion, parseHeader(lines[0]!)).events
            : parseEventLines(lines.slice(1))).every((ev) => ev.type !== "turn/start"), updatedAt,
        }
      }
      return { meta: await readHeader(path), blank: false, updatedAt }
    },

    async updateMeta(sessionId, patch) {
      await assertNotDeleted("session", sessionId)
      await assertPublicBootstrap(sessionId)
      const path = filePath(sessionId)
      // Header rewrite: replace line 0 only; event lines are kept byte-exact
      // (a torn tail is preserved as-is, repair's business). Atomic temp +
      // rename (putDocument pattern) — a concurrent reader sees either the
      // old or the new file, never a truncated one.
      const raw = await readFile(path), end=raw.indexOf(10)
      if(end<0||end+1>HEADER_READ_MAX_BYTES||!raw.subarray(0,end).toString('utf8').trim())throw new Error(`empty session file: ${sessionId}`)
      const previous=parseHeader(raw.subarray(0,end).toString('utf8'))
      const birth=previous.semanticSeed?.version===3 ? await resolveSelectedBirth(path,sessionId,assertNotDeleted,{stage:ordinaryStageIO(path),readJournal:()=>readFile(path)}) : undefined
      // Bind the rewrite to the same observed bytes, including the real resolver reread.
      if(birth&&!(await readFile(path)).equals(raw))throw TypeError('Selected journal changed during metadata update')
      const snapshot=birth ? snapshotSelectedMetadataUpdate(birth,patch) : snapshotMetadataUpdate(previous,patch)
      // Never write a header that the 64 KiB reader could not read back.
      assertHeaderLineReadable(snapshot.line)
      // A title/archive change must not be able to lose the transcript: reuse
      // the fsync+rename replacement rather than a bare writeFile+rename.
      await replaceRawSessionFile(path, Buffer.concat([Buffer.from(snapshot.line+'\n'),raw.subarray(end+1)]))
      forgetJournal(sessionId)
      return snapshot.meta
    },

    async putDocument(key: string, data: unknown): Promise<void> {
      await assertNotDeleted("document", key)
      await mkdir(rootPath, { recursive: true })
      const path = docPath(key)
      // Namespaced keys ("session-title/<id>") live in a subdirectory of the
      // store root — create it so nested doc keys work (top-level listings
      // stay clean: the subdir never matches `*.jsonl`).
      await mkdir(dirname(path), { recursive: true })
      // Atomic write: temp file + rename so concurrent saves never
      // interleave/truncate the sidecar. A transient `<uuid>.tmp` matches
      // neither `*.jsonl` nor `*.doc.jsonl`, so list() stays correct.
      await writeLegacyDocument(path, data)
    },
    async getDocument(key: string): Promise<unknown | undefined> {
      let text: string
      try { text = await readFile(docPath(key), "utf-8") }
      catch (error) {
        // Only a missing document is absent; a permission/IO failure must not be
        // reported as "no document" (the caller would silently lose durable state).
        if ((error as NodeJS.ErrnoException | null)?.code === "ENOENT") return undefined
        throw error
      }
      return JSON.parse(text) as unknown
    },
    async readDocumentObserved(key) {
      // An absent child under an unavailable root is not an absent binding.
      const available = async () => {
        const directory = await stat(rootPath)
        if (!directory.isDirectory()) throw new Error('Document storage root is unavailable')
        await readdir(rootPath)
        await assertNotDeleted('document', key)
      }
      await available()
      let text: string | undefined
      try { text = await readFile(docPath(key), 'utf8') }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
      await available()
      return text === undefined ? { kind: 'absent' } : { kind: 'present', value: JSON.parse(text) as unknown }
    },
    async deleteOwnedSession(sessionId, manifest) {
      forgetJournal(sessionId)
      if (!sessionId || /[\\/]/.test(sessionId) || sessionId.includes("..")) throw new Error("Invalid owned session identity")
      if (!Array.isArray(manifest.documents) || manifest.documents.length > 32 || new Set(manifest.documents).size !== manifest.documents.length) throw new Error("Invalid owned document manifest")
      const digest = createHash("sha256").update(sessionId).digest("hex")
      const owned = new Set([sessionId, `task-${sessionId}`, `session-title/${sessionId}`, `desktop-navigation-${digest}`, `desktop-session-project-${digest}`, `approval-history-${digest}`, `desktop-goal-${digest}`, `desktop-input-tokens-${digest}`])
      if (manifest.documents.some(key => !owned.has(key))) throw new Error("Document manifest includes an artifact not owned by this session")
      const marker = tombPath("session", sessionId)
      await confined(marker)
      const prior = await readFile(marker, "utf8").catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return undefined; throw error })
      const receipt = prior === undefined ? undefined : await deletionReceipt(sessionId)
      const stagePrefix = sessionId + '.jsonl.bootstrap-'
      const isStage = (file: string) => file.startsWith(stagePrefix) && /^[a-f0-9]{64}\.(stage|publish|promote)$/.test(file.slice(stagePrefix.length))
      const declared = [...(manifest.files ?? [])]
      if (new Set(declared).size !== declared.length) throw new Error("Owned file manifest contains duplicate identities")
      const files = [...new Set([...declared, ...await bootstrapArtifacts(filePath(sessionId)), ...(receipt?.manifest.files ?? []).filter(isStage)])].sort()
      if (new Set(files).size !== files.length) throw new Error("Owned file manifest contains duplicate identities")
      if (files.length > 100000 || files.some(file => !isStage(file) && !new RegExp(`^rewind/${sessionId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/(?:points\\.jsonl|meta\\.json|pending\\.json|orphaned\\.jsonl|blobs/[a-f0-9]{64})$`).test(file))) throw new Error("Invalid owned file manifest")
      const paths = [filePath(sessionId), ...manifest.documents.map(docPath), ...files.map(file => artifactPath(file, ""))]
      for (const path of paths) await confined(path)
      const header = prior === undefined ? await readHeader(filePath(sessionId)) : undefined
      if (header && header.sessionId !== sessionId) throw new Error("Owned session identity does not match artifact")
      const visibility = header ? { ...(header.origin !== undefined ? { origin: header.origin } : {}), ...(header.parentSession !== undefined ? { parentSession: header.parentSession } : {}) } : receipt?.visibility
      const document = JSON.stringify({ version: visibility ? 2 : 1, sessionId, ...(visibility ? { visibility } : {}), documents: [...manifest.documents].sort(), files })
      if (prior !== undefined && prior.trimEnd() !== document) throw new Error("Deletion artifact manifest changed")
      // A durable closure survives partial cleanup and prevents create/append/repair.
      if (prior === undefined) {
        await replaceSessionFile(marker, document, [])
      }
      for (const key of manifest.documents) {
        const path = tombPath("document", key)
        await confined(path)
        const handle = await open(path, "w")
        try { await handle.writeFile(sessionId); await handle.sync() } finally { await handle.close() }
      }
      for (const path of paths) await unlink(path).catch((error: NodeJS.ErrnoException) => { if (error.code !== "ENOENT") throw error })
    },
  }
  const artifactOwner = pathResolution.bindBackend(backend, {
    async prepareRoot() { assertOriginal(); await mkdir(rootPath, {recursive:true}); assertOriginal() },
    async prepareDocumentParents(key: string) {
      assertOriginal(); await assertNotDeleted('document', key); assertOriginal()
      await mkdir(rootPath, { recursive: true }); assertOriginal()
      await mkdir(dirname(docPath(key)), { recursive: true }); assertOriginal()
    },
  })
  const assertOriginal = artifactOwner.assertOriginal
  const teamRoutes=bootstrapBackend.bootstrapRoutes!,teamDiscover=teamRoutes.discoverTeamChild!,teamSettle=teamRoutes.settleTeamDiscovery!,teamCurrent=()=>{assertOriginal();for(const [name,original] of [['discoverTeamChild',teamDiscover],['settleTeamDiscovery',teamSettle]] as const){const field=Object.getOwnPropertyDescriptor(teamRoutes,name);if(!field||!('value'in field)||field.value!==original)throw TypeError('Original Team target backend changed')}}
  associateOriginalTeamTargetBackend(backend,Object.freeze({async discover(id,owner){teamCurrent();const result=await teamDiscover.call(teamRoutes,id,owner);teamCurrent();return result},async settle(id,owner){teamCurrent();await teamSettle.call(teamRoutes,id,owner);teamCurrent()}}))
  associateOriginalTeamBindingBackend(backend,Object.freeze({open(scope){
    assertOriginal();async function available(){for(const path of [tombPath('session',scope.parentSessionId),tombPath('document',scope.key)]){try{await lstat(path);throw Object.assign(Error('Team binding deleted'),{code:'SESSION_DELETED'})}catch(error){if((error as NodeJS.ErrnoException|null|undefined)?.code!=='ENOENT')throw error}}}
    const original=createTaskDocumentObservation(rootPath,docPath(scope.key),scope,undefined,available,createOriginalTaskNativeStage(scope,available,assertOriginal))
    const session=Object.freeze({async observe(){if(this!==session)throw TypeError('Original Team binding receiver required');assertOriginal();await available();const result=await original.observe();await available();assertOriginal();return result},async confirm(witness:Parameters<typeof original.confirm>[0]){if(this!==session)throw TypeError('Original Team binding receiver required');assertOriginal();await available();const result=await original.confirm(witness);await available();assertOriginal();return result},stageInitialize(bytes:Uint8Array){if(this!==session)throw TypeError('Original Team binding receiver required');assertOriginal();return original.stageInitialize(bytes)},settleResources(){if(this!==session)return Promise.reject(TypeError('Original Team binding receiver required'));return original.settleResources()}});return session
  }}))
  associateArchiveReadResources(backend,archiveReads.association)
  nativePrewrite.associate(backend, assertOriginal)
  associateOwnedExecutionReader(backend,{assertOriginal,filePath,assertNotDeleted,archive:archiveReads,
    register(id,held){trackHeaderOwner(id,held);if(hasTrackedHeaderDebt(id,held))throw Error('Owned dependency birth cleanup unresolved')},
    qualify:(id,held,prefix)=>assertPublicBootstrap(id,false,prefix,trackedStageIO(id,held)),
    settleBirth:(id,held)=>settleTrackedHeaderIO(id,held)})
  associateArtifactPaths(backend, artifactOwner)
  const capability = Object.freeze(createJsonlProcessReadCapability({ assertOriginal, root: rootPath, file: filePath, document: docPath, checkDeleted: assertNotDeleted,
    async checkNamespace(id) { if ((await bootstrapNamespace(filePath(id))).length) throw new Error('PROCESS_READ_UNAVAILABLE') } }))
  associateArchiveHistoryPrefixReader(backend,proof=>{assertOriginal();return capability.qualifiedHistoryPrefix(proof)})
  function openOwnedTask(scope: HeldTaskDocumentScope, initialize: boolean): TaskDocumentBackendSession {
    assertOriginal(); const original = createTaskDocumentObservation(rootPath, docPath(scope.key), scope, undefined, available, createOriginalTaskNativeStage(scope, available, assertOriginal))
    async function available() {
      for (const path of [tombPath('session', scope.parentSessionId), tombPath('document', scope.key)]) {
        try { await lstat(path); throw Object.assign(new Error('Task document is deleted'), { code: 'SESSION_DELETED' }) }
        catch (error) { if ((error as NodeJS.ErrnoException | null | undefined)?.code !== 'ENOENT') throw error }
      }
    }
    const session = Object.freeze({
      async observe() { if (this !== session) throw new TypeError('Invalid task backend receiver'); assertOriginal(); await available(); const result = await original.observe(); await available(); assertOriginal(); return result },
      async confirm(witness: Parameters<typeof original.confirm>[0]) { if (this !== session) throw new TypeError('Invalid task backend receiver'); assertOriginal(); await available(); const result = await original.confirm(witness); await available(); assertOriginal(); return result },
      stageWrite(witness: Parameters<typeof original.stageWrite>[0], bytes: Uint8Array) { if (this !== session) throw new TypeError('Invalid task backend receiver'); assertOriginal(); return original.stageWrite(witness, bytes) },
      ...(initialize ? { stageInitialize(bytes: Uint8Array) { if (this !== session) throw new TypeError('Invalid task backend receiver'); assertOriginal(); return original.stageInitialize(bytes) } } : {}),
      settleResources() { if (this !== session) return Promise.reject(new TypeError('Invalid task backend receiver')); return original.settleResources() },
    })
    return session
  }
  processReadOwners.set(backend, {
    capability, assertOriginal, trackHeaderOwner, settleTrackedHeaderIO, readTrackedState, hasTrackedHeaderDebt, trackedStageIO, resolveTrackedBirth,
    openTask(scope) { return openOwnedTask(scope, false) },
    openTransitionTask(scope) { return openOwnedTask(scope, true) as TaskTransitionBackendSession },
    stageUpgradeHeader(scope, proof, held) {
      assertOriginal(); const original = capability.originalHistory(proof, scope)
      return stageOwnedUpgrade(filePath(scope.parentSessionId), original.bytes, original.identity,
        () => { assertOriginal(); capability.originalHistory(proof, scope); scope.assertActive() },
        async () => { await proof.assertRoot(); assertOriginal(); scope.assertActive() }, trackedStageIO(scope.parentSessionId,held))
    },    stageCreateHeader(scope, meta, proof) {
      assertOriginal(); capability.assertFreshOwner(proof, scope); scope.assertActive()
      if (meta.sessionId !== scope.parentSessionId || meta.formatVersion !== CURRENT_FORMAT_VERSION) throw new Error('Invalid original session header')
      const bytes = Buffer.from(initialHeader(meta))
      return stageOwnedSessionFile(filePath(scope.parentSessionId), bytes,
        () => { assertOriginal(); capability.assertFreshOwner(proof, scope); scope.assertActive() },
        async () => { await proof.assertRoot(); assertOriginal(); scope.assertActive() })
    },
  })
  return backend
}

// C5 header-only read (profile on a large artifact): the header is always
// line 0 and bounded (ids ~40 chars, titles capped at 200), so reading one
// 64 KiB window never touches the event body of a multi-megabyte log.
// The bound lives in backend/header-limit.ts and is enforced on write too.

async function readHeader(path: string): Promise<SessionMeta> {
  const handle = await open(path, "r")
  try {
    const buffer = Buffer.alloc(HEADER_READ_MAX_BYTES)
    await handle.read(buffer, 0, HEADER_READ_MAX_BYTES, 0)
    // Unread tail is zeros, so a newline found anywhere was inside the window.
    const end = buffer.indexOf(0x0a, 0) // "\n"
    const line = (end === -1 ? buffer : buffer.subarray(0, end)).toString("utf8")
    return parseHeader(line)
  } finally {
    await handle.close()
  }
}

// Track turn/step nesting; a session stopped inside either gets synthetic
// closers so deriveMessages() reconstructs normally (F01-2 commitRepair).
function missingClosers(events: SessionEvent[]): Array<Extract<SessionEvent, { type: 'step/end' | 'turn/end' }>> {
  let inTurn = false
  let inStep = false
  for (const ev of events) {
    if (ev.type === "turn/start") inTurn = true
    if (ev.type === "step/start") inStep = true
    if (ev.type === "step/end") inStep = false
    if (ev.type === "turn/end") inTurn = false
  }
  const closers: Array<Extract<SessionEvent, { type: 'step/end' | 'turn/end' }>> = []
  if (inStep) closers.push({ type: "step/end" })
  if (inTurn) closers.push({ type: "turn/end" })
  return closers
}
