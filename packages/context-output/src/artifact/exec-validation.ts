import { encodeExecFrameRecord, sameManagedArtifactRef, validManagedArtifactRef, type ExecFrameCursor, type ManagedArtifactRef } from '@i-harness/core-session'
import type { ExecFramePage } from './exec-reader.ts'

const HEADER_BYTES = 9
const PAGE_BYTES = 32768
const bad = (): never => { throw new Error('Artifact frame summary corrupt or nonadvancing') }
const safe = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0

function validCursor(value: unknown, extent: number): value is ExecFrameCursor {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== 2) return false
  const cursor = value as ExecFrameCursor
  return safe(cursor.recordOffset) && cursor.recordOffset >= HEADER_BYTES && cursor.recordOffset <= extent
    && safe(cursor.sliceOffset) && cursor.sliceOffset <= PAGE_BYTES
    && (cursor.recordOffset !== extent || cursor.sliceOffset === 0)
}

/** Validates pages read under the caller's own artifact authority. Starting
 * at an arbitrary cursor proves continuation from that cursor only. */
export function createExecFramePageValidator(original: ManagedArtifactRef, start?: ExecFrameCursor) {
  if (!validManagedArtifactRef(original) || original.codec !== 'exec-frames-v1' || original.encodedBytes < HEADER_BYTES) bad()
  const ref = Object.freeze({ ...original })
  const initial = start === undefined || (start?.recordOffset === 0 && start?.sliceOffset === 0)
    ? { recordOffset: HEADER_BYTES, sliceOffset: 0 } : start
  if (!validCursor(initial, ref.encodedBytes)) bad()
  let cursor = { ...initial }, ended = false
  let preceding: { frame: number; channel: string; next: number; end: boolean } | undefined

  return {
    get cursor(): ExecFrameCursor { return { ...cursor } },
    validate(input: unknown): ExecFramePage {
      if (ended || !input || typeof input !== 'object' || Array.isArray(input)) return bad()
      const page = input as ExecFramePage
      if (!validManagedArtifactRef(page.ref) || !sameManagedArtifactRef(ref, page.ref) || !validCursor(page.cursor, ref.encodedBytes)
        || page.cursor.recordOffset !== cursor.recordOffset || page.cursor.sliceOffset !== cursor.sliceOffset
        || typeof page.eof !== 'boolean' || !Array.isArray(page.frames) || Buffer.byteLength(JSON.stringify(page)) > PAGE_BYTES
        || page.eof !== (page.nextCursor === null)) return bad()
      const next = page.nextCursor
      if (next !== null && (!validCursor(next, ref.encodedBytes) || next.recordOffset >= ref.encodedBytes
        || next.recordOffset < cursor.recordOffset || next.recordOffset === cursor.recordOffset && next.sliceOffset <= cursor.sliceOffset)) return bad()
      if (page.frames.length === 0 ? !page.eof || cursor.recordOffset !== ref.encodedBytes : cursor.recordOffset === ref.encodedBytes) return bad()

      let position = cursor.recordOffset, slice = cursor.sliceOffset, previous = preceding
      for (const [index, part] of page.frames.entries()) {
        if (!part || !['stdout', 'stderr'].includes(part.channel) || !safe(part.frame) || !safe(part.offset) || typeof part.end !== 'boolean'
          || typeof part.data !== 'string' || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(part.data)) return bad()
        const bytes = Buffer.from(part.data, 'base64')
        if (bytes.toString('base64') !== part.data || slice + bytes.length > PAGE_BYTES || part.offset < slice
          || !safe(part.offset + bytes.length) || !bytes.length && (!part.end || part.offset !== 0)) return bad()
        if (previous ? part.frame === previous.frame
          ? previous.end || part.channel !== previous.channel || part.offset !== previous.next
          : part.frame <= previous.frame || !previous.end || part.offset !== 0
          : cursor.recordOffset === HEADER_BYTES && part.offset !== cursor.sliceOffset) return bad()

        const partial = index === page.frames.length - 1 && next?.recordOffset === position
        if (partial) {
          if (part.end) return bad()
          slice += bytes.length
        } else {
          const record = encodeExecFrameRecord({ ...part, offset: part.offset - slice, data: '' })
          position += Buffer.byteLength(record) + 4 * Math.ceil((slice + bytes.length) / 3)
          if (!safe(position) || position > ref.encodedBytes) return bad()
          slice = 0
        }
        previous = { frame: part.frame, channel: part.channel, next: part.offset + bytes.length, end: part.end }
      }
      if (next === null) {
        if (position !== ref.encodedBytes || slice || previous && !previous.end && ref.completeness === 'complete') return bad()
        ended = true
      } else {
        if (next.recordOffset !== position || next.sliceOffset !== slice) return bad()
        cursor = { ...next }
      }
      preceding = previous
      return page
    },
  }
}

export async function* validatedExecFramePages(original: ManagedArtifactRef, read: (cursor: ExecFrameCursor, maxBytes: number) => Promise<ExecFramePage>, signal?: AbortSignal): AsyncGenerator<ExecFramePage> {
  const validator = createExecFramePageValidator(original)
  for (;;) {
    signal?.throwIfAborted()
    const page = await read(validator.cursor, PAGE_BYTES)
    signal?.throwIfAborted()
    validator.validate(page)
    if (page.eof) {
      signal?.throwIfAborted()
      yield page
      return
    }
    yield page
  }
}
