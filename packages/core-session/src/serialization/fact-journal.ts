import { validateDeliveryFrame } from '../conversation/delivery.ts'
import { isDeliveryEventType } from '../events/delivery.ts'
import { createHash } from 'node:crypto'
import { types } from 'node:util'
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
const { parse: nativeParse, stringify: nativeStringify } = JSON
const { getOwnPropertyDescriptor, getPrototypeOf, hasOwn } = Object
const { isArray } = Array
const objectPrototype = Object.prototype
const arrayPrototype = Array.prototype
const arraySome = arrayPrototype.some
const decodedEnvelopeFields = ['recordKind', 'version', 'events', 'batchId', 'previousPrefixDigest', 'firstSeq', 'count'] as const
const outerStart = Buffer.from('{"recordKind":"session/fact-batch","version":1,')
const eventKey = Buffer.from(',"events":')
const closeCore = Buffer.from('}')
const comma = Buffer.from(',')
const newline = Buffer.from('\n')

function hasNativeSerializer(): boolean {
  return getOwnPropertyDescriptor(JSON, 'stringify')?.value === nativeStringify
    && getPrototypeOf(objectPrototype) === null && getPrototypeOf(arrayPrototype) === objectPrototype
    && !getOwnPropertyDescriptor(objectPrototype, 'toJSON') && !getOwnPropertyDescriptor(arrayPrototype, 'toJSON')
}

const hasNativeSequenceCheck = () => getOwnPropertyDescriptor(arrayPrototype, 'some')?.value === arraySome

function canEncodeParsedFrame(row: unknown): boolean {
  if (!row || typeof row !== 'object' || !hasNativeSerializer()
    || getOwnPropertyDescriptor(Array, 'isArray')?.value !== isArray || !hasNativeSequenceCheck()) return false
  // Native parsing creates dense arrays and own JSON data properties. Require
  // every framing read to be own data too, so inherited getters cannot run
  // between parsing and canonical encoding.
  for (let i = 0; i < decodedEnvelopeFields.length; i++) {
    if (!hasOwn(row, decodedEnvelopeFields[i]!)) return false
  }
  const events = (row as { events: unknown }).events
  if (!isArray(events)) return false
  for (let i = 0; i < events.length; i++) {
    const event: unknown = events[i]
    if (!event || typeof event !== 'object' || typeof getOwnPropertyDescriptor(event, 'seq')?.value !== 'number') return false
  }
  return true
}

function utf8Parsed(value: unknown) {
  if (!hasNativeSerializer()) return utf8(value)
  let encoded: string | undefined
  try { encoded = nativeStringify(value) } catch (cause) {
    // The iterative encoder also accepts canonical frames whose depth exceeds
    // the native serializer's stack limit.
    if (!(cause instanceof RangeError)) throw cause
    return utf8(value)
  }
  return Buffer.from(encoded ?? fail(), 'utf8')
}

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

function factBatchParts(batchId: string, previousPrefixDigest: string, events: readonly import('../managed/types.ts').SessionEventView[], encode = utf8) {
  const firstSeq = events[0]?.seq, eventCount = events.length
  if (typeof batchId !== 'string' || !/^[\x21-\x7e]{1,256}$/.test(batchId) || !digest(previousPrefixDigest)
    || !count(firstSeq) || !eventCount || !count(firstSeq + eventCount)) return fail()
  if (encode === utf8Parsed && !hasNativeSequenceCheck()) encode = utf8
  if (events.some((event, position) => event.seq !== firstSeq + position)) fail()
  const coreHeader = encode({ batchId, firstSeq, count: eventCount, previousPrefixDigest }).subarray(0, -1)
  const encodedEvents = encode(events)
  // The digest covers the original v1 core object byte for byte. Reuse its
  // event representation in the outer frame instead of walking it again.
  const batchDigest = hash('ih.fact-batch.v1\0', coreHeader, eventKey, encodedEvents, closeCore)
  const prefixDigest = factPrefixDigest(previousPrefixDigest, batchDigest)
  const trailer = encode({ batchDigest, prefixDigest }).subarray(1)
  return {
    key: Object.freeze({ batchId, firstSeq, count: eventCount, previousPrefixDigest, batchDigest }),
    prefixDigest,
    parts: [outerStart, coreHeader.subarray(1), eventKey, encodedEvents, comma, trailer, newline],
  }
}

export function encodeFactBatch(batchId: string, previousPrefixDigest: string, events: readonly import('../managed/types.ts').SessionEventView[]): EncodedFactBatch {
  const { key, parts } = factBatchParts(batchId, previousPrefixDigest, events)
  return { key, bytes: Buffer.concat(parts) }
}

export function decodeFactBatch(bytes: Uint8Array): { key: BatchKey; events: SessionEvent[]; prefixDigest: string } {
  return decodeBatchBuffer(Buffer.from(bytes))
}

function decodeBatchBuffer(buffer: Buffer): ReturnType<typeof decodeFactBatch> {
  if (buffer.at(-1) !== 0x0a) fail()
  let row: Record<string, unknown>
  let parse: typeof nativeParse
  try {
    parse = JSON.parse
    const text = buffer.subarray(0, -1).toString('utf8')
    row = parse === nativeParse ? nativeParse(text) : Reflect.apply(parse, JSON, [text])
  } catch { return fail() }
  const encode = parse === nativeParse && canEncodeParsedFrame(row) ? utf8Parsed : utf8
  if (!row! || row!.recordKind !== 'session/fact-batch' || row!.version !== 1 || !Array.isArray(row!.events)) fail()
  const { key, prefixDigest, parts } = factBatchParts(row!.batchId as string, row!.previousPrefixDigest as string, row!.events as SessionEvent[], encode)
  if (row!.firstSeq !== key.firstSeq || row!.count !== key.count) fail()
  let offset = 0
  // Compare the canonical envelope directly. Validation needs all its bytes,
  // but replay never needs to allocate a second concatenated frame.
  for (const part of parts) {
    const end = offset + part.length
    if (!buffer.subarray(offset, end).equals(part)) fail()
    offset = end
  }
  if (offset !== buffer.length) fail()
  return { key, events: row!.events as SessionEvent[], prefixDigest }
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
  const frames: DecodedFrame[] = []
  const decoded = decodeJournal(body, metadata, formatVersion, frames)
  createBootstrapConversationIndex(decoded.events, undefined, formatVersion, header)
  return { ...decoded, frames }
}
type DecodedFrame = { prefix: JournalPrefix; batch: EncodedFactBatch }
function decodeJournal(body: Uint8Array, metadata: JournalMetadata, formatVersion: number, frames?: DecodedFrame[]) {
  if (!validJournalMetadata(metadata)) fail()
  const buffer = Buffer.from(body), legacy = buffer.subarray(0, metadata.legacyBodyBytes)
  if (legacy.length !== metadata.legacyBodyBytes || legacyPrefixDigest(metadata.legacyEventCount, legacy) !== metadata.legacyPrefixDigest) fail()
  const events: SessionEvent[] = []
  for (const line of legacy.toString('utf8').split('\n')) {
    if (line.trim()) { try { events.push(JSON.parse(line)) } catch { fail() } }
  }
  if (events.length !== metadata.legacyEventCount || events.some(event => isDeliveryEventType(event.type) || event.type === 'agent/input/admitted' && ['session.delivery.subagent', 'session.delivery.exec', 'session.delivery.workflow','session.delivery.code'].includes(event.provenance?.producer ?? ''))) fail()
  let offset = metadata.legacyBodyBytes
  if (metadata.separatorBytes) { if (buffer[offset] !== 0x0a) fail(); offset++ }
  let prefixDigest = metadata.legacyPrefixDigest
  while (offset < buffer.length) {
    const end = buffer.indexOf(0x0a, offset)
    if (end < 0) break
    const record = buffer.subarray(offset, end + 1)
    const frame = decodeBatchBuffer(record)
    validateDeliveryFrame(frame.events, formatVersion)
    if (frame.key.firstSeq !== events.length || frame.key.previousPrefixDigest !== prefixDigest) fail()
    frames?.push({ prefix: { eventCount: events.length, bodyBytes: offset, prefixDigest }, batch: { key: frame.key, bytes: record } })
    for (const event of frame.events) events.push(event)
    prefixDigest = frame.prefixDigest
    offset = end + 1
  }
  return { events, prefix: { eventCount: events.length, bodyBytes: offset, prefixDigest }, torn: offset !== buffer.length }
}

/** Complete native frame coordinates, relative to the journal body. */
export interface JournalFrameExtent {
  readonly firstSeq: number
  readonly count: number
  readonly offset: number
  readonly length: number
}

/** Incremental physical decoding. A resumed prefix must already have been
 * verified by the original archive reader. Publish only after finish. */
export function createJournalStreamDecoder(
  metadata: JournalMetadata,
  formatVersion: number,
  consume: (events: SessionEvent[]) => void,
  { from, onFrame }: { from?: Readonly<JournalPrefix>; onFrame?: (extent: JournalFrameExtent) => void } = {},
) {
  if (!validJournalMetadata(metadata)) fail()
  const size = Buffer.alloc(8); size.writeBigUInt64BE(BigInt(metadata.legacyEventCount))
  const legacyHash = createHash('sha256').update('ih.fact-legacy.v1\0').update(size)
  if (from !== undefined) {
    if (!from || types.isProxy(from) || ![Object.prototype, null].includes(Object.getPrototypeOf(from)) ||
        Reflect.ownKeys(from).length !== 3 ||
        ['eventCount', 'bodyBytes', 'prefixDigest'].some(key => !Object.hasOwn(Object.getOwnPropertyDescriptor(from, key) ?? {}, 'value')) ||
        !validJournalPrefix(from)) fail()
    if (metadata.legacyEventCount || metadata.legacyBodyBytes || metadata.separatorBytes ||
        legacyHash.digest('hex') !== metadata.legacyPrefixDigest ||
        (from.eventCount === 0) !== (from.bodyBytes === 0) ||
        (from.eventCount === 0 && from.prefixDigest !== metadata.legacyPrefixDigest)) fail()
  }
  let legacyLeft = metadata.legacyBodyBytes, separatorLeft = metadata.separatorBytes
  let legacyChecked = from !== undefined
  let eventCount = from?.eventCount ?? 0, bodyBytes = from?.bodyBytes ?? 0
  let prefixDigest = from?.prefixDigest ?? metadata.legacyPrefixDigest
  let parts: Buffer[] = [], partBytes = 0, finished = false
  function add(bytes: Uint8Array) { if (bytes.length) { parts.push(Buffer.from(bytes)); partBytes += bytes.length } }
  function take() { const result = parts.length === 1 ? parts[0]! : Buffer.concat(parts, partBytes); parts = []; partBytes = 0; return result }
  function legacyLine(bytes: Buffer) {
    const line = bytes.toString('utf8')
    if (!line.trim()) return
    let event: SessionEvent
    try { event = JSON.parse(line) } catch { return fail() }
    if (isDeliveryEventType(event.type) || event.type === 'agent/input/admitted' && ['session.delivery.subagent', 'session.delivery.exec', 'session.delivery.workflow','session.delivery.code'].includes(event.provenance?.producer ?? '')) fail()
    eventCount++; consume([event])
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
      // Unfinished lines own their fragments across pushes. Complete lines
      // are decoded synchronously while the current chunk is still in scope.
      let record = input.subarray(start, end + 1)
      if (partBytes) {
        add(record)
        record = take()
      }
      if (legacy) legacyLine(record.subarray(0, -1))
      else {
        const frame = decodeBatchBuffer(record); validateDeliveryFrame(frame.events, formatVersion)
        const nextBytes = bodyBytes + record.length
        if (frame.key.firstSeq !== eventCount || frame.key.previousPrefixDigest !== prefixDigest || !count(nextBytes)) fail()
        onFrame?.({ firstSeq: frame.key.firstSeq, count: frame.key.count, offset: bodyBytes, length: record.length })
        consume(frame.events); eventCount += frame.key.count; prefixDigest = frame.prefixDigest; bodyBytes = nextBytes
      }
      start = end + 1
    }
  }
  return {
    push(bytes: Uint8Array) {
      if (finished) throw new TypeError('Journal decoder already finished')
      const input = types.isSharedArrayBuffer(bytes.buffer) ? Buffer.from(bytes) : Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength)
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
