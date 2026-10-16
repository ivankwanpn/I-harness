import { conversationSeq } from './conversation.ts'

export interface ConversationAddress { readonly seq: number; readonly part: string }
export interface ConversationItemRef { readonly kind: 'input' | 'exchange' | 'summary'; readonly at: ConversationAddress }
export interface ConversationCoverage { readonly item: ConversationItemRef; readonly sources: readonly ConversationAddress[] }
export interface ContextReplacementRecordV1 {
  readonly type: 'compaction/replacement'; readonly version: 1; readonly replacementId: string
  readonly coverage: readonly ConversationCoverage[]; readonly insertBefore: ConversationItemRef
  readonly text: string; readonly seq?: number
}
export type ReplacementReason = 'shape' | 'format' | 'unsafe-address' | 'duplicate-id' | 'missing-source' | 'coverage-mismatch' | 'noncontiguous' | 'incomplete-unit' | 'protected-source'
export function replacementFormatError(reason: ReplacementReason, seq?: number): never {
  throw Object.assign(new Error(`invalid context replacement: ${reason}`), {
    code: 'SESSION_CONTEXT_REPLACEMENT_FORMAT', reason, ...(conversationSeq(seq) ? { seq } : {}),
  })
}
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
const fields = (value: object, allowed: readonly string[]) => [Object.prototype, null].includes(Object.getPrototypeOf(value))
  && Reflect.ownKeys(value).every(key => typeof key === 'string' && allowed.includes(key)
    && Object.getOwnPropertyDescriptor(value, key)?.enumerable === true && Object.hasOwn(Object.getOwnPropertyDescriptor(value, key)!, 'value'))
export const addressKey = (value: ConversationAddress) => JSON.stringify([value.seq, value.part])
export const itemRefKey = (value: ConversationItemRef) => JSON.stringify([value.kind, value.at.seq, value.at.part])
export const compareAddresses = (a: ConversationAddress, b: ConversationAddress) => a.seq - b.seq || Buffer.compare(Buffer.from(a.part), Buffer.from(b.part))

/** Closed reader DTO; this deliberately creates no producer capability. */
export function validateReplacementShape(event: ContextReplacementRecordV1, format: number, assignedSeq?: number): void {
  const seq = assignedSeq ?? Object.getOwnPropertyDescriptor(event, 'seq')?.value
  if (format < 7) replacementFormatError('format', seq)
  if (!fields(event, ['type', 'version', 'replacementId', 'coverage', 'insertBefore', 'text', 'seq']) || event.version !== 1
    || typeof event.replacementId !== 'string' || !/^[\x00-\x7f]{1,256}$/.test(event.replacementId)
    || typeof event.text !== 'string' || !event.text.trim() || !Array.isArray(event.coverage) || !event.coverage.length) replacementFormatError('shape', seq)
  if (!conversationSeq(seq)) replacementFormatError('unsafe-address')
  const address = (value: unknown): value is ConversationAddress => object(value) && fields(value, ['seq', 'part'])
    && conversationSeq(value.seq) && value.seq < seq && typeof value.part === 'string' && value.part.length > 0 && Buffer.byteLength(value.part) <= 64
  const ref = (value: unknown): value is ConversationItemRef => object(value) && fields(value, ['kind', 'at'])
    && ['input', 'exchange', 'summary'].includes(value.kind as string) && address(value.at)
  if (!ref(event.insertBefore)) replacementFormatError('unsafe-address', event.seq)
  const items = new Set<string>()
  for (const coverage of event.coverage) {
    if (!object(coverage) || !fields(coverage, ['item', 'sources']) || !ref(coverage.item) || !Array.isArray(coverage.sources) || !coverage.sources.length) replacementFormatError('shape', event.seq)
    const key = itemRefKey(coverage.item)
    if (items.has(key) || !coverage.sources.every(address) || new Set(coverage.sources.map(addressKey)).size !== coverage.sources.length) replacementFormatError('unsafe-address', event.seq)
    items.add(key)
  }
}
