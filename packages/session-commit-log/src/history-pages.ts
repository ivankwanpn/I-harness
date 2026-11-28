import type { BigIntStats } from 'node:fs'
import type { FileHandle } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { canonicalJsonData, type OwnedSessionHistoryPage, type SessionEvent, type SessionHistoryPageOptions } from '@i-harness/core-session'
import { materializeSessionHistoryPage, pageFromSessionHistoryWindow, planSessionHistoryPage, planSessionHistoryWindow, sessionHistoryFact, type SessionHistoryPagePlan } from '@i-harness/core-session/internal/archive'
import { COMMIT_FORMAT_VERSION, type CommitRecord } from './format.ts'
import { foldCommits, type CommitView } from './fold.ts'
import { isNotFound, nodeIo } from './io.ts'
import { acquireCommitSnapshotLease } from './lease.ts'
import { generationPath } from './paths.ts'
import { CommitLogCleanupError, CommitLogResources } from './resources.ts'
import { scanCommitLog } from './scanner.ts'
import { CommitFormatError } from './errors.ts'
import type { CommitLogOptions } from './store.ts'
import { usableGeneration as usable, sameCommitGenerationVersion as sameVersion } from './generation-version.ts'

// Retain a bounded viewport even in a much longer conversation, plus the
// earlier admission coordinates referenced by images inside that viewport.
const maxSessions = 2, windowEvents = 16_384
type Span = { offset: number; bytes: number; digest: string }
type Window = Pick<SessionHistoryPagePlan, 'range' | 'admissions' | 'turns'>
type HistoryIndex = { version: BigIntStats; window: Window; spans: Map<number, Span> }
const digest = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex')

function indexGeneration(bytes: Buffer, records: readonly CommitRecord[], entries: readonly SessionEvent[], version: BigIntStats, plan: SessionHistoryPagePlan): HistoryIndex | undefined {
  const selected = new Set(plan.ordinals)
  if (entries.length) selected.add(entries.length - 1) // proof for an empty page
  const retained = new Set<SessionEvent>(), spans = new Map<number, Span>()
  for (const ordinal of selected) {
    const entry = entries[ordinal]
    if (entry?.seq !== ordinal) return
    retained.add(entry)
  }
  let line = 0
  for (const record of records) {
    const end = bytes.indexOf(10, line)
    if (end < 0) return
    if (record.entries.some(entry => retained.has(entry))) {
      // The store writes canonical JSON. Valid externally encoded lines still
      // use the normal snapshot path if their byte layout differs.
      const prefix = Buffer.from('{"at":' + canonicalJsonData(record.at) + ',"digest":' + canonicalJsonData(record.digest) + ',"entries":[')
      if (!bytes.subarray(line, line + prefix.length).equals(prefix)) return
      let offset = line + prefix.length
      for (const [i, entry] of record.entries.entries()) {
        if (i && bytes[offset++] !== 44) return
        const encoded = Buffer.from(canonicalJsonData(entry))
        if (offset + encoded.length > end || !bytes.subarray(offset, offset + encoded.length).equals(encoded)) return
        if (retained.has(entry)) {
          spans.set(entry.seq!, { offset, bytes: encoded.length, digest: digest(encoded) })
        }
        offset += encoded.length
      }
      if (bytes[offset] !== 93) return
    }
    line = end + 1
  }
  const { range, admissions, turns } = plan
  return spans.size === selected.size ? { version, window: { range, admissions, turns }, spans } : undefined
}

async function readIndexed(handle: FileHandle, index: HistoryIndex, plan: SessionHistoryPagePlan) {
  const selected: SessionEvent[] = []
  for (let i = 0; i < plan.ordinals.length;) {
    const first = index.spans.get(plan.ordinals[i]!)!
    let end = first.offset + first.bytes, next = i + 1
    // Adjacent entries in one commit are separated by one comma. Coalesce
    // short rows, without reading gaps, crossing commits or buffering a
    // whole large page in addition to its decoded messages.
    for (; next < plan.ordinals.length; next++) {
      const span = index.spans.get(plan.ordinals[next]!)!
      if (span.offset !== end + 1 || span.offset + span.bytes - first.offset > 1_048_576) break
      end = span.offset + span.bytes
    }
    const bytes = Buffer.allocUnsafe(end - first.offset)
    for (let read = 0; read < bytes.length;) {
      const { bytesRead } = await handle.read(bytes, read, bytes.length - read, first.offset + read)
      if (!bytesRead) return
      read += bytesRead
    }
    for (; i < next; i++) {
      const span = index.spans.get(plan.ordinals[i]!)!, offset = span.offset - first.offset
      const entry = bytes.subarray(offset, offset + span.bytes)
      if (digest(entry) !== span.digest) return
      selected.push(JSON.parse(entry.toString('utf8')))
    }
  }
  return materializeSessionHistoryPage(plan, selected)
}

/** One coordinator's passive index. A hit still holds the original read lease,
 * verifies the selected bytes and rechecks the actual path before returning. */
export function createCommitHistoryReader(validate: (sessionId: string, view: CommitView) => void) {
  const indexes = new Map<string, HistoryIndex>()
  return {
    clear() { indexes.clear() },
    async read(options: CommitLogOptions, page: SessionHistoryPageOptions): Promise<OwnedSessionHistoryPage | undefined> {
      const { root, sessionId } = options, io = options.io ?? nodeIo
      const path = generationPath(root, sessionId, COMMIT_FORMAT_VERSION), resources = new CommitLogResources()
      async function readPage() {
        // An absent native generation can be a legacy-only session. Do not
        // create a lease or a native generation just to perform a display read.
        const probe = await io.open(path, 'r').catch(error => { if (!isNotFound(error)) throw error })
        if (!probe) { indexes.delete(path); return }
        await resources.release(resources.file(probe))
        resources.retain(await acquireCommitSnapshotLease(sessionId, { lockRoot: options.lockRoot ?? root, ...options.lease }, 'shared'))
        const handle = await io.open(path, 'r')
        resources.file(handle)
        const before = await handle.stat({ bigint: true }), cached = indexes.get(path)
        let result: OwnedSessionHistoryPage | undefined, next: HistoryIndex | undefined
        const covered = cached && sameVersion(before, cached.version) ? pageFromSessionHistoryWindow(cached.window, page) : undefined
        if (cached && covered) {
          result = await readIndexed(handle, cached, covered)
          if (!result) { indexes.delete(path); return }
          next = cached
        } else {
          indexes.delete(path)
          const bytes = await handle.readFile()
          const scan = scanCommitLog(bytes)
          if (!scan.records.length) throw new CommitFormatError('corrupt', 'commit log has no complete commit')
          const view = foldCommits(scan.records)
          validate(sessionId, view)
          const facts = view.entries.map(sessionHistoryFact)
          const window = scan.tornBytes === 0 && usable(before) ? planSessionHistoryWindow(facts, page, windowEvents) : undefined
          if (window) next = indexGeneration(bytes, scan.records, view.entries, before, window)
          const plan = window ? pageFromSessionHistoryWindow(window, page) : planSessionHistoryPage(facts, page)
          if (!plan) return
          result = materializeSessionHistoryPage(plan, plan.ordinals.map(ordinal => view.entries[ordinal]!))
        }
        // An append can coexist with a snapshot lease. A pathname replacement
        // can leave the open descriptor pointing to the prior file.
        if (!usable(before)) return result
        const current = await io.open(path, 'r')
        resources.file(current)
        if (!sameVersion(before, await handle.stat({ bigint: true })) || !sameVersion(before, await current.stat({ bigint: true }))) {
          indexes.delete(path); return
        }
        if (next) {
          indexes.delete(path); indexes.set(path, next)
          if (indexes.size > maxSessions) indexes.delete(indexes.keys().next().value!)
        }
        return result
      }
      let result: OwnedSessionHistoryPage | undefined, failed = false, primary: unknown
      try { result = await readPage() } catch (error) { failed = true; primary = error }
      try { await resources.close() } catch (error) { throw new CommitLogCleanupError(failed ? [primary, error] : [error], resources) }
      if (failed) throw primary
      return result
    },
  }
}
