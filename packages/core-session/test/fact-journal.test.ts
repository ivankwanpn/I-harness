import { expect, it } from 'vitest'
import { createHash } from 'node:crypto'
import * as core from '../src/index.ts'

it('uses the fixed envelope and source JSON property order with literal UTF8/LF bytes', () => {
  const previous = '00'.repeat(32)
  const events = [{ type: 'tool/call' as const, callId: 'c', name: 'f', args: { z: 1, a: 2 }, seq: 7 }]
  const body = '{"batchId":"b","firstSeq":7,"count":1,"previousPrefixDigest":"' + previous + '","events":[{"type":"tool/call","callId":"c","name":"f","args":{"z":1,"a":2},"seq":7}]}'
  const digest = createHash('sha256').update('ih.fact-batch.v1\0').update(body).digest('hex')
  const prefix = createHash('sha256').update('ih.fact-prefix.v1\0').update(Buffer.alloc(32)).update(Buffer.from(digest, 'hex')).digest('hex')
  const encoded = core.encodeFactBatch('b', previous, events)
  expect(Buffer.from(encoded.bytes).toString('utf8')).toBe('{"recordKind":"session/fact-batch","version":1,' + body.slice(1, -1) + ',"batchDigest":"' + digest + '","prefixDigest":"' + prefix + '"}\n')
  expect(core.decodeFactBatch(encoded.bytes).events).toEqual(events)
  expect(() => core.decodeFactBatch(encoded.bytes.subarray(0, encoded.bytes.length - 1))).toThrow(/frame/i)
  expect(() => core.decodeFactBatch(Buffer.from(Buffer.from(encoded.bytes).toString('utf8').replace('"z":1,"a":2', '"a":2,"z":1')))).toThrow(/digest|frame/i)
})

it('does not activate any event from an incomplete group and preserves literal $ref arguments', () => {
  const previous = core.legacyPrefixDigest(0, new Uint8Array())
  const encoded = core.encodeFactBatch('b', previous, [{ type: 'tool/call', callId: 'c', name: 'f', args: { $ref: { kind: 'group', position: 99 } }, seq: 0 }, { type: 'turn/end', seq: 1 }])
  const metadata = { version: 1 as const, legacyBodyBytes: 0, legacyEventCount: 0, legacyPrefixDigest: previous, separatorBytes: 0 as const }
  expect(core.readFactJournal(encoded.bytes.subarray(0, encoded.bytes.length - 2), metadata).events).toEqual([])
  expect(core.readFactJournal(encoded.bytes, metadata).events[0]).toEqual({ type: 'tool/call', callId: 'c', name: 'f', args: { $ref: { kind: 'group', position: 99 } }, seq: 0 })
})
