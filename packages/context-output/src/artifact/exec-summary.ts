import { createHash } from 'node:crypto'
import { sameManagedArtifactRef, validManagedArtifactRef, type ExecFrameCursor, type ManagedArtifactRef, type ResultCompleteness } from '@i-harness/core-session'
import type { ExecFramePage } from './exec-reader.ts'

export interface ExecFrameSummary {
  readonly version: 1
  readonly stdout: Readonly<{ bytes: number; sha256: string }>
  readonly stderr: Readonly<{ bytes: number; sha256: string }>
  readonly totalRawBytes: number
  readonly completeness: ResultCompleteness
}

/** First read is O(captured output) authenticated IO. Holds one bounded page,
 * incremental hashes and numeric frame/record state, never the whole output. */
export async function summarizeExecFrames(original: ManagedArtifactRef, read: (cursor: ExecFrameCursor, maxBytes: number) => Promise<ExecFramePage>, signal?: AbortSignal): Promise<ExecFrameSummary> {
  const bad = (): never => { throw new Error('Artifact frame summary corrupt or nonadvancing') }
  if (!validManagedArtifactRef(original) || original.codec !== 'exec-frames-v1' || original.encodedBytes < 9) bad()
  const ref = Object.freeze({ ...original }), hashes = { stdout: createHash('sha256'), stderr: createHash('sha256') }, counts = { stdout: 0, stderr: 0 }
  const safe = (value: number) => Number.isSafeInteger(value) && value >= 0
  const cursorValid = (value: ExecFrameCursor) => value && safe(value.recordOffset) && value.recordOffset >= 9 && value.recordOffset <= ref.encodedBytes && safe(value.sliceOffset) && value.sliceOffset <= 32768
  let cursor: ExecFrameCursor = { recordOffset: 9, sliceOffset: 0 }
  let previous: { frame: number; channel: string; next: number; end: boolean } | undefined
  let recordBytes = 0, recordOffset = 0
  for (;;) {
    signal?.throwIfAborted()
    const page = await read({ ...cursor }, 32768)
    signal?.throwIfAborted()
    if (!page || !validManagedArtifactRef(page.ref) || !sameManagedArtifactRef(ref, page.ref) || !cursorValid(page.cursor)
      || page.cursor.recordOffset !== cursor.recordOffset || page.cursor.sliceOffset !== cursor.sliceOffset
      || typeof page.eof !== 'boolean' || !Array.isArray(page.frames) || Buffer.byteLength(JSON.stringify(page)) > 32768
      || page.eof !== (page.nextCursor === null)) bad()
    if (!page.frames.length && !(page.eof && ref.encodedBytes === 9 && cursor.recordOffset === 9 && cursor.sliceOffset === 0)) bad()
    let position = cursor.recordOffset
    for (const [index, part] of page.frames.entries()) {
      if (!part || !['stdout', 'stderr'].includes(part.channel) || !safe(part.frame) || !safe(part.offset) || typeof part.end !== 'boolean'
        || typeof part.data !== 'string' || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(part.data)) bad()
      const bytes = Buffer.from(part.data, 'base64')
      if (bytes.toString('base64') !== part.data || bytes.length > 32768 || !safe(part.offset + bytes.length)
        || !bytes.length && (!part.end || part.offset !== 0)) bad()
      if (previous ? part.frame === previous.frame
        ? previous.end || part.channel !== previous.channel || part.offset !== previous.next
        : part.frame <= previous.frame || !previous.end || part.offset !== 0
        : part.offset !== 0) bad()
      if (!recordBytes) recordOffset = part.offset
      recordBytes += bytes.length
      if (recordBytes > 32768) bad()
      hashes[part.channel].update(bytes); counts[part.channel] += bytes.length
      if (!safe(counts.stdout + counts.stderr)) bad()
      previous = { frame: part.frame, channel: part.channel, next: part.offset + bytes.length, end: part.end }
      const last = index === page.frames.length - 1
      const completeRecord = !last || page.eof || page.nextCursor!.recordOffset !== position
      if (completeRecord) {
        // Each page element ends a native canonical record, except the final
        // sliced element whose next cursor remains inside that same record.
        position += Buffer.byteLength(JSON.stringify({ channel: part.channel, frame: part.frame, offset: recordOffset, end: part.end, data: '' }) + '\n') + 4 * Math.ceil(recordBytes / 3)
        recordBytes = 0
      } else if (part.end) bad()
    }
    if (page.eof) {
      if (position !== ref.encodedBytes || recordBytes || previous && !previous.end && ref.completeness === 'complete') bad()
      signal?.throwIfAborted()
      return Object.freeze({ version: 1, stdout: Object.freeze({ bytes: counts.stdout, sha256: hashes.stdout.digest('hex') }),
        stderr: Object.freeze({ bytes: counts.stderr, sha256: hashes.stderr.digest('hex') }), totalRawBytes: counts.stdout + counts.stderr, completeness: ref.completeness })
    }
    const next = page.nextCursor!
    if (!cursorValid(next) || next.recordOffset >= ref.encodedBytes || next.recordOffset !== position
      || next.sliceOffset !== recordBytes || next.recordOffset < cursor.recordOffset
      || next.recordOffset === cursor.recordOffset && next.sliceOffset <= cursor.sliceOffset) bad()
    cursor = { ...next }
  }
}
