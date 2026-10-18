import { decodeExecFrameRecord, type ExecFrameCursor, type ManagedArtifactRef } from '@i-harness/core-session'

export interface ExecFramePage {
  ref: ManagedArtifactRef; cursor: ExecFrameCursor; nextCursor: ExecFrameCursor | null; eof: boolean
  frames: { channel: 'stdout' | 'stderr'; frame: number; offset: number; end: boolean; data: string; text?: { kind: 'utf8-view'; text: string } }[]
}
export async function readExecFramePage(ref: ManagedArtifactRef, query: { cursor?: ExecFrameCursor; maxBytes?: number; textView?: boolean }, read: (offset: number, length: number) => Promise<Buffer>): Promise<ExecFramePage> {
  const cap = query.maxBytes ?? 32768, supplied = query.cursor ?? { recordOffset: 0, sliceOffset: 0 }
  if (ref.codec !== 'exec-frames-v1' || !Number.isSafeInteger(cap) || cap < 1 || cap > 32768 || ![supplied.recordOffset, supplied.sliceOffset].every(value => Number.isSafeInteger(value) && value >= 0)
    || supplied.recordOffset > ref.encodedBytes || supplied.sliceOffset > 32768) throw new Error('Artifact frame cursor range unavailable')
  if (ref.encodedBytes < 9 || !(await read(0, 9)).equals(Buffer.from('IHEXEC01\n'))) throw new Error('Artifact frame header corrupt')
  let position = supplied.recordOffset === 0 ? 9 : supplied.recordOffset, slice = supplied.sliceOffset
  if (position < 9 || supplied.recordOffset === 0 && slice !== 0 || (await read(position - 1, 1))[0] !== 10) throw new Error('Artifact frame cursor range unavailable')
  const cursor = { recordOffset: position, sliceOffset: slice }, frames: ExecFramePage['frames'] = []
  const page = (next: ExecFrameCursor | null): ExecFramePage => ({ ref, cursor, nextCursor: next, eof: next === null, frames })
  if (Buffer.byteLength(JSON.stringify(page(cursor))) > cap) throw new Error('Artifact frame budget cannot fit metadata')
  let window = Buffer.alloc(0), readOffset = position
  while (position < ref.encodedBytes) {
    let newline = window.indexOf(10)
    while (newline < 0) {
      const length = Math.min(45056 - window.length, ref.encodedBytes - readOffset)
      if (!length) throw new Error('Artifact frame record corrupt')
      window = Buffer.concat([window, await read(readOffset, length)]); readOffset += length
      newline = window.indexOf(10)
    }
    const lineBytes = window.subarray(0, newline + 1)
    let decoded: ReturnType<typeof decodeExecFrameRecord>
    try { decoded = decodeExecFrameRecord(new TextDecoder('utf-8', { fatal: true }).decode(lineBytes)) }
    catch { throw new Error('Artifact frame record corrupt') }
    const { record, bytes } = decoded
    if (slice > bytes.length || slice === bytes.length && bytes.length > 0) throw new Error('Artifact frame cursor range unavailable')
    const afterRecord = position + lineBytes.length
    const next = (length: number): ExecFrameCursor | null => slice + length < bytes.length ? { recordOffset: position, sliceOffset: slice + length } : afterRecord === ref.encodedBytes ? null : { recordOffset: afterRecord, sliceOffset: 0 }
    const part = (length: number): ExecFramePage['frames'][number] => {
      const raw = bytes.subarray(slice, slice + length), value: ExecFramePage['frames'][number] = { channel: record.channel, frame: record.frame, offset: record.offset + slice, end: record.end && slice + length === bytes.length, data: Buffer.from(raw).toString('base64') }
      if (query.textView) { try { value.text = { kind: 'utf8-view', text: new TextDecoder('utf-8', { fatal: true }).decode(raw) } } catch { /* Binary slices remain exact bytes. */ } }
      return value
    }
    let lower = 0, upper = bytes.length - slice
    while (lower < upper) {
      const middle = Math.ceil((lower + upper) / 2)
      frames.push(part(middle)); const fits = Buffer.byteLength(JSON.stringify(page(next(middle)))) <= cap; frames.pop()
      if (fits) lower = middle; else upper = middle - 1
    }
    frames.push(part(lower))
    if (Buffer.byteLength(JSON.stringify(page(next(lower)))) > cap || !lower && bytes.length > 0) {
      frames.pop()
      if (!frames.length) throw new Error('Artifact frame budget leaves no advancing page')
      return page({ recordOffset: position, sliceOffset: slice })
    }
    if (slice + lower < bytes.length) return page(next(lower))
    position = afterRecord; slice = 0; window = window.subarray(lineBytes.length)
  }
  if (slice !== 0) throw new Error('Artifact frame cursor range unavailable')
  return page(null)
}
