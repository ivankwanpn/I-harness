import { open, readFile, type FileHandle } from 'node:fs/promises'
import { decodeFactBatch, readFactJournal, validJournalMetadata, validJournalPrefix, type EncodedFactBatch, type FactReceipt, type JournalPrefix } from '@i-harness/core-session'
import type { BackendFactOutcome, HeldFactOwner, OwnedFactBackend, SessionMeta } from '@i-harness/session-persistence'
import { isHeldFactOwner } from '@i-harness/session-persistence'
import { parseHeader } from '../format.ts'

const scope = (id: string, owner: HeldFactOwner) => {
  if (!isHeldFactOwner(owner)) throw new TypeError('Invalid held owner scope')
  if (id !== owner.owner.sessionId) throw new TypeError('FACT_OWNER_UNSUPPORTED')
  owner.assertHeld()
}
class JournalPrefixConflict extends Error {}
async function header(handle: FileHandle) {
  const bytes = Buffer.alloc(64 * 1024)
  const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0)
  const end = bytes.subarray(0, bytesRead).indexOf(0x0a)
  if (end < 0) throw new TypeError('Invalid managed header')
  const meta = parseHeader(bytes.subarray(0, end).toString('utf8'))
  if (![6, 7].includes(meta.formatVersion) || !validJournalMetadata(meta.journal)) throw new TypeError('Managed journal format required')
  return { meta, bytes: end + 1 }
}
function checkBatch(prefix: JournalPrefix, batch: EncodedFactBatch) {
  if (!validJournalPrefix(prefix)) throw new TypeError('Invalid journal prefix')
  const decoded = decodeFactBatch(batch.bytes)
  if (JSON.stringify(decoded.key) !== JSON.stringify(batch.key) || batch.key.firstSeq !== prefix.eventCount
    || batch.key.previousPrefixDigest !== prefix.prefixDigest) throw new TypeError('Invalid owned batch scope')
  return decoded
}
async function checkPrefix(handle: FileHandle, h: { meta: SessionMeta; bytes: number }, prefix: JournalPrefix) {
  const journal = h.meta.journal!
  const boundary = journal.legacyBodyBytes + journal.separatorBytes
  if (prefix.bodyBytes < boundary) throw new TypeError('Invalid journal boundary')
  if (prefix.bodyBytes === boundary) {
    if (prefix.eventCount !== journal.legacyEventCount || prefix.prefixDigest !== journal.legacyPrefixDigest) throw new JournalPrefixConflict('Journal prefix conflict')
  } else {
    const suffix = Buffer.from(`,"prefixDigest":"${prefix.prefixDigest}"}\n`)
    const bytes = Buffer.alloc(suffix.length)
    const { bytesRead } = await handle.read(bytes, 0, bytes.length, h.bytes + prefix.bodyBytes - bytes.length)
    if (bytesRead !== bytes.length || !bytes.equals(suffix)) throw new JournalPrefixConflict('Journal prefix conflict')
  }
}

/** Only the coordinator creates owner contexts. This leaf owns complete writes,
 * fsync evidence and same-issued-batch reconciliation; no write-behind retry. */
export function createFactJournalBackend(filePath: (id: string) => string, assertNotDeleted: (kind: string, id: string) => Promise<void>): OwnedFactBackend {
  const receipt = (owner: HeldFactOwner, batch: EncodedFactBatch, prefixDigest: string): FactReceipt => ({
    owner: { ...owner.owner }, key: { ...batch.key }, lastSeq: batch.key.firstSeq + batch.key.count - 1, prefixDigest,
  })
  return {
    async readJournalPrefix(id, owner) {
      scope(id, owner)
      await assertNotDeleted('session', id)
      const path = filePath(id), bytes = await readFile(path)
      const end = bytes.indexOf(0x0a)
      const meta = parseHeader(bytes.subarray(0, end).toString('utf8'))
      if (![6, 7].includes(meta.formatVersion) || !validJournalMetadata(meta.journal)) throw new TypeError('Managed journal format required')
      const decoded = readFactJournal(bytes.subarray(end + 1), meta.journal, meta.formatVersion)
      const handle = await open(path, 'r+')
      try {
        scope(id, owner)
        if (decoded.torn) await handle.truncate(end + 1 + decoded.prefix.bodyBytes)
        await handle.sync()
        scope(id, owner)
      } finally { await handle.close() }
      return decoded.prefix
    },
    async appendOwnedBatch(id, owner, prefix, batch) {
      scope(id, owner)
      const decoded = checkBatch(prefix, batch)
      await assertNotDeleted('session', id)
      let handle: FileHandle | undefined, issued = false, synced = false, position = 0
      let outcome: BackendFactOutcome
      try {
        handle = await open(filePath(id), 'r+')
        const h = await header(handle)
        position = h.bytes + prefix.bodyBytes
        if ((await handle.stat()).size !== position) return { kind: 'conflict', key: batch.key }
        await checkPrefix(handle, h, prefix)
        // No await is permitted between the final fence and the first write.
        scope(id, owner)
        owner.beforeIssue()
        issued = true
        let written = 0
        while (written < batch.bytes.length) {
          const result = await handle.write(batch.bytes, written, batch.bytes.length - written, position + written)
          if (!Number.isSafeInteger(result.bytesWritten) || result.bytesWritten <= 0) throw new Error('Fact write made no progress')
          written += result.bytesWritten
        }
        await handle.sync()
        synced = true
        outcome = { kind: 'committed', receipt: receipt(owner, batch, decoded.prefixDigest) }
      } catch (error) {
        const code = (error as { code?: string }).code
        if (!issued) outcome = error instanceof JournalPrefixConflict ? { kind: 'conflict', key: batch.key } : code === 'FACT_CANCELLED' || code === 'FACT_CLOSED' || code === 'FACT_OWNER_UNSUPPORTED' || code === 'FACT_RECOVERY_REQUIRED'
          ? { kind: 'not-issued', code } : { kind: 'absent', key: batch.key }
        else {
          outcome = { kind: 'unknown', key: batch.key }
          try {
            scope(id, owner)
            await handle!.truncate(position)
            await handle!.sync()
            outcome = { kind: 'absent', key: batch.key }
          } catch { /* absence needs both truncate and sync under the same lease */ }
        }
      } finally {
        if (handle) try { await handle.close() } catch {
          // A successful fsync is already a durable commit. Cleanup cannot
          // erase that receipt or authorize rewriting the committed batch.
          if (synced && outcome!.kind === 'committed') outcome = { ...outcome!, cleanupDiagnostic: 'file-close-failed' }
          else if (!synced && issued) outcome = { kind: 'unknown', key: batch.key }
        }
      }
      return outcome!
    },
    async reconcileOwnedBatch(id, owner, prefix, batch) {
      scope(id, owner)
      const decoded = checkBatch(prefix, batch)
      await assertNotDeleted('session', id)
      let handle: FileHandle | undefined, outcome: BackendFactOutcome = { kind: 'unknown', key: batch.key }
      try {
        handle = await open(filePath(id), 'r+')
        const h = await header(handle), position = h.bytes + prefix.bodyBytes
        await checkPrefix(handle, h, prefix)
        const size = (await handle.stat()).size
        if (size < position || size > position + batch.bytes.length) return { kind: 'conflict', key: batch.key }
        const actual = Buffer.alloc(size - position)
        let offset = 0
        while (offset < actual.length) {
          const { bytesRead } = await handle.read(actual, offset, actual.length - offset, position + offset)
          if (!bytesRead) throw new Error('Fact reconciliation read made no progress')
          offset += bytesRead
        }
        if (!actual.equals(Buffer.from(batch.bytes.subarray(0, actual.length)))) return { kind: 'conflict', key: batch.key }
        scope(id, owner)
        if (actual.length === batch.bytes.length) {
          await handle.sync()
          outcome = { kind: 'committed', receipt: receipt(owner, batch, decoded.prefixDigest) }
        } else {
          await handle.truncate(position)
          await handle.sync()
          outcome = { kind: 'absent', key: batch.key }
        }
      } catch (error) { if (error instanceof JournalPrefixConflict) outcome = { kind: 'conflict', key: batch.key } }
      finally {
        if (handle) await handle.close().catch(() => {
          if (outcome.kind === 'committed') outcome = { ...outcome, cleanupDiagnostic: 'file-close-failed' }
        })
      }
      return outcome
    },
  }
}
