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
  for await (const page of validatedExecFramePages(ref, read, signal)) {
    for (const part of page.frames) {
      if (part.channel !== 'stdout') continue
      const bytes = Buffer.from(part.data, 'base64')
      for (const byte of bytes) {
        signal?.throwIfAborted()
        if (position >= total) bad()
        let scalar: string
        try { scalar = decoder.decode(Uint8Array.of(byte), { stream: true }) } catch { return bad() }
        position++
        if (!scalar) continue
        if (scalarStart < offset && position > offset) throw new ExecTextWindowError('invalid-range')
        if (scalarStart >= offset) {
          const length = position - scalarStart
          if (admitted + length > budget) return { text, next: offset + admitted }
          text += scalar; admitted += length
          if (admitted === budget && position < total) return { text, next: offset + admitted }
        }
        scalarStart = position
      }
    }
    if (page.eof) {
      if (position !== total) bad()
      try { decoder.decode() } catch { return bad() }
      return { text, next: offset + admitted }
    }
  }
  return bad()
}
