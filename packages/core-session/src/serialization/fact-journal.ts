import { createHash } from 'node:crypto'
import type { SessionEvent } from '../events/types.ts'
import type { BatchKey, EncodedFactBatch, JournalMetadata, JournalPrefix } from '../managed/types.ts'
import { stringifyJsonData } from './json-data.ts'
import { validateConversationHistory } from '../conversation/validation.ts'

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

export function encodeFactBatch(batchId: string, previousPrefixDigest: string, events: readonly SessionEvent[]): EncodedFactBatch {
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
export function readFactJournal(body: Uint8Array, metadata: JournalMetadata, formatVersion = 6) {
  if (!validJournalMetadata(metadata)) fail()
  const buffer = Buffer.from(body), legacy = buffer.subarray(0, metadata.legacyBodyBytes)
  if (legacy.length !== metadata.legacyBodyBytes || legacyPrefixDigest(metadata.legacyEventCount, legacy) !== metadata.legacyPrefixDigest) fail()
  const events: SessionEvent[] = []
  for (const line of legacy.toString('utf8').split('\n')) {
    if (line.trim()) { try { events.push(JSON.parse(line)) } catch { fail() } }
  }
  if (events.length !== metadata.legacyEventCount) fail()
  let offset = metadata.legacyBodyBytes
  if (metadata.separatorBytes) { if (buffer[offset] !== 0x0a) fail(); offset++ }
  let prefixDigest = metadata.legacyPrefixDigest
  while (offset < buffer.length) {
    const end = buffer.indexOf(0x0a, offset)
    if (end < 0) break
    const frame = decodeFactBatch(buffer.subarray(offset, end + 1))
    if (frame.key.firstSeq !== events.length || frame.key.previousPrefixDigest !== prefixDigest) fail()
    for (const event of frame.events) events.push(event)
    prefixDigest = frame.prefixDigest
    offset = end + 1
  }
  validateConversationHistory(events, formatVersion)
  return { events, prefix: { eventCount: events.length, bodyBytes: offset, prefixDigest }, torn: offset !== buffer.length }
}
