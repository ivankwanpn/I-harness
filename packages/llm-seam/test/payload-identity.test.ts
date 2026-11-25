import { createHash } from "node:crypto"
import { expect, it } from "vitest"
import { createPreparedPayload, prepareModelRequest } from "../src/index.ts"
import { ProjectionCounter } from "@i-harness/token-meter"
import { createPreparedValidation, type FinalValidationPacket } from '../src/prepared/validation.ts'
const request = { systemPrompt: "", messages: [], tools: [] }
function prepare(body: Record<string, unknown>, sdk = false, observe?: (body: unknown, packet: FinalValidationPacket) => void) {
  return createPreparedPayload({ body, request, kind: sdk ? "sdk-command-estimate" : "http-json-body",
    ...(observe ? { validate(actual: Record<string, unknown>, packet: FinalValidationPacket) { observe(actual, packet); return { kind: 'accepted' as const, report: createPreparedValidation({ version: 1, route: 'custom', contract: 'neutral-only-v1', coverage: 'neutral-only', status: 'partial', native: 'unverified', issues: [], gaps: ['custom-client'], omittedIssueCount: 0 }) } } } : {}),
    describe(actual) {
      const counter = new ProjectionCounter("projected-pricing-v2")
      counter.structured("otherInput", actual)
      return { input: counter.finish({ protocol: "fixture", modelId: "m" }, actual, actual), packet: { sizeKind: sdk ? "sdk-command-estimate" as const : "http-json-body" as const, inlineBinaryBytes: 0, cacheMetadataBytes: 0, signatureBytes: 0 } }
    },
    output: () => ({ capSupport: "supported", minimumCap: 1, source: "request" }), cap: body => body,
    async *execute(_body, serialized) { yield { type: "text/chunk", text: serialized }; yield { type: "end" } },
  })
}
it("hashes the exact 11-byte UTF8 body and preserves source-order wire differences", async () => {
  const unicode = prepare({ x: "中" })
  expect(unicode.measurement.packet.bodyBytes).toBe(11)
  expect(unicode.measurement.payloadIdentity).toEqual({ version: 2, kind: "http-json-body", id: createHash("sha256").update("i-harness:projection:v2:http-json-body\0").update('{"x":"中"}').digest("hex") })
  const a = prepare({ b: 2, a: 1 }), b = prepare({ a: 1, b: 2 })
  expect(a.measurement.input.semanticIdentity).toEqual(b.measurement.input.semanticIdentity)
  expect(a.measurement.payloadIdentity?.id).not.toBe(b.measurement.payloadIdentity?.id)
  const sent = []; for await (const event of a.stream()) sent.push(event)
  expect(sent[0]).toEqual({ type: "text/chunk", text: '{"b":2,"a":1}' })
})
it("keeps typed SDK bytes distinct from arrays and user marker lookalikes", () => {
  const bytes = prepare({ x: new Uint8Array([1, 2]) }, true)
  const array = prepare({ x: [1, 2] }, true), lookalike = prepare({ x: { type: "bytes", data: "AQI=" } }, true)
  expect(bytes.measurement.payloadIdentity?.kind).toBe("sdk-command-estimate")
  const literal = '["object",[["x",["bytes","AQI="]]]]'
  expect(bytes.measurement.packet.sdkCommandBytesEstimate).toBe(Buffer.byteLength(literal))
  expect(bytes.measurement.payloadIdentity?.id).toBe(createHash("sha256").update("i-harness:projection:v2:sdk-command-estimate\0").update(literal).digest("hex"))
  expect(bytes.measurement.payloadIdentity?.id).not.toBe(array.measurement.payloadIdentity?.id)
  expect(bytes.measurement.payloadIdentity?.id).not.toBe(lookalike.measurement.payloadIdentity?.id)
  expect(bytes.measurement.payloadIdentity?.id).not.toBe(prepare({ x: ["bytes", "AQI="] }, true).measurement.payloadIdentity?.id)
  expect(bytes.measurement.packet.bodyBytes).toBeUndefined()
})
it("preserves captured SDK Date values as typed command data", () => {
  const a = prepare({ x: new Date("2026-01-01T00:00:00.000Z") }, true)
  const b = prepare({ x: new Date("2026-01-02T00:00:00.000Z") }, true)
  expect(a.measurement.payloadIdentity?.id).not.toBe(b.measurement.payloadIdentity?.id)
  expect(a.measurement.payloadIdentity?.id).not.toBe(prepare({ x: {} }, true).measurement.payloadIdentity?.id)
  expect(a.measurement.payloadIdentity?.id).not.toBe(prepare({ x: "2026-01-01T00:00:00.000Z" }, true).measurement.payloadIdentity?.id)
})
it("lowers toJSON once before description and execution", async () => {
  let calls = 0
  const prepared = prepare({ x: { toJSON() { calls++; return `value${calls}` } } })
  const events = []; for await (const event of prepared.stream()) events.push(event)
  expect(calls).toBe(1)
  expect(events[0]).toEqual({ type: "text/chunk", text: '{"x":"value1"}' })
})

it('keeps HTTP cap derivatives independent of callback mutations and preserves the measured wire bytes', async () => {
  const body = { cap: 512, argument: { text: 'original', requestScope: { id: 'scope' } } }
  const requests: { bytes: string; actual: string }[] = []
  const capScopes: object[] = []
  const prepared = createPreparedPayload({ body, request,
    describe(actual) {
      const counter = new ProjectionCounter()
      counter.structured('otherInput', actual)
      const input = counter.finish({ protocol: 'fixture', modelId: 'm' }, actual, actual)
      actual.argument.text = 'description scratch'
      return { input, packet: { sizeKind: 'http-json-body', inlineBinaryBytes: 0, cacheMetadataBytes: 0, signatureBytes: 0 } }
    },
    output(actual) { return { capSupport: 'supported', minimumCap: 1, effectiveCap: actual.cap, source: 'request' } },
    cap(actual, cap) {
      expect(actual.argument.text).toBe('original')
      capScopes.push(actual.argument.requestScope)
      actual.cap = cap!
      return actual
    },
    async *execute(actual, serialized) {
      requests.push({ bytes: serialized, actual: actual.argument.text })
      actual.argument.text = 'execution scratch'
      yield { type: 'end' }
    },
  })
  body.argument.text = 'caller scratch'
  const reduced = prepared.withOutputCap(128)
  const smaller = reduced.withOutputCap(64)
  const repeated = smaller.withOutputCap(128)
  expect(capScopes).toHaveLength(3)
  expect(capScopes.every(scope => scope === capScopes[0])).toBe(true)
  expect(capScopes[0]).not.toBe(body.argument.requestScope)
  expect(repeated.measurement).toEqual(reduced.measurement)

  for (const selected of [prepared, reduced, smaller, repeated, prepared]) {
    for await (const event of selected.stream()) expect(event.type).toBe('end')
    const sent = requests.at(-1)!
    const cap = selected.measurement.output.effectiveCap
    expect(sent).toEqual({ bytes: `{"cap":${cap},"argument":{"text":"original","requestScope":{"id":"scope"}}}`, actual: 'description scratch' })
    expect(selected.measurement.packet.bodyBytes).toBe(Buffer.byteLength(sent.bytes))
    expect(selected.measurement.payloadIdentity?.id).toBe(createHash('sha256').update('i-harness:projection:v2:http-json-body\0').update(sent.bytes).digest('hex'))
  }
})

it('keeps eager HTTP copies when the parser has been replaced', () => {
  const native = JSON.parse, receivers: unknown[] = []
  JSON.parse = function (this: typeof JSON, source, reviver) {
    if (source === '{"x":"parser fixture"}') receivers.push(this)
    return Reflect.apply(native, this, [source, reviver])
  }
  try { prepare({ x: 'parser fixture' }) }
  finally { JSON.parse = native }
  expect(receivers).toEqual([JSON, JSON])
})

it('gives validation the once-lowered actual body and the same measured packet discriminant/bytes', () => {
  let calls = 0
  const seen: { body: unknown; packet: FinalValidationPacket }[] = []
  const http = prepare({ x: { toJSON() { calls++; return '中' } } }, false, (body, packet) => seen.push({ body, packet }))
  expect(calls).toBe(1)
  expect(seen[0]).toEqual({ body: { x: '中' }, packet: { kind: 'http-json-body', bodyBytes: http.measurement.packet.bodyBytes } })
  const sdk = prepare({ x: new Uint8Array([1, 2]) }, true, (body, packet) => seen.push({ body, packet }))
  expect(seen[1]?.packet).toEqual({ kind: 'sdk-command-estimate', sdkCommandBytesEstimate: sdk.measurement.packet.sdkCommandBytesEstimate })
  expect(seen[1]?.packet).not.toHaveProperty('bodyBytes')
  expect((seen[1]?.body as { x: Uint8Array }).x).toBeInstanceOf(Uint8Array)
})
it("gives custom neutral fallback no invented protocol or payload identity", async () => {
  const prepared = await prepareModelRequest({ async *stream() { yield { type: "end" } } }, request)
  expect(prepared.measurement.input.semanticIdentity).toBeUndefined()
  expect(prepared.measurement.payloadIdentity).toBeUndefined()
})
