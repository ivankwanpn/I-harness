import { open, readFile, type FileHandle } from 'node:fs/promises'
import { CURRENT_FORMAT_VERSION, canonicalJsonData, decodeFactBatch, readFactJournal, validJournalMetadata, validJournalPrefix, type EncodedFactBatch, type FactReceipt, type JournalPrefix, type SessionEvent } from '@i-harness/core-session'
import type { BackendFactOutcome, HeldFactOwner, OwnedFactBackend, SessionMeta } from '@i-harness/session-persistence'
import { isHeldFactOwner, bootstrapManifest, validateOwnedCaptureStage } from '@i-harness/session-persistence'
import { parseHeader } from '../format.ts'
import { readBootstrapFactJournal } from '@i-harness/core-session/internal/bootstrap'
import type { BootstrapBackend } from '@i-harness/session-persistence'
import { lookupBootstrapStage, ordinaryStageIO, type StageLookupIO } from './bootstrap-stage.ts'
import { resolveSelectedBirth } from './selected-birth.ts'
import type { PublicationOwner } from './publication.ts'

/** Ordinary replacement may rewrite a suffix, never the actual birth frames
 * whose keys/bytes establish the retained operation's historical receipts. */
export async function preserveBootstrapBirth(path: string, raw: Buffer, meta: SessionMeta, candidate: readonly SessionEvent[], stageIO?: StageLookupIO) {
  const reservation = meta.semanticSeed
  if (!reservation) throw new TypeError('Bootstrap reservation required')
  if (reservation.version === 3) {
    const birth=await resolveSelectedBirth(path,meta.sessionId,async()=>{}, {readJournal:async()=>raw,stage:stageIO ?? ordinaryStageIO(path)})
    if (!birth) throw new TypeError('Selected birth unavailable')
    const end=raw.indexOf(10),body=raw.subarray(end+1),decoded=readBootstrapFactJournal(body,meta.journal!,meta.formatVersion,meta)
    const count=reservation.seedLength+1,last=decoded.frames[1]
    if (!last || canonicalJsonData(candidate.slice(0,count))!==canonicalJsonData(decoded.events.slice(0,count))) throw new TypeError('Selected birth records are immutable')
    const bytes=last.prefix.bodyBytes+last.batch.bytes.length
    return {bytes:body.subarray(0,bytes),eventCount:count,prefixDigest:decodeFactBatch(last.batch.bytes).prefixDigest}
  }
  const invocation = { version: 1 as const, operationId: reservation.operationId, targetSessionId: meta.sessionId, createdAt: meta.createdAt, requestDigest: reservation.requestDigest }
  const selected = await lookupBootstrapStage(path,{kind:'header',meta},stageIO ?? ordinaryStageIO(path))
  if(selected.kind!=='full')throw new TypeError('Unique bootstrap birth unavailable')
  const stage=selected.stage
  const original = JSON.parse(stage.headerBytes) as SessionMeta
  if (meta.formatVersion !== original.formatVersion && !([11,12].includes(original.formatVersion) && meta.formatVersion > original.formatVersion && meta.formatVersion <= CURRENT_FORMAT_VERSION) && !(original.formatVersion===13 && meta.formatVersion===14)) throw new TypeError('Bootstrap storage format changed')
  for (const key of ['sessionId','createdAt','journal','parentSession','seedLength','origin','delegationDepth','subagentProtocolVersion','subagentTaskId','subagentAgentPath','semanticSeed'] as const) {
    if (canonicalJsonData(meta[key]) !== canonicalJsonData(original[key])) throw new TypeError('Bootstrap birth scope changed')
  }
  const end = raw.indexOf(10), body = raw.subarray(end + 1)
  const decoded = readBootstrapFactJournal(body, meta.journal!, meta.formatVersion, meta)
  if(stage.captureReservation)validateOwnedCaptureStage(stage.captureReservation,stage,decoded.events.slice(0,reservation.seedLength) as import('@i-harness/session-persistence').BootstrapRequest['seed']['records'])
  if (bootstrapManifest(stage, decoded.events.slice(0, reservation.seedLength) as import('@i-harness/session-persistence').BootstrapRequest['seed']['records']) !== reservation.manifestDigest) throw new TypeError('Bootstrap birth manifest changed')
  const birthCount = reservation.seedLength + 1 + (reservation.initialInputId === undefined ? 0 : 1)
  if (canonicalJsonData(candidate.slice(0, birthCount)) !== canonicalJsonData(decoded.events.slice(0, birthCount))) throw new TypeError('Bootstrap birth records are immutable')
  const phases = reservation.seedLength ? [{ name: 'seed', count: reservation.seedLength }, { name: 'complete', count: birthCount - reservation.seedLength }] : [{ name: 'complete', count: birthCount }]
  let eventCount = 0
  for (const [index, phase] of phases.entries()) {
    const actual = decoded.frames[index]
    if (!actual || actual.prefix.eventCount !== eventCount || actual.batch.key.firstSeq !== eventCount || actual.batch.key.count !== phase.count
      || actual.batch.key.batchId !== `bootstrap:${invocation.operationId}:${phase.name}`) throw new TypeError('Original bootstrap phase layout unavailable')
    eventCount += phase.count
  }
  const last = decoded.frames[phases.length - 1]!, bytes = last.prefix.bodyBytes + last.batch.bytes.length
  return { bytes: body.subarray(0, bytes), eventCount: birthCount, prefixDigest: decodeFactBatch(last.batch.bytes).prefixDigest }
}

const scope = (id: string, owner: HeldFactOwner) => {
  if (!isHeldFactOwner(owner)) throw new TypeError('Invalid held owner scope')
  if (id !== owner.owner.sessionId) throw new TypeError('FACT_OWNER_UNSUPPORTED')
  owner.assertHeld()
}
class JournalPrefixConflict extends Error {}
async function header(handle: FileHandle, path: string, batch: EncodedFactBatch) {
  const bytes = Buffer.alloc(64 * 1024)
  const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0)
  const end = bytes.subarray(0, bytesRead).indexOf(0x0a)
  if (end < 0) throw new TypeError('Invalid managed header')
  const meta = parseHeader(bytes.subarray(0, end).toString('utf8'))
  if (!validJournalMetadata(meta.journal)) throw new TypeError('Current managed journal format required')
  const selected=meta.semanticSeed?await lookupBootstrapStage(path,{kind:'header',meta},ordinaryStageIO(path)):undefined
  if(meta.semanticSeed&&selected?.kind!=='full')throw new TypeError('Unique bootstrap birth unavailable')
  if (meta.formatVersion !== CURRENT_FORMAT_VERSION) {
    const seed = meta.semanticSeed
    if (![11,12,13].includes(meta.formatVersion) || !seed) throw new TypeError('Current managed journal format required')
    if(selected?.kind!=='full')throw new TypeError('Unique bootstrap birth unavailable')
    const stage=selected.stage
    if (!bytes.subarray(0, end + 1).equals(Buffer.from(stage.headerBytes))) throw new TypeError('Original bootstrap header required')
    const phase = batch.key.firstSeq === 0 && seed.seedLength > 0 ? 'seed' : 'complete'
    const first = phase === 'seed' ? 0 : seed.seedLength, count = phase === 'seed' ? seed.seedLength : 1 + (seed.initialInputId === undefined ? 0 : 1)
    if (batch.key.batchId !== `bootstrap:${seed.operationId}:${phase}` || batch.key.firstSeq !== first || batch.key.count !== count) throw new TypeError('Original bootstrap phase required')
    const raw = await readFile(path), body = raw.subarray(raw.indexOf(10) + 1)
    const prefix = body.subarray(0, phase === 'seed' ? 0 : readBootstrapFactJournal(body, meta.journal!, meta.formatVersion, meta).frames.find(frame => frame.batch.key.batchId.endsWith(':seed'))?.batch.bytes.length ?? 0)
    // The original lane permits only the exact seed/completion/initial shape.
    const combined=readBootstrapFactJournal(Buffer.concat([prefix, Buffer.from(batch.bytes)]), meta.journal!, meta.formatVersion, meta)
    if(stage.captureReservation)validateOwnedCaptureStage(stage.captureReservation,stage,combined.events.slice(0,seed.seedLength) as import('@i-harness/session-persistence').BootstrapRequest['seed']['records'])
  }
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
export function createFactJournalBackend(filePath: (id: string) => string, assertNotDeleted: (kind: string, id: string) => Promise<void>, nativePrewrite?: Readonly<{ filePath: typeof filePath; assertNotDeleted: typeof assertNotDeleted; enter(id: string, owner: import('@i-harness/session-persistence').IssuingFactOwner, batch: EncodedFactBatch): () => void }>, publication?: PublicationOwner): OwnedFactBackend & Pick<BootstrapBackend,'confirmBootstrapFrames'> {
  if (nativePrewrite && (nativePrewrite.filePath !== filePath || nativePrewrite.assertNotDeleted !== assertNotDeleted)) throw new TypeError('Changed original native writer prerequisites')
  const receipt = (owner: HeldFactOwner, batch: EncodedFactBatch, prefixDigest: string): FactReceipt => ({
    owner: { ...owner.owner }, key: { ...batch.key }, lastSeq: batch.key.firstSeq + batch.key.count - 1, prefixDigest,
  })
  return {
    async confirmBootstrapFrames(id,owner,expected) {
      scope(id,owner);await assertNotDeleted('session',id)
      let handle:FileHandle|undefined
      try {
        const bytes=await readFile(filePath(id)),end=bytes.indexOf(10),meta=parseHeader(bytes.subarray(0,end).toString('utf8'))
        if(meta.semanticSeed?.version===3)throw new TypeError('Legacy acknowledgment cannot confirm selected results')
        const decoded=readBootstrapFactJournal(bytes.subarray(end+1),meta.journal!,meta.formatVersion,meta)
        if(decoded.torn)return {kind:'unknown'}
        readFactJournal(bytes.subarray(end+1),meta.journal!,meta.formatVersion,meta)
        for(const wanted of expected){checkBatch(wanted.prefix,wanted.batch);const frame=decoded.frames.find(frame=>frame.prefix.bodyBytes===wanted.prefix.bodyBytes)
          if(!frame||JSON.stringify(frame.prefix)!==JSON.stringify(wanted.prefix)||!Buffer.from(frame.batch.bytes).equals(Buffer.from(wanted.batch.bytes)))return {kind:'conflict'}}
        handle=await open(filePath(id),'r+');scope(id,owner);await handle.sync();scope(id,owner)
        return {kind:'committed',receipts:expected.map(frame=>receipt(owner,frame.batch,decodeFactBatch(frame.batch.bytes).prefixDigest))}
      }catch{return {kind:'unknown'}}finally{await handle?.close().catch(()=>{})}
    },
    async readJournalPrefix(id, owner) {
      scope(id, owner)
      await assertNotDeleted('session', id)
      const path = filePath(id), bytes = await readFile(path)
      const end = bytes.indexOf(0x0a)
      const meta = parseHeader(bytes.subarray(0, end).toString('utf8'))
      if (meta.semanticSeed?.version === 3) throw new TypeError('Legacy owned prefix cannot repair selected results')
      if (![6, 7, 8, 9, 10, 11, 12, 13, 14].includes(meta.formatVersion) || !validJournalMetadata(meta.journal)) throw new TypeError('Managed journal format required')
      const decoded = readFactJournal(bytes.subarray(end + 1), meta.journal, meta.formatVersion, meta)
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
      // Only the original JSONL constructor pairs these exact native-only closures.
      // Custom callback-bearing factories never receive this observation.
      let leavePrewrite = nativePrewrite?.enter(id, owner, batch)
      try { await assertNotDeleted('session', id) } catch (error) { leavePrewrite?.(); throw error }
      let handle: FileHandle | undefined, issued = false, synced = false, position = 0
      let outcome: BackendFactOutcome
      try {
        handle = await open(filePath(id), 'r+')
        const h = await header(handle, filePath(id), batch)
        position = h.bytes + prefix.bodyBytes
        if ((await handle.stat()).size !== position) return { kind: 'conflict', key: batch.key }
        await checkPrefix(handle, h, prefix)
        // No await is permitted between the final fence and the first write.
        scope(id, owner)
        leavePrewrite?.(); leavePrewrite = undefined
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
        if (!issued) outcome = error instanceof JournalPrefixConflict ? { kind: 'conflict', key: batch.key } : code === 'FACT_CANCELLED' || code === 'FACT_CLOSED' || code === 'FACT_OWNER_UNSUPPORTED' || code === 'FACT_RECOVERY_REQUIRED' || code === 'FACT_PRECONDITION_STALE'
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
        leavePrewrite?.(); leavePrewrite = undefined
        if (handle) try { await handle.close() } catch {
          // A successful fsync is already a durable commit. Cleanup cannot
          // erase that receipt or authorize rewriting the committed batch.
          if (synced && outcome!.kind === 'committed') outcome = { ...outcome!, cleanupDiagnostic: 'file-close-failed' }
          else if (!synced && issued) outcome = { kind: 'unknown', key: batch.key }
        }
      }
      if (outcome!.kind === 'committed' && decoded.events.some(event => event.type === 'session/bootstrap')) await publication?.end(id, filePath(id))
      return outcome!
    },
    async reconcileOwnedBatch(id, owner, prefix, batch) {
      scope(id, owner)
      const decoded = checkBatch(prefix, batch)
      await assertNotDeleted('session', id)
      let handle: FileHandle | undefined, outcome: BackendFactOutcome = { kind: 'unknown', key: batch.key }
      try {
        handle = await open(filePath(id), 'r+')
        const h = await header(handle, filePath(id), batch), position = h.bytes + prefix.bodyBytes
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
      if (outcome.kind === 'committed' && decoded.events.some(event => event.type === 'session/bootstrap')) await publication?.end(id, filePath(id))
      return outcome
    },
  }
}
