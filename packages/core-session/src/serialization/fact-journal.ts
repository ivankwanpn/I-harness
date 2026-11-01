import { validateDeliveryFrame } from '../conversation/delivery.ts'
import { isDeliveryEventType } from '../events/delivery.ts'
import { createHash } from 'node:crypto'
import type { SessionEvent } from '../events/types.ts'
import type { BatchKey, EncodedFactBatch, JournalMetadata, JournalPrefix } from '../managed/types.ts'
import { stringifyJsonData } from './json-data.ts'
import { validateConversationHistory, createBootstrapConversationIndex } from '../conversation/validation.ts'

const digestPattern = /^[a-f0-9]{64}$/
const fail = (): never => { throw new TypeError('Invalid fact journal frame or digest') }
const count = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0
const digest = (value: unknown): value is string => typeof value === 'string' && digestPattern.test(value)
const hash = (domain: string, ...parts: Uint8Array[]) => {
  const result = createHash('sha256').update(domain)
  for (const part of parts) result.update(part)
  return result.digest('hex')
}
const utf8 = (value: unknown) => Buffer.from(stringifyJsonData(value) ?? fail(), 'utf8')

export function legacyPrefixDigest(eventCount: number, body: Uint8Array): string {
  if (!count(eventCount)) fail()
  const size = Buffer.alloc(8)
  size.writeBigUInt64BE(BigInt(eventCount))
  return hash('ih.fact-legacy.v1\0', size, body)
}

export function validJournalMetadata(value: unknown): value is JournalMetadata {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const fields = Object.getOwnPropertyDescriptors(value)
  if (Object.keys(fields).length !== 5 || Object.values(fields).some(field => !('value' in field))) return false
  const row = value as JournalMetadata
  return row.version === 1 && count(row.legacyBodyBytes) && count(row.legacyEventCount)
    && digest(row.legacyPrefixDigest) && (row.separatorBytes === 0 || row.separatorBytes === 1)
}
export function factPrefixDigest(previousPrefixDigest: string, batchDigest: string): string {
  if (!digest(previousPrefixDigest) || !digest(batchDigest)) fail()
  return hash('ih.fact-prefix.v1\0', Buffer.from(previousPrefixDigest, 'hex'), Buffer.from(batchDigest, 'hex'))
}

export function validJournalPrefix(value: JournalPrefix): boolean {
  return count(value.eventCount) && count(value.bodyBytes) && digest(value.prefixDigest)
}

export function encodeFactBatch(batchId: string, previousPrefixDigest: string, events: readonly import('../managed/types.ts').SessionEventView[]): EncodedFactBatch {
  const firstSeq = events[0]?.seq, eventCount = events.length
  if (typeof batchId !== 'string' || !/^[\x21-\x7e]{1,256}$/.test(batchId) || !digest(previousPrefixDigest)
    || !count(firstSeq) || !eventCount || !count(firstSeq + eventCount)
    || events.some((event, position) => event.seq !== firstSeq + position)) fail()
  const core = { batchId, firstSeq, count: eventCount, previousPrefixDigest, events }
  const batchDigest = hash('ih.fact-batch.v1\0', utf8(core))
  const prefixDigest = factPrefixDigest(previousPrefixDigest, batchDigest)
  const bytes = Buffer.concat([utf8({ recordKind: 'session/fact-batch', version: 1, ...core, batchDigest, prefixDigest }), Buffer.from([0x0a])])
  return { key: Object.freeze({ batchId, firstSeq: firstSeq!, count: eventCount, previousPrefixDigest, batchDigest }), bytes }
}

export function decodeFactBatch(bytes: Uint8Array): { key: BatchKey; events: SessionEvent[]; prefixDigest: string } {
  const buffer = Buffer.from(bytes)
  if (buffer.at(-1) !== 0x0a) fail()
  let row: Record<string, unknown>
  try { row = JSON.parse(buffer.subarray(0, -1).toString('utf8')) } catch { fail() }
  if (!row! || row!.recordKind !== 'session/fact-batch' || row!.version !== 1 || !Array.isArray(row!.events)) fail()
  const encoded = encodeFactBatch(row!.batchId as string, row!.previousPrefixDigest as string, row!.events as SessionEvent[])
  if (row!.firstSeq !== encoded.key.firstSeq || row!.count !== encoded.key.count || !buffer.equals(Buffer.from(encoded.bytes))) fail()
  return { key: encoded.key, events: row!.events as SessionEvent[], prefixDigest: row!.prefixDigest as string }
}

/** Decodes complete frames only. A torn final envelope is a private suffix;
 * corrupt complete frames fail closed rather than shortening valid history. */
export function readFactJournal(body: Uint8Array, metadata: JournalMetadata, formatVersion = 6, header?: import('../conversation/generation.ts').GenerationHistoryScope) {
  const decoded = decodeJournal(body, metadata, formatVersion)
  validateConversationHistory(decoded.events, formatVersion, header)
  return { events: decoded.events, prefix: decoded.prefix, torn: decoded.torn }
}

/** Internal bootstrap composition only: same physical decoder, no repair. */
export function readBootstrapFactJournal(body: Uint8Array, metadata: JournalMetadata, formatVersion: number, header: import('../conversation/generation.ts').GenerationHistoryScope) {
  const decoded = decodeJournal(body, metadata, formatVersion)
  createBootstrapConversationIndex(decoded.events, undefined, formatVersion, header)
  return decoded
}
function decodeJournal(body: Uint8Array, metadata: JournalMetadata, formatVersion:number) {
  if (!validJournalMetadata(metadata)) fail()
  const buffer = Buffer.from(body), legacy = buffer.subarray(0, metadata.legacyBodyBytes)
  if (legacy.length !== metadata.legacyBodyBytes || legacyPrefixDigest(metadata.legacyEventCount, legacy) !== metadata.legacyPrefixDigest) fail()
  const events: SessionEvent[] = []
  for (const line of legacy.toString('utf8').split('\n')) {
    if (line.trim()) { try { events.push(JSON.parse(line)) } catch { fail() } }
  }
  if (events.length !== metadata.legacyEventCount || events.some(event => isDeliveryEventType(event.type) || event.type === 'agent/input/admitted' && ['session.delivery.subagent', 'session.delivery.exec'].includes(event.provenance?.producer ?? ''))) fail()
  let offset = metadata.legacyBodyBytes
  if (metadata.separatorBytes) { if (buffer[offset] !== 0x0a) fail(); offset++ }
  let prefixDigest = metadata.legacyPrefixDigest
  const frames: { prefix: JournalPrefix; batch: EncodedFactBatch }[] = []
  while (offset < buffer.length) {
    const end = buffer.indexOf(0x0a, offset)
    if (end < 0) break
    const frame = decodeFactBatch(buffer.subarray(offset, end + 1))
    validateDeliveryFrame(frame.events, formatVersion)
    if (frame.key.firstSeq !== events.length || frame.key.previousPrefixDigest !== prefixDigest) fail()
    frames.push({ prefix: { eventCount: events.length, bodyBytes: offset, prefixDigest }, batch: { key: frame.key, bytes: buffer.subarray(offset, end + 1) } })
    for (const event of frame.events) events.push(event)
    prefixDigest = frame.prefixDigest
    offset = end + 1
  }
  return { events, prefix: { eventCount: events.length, bodyBytes: offset, prefixDigest }, torn: offset !== buffer.length, frames }
}

/** Incremental physical decoding. The consumer is private and must not publish
 * its candidate until finish and the original whole-history validation succeed. */
export interface DecodedJournalStreamUnit {
  readonly kind: 'legacy' | 'batch'; readonly bodyOffset: number; readonly byteLength: number;
  readonly firstOrdinal: number; readonly count: number; readonly bytes: Uint8Array;
  readonly key?: BatchKey
}
export function createJournalStreamDecoder(metadata: JournalMetadata, formatVersion: number, consume: (events: SessionEvent[], unit: DecodedJournalStreamUnit) => void) {
  if (!validJournalMetadata(metadata)) fail()
  const size = Buffer.alloc(8); size.writeBigUInt64BE(BigInt(metadata.legacyEventCount))
  const legacyHash = createHash('sha256').update('ih.fact-legacy.v1\0').update(size)
  let legacyLeft = metadata.legacyBodyBytes, separatorLeft = metadata.separatorBytes
  let legacyChecked = false, legacyOffset = 0, eventCount = 0, bodyBytes = 0, prefixDigest = metadata.legacyPrefixDigest
  let parts: Buffer[] = [], partBytes = 0, finished = false
  function add(bytes: Uint8Array) { if (bytes.length) { parts.push(Buffer.from(bytes)); partBytes += bytes.length } }
  function take() { const result = Buffer.concat(parts, partBytes); parts = []; partBytes = 0; return result }
  function legacyLine(bytes: Buffer, rawLength = bytes.length) {
    const start = legacyOffset; legacyOffset += rawLength
    const line = bytes.toString('utf8')
    if (!line.trim()) return
    let event: SessionEvent
    try { event = JSON.parse(line) } catch { return fail() }
    if (isDeliveryEventType(event.type) || event.type === 'agent/input/admitted' && ['session.delivery.subagent', 'session.delivery.exec'].includes(event.provenance?.producer ?? '')) fail()
    const firstOrdinal = eventCount++; consume([event], {kind:'legacy',bodyOffset:start,byteLength:rawLength,firstOrdinal,count:1,bytes:rawLength===bytes.length?bytes:Buffer.concat([bytes,Buffer.from([10])])})
  }
  function checkLegacy() {
    if (legacyChecked) return
    if (partBytes) legacyLine(take())
    if (eventCount !== metadata.legacyEventCount || legacyHash.digest('hex') !== metadata.legacyPrefixDigest) fail()
    legacyChecked = true
  }
  function lines(input: Buffer, legacy: boolean) {
    let start = 0
    while (start < input.length) {
      const end = input.indexOf(10, start)
      if (end < 0) { add(input.subarray(start)); break }
      add(input.subarray(start, end + 1)); const record = take()
      if (legacy) legacyLine(record.subarray(0, -1), record.length)
      else {
        const frame = decodeFactBatch(record); validateDeliveryFrame(frame.events, formatVersion)
        if (frame.key.firstSeq !== eventCount || frame.key.previousPrefixDigest !== prefixDigest) fail()
        consume(frame.events,{kind:'batch',bodyOffset:bodyBytes,byteLength:record.length,firstOrdinal:eventCount,count:frame.events.length,bytes:record,key:frame.key}); eventCount += frame.events.length; prefixDigest = frame.prefixDigest; bodyBytes += record.length
      }
      start = end + 1
    }
  }
  return {
    push(bytes: Uint8Array) {
      if (finished) throw new TypeError('Journal decoder already finished')
      const input = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength)
      let offset = 0
      if (legacyLeft) {
        const length = Math.min(legacyLeft, input.length), chunk = input.subarray(0, length)
        legacyHash.update(chunk); lines(chunk, true); legacyLeft -= length; bodyBytes += length; offset += length
      }
      if (!legacyLeft) checkLegacy()
      if (separatorLeft && offset < input.length) { if (input[offset++] !== 10) fail(); separatorLeft = 0; bodyBytes++ }
      if (!legacyLeft && !separatorLeft && offset < input.length) lines(input.subarray(offset), false)
    },
    finish() {
      if (finished) throw new TypeError('Journal decoder already finished')
      finished = true
      if (legacyLeft || separatorLeft) fail()
      checkLegacy()
      return { prefix: { eventCount, bodyBytes, prefixDigest }, torn: partBytes !== 0 }
    },
  }
}
