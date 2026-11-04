import type { ExecFrameCursor, ManagedArtifactRef } from '@i-harness/core-session'
import type { ExecFramePage } from './exec-reader.ts'
import { validatedExecFramePages } from './exec-validation.ts'

export class ExecTextWindowError extends Error {
  constructor(readonly code: 'invalid-range' | 'text-view-unavailable') { super(code) }
}
/** Authenticated O(prefix + window) traversal, retaining one page and scalar carry.
 * Decode stdout only, including the discarded prefix. BOM is an ordinary scalar. */
export async function readExecTextWindow(ref: ManagedArtifactRef, total: number, offset: number, budget: number,
  read: (cursor: ExecFrameCursor, maxBytes: number) => Promise<ExecFramePage>, signal?: AbortSignal): Promise<{ text: string; next: number }> {
  if (![total, offset, budget].every(Number.isSafeInteger) || total < 0 || offset < 0 || offset > total || budget < 0) throw new ExecTextWindowError('invalid-range')
  const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })
  let position = 0, scalarStart = 0, text = '', admitted = 0
  const bad = (): never => { throw new ExecTextWindowError('text-view-unavailable') }
  const consume = (decoded: string): { text: string; next: number } | undefined => {
    for (const scalar of decoded) {
      const width = Buffer.byteLength(scalar)
      if (position + width > total) bad()
      position += width
      if (scalarStart < offset && position > offset) throw new ExecTextWindowError('invalid-range')
      if (scalarStart >= offset) {
        const length = position - scalarStart
        if (admitted + length > budget) return { text, next: offset + admitted }
        text += scalar; admitted += length
        if (admitted === budget && position < total) return { text, next: offset + admitted }
      }
      scalarStart = position
    }
    return undefined
  }
  for await (const page of validatedExecFramePages(ref, read, signal)) {
    for (const part of page.frames) {
      if (part.channel !== 'stdout') continue
      const bytes = Buffer.from(part.data, 'base64')
      // Decode in chunks: the byte-at-a-time walk below paid one TextDecoder
      // call (and one Uint8Array allocation) per byte of the prefix.
      for (let start = 0; start < bytes.length; start += 8192) {
        signal?.throwIfAborted()
        if (position >= total) bad()
        let decoded: string
        try { decoded = decoder.decode(bytes.subarray(start, Math.min(start + 8192, bytes.length)), { stream: true }) } catch { return bad() }
        const window = consume(decoded)
        if (window) return window
      }
    }
    if (page.eof) {
      let tail: string
      try { tail = decoder.decode() } catch { return bad() }
      const window = consume(tail)
      if (window) return window
      if (position !== total) bad()
      return { text, next: offset + admitted }
    }
  }
  return bad()
}
