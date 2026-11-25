import { expect, it } from 'vitest'
import { createArchiveJournalHistoryDecoder, createJournalStreamDecoder, decodeFactBatch, encodeFactBatch, legacyPrefixDigest, readFactJournal } from '../src/serialization/fact-journal.ts'
import { CURRENT_FORMAT_VERSION } from '../src/events/types.ts'
import type { JournalFrameExtent } from '../src/serialization/archive-internal.ts'

it('matches the original decoder across every byte boundary and ignores a torn suffix', () => {
  const legacy = Buffer.from('{"type":"turn/end","seq":0}\n')
  const metadata = { version: 1 as const, legacyBodyBytes: legacy.length, legacyEventCount: 1, legacyPrefixDigest: legacyPrefixDigest(1, legacy), separatorBytes: 0 as const }
  const frame = encodeFactBatch('x', metadata.legacyPrefixDigest, [{ type: 'turn/end', seq: 1 }])
  const body = Buffer.concat([legacy, frame.bytes, Buffer.from('{"unfinished":"é')])
  const expected = readFactJournal(body, metadata)
  const events: unknown[] = [], extents: JournalFrameExtent[] = []
  const decoder = createJournalStreamDecoder(metadata, 6, unit => events.push(...unit), { onFrame: extent => extents.push(extent) })
  for (const byte of body) decoder.push(Uint8Array.of(byte))
  expect({ events, ...decoder.finish() }).toEqual(expected)
  expect(extents).toEqual([{ firstSeq: 1, count: 1, offset: legacy.length, length: frame.bytes.length }])
})

it('rejects complete corrupt frames but keeps an incomplete frame private', () => {
  const previous = legacyPrefixDigest(0, new Uint8Array())
  const metadata = { version: 1 as const, legacyBodyBytes: 0, legacyEventCount: 0, legacyPrefixDigest: previous, separatorBytes: 0 as const }
  const frame = Buffer.from(encodeFactBatch('x', previous, [{ type: 'turn/end', seq: 0 }]).bytes)
  const events: unknown[] = []
  const decoder = createJournalStreamDecoder(metadata, 6, unit => events.push(...unit))
  decoder.push(frame.subarray(0, -1))
  expect(decoder.finish().torn).toBe(true)
  expect(events).toEqual([])
  frame[20] ^= 1
  expect(() => createJournalStreamDecoder(metadata, 6, () => {}).push(frame)).toThrow()
})

it('rejects an invalid legacy digest and a missing declared separator', () => {
  const legacy = Buffer.from('{"type":"turn/end","seq":0}')
  const metadata = { version: 1 as const, legacyBodyBytes: legacy.length, legacyEventCount: 1, legacyPrefixDigest: legacyPrefixDigest(1, legacy), separatorBytes: 1 as const }
  const decoder = createJournalStreamDecoder(metadata, 6, () => {})
  decoder.push(legacy)
  expect(() => decoder.finish()).toThrow()
  const wrong = createJournalStreamDecoder({ ...metadata, legacyPrefixDigest: '00'.repeat(32) }, 6, () => {})
  expect(() => wrong.push(legacy)).toThrow()
})

it('owns the incomplete input across pushes and rejects noncanonical frames', () => {
  const previous = legacyPrefixDigest(0, new Uint8Array())
  const metadata = { version: 1 as const, legacyBodyBytes: 0, legacyEventCount: 0, legacyPrefixDigest: previous, separatorBytes: 0 as const }
  const events = [{ type: 'assistant/message', seq: 0, text: '保留文字' }] as const
  const frame = Buffer.from(encodeFactBatch('x', previous, events).bytes)
  const split = Math.floor(frame.length / 2)
  const first = Buffer.from(frame.subarray(0, split))
  const observed: unknown[] = []
  const decoder = createJournalStreamDecoder(metadata, 6, unit => observed.push(...unit))
  decoder.push(first)
  first.fill(0)
  decoder.push(frame.subarray(split))
  expect(decoder.finish().torn).toBe(false)
  expect(observed).toEqual(events)
  const noncanonical = Buffer.from(frame.toString('utf8').replace(',"events":', ', "events":'))
  expect(() => decodeFactBatch(noncanonical)).toThrow('Invalid fact journal')
})

function nativePrefix() {
  const previous = legacyPrefixDigest(0, new Uint8Array())
  const metadata = { version: 1 as const, legacyBodyBytes: 0, legacyEventCount: 0, legacyPrefixDigest: previous, separatorBytes: 0 as const }
  const first = encodeFactBatch('first', previous, [{ type: 'assistant/message', seq: 0, text: 'prior' }])
  const from = readFactJournal(first.bytes, metadata).prefix
  const suffix = encodeFactBatch('next', from.prefixDigest, [
    { type: 'assistant/message', seq: 1, text: '跨區塊 🌱' },
    { type: 'turn/end', seq: 2 },
  ])
  return { metadata, first, from, suffix }
}

it('validates the full shape before relational errors and never exposes an unvalidated archive', () => {
  const { metadata } = nativePrefix()
  const duplicate = [
    { type: 'conversation/semantics', version: 1, mode: 'accepted-exchange-v1', seq: 0 },
    { type: 'conversation/semantics', version: 1, mode: 'accepted-exchange-v1', seq: 1 },
  ] as const
  const malformed = { ...duplicate[1], mode: 'invalid' as typeof duplicate[1]['mode'], seq: 2 }
  const load = (events: Parameters<typeof encodeFactBatch>[2]) => {
    const decoder = createArchiveJournalHistoryDecoder(metadata, CURRENT_FORMAT_VERSION)
    const frame = encodeFactBatch('archive', metadata.legacyPrefixDigest, events)
    const header = { sessionId: 'archive' }
    decoder.push(frame.bytes)
    const finished = decoder.finish()
    expect(finished.frames).toEqual([{ firstSeq: 0, count: events.length, offset: 0, length: frame.bytes.length }])
    expect(finished).not.toHaveProperty('events')
    return () => finished.validatedEvents(header)
  }
  expect(load([...duplicate, malformed])).toThrow(/invalid semantics fence/)
  expect(load(duplicate)).toThrow(/duplicate semantics fence/)
  const valid = load(duplicate.slice(0, 1))
  expect(valid()).toEqual(duplicate.slice(0, 1))
  expect(valid).toThrow(/already consumed/)
})

it('resumes a verified native prefix and reports complete frames at absolute body offsets', () => {
  const { metadata, first, from, suffix } = nativePrefix()
  const last = encodeFactBatch('last', decodeFactBatch(suffix.bytes).prefixDigest, [{ type: 'turn/start', seq: 3 }])
  const events: unknown[] = [], extents: JournalFrameExtent[] = []
  const decoder = createJournalStreamDecoder(metadata, 6, unit => events.push(...unit), { from, onFrame: extent => extents.push(extent) })
  for (const byte of Buffer.concat([suffix.bytes, last.bytes])) decoder.push(Uint8Array.of(byte))
  const expected = readFactJournal(Buffer.concat([first.bytes, suffix.bytes, last.bytes]), metadata)
  expect({ events, ...decoder.finish() }).toEqual({ ...expected, events: expected.events.slice(1) })
  expect(extents).toEqual([
    { firstSeq: 1, count: 2, offset: first.bytes.length, length: suffix.bytes.length },
    { firstSeq: 3, count: 1, offset: first.bytes.length + suffix.bytes.length, length: last.bytes.length },
  ])
})

it('refuses an unrelated native chain and excludes a torn frame from resumed offsets', () => {
  const { metadata, from, suffix } = nativePrefix()
  const wrong = encodeFactBatch('unrelated', metadata.legacyPrefixDigest, [{ type: 'turn/end', seq: from.eventCount }])
  const extents: JournalFrameExtent[] = [], events: unknown[] = []
  const decoder = () => createJournalStreamDecoder(metadata, 6, unit => events.push(...unit), { from, onFrame: extent => extents.push(extent) })
  expect(() => decoder().push(wrong.bytes)).toThrow('Invalid fact journal')
  const torn = decoder()
  torn.push(suffix.bytes.subarray(0, -1))
  expect(torn.finish()).toEqual({ prefix: from, torn: true })
  expect(events).toEqual([])
  expect(extents).toEqual([])
})

it('requires native empty-legacy metadata and a closed resume prefix', () => {
  const { metadata, from } = nativePrefix()
  const legacy = Buffer.from('{"type":"turn/end","seq":0}')
  const withLegacy = { ...metadata, legacyBodyBytes: legacy.length, legacyEventCount: 1, legacyPrefixDigest: legacyPrefixDigest(1, legacy), separatorBytes: 1 as const }
  expect(() => createJournalStreamDecoder(withLegacy, 6, () => {}, { from })).toThrow('Invalid fact journal')
  expect(() => createJournalStreamDecoder({ ...metadata, legacyPrefixDigest: '00'.repeat(32) }, 6, () => {}, { from })).toThrow('Invalid fact journal')
  expect(() => createJournalStreamDecoder(metadata, 6, () => {}, { from: { ...from, bodyBytes: 0 } })).toThrow('Invalid fact journal')
  let accessed = false
  const accessor = { ...from, get bodyBytes() { accessed = true; return from.bodyBytes } }
  expect(() => createJournalStreamDecoder(metadata, 6, () => {}, { from: accessor })).toThrow('Invalid fact journal')
  expect(accessed).toBe(false)
})
