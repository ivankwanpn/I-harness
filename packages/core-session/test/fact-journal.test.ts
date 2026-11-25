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

it('keeps canonical v1 bytes across nested JSON keys, numbers and escaped strings', () => {
  const previous = '00'.repeat(32)
  const args = JSON.parse('{"z":1,"a":2,"10":"ten","2":"two","toJSON":"literal","__proto__":{"data":true},"number":1e+30}')
  args.text = 'x'.repeat(4095) + '🌱\uD800\\\n\uDC00 漢字'
  const events = [{ type: 'tool/call' as const, callId: 'c', name: 'f', args, seq: 0 }]
  const encoded = core.encodeFactBatch('b', previous, events)
  const source = Buffer.from(encoded.bytes).toString('utf8')
  const decoded = core.decodeFactBatch(encoded.bytes)
  expect(decoded.key).toEqual(encoded.key)
  expect(decoded.events).toEqual(events)
  expect(core.encodeFactBatch('b', previous, decoded.events).bytes).toEqual(encoded.bytes)
  expect(() => core.decodeFactBatch(Buffer.from(source.replace('"a":2', '"a":2.0')))).toThrow(/frame/i)
  expect(() => core.decodeFactBatch(Buffer.from(source.replace('"a":2', '"a":2,"a":2')))).toThrow(/frame/i)
})

it.each(['before decode', 'during frame validation'] as const)('preserves the encoder behavior if the array prototype chain changes %s', when => {
  const events = [{ type: 'turn/end' as const, seq: 0 }]
  const encoded = core.encodeFactBatch('b', '00'.repeat(32), events)
  const original = Object.getPrototypeOf(Array.prototype)
  const test = RegExp.prototype.test
  let serializerReads = 0
  const prototype = Object.create(original, {
    toJSON: { get() { serializerReads++; return undefined } },
  })
  let decoded: ReturnType<typeof core.decodeFactBatch>
  try {
    if (when === 'before decode') Object.setPrototypeOf(Array.prototype, prototype)
    else RegExp.prototype.test = function (input) {
      if (input === 'b') Object.setPrototypeOf(Array.prototype, prototype)
      return Reflect.apply(test, this, [input])
    }
    decoded = core.decodeFactBatch(encoded.bytes)
  } finally {
    RegExp.prototype.test = test
    Object.setPrototypeOf(Array.prototype, original)
  }
  expect(serializerReads).toBe(0)
  expect(decoded.events).toEqual(events)
})

it('still accepts deeply nested canonical frames written by the iterative encoder', () => {
  const depth = 16000
  const args = JSON.parse('{"data":'.repeat(depth) + 'null' + '}'.repeat(depth))
  const events = [{ type: 'tool/call' as const, callId: 'c', name: 'f', args, seq: 0 }]
  const encoded = core.encodeFactBatch('b', '00'.repeat(32), events)
  const decoded = core.decodeFactBatch(encoded.bytes)
  expect(decoded.key).toEqual(encoded.key)
  expect(core.encodeFactBatch('b', '00'.repeat(32), decoded.events).bytes).toEqual(encoded.bytes)
})

it('does not activate any event from an incomplete group and preserves literal $ref arguments', () => {
  const previous = core.legacyPrefixDigest(0, new Uint8Array())
  const encoded = core.encodeFactBatch('b', previous, [{ type: 'tool/call', callId: 'c', name: 'f', args: { $ref: { kind: 'group', position: 99 } }, seq: 0 }, { type: 'turn/end', seq: 1 }])
  const metadata = { version: 1 as const, legacyBodyBytes: 0, legacyEventCount: 0, legacyPrefixDigest: previous, separatorBytes: 0 as const }
  expect(core.readFactJournal(encoded.bytes.subarray(0, encoded.bytes.length - 2), metadata).events).toEqual([])
  expect(core.readFactJournal(encoded.bytes, metadata).events[0]).toEqual({ type: 'tool/call', callId: 'c', name: 'f', args: { $ref: { kind: 'group', position: 99 } }, seq: 0 })
})
