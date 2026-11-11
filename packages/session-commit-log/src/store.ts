import { createHash, randomUUID } from 'node:crypto'
import type { FileHandle } from 'node:fs/promises'
import type { SessionEvent } from '@i-harness/core-session'
import { CommitFormatError } from './errors.ts'
import { COMMIT_FORMAT_VERSION, GENESIS_PREV, decodeCommit, encodeCommit, parseOps, type CommitOp, type CommitPayload, type CommitRecord } from './format.ts'
import { foldCommits, type CommitDocument, type CommitView } from './fold.ts'
import { acquireCommitLease, acquireCommitSnapshotLease, type CommitLease } from './lease.ts'
import { SessionLockConflictError } from '@i-harness/fs-lock'
import { documentCheckpoint } from './document-checkpoint.ts'
import { CommitLogCleanupError, CommitLogResources } from './resources.ts'
import { generationPath, sessionDirectory, sidecarDirectory, sidecarPath, temporaryPath } from './paths.ts'
import { isAlreadyExists, isNotFound, nodeIo, type CommitLogIo } from './io.ts'
import { scanCommitLog } from './scanner.ts'

/** The on-disk generation number this store writes. */
export const COMMIT_LOG_GENERATION = COMMIT_FORMAT_VERSION

export class CommitLogNotFoundError extends Error {
  readonly code = 'COMMIT_LOG_NOT_FOUND'
  constructor(sessionId: string) { super(`commit log for session ${JSON.stringify(sessionId)} does not exist`); this.name = 'CommitLogNotFoundError' }
}
export class CommitLogConflictError extends Error {
  readonly code = 'COMMIT_LOG_EXISTS'
  constructor(sessionId: string) { super(`commit log for session ${JSON.stringify(sessionId)} already exists`); this.name = 'CommitLogConflictError' }
}
export class CommitLogClosedError extends Error {
  readonly code = 'COMMIT_LOG_CLOSED'
  constructor() { super('commit log is closed'); this.name = 'CommitLogClosedError' }
}
export class CommitLogReadOnlyError extends Error {
  readonly code = 'COMMIT_LOG_READ_ONLY'
  constructor() { super('commit log is open for read'); this.name = 'CommitLogReadOnlyError' }
}

export type CommitLogOptions = {
  readonly root: string
  readonly sessionId: string
  readonly io?: CommitLogIo
  readonly recreateDeleted?: boolean
  /** Checkpoint the coordinator's current-value document namespace. */
  readonly compactDocuments?: boolean
  readonly now?: () => Date
  /** Writable coordination directory for writer and reader leases. Defaults to the store root. */
  readonly lockRoot?: string
  readonly lease?: { readonly retryMs?: number; readonly deadlineMs?: number }
}

export type CommitInput = {
  readonly entries?: readonly SessionEvent[]
  readonly ops?: readonly CommitOp[]
}

export type CreateInput = CommitInput & {
  readonly header: Readonly<Record<string, unknown>>
}

export type CommitLogMode = 'read' | 'write'

export type CommitLog = {
  readonly sessionId: string
  readonly mode: CommitLogMode
  /** False once closed; the writer lease is held for the handle's whole life. */
  readonly open: boolean
  header(): Readonly<Record<string, unknown>>
  metadata(): Readonly<Record<string, unknown>>
  view(): CommitView
  records(): readonly CommitRecord[]
  /** Re-read the generation file and re-fold (read handles observe later commits). */
  refresh(): Promise<void>
  append(input: CommitInput | ((current: { readonly entryCount: number; readonly lastRecord: CommitRecord }) => CommitInput)): Promise<CommitRecord>
  entryCount(): number
  entryAt(index: number): SessionEvent | undefined
  lastBatchDigest(): string | undefined
  writeSidecar(bytes: Uint8Array): Promise<CommitDocument>
  readSidecar(digest: string): Promise<Uint8Array>
  close(): Promise<void>
}

type State = {
  records: CommitRecord[]
  view: CommitView
  size: number
  handle?: FileHandle
  closed: boolean
}

type CommitLogLocation = { readonly root: string; readonly sessionId: string; readonly io: CommitLogIo }

function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

function nowIso(options: CommitLogOptions): string {
  return (options.now?.() ?? new Date()).toISOString()
}

async function syncDirectory(io: CommitLogIo, directory: string, resources: CommitLogResources): Promise<void> {
  let handle: FileHandle
  try { handle = await io.open(directory, 'r') }
  catch { return } // Directory handles are unavailable on some platforms.
  await resources.withFile(handle, async () => {
    try { await handle.sync() } catch { /* Directory sync remains diagnostic. */ }
  })
}

async function writeAll(handle: FileHandle, text: string, position: number): Promise<void> {
  const bytes = Buffer.from(text, 'utf8')
  let offset = 0
  while (offset < bytes.length) {
    const result = await handle.write(bytes, offset, bytes.length - offset, position + offset)
    if (result.bytesWritten <= 0) throw new Error('commit write made no progress')
    offset += result.bytesWritten
  }
}

/** Publish a brand-new session generation atomically: temp write + fsync, then a
 *  no-overwrite link. A crash before the link leaves only a temporary file, so the
 *  session never existed; the link itself is the single commit point. */
async function publish(io: CommitLogIo, root: string, sessionId: string, line: string, resources: CommitLogResources, expectedGeneration?: string): Promise<void> {
  const directory = sessionDirectory(root, sessionId)
  await io.mkdir(directory)
  const finalPath = generationPath(root, sessionId, COMMIT_LOG_GENERATION)
  const temporary = temporaryPath(root, sessionId, randomUUID().slice(0, 8))
  const handle = await io.open(temporary, 'wx')
  await resources.withFile(handle, async () => {
    await writeAll(handle, line, 0)
    await handle.sync()
  })
  try {
    if (expectedGeneration !== undefined) {
      const deadline = performance.now() + 500
      let delayMs = 10
      for (;;) {
        // The writer retains the original generation and completed stage.
        // Every sharing retry rechecks the same original content identity.
        const current = await readGeneration(io, finalPath)
        if (current === undefined || sha256Hex(current) !== expectedGeneration) throw new CommitLogConflictError(sessionId)
        try { await io.rename(temporary, finalPath); break }
        catch (error) {
          const remaining = deadline - performance.now()
          const code = (error as NodeJS.ErrnoException | null)?.code
          if (process.platform !== 'win32' || !['EPERM', 'EBUSY'].includes(code ?? '') || remaining <= 0) throw error
          await new Promise(resolve => setTimeout(resolve, Math.min(delayMs, remaining)))
          if (performance.now() >= deadline) throw error
          delayMs = Math.min(delayMs * 2, 80)
        }
      }
    } else await io.link(temporary, finalPath)
  } catch (error) {
    if (isAlreadyExists(error)) throw new CommitLogConflictError(sessionId)
    throw error
  } finally {
    await io.unlink(temporary).catch(() => {})
  }
  await syncDirectory(io, directory, resources)
}

async function readGeneration(io: CommitLogIo, path: string): Promise<Buffer | undefined> {
  try { return await io.readFile(path) } catch (error) { if (isNotFound(error)) return undefined; throw error }
}

function openState(records: readonly CommitRecord[], view: CommitView, size: number): State {
  return { records: [...records], view, size, closed: false }
}

export async function createCommitLog(options: CommitLogOptions, first: CreateInput): Promise<CommitLog> {
  const io = options.io ?? nodeIo
  const { root, sessionId } = options
  const location = { root, sessionId, io }, captured = structuredClone(first), recreateDeleted = options.recreateDeleted
  const resources = new CommitLogResources()
  resources.retain(await acquireCommitLease(sessionId, { lockRoot: options.lockRoot ?? root, retryMs: options.lease?.retryMs, deadlineMs: options.lease?.deadlineMs }))
  try {
    const ops = parseOps([{ kind: 'header', value: captured.header }, ...(captured.ops ?? [])])
    const payload: CommitPayload = {
      v: COMMIT_FORMAT_VERSION,
      seq: 1,
      prev: GENESIS_PREV,
      at: nowIso(options),
      entries: [...(captured.entries ?? [])],
      ops,
    }
    const line = encodeCommit(payload) + '\n'
    const record = decodeCommit(line.slice(0, -1))
    const view = foldCommits([record])
    let deletedGeneration: string | undefined
    if (recreateDeleted) {
      const existing = await readGeneration(io, generationPath(root, sessionId, COMMIT_LOG_GENERATION))
      if (existing) {
        if (!foldCommits(scanCommitLog(existing).records).deleted) throw new CommitLogConflictError(sessionId)
        deletedGeneration = sha256Hex(existing)
      }
    }
    // Atomic file replacement keeps the durable tombstone until new birth commits.
    await publish(io, root, sessionId, line, resources, deletedGeneration)
    const handle = await io.open(generationPath(root, sessionId, COMMIT_LOG_GENERATION), 'r+')
    resources.file(handle)
    const state = openState([record], view, Buffer.byteLength(line))
    state.handle = handle
    return makeLog(options, 'write', state, resources, location)
  } catch (error) {
    try { await resources.close() }
    catch (cleanup) { throw new CommitLogCleanupError([error, cleanup], resources) }
    throw error
  }
}

const SCAN_CACHE_ENABLED = process.env.IH_COMMIT_SCAN_CACHE !== '0'
const scanCache = new Map<string, { fingerprint: string; records: readonly CommitRecord[] }>()
const SCAN_CACHE_LIMIT = 64
function cacheScan(key: string, fingerprint: string, records: readonly CommitRecord[]): void {
  scanCache.delete(key)
  scanCache.set(key, { fingerprint, records })
  while (scanCache.size > SCAN_CACHE_LIMIT) scanCache.delete(scanCache.keys().next().value as string)
}

export async function openCommitLog(options: CommitLogOptions, mode: CommitLogMode): Promise<CommitLog> {
  const io = options.io ?? nodeIo
  const { root, sessionId } = options
  const location = { root, sessionId, io }, lockRoot = options.lockRoot ?? root, compactDocuments = options.compactDocuments
  const resources = new CommitLogResources()
  const path = generationPath(root, sessionId, COMMIT_LOG_GENERATION)
  let handle: FileHandle | undefined
  try {
    if (mode === 'write') resources.retain(await acquireCommitLease(sessionId, { lockRoot, retryMs: options.lease?.retryMs, deadlineMs: options.lease?.deadlineMs }))
    else {
      // An absent read stays passive. Read the actual generation only after
      // its retention lease is held, so concurrent maintenance stays ordered.
      try { handle = await io.open(path, 'r') }
      catch (error) { if (isNotFound(error)) throw new CommitLogNotFoundError(sessionId); throw error }
      await resources.release(resources.file(handle)); handle = undefined
      resources.retain(await acquireCommitSnapshotLease(sessionId, { lockRoot, retryMs: options.lease?.retryMs, deadlineMs: options.lease?.deadlineMs }, 'shared'))
    }
    let bytes = await readGeneration(io, path)
    if (!bytes) throw new CommitLogNotFoundError(sessionId)
    // Content identity also detects replacement with an equal-length generation.
    const cacheKey = root + '|' + sessionId
    const cached = mode === 'read' && SCAN_CACHE_ENABLED ? scanCache.get(cacheKey) : undefined
    const fingerprint = sha256Hex(bytes)
    let scan = cached?.fingerprint === fingerprint ? { records: cached.records, tornBytes: 0 } : scanCommitLog(bytes)
    if (scan.tornBytes === 0 && mode === 'read' && SCAN_CACHE_ENABLED && (!cached || cached.fingerprint !== fingerprint)) cacheScan(cacheKey, fingerprint, scan.records)
    if (scan.records.length === 0) throw new CommitFormatError('corrupt', 'commit log has no complete commit')
    let view = foldCommits(scan.records)
    if (mode === 'write') {
      let maintenance: CommitLease | undefined
      try { maintenance = resources.retain(await acquireCommitSnapshotLease(sessionId, { lockRoot, deadlineMs: 0 }, 'exclusive')) }
      catch (error) { if (!(error instanceof SessionLockConflictError)) throw error }
      if (maintenance) {
        await resources.withResource(maintenance, async () => {
          const checkpoint = compactDocuments && documentCheckpoint(scan.records, view)
          if (checkpoint) {
            await publish(io, root, sessionId, checkpoint.line, resources, fingerprint)
            bytes = Buffer.from(checkpoint.line)
            scan = { records: [checkpoint.record], tornBytes: 0 }
            view = checkpoint.view
          }
        })
        // New readers observe this generation. The writer lease prevents a
        // concurrent mutation from creating a reference during this cleanup.
        await collectGarbage(location, scan.records)
      }
    }
    let size = bytes.length
    if (mode === 'write') {
      handle = await io.open(path, 'r+')
      resources.file(handle)
      if (scan.tornBytes > 0) {
        size = bytes.length - scan.tornBytes
        await handle.truncate(size)
        await handle.sync()
      }
    }
    const state = openState(scan.records, view, size)
    state.handle = handle
    const log = makeLog(options, mode, state, resources, location)
    return log
  } catch (error) {
    try { await resources.close() }
    catch (cleanup) { throw new CommitLogCleanupError([error, cleanup], resources) }
    throw error
  }
}

async function collectGarbage(options: CommitLogOptions, records: readonly CommitRecord[]): Promise<void> {
  const io = options.io ?? nodeIo
  const directory = sidecarDirectory(options.root, options.sessionId)
  let names: string[]
  try { names = await io.readdir(directory) } catch (error) { if (isNotFound(error)) return; throw error }
  // Readers may hold any published prefix; reclaim only never-committed orphans.
  const referenced = new Set<string>()
  for (const record of records) for (const op of record.ops) if (op.kind === 'doc') referenced.add(op.side.digest)
  for (const name of names) {
    if (!/^[0-9a-f]{64}$/.test(name) || referenced.has(name)) continue
    await io.rm(sidecarPath(options.root, options.sessionId, name)).catch(() => {})
  }
}

function makeLog(options: CommitLogOptions, mode: CommitLogMode, state: State, resources: CommitLogResources, location: CommitLogLocation): CommitLog {
  const { root, sessionId, io } = location
  const path = generationPath(root, sessionId, COMMIT_LOG_GENERATION)
  let latestBatch: string | undefined
  for (const value of state.view.batches.values()) latestBatch = value
  let poisoned = false
  let snapshot: CommitView | undefined
  let recordSnapshot: readonly CommitRecord[] | undefined
  const invalidate = () => { snapshot = undefined; recordSnapshot = undefined }
  const assertOpen = () => { if (state.closed) throw new CommitLogClosedError(); resources.assertHealthy() }
  const assertWrite = () => { assertOpen(); if (poisoned) throw new Error('commit log writer requires reopening after failed rollback'); if (mode !== 'write' || !state.handle) throw new CommitLogReadOnlyError() }
  let queue: Promise<unknown> = Promise.resolve()
  const serialize = <T>(op: () => Promise<T>): Promise<T> => { const result = queue.then(op); queue = result.catch(() => {}); return result }
  const log: CommitLog = {
    sessionId,
    mode,
    get open() { return !state.closed },
    header: () => state.view.header,
    metadata: () => ({ ...state.view.meta }),
    view: () => snapshot ??= { ...state.view, entries: [...state.view.entries], meta: { ...state.view.meta }, documents: new Map(state.view.documents), intents: new Map(state.view.intents), batches: new Map(state.view.batches) },
    records: () => recordSnapshot ??= [...state.records],
    async refresh() {
      assertOpen()
      const bytes = await readGeneration(io, path)
      if (!bytes) throw new CommitLogNotFoundError(sessionId)
      const scan = scanCommitLog(bytes)
      const view = foldCommits(scan.records)
      invalidate()
      state.records = [...scan.records]
      state.view = view
      latestBatch = undefined
      for (const value of view.batches.values()) latestBatch = value
      if (mode === 'write') state.size = bytes.length - scan.tornBytes
    },
    entryCount: () => state.view.entries.length,
    entryAt: index => state.view.entries[index],
    lastBatchDigest: () => latestBatch,
    async append(input) {
      assertWrite()
      input = typeof input === 'function' ? input({ entryCount: state.view.entries.length, lastRecord: state.records[state.records.length - 1]! }) : input
      const entries = [...(input.entries ?? [])]
      const ops = parseOps(input.ops ?? [])
      const last = state.records[state.records.length - 1]!
      const payload: CommitPayload = { v: COMMIT_FORMAT_VERSION, seq: last.seq + 1, prev: last.digest, at: nowIso(options), entries, ops }
      const line = encodeCommit(payload) + '\n'
      const record = decodeCommit(line.slice(0, -1))
      let entryCount = state.view.entries.length + record.entries.length
      for (const op of record.ops) if (op.kind === 'rewind') {
        if (op.toSeq > entryCount) throw new CommitFormatError('ops', 'rewind exceeds committed entries')
        entryCount = op.toSeq
      }
      const previousSize = state.size
      try {
        await writeAll(state.handle!, line, previousSize)
        await state.handle!.sync()
      } catch (error) {
        try { await state.handle!.truncate(previousSize); await state.handle!.sync() } catch { poisoned = true }
        throw error
      }
      state.size += Buffer.byteLength(line)
      invalidate()
      state.records.push(record)
      state.view = foldCommits([record], state.view)
      for (const op of record.ops) if (op.kind === 'batch') latestBatch = op.prefixDigest
      return record
    },
    async writeSidecar(bytes: Uint8Array) {
      assertWrite()
      const digest = sha256Hex(bytes)
      const directory = sidecarDirectory(root, sessionId)
      await io.mkdir(directory)
      const path = sidecarPath(root, sessionId, digest)
      try {
        const handle = await io.open(path, 'wx')
        await resources.withFile(handle, async () => {
          let offset = 0
          while (offset < bytes.length) {
            const result = await handle.write(bytes, offset, bytes.length - offset, offset)
            if (result.bytesWritten <= 0) throw new Error('sidecar write made no progress')
            offset += result.bytesWritten
          }
          await handle.sync()
        })
      } catch (error) {
        if (!isAlreadyExists(error)) throw error
        // Content addressing: an existing sidecar must hold these exact bytes.
        const existing = new Uint8Array(await io.readFile(path))
        if (existing.byteLength !== bytes.byteLength || !Buffer.from(existing).equals(Buffer.from(bytes))) throw new CommitFormatError('corrupt', `sidecar ${digest} already exists with different bytes`)
      }
      return { digest, bytes: bytes.byteLength }
    },
    async readSidecar(digest: string) {
      assertOpen()
      const bytes = new Uint8Array(await io.readFile(sidecarPath(root, sessionId, digest)))
      const doc = [...state.view.documents.values()].find(value => value.digest === digest)
      if (sha256Hex(bytes) !== digest || (doc && doc.bytes !== bytes.byteLength)) throw new CommitFormatError('corrupt', 'sidecar integrity verification failed')
      return bytes
    },
    async close() {
      if (state.closed) return
      try { await resources.close() }
      catch (error) { throw new CommitLogCleanupError([error], { close: () => log.close() }) }
      state.handle = undefined
      state.closed = true
    },
  }
  let closing = false
  let closePromise: Promise<void> | undefined
  const admit = () => { if (closing || state.closed) throw new CommitLogClosedError() }
  return {
    ...log,
    get open() { return !state.closed },
    async refresh() {
      admit()
      return serialize(() => log.refresh())
    },
    async append(input) {
      admit()
      // Object inputs belong to this call; callbacks deliberately observe queued state.
      const captured = typeof input === 'function' ? input : structuredClone(input)
      return serialize(() => log.append(captured))
    },
    async writeSidecar(bytes) {
      admit()
      const captured = new Uint8Array(bytes)
      return serialize(() => log.writeSidecar(captured))
    },
    async readSidecar(digest) {
      admit()
      return serialize(() => log.readSidecar(digest))
    },
    close() {
      if (!closePromise) {
        closing = true
        const flight = serialize(() => log.close())
        closePromise = flight
        void flight.catch(() => { if (closePromise === flight) closePromise = undefined })
      }
      return closePromise
    },
  }
}
