import { canonicalJsonData, type LLMContentPart, type LLMMessage } from '@i-harness/core-session'
import type { ReductionGroup } from '@i-harness/context-engine'
import { SummaryBlockedError } from '../summary-errors.ts'
import { recordedSegments, sourceHash, type RecordedSegment } from './source.ts'

type Cursor = { segment: number; offset: number }
export interface PageRange { segmentId: string; startByte: number; endByte: number; totalBytes: number; digest: string }
export interface RecordedPage {
  readonly sourceDigest: string
  readonly digest: string
  readonly start: Cursor
  readonly end: Cursor
  readonly ranges: readonly PageRange[]
  readonly textBytes: number
  readonly messages: LLMMessage[]
  readonly manifest: string
  readonly images: number
}
/** An attempt-local ledger. Only accepted physical exchanges may advance it. */
export class RecordedPages {
  readonly segments: readonly RecordedSegment[]
  readonly sourceDigest: string
  private cursor: Cursor = { segment: 0, offset: 0 }
  private readonly accepted: string[] = []
  constructor(private readonly groups: readonly ReductionGroup[]) {
    this.segments = recordedSegments(groups)
    this.sourceDigest = sourceHash(canonicalJsonData({ groups: groups.map(group => ({ id: group.id, coverage: group.coverage })), segments: this.segments.map(({ text, media, label, ...identity }) => identity) }))
  }
  get complete() { return this.cursor.segment === this.segments.length && this.cursor.offset === 0 }
  candidate(maximumBytes = 65536): RecordedPage {
    if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 1 || this.complete) throw new SummaryBlockedError('fixed-input')
    const start = { ...this.cursor }, end = { ...start }, ranges: PageRange[] = [], content: LLMContentPart[] = []
    let textBytes = 0, images = 0
    while (end.segment < this.segments.length) {
      const segment = this.segments[end.segment]!, remaining = maximumBytes - textBytes
      if (segment.text !== undefined && segment.totalBytes > 0 && remaining === 0) break
      // Keep a segment whole when it fits a fresh page; split only oversized segments.
      if (segment.text !== undefined && end.offset === 0 && textBytes > 0 && segment.totalBytes <= maximumBytes && segment.totalBytes > remaining) break
      const bytes = segment.text === undefined ? undefined : Buffer.from(segment.text)
      let until = bytes ? Math.min(bytes.length, end.offset + remaining) : segment.totalBytes
      if (bytes) while (until > end.offset && until < bytes.length && (bytes[until]! & 0xc0) === 0x80) until--
      if (bytes && until === end.offset && bytes.length) break
      const range = { segmentId: segment.segmentId, startByte: end.offset, endByte: until, totalBytes: segment.totalBytes, digest: segment.digest }
      ranges.push(range)
      const { sources, provenance, ...identity } = segment.source
      content.push({ type: 'text', text: JSON.stringify({ fragment: range, source: identity, ...(bytes ? { text: bytes.subarray(end.offset, until).toString('utf8') } : { mediaIdentity: segment.digest }) }) })
      if (segment.media) { content.push(segment.media); if (segment.media.type === 'image') images++ }
      textBytes += bytes ? until - end.offset : 0
      if (until === segment.totalBytes) { end.segment++; end.offset = 0 } else { end.offset = until; break }
    }
    if (!ranges.length) throw new SummaryBlockedError('fixed-input')
    const messages: LLMMessage[] = [{ role: 'user', content }]
    const digest = sourceHash(canonicalJsonData({ sourceDigest: this.sourceDigest, ranges, messages }))
    const itemRefs = new Set(ranges.map(range => canonicalJsonData(this.segments.find(segment => segment.segmentId === range.segmentId)!.source.itemRef)))
    const manifest = JSON.stringify({ mode: 'recorded-pages-v1', sourceDigest: this.sourceDigest, pageDigest: digest,
      framing: 'Ordered recorded source fragments. Ranges are UTF8 bytes, half-open. JSON arguments/results may be partial scalars; fragments are neither executable calls nor standalone completed results. Original group closure is retained by the host. Source authority remains as labeled.',
      groups: this.groups.map(group => ({ group: group.id, sources: group.coverage, items: group.items.filter(item => itemRefs.has(canonicalJsonData(item.ref ?? item.id))).map(item => ({ itemRef: item.ref ?? item.id, sources: item.sources, provenance: item.provenance, exchange: item.exchange })) })),
      fragments: ranges.map((range, index) => ({ ...range, message: 0, part: ranges.slice(0, index).reduce((n, previous) => n + (this.segments.find(segment => segment.segmentId === previous.segmentId)!.media ? 2 : 1), 0) })) })
    return Object.freeze({ sourceDigest: this.sourceDigest, digest, start, end, ranges: Object.freeze(ranges), textBytes, messages, manifest, images })
  }
  accept(page: RecordedPage): void {
    if (page.sourceDigest !== this.sourceDigest || canonicalJsonData(page.start) !== canonicalJsonData(this.cursor)
      || page.digest !== sourceHash(canonicalJsonData({ sourceDigest: page.sourceDigest, ranges: page.ranges, messages: page.messages })) || this.accepted.includes(page.digest)) throw new SummaryBlockedError('source-unrepresentable')
    const expected = this.candidate(Math.max(1, page.textBytes))
    if (page.digest !== expected.digest || canonicalJsonData(page.end) !== canonicalJsonData(expected.end) || page.manifest !== expected.manifest) throw new SummaryBlockedError('source-unrepresentable')
    this.accepted.push(page.digest); this.cursor = { ...page.end }
  }
}
