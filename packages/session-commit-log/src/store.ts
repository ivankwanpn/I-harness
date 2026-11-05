import { createHash, randomUUID } from 'node:crypto'
import type { FileHandle } from 'node:fs/promises'
import type { SessionEvent } from '@i-harness/core-session'
import { CommitFormatError } from './errors.ts'
import { COMMIT_FORMAT_VERSION, GENESIS_PREV, decodeCommit, encodeCommit, parseOps, type CommitOp, type CommitPayload, type CommitRecord } from './format.ts'
import { foldCommits, type CommitDocument, type CommitView } from './fold.ts'
import { acquireCommitLease, type CommitLease } from './lease.ts'
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
  readonly now?: () => Date
  /** Lease root; defaults to the store root. */
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
  view(): CommitView
  records(): readonly CommitRecord[]
  /** Re-read the generation file and re-fold (read handles observe later commits). */
  refresh(): Promise<void>
  append(input: CommitInput): Promise<CommitRecord>
  writeSidecar(bytes: Uint8Array): Promise<CommitDocument>
  readSidecar(digest: string): Promise<Uint8Array>
  close(): Promise<void>
}

type State = {
  records: CommitRecord[]
  view: CommitView
  size: number
  handle?: FileHandle
  lease?: CommitLease
  closed: boolean
}

function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

function nowIso(options: CommitLogOptions): string {
  return (options.now?.() ?? new Date()).toISOString()
}

async function syncDirectory(io: CommitLogIo, directory: string): Promise<void> {
  try {
    const handle = await io.open(directory, 'r')
    try { await handle.sync() } catch { /* directory sync is diagnostic */ } finally { await handle.close().catch(() => {}) }
  } catch { /* Windows cannot open a directory as a file */ }
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
async function publish(io: CommitLogIo, root: string, sessionId: string, line: string): Promise<void> {
  const directory = sessionDirectory(root, sessionId)
  await io.mkdir(directory)
  const finalPath = generationPath(root, sessionId, COMMIT_LOG_GENERATION)
  const temporary = temporaryPath(root, sessionId, randomUUID().slice(0, 8))
  const handle = await io.open(temporary, 'wx')
  try {
    await writeAll(handle, line, 0)
    await handle.sync()
  } finally {
    await handle.close().catch(() => {})
  }
  try {
    await io.link(temporary, finalPath)
  } catch (error) {
    if (isAlreadyExists(error)) throw new CommitLogConflictError(sessionId)
    throw error
  } finally {
    await io.unlink(temporary).catch(() => {})
  }
  await syncDirectory(io, directory)
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
  const lease = await acquireCommitLease(sessionId, { lockRoot: options.lockRoot ?? root, retryMs: options.lease?.retryMs, deadlineMs: options.lease?.deadlineMs })
  try {
    const ops = parseOps([{ kind: 'header', value: first.header }, ...(first.ops ?? [])])
    const payload: CommitPayload = {
      v: COMMIT_FORMAT_VERSION,
      seq: 1,
      prev: GENESIS_PREV,
      at: nowIso(options),
      entries: [...(first.entries ?? [])],
      ops,
    }
    const line = encodeCommit(payload) + '\n'
    await publish(io, root, sessionId, line)
    const record = decodeCommit(line.slice(0, -1))
    const view = foldCommits([record])
    const handle = await io.open(generationPath(root, sessionId, COMMIT_LOG_GENERATION), 'r+')
    const state = openState([record], view, Buffer.byteLength(line))
    state.handle = handle
    state.lease = lease
    return makeLog(options, 'write', state, lease)
  } catch (error) {
    await lease.release().catch(() => {})
    throw error
  }
}

const SCAN_CACHE_ENABLED = process.env.IH_COMMIT_SCAN_CACHE !== '0'
const scanCache = new Map<string, { length: number; records: readonly CommitRecord[] }>()
const SCAN_CACHE_LIMIT = 64
function cacheScan(key: string, length: number, records: readonly CommitRecord[]): void {
  scanCache.delete(key)
  scanCache.set(key, { length, records })
  while (scanCache.size > SCAN_CACHE_LIMIT) scanCache.delete(scanCache.keys().next().value as string)
}

export async function openCommitLog(options: CommitLogOptions, mode: CommitLogMode): Promise<CommitLog> {
  const io = options.io ?? nodeIo
  const { root, sessionId } = options
  const path = generationPath(root, sessionId, COMMIT_LOG_GENERATION)
  let lease: CommitLease | undefined
  try {
    if (mode === 'write') lease = await acquireCommitLease(sessionId, { lockRoot: options.lockRoot ?? root, retryMs: options.lease?.retryMs, deadlineMs: options.lease?.deadlineMs })
    const bytes = await readGeneration(io, path)
    if (!bytes) throw new CommitLogNotFoundError(sessionId)
    // Logs are append-only, so an unchanged byte length means an unchanged
    // record set; repeated read opens (profile/list/load) reuse the parse.
    const cacheKey = root + '|' + sessionId
    const cached = mode === 'read' && SCAN_CACHE_ENABLED ? scanCache.get(cacheKey) : undefined
    const scan = cached && cached.length === bytes.length ? { records: cached.records, tornBytes: 0 } : scanCommitLog(bytes)
    if (mode === 'read' && SCAN_CACHE_ENABLED && (!cached || cached.length !== bytes.length)) cacheScan(cacheKey, bytes.length, scan.records)
    if (scan.records.length === 0) throw new CommitFormatError('corrupt', 'commit log has no complete commit')
    let size = bytes.length
    let handle: FileHandle | undefined
    if (mode === 'write') {
      handle = await io.open(path, 'r+')
      if (scan.tornBytes > 0) {
        size = bytes.length - scan.tornBytes
        await handle.truncate(size)
        await handle.sync()
      }
    }
    const view = foldCommits(scan.records)
    const state = openState(scan.records, view, size)
    state.handle = handle
    state.lease = lease
    const log = makeLog(options, mode, state, lease)
    if (mode === 'write') await collectGarbage(options, view)
    return log
  } catch (error) {
    if (lease) await lease.release().catch(() => {})
    throw error
  }
}

async function collectGarbage(options: CommitLogOptions, view: CommitView): Promise<void> {
  const io = options.io ?? nodeIo
  const directory = sidecarDirectory(options.root, options.sessionId)
  let names: string[]
  try { names = await io.readdir(directory) } catch (error) { if (isNotFound(error)) return; throw error }
  const referenced = new Set([...view.documents.values()].map(document => document.digest))
  for (const name of names) {
    if (!/^[0-9a-f]{64}$/.test(name) || referenced.has(name)) continue
    await io.rm(sidecarPath(options.root, options.sessionId, name)).catch(() => {})
  }
}

function makeLog(options: CommitLogOptions, mode: CommitLogMode, state: State, lease: CommitLease | undefined): CommitLog {
  const io = options.io ?? nodeIo
  const path = generationPath(options.root, options.sessionId, COMMIT_LOG_GENERATION)
  const assertOpen = () => { if (state.closed) throw new CommitLogClosedError() }
  const assertWrite = () => { assertOpen(); if (mode !== 'write' || !state.handle) throw new CommitLogReadOnlyError() }
  return {
    sessionId: options.sessionId,
    mode,
    get open() { return !state.closed },
    header: () => state.view.header,
    view: () => state.view,
    records: () => state.records,
    async refresh() {
      assertOpen()
      const bytes = await readGeneration(io, path)
      if (!bytes) throw new CommitLogNotFoundError(options.sessionId)
      const scan = scanCommitLog(bytes)
      state.records = [...scan.records]
      state.view = foldCommits(scan.records)
      if (mode === 'write') state.size = bytes.length - scan.tornBytes
    },
    async append(input: CommitInput) {
      assertWrite()
      const entries = [...(input.entries ?? [])]
      const ops = parseOps(input.ops ?? [])
      const last = state.records[state.records.length - 1]!
      const payload: CommitPayload = { v: COMMIT_FORMAT_VERSION, seq: last.seq + 1, prev: last.digest, at: nowIso(options), entries, ops }
      const line = encodeCommit(payload) + '\n'
      const previousSize = state.size
      try {
        await writeAll(state.handle!, line, previousSize)
        await state.handle!.sync()
      } catch (error) {
        try { await state.handle!.truncate(previousSize); await state.handle!.sync() } catch { /* best-effort rollback */ }
        throw error
      }
      state.size += Buffer.byteLength(line)
      const record = decodeCommit(line.slice(0, -1))
      state.records = [...state.records, record]
      state.view = foldCommits(state.records)
      return record
    },
    async writeSidecar(bytes: Uint8Array) {
      assertWrite()
      const digest = sha256Hex(bytes)
      const directory = sidecarDirectory(options.root, options.sessionId)
      await io.mkdir(directory)
      const path = sidecarPath(options.root, options.sessionId, digest)
      try {
        const handle = await io.open(path, 'wx')
        try {
          let offset = 0
          while (offset < bytes.length) {
            const result = await handle.write(bytes, offset, bytes.length - offset, offset)
            if (result.bytesWritten <= 0) throw new Error('sidecar write made no progress')
            offset += result.bytesWritten
          }
          await handle.sync()
        } finally { await handle.close().catch(() => {}) }
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
      return new Uint8Array(await io.readFile(sidecarPath(options.root, options.sessionId, digest)))
    },
    async close() {
      if (state.closed) return
      state.closed = true
      try { if (state.handle) await state.handle.close() } finally { if (lease) await lease.release() }
    },
  }
}
