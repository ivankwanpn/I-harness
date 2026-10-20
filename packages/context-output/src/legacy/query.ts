import { boundary, checkAbort, floorBoundary, serializedBytes } from '../bytes.ts'
import type { ContextStore } from '../store.ts'
import type { ContextReadResult, ContextResultRef, ContextSearchResult } from '../types.ts'

/** The legacy reader loads the captured body before applying its UTF-8 page. */
export async function readLegacy(
  id: string, offset: number, budget: number, owned: AbortSignal,
  readable: () => Promise<ContextResultRef>,
  readBytes: (id: string, signal: AbortSignal) => Promise<Buffer>,
): Promise<ContextReadResult> {
  const ref = await readable()
  const bytes = await readBytes(id, owned)
  if (offset > bytes.length || !boundary(bytes, offset)) throw new Error('offset must be an exact UTF-8 boundary within the captured output')
  const end = floorBoundary(bytes, offset + budget)
  if (end === offset && offset < bytes.length) throw new Error('read budget cannot fit the next UTF-8 character')
  return { ref, text: bytes.subarray(offset, end).toString('utf8'), offset, nextOffset: end < bytes.length ? end : null, eof: end === bytes.length }
}

/** Stateless query projection; candidate ordering, scan/output budgets and
 * authorization remain the original legacy algorithm. */
export async function searchLegacy(
  query: { terms: string[]; limit: number; maxBytes: number; filter?: Set<string> },
  getStore: (signal: AbortSignal) => Promise<ContextStore>,
  allowed: (ref: ContextResultRef, signal: AbortSignal) => Promise<boolean>,
  owned: AbortSignal,
): Promise<ContextSearchResult> {
  const { terms, limit, maxBytes, filter } = query
  const current = await getStore(owned)
  const result: ContextSearchResult = { hits: [], partial: false, reasons: [] }
  const mark = (reason: string) => { result.partial = true; if (!result.reasons.includes(reason)) result.reasons.push(reason) }
  const matchers = terms.map((term) => new RegExp(term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'iu'))
  let scannedBytes = 0
  for await (const { ref, verify } of current.candidates(terms, owned, mark)) {
    checkAbort(owned)
    if (filter && !filter.has(ref.id) || !await allowed(ref, owned) || !current.get(ref.id)) continue
    if (!ref.complete) mark('incomplete-capture')
    if (!verify) continue
    if (scannedBytes + ref.bytes > 32 * 1024 * 1024) { mark('scan-byte-budget'); break }
    scannedBytes += ref.bytes
    const bytes = await current.bytes(ref.id, owned)
    const text = bytes.toString('utf8')
    const matches = matchers.map((matcher) => matcher.exec(text))
    if (matches.some((match) => match === null)) continue
    if (result.hits.length >= limit) { mark('limit'); break }
    const first = matches.reduce((a, b) => a!.index <= b!.index ? a : b)!
    const offset = Buffer.byteLength(text.slice(0, first.index))
    const matchEnd = offset + Buffer.byteLength(first[0])
    let start = floorBoundary(bytes, Math.max(0, offset - 256))
    let end = floorBoundary(bytes, Math.min(bytes.length, matchEnd + 512))
    const hit = { ref, text: '', offset: start, endOffset: end }
    // Budget actual JSON including escape expansion, ref metadata, and
    // partial reasons. Shrink the surrounding window before dropping a hit.
    const previous = [...result.hits]
    while (true) {
      hit.offset = start; hit.endOffset = end; hit.text = bytes.subarray(start, end).toString('utf8')
      result.hits = [...previous, hit]
      if (serializedBytes(result) <= maxBytes) break
      mark('byte-budget')
      if (end > matchEnd) end = floorBoundary(bytes, Math.max(matchEnd, end - 32))
      else if (start < offset) {
        start = Math.min(offset, start + 32)
        while (!boundary(bytes, start)) start++
      } else { result.hits = previous; break }
    }
    if (result.reasons.includes('byte-budget')) break
  }
  // A reason added after earlier hits must itself remain inside the budget.
  while (serializedBytes(result) > maxBytes && result.hits.length) result.hits.pop()
  if (serializedBytes(result) > maxBytes) { result.reasons = ['byte-budget']; result.partial = true }
  checkAbort(owned)
  return result
}
