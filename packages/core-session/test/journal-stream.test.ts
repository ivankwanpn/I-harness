import { expect, it } from 'vitest'
import { createJournalStreamDecoder, encodeFactBatch, legacyPrefixDigest, readFactJournal } from '../src/serialization/fact-journal.ts'

it('matches the original decoder across every byte boundary and ignores a torn suffix', () => {
  const legacy = Buffer.from('{"type":"turn/end","seq":0}\n')
  const metadata = { version: 1 as const, legacyBodyBytes: legacy.length, legacyEventCount: 1, legacyPrefixDigest: legacyPrefixDigest(1, legacy), separatorBytes: 0 as const }
  const frame = encodeFactBatch('x', metadata.legacyPrefixDigest, [{ type: 'turn/end', seq: 1 }])
  const body = Buffer.concat([legacy, frame.bytes, Buffer.from('{"unfinished":"é')])
  const expected = readFactJournal(body, metadata)
  const events: unknown[] = []
  const decoder = createJournalStreamDecoder(metadata, 6, unit => events.push(...unit))
  for (const byte of body) decoder.push(Uint8Array.of(byte))
  expect({ events, ...decoder.finish() }).toEqual(expected)
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
