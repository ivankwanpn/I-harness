import { expect, it } from 'vitest'
import { createSelectedResultsIntent, readSelectedResultsCore } from '../src/selected-results-fork-contract.ts'
import { captureSelectedResultsCaptureRequest, encodeSelectedResultsReservation, parseSelectedResultsReservation } from '../src/coordinator/selected-results-intent.ts'

function fixture() {
  const core = readSelectedResultsCore({version:2,kind:'session-fork-core',sourceSessionId:'source',selection:{kind:'completed',atSeq:2},sourceCapture:'first-authorized-capture',metadata:{title:'雪 "hello"'},results:'selected-results-v1'})
  const {intent,requestDigest} = createSelectedResultsIntent(core,{kind:'project',projectId:'p'})
  return {invocation:{version:1,operationId:'op',targetSessionId:'target',createdAt:'2026-10-28T00:00:00.000Z',requestDigest},core,requestIntent:intent}
}
const reservation = (request: unknown) => ({version:1,kind:'semantic-bootstrap-selected-results-capture',request})
it('roundtrips canonical reservation bytes and captures detached frozen data', () => {
  const input = JSON.parse(JSON.stringify(fixture()))
  const captured = captureSelectedResultsCaptureRequest(input)
  const bytes = encodeSelectedResultsReservation(reservation(input))
  expect(parseSelectedResultsReservation(bytes)).toEqual(reservation(captured))
  expect(Buffer.from(bytes).toString('utf8')).toContain('雪 \\"hello\\"')
  input.core.metadata.title = 'changed'
  expect(captured.core.metadata.title).toBe('雪 "hello"')
  expect(Object.isFrozen(captured.core.metadata)).toBe(true)
})
it('binds both request commitments and rejects wrong routes or closed fields', () => {
  const f=fixture()
  for (const input of [{...f,version:1},{...f,core:{...f.core,sourceSessionId:'other'}},{...f,requestIntent:{...f.requestIntent,project:{kind:'unassigned'}}},{...f,invocation:{...f.invocation,requestDigest:'0'.repeat(64)}},{...f,invocation:{...f.invocation,targetSessionId:'source'}}]) expect(() => captureSelectedResultsCaptureRequest(input)).toThrow()
  expect(() => encodeSelectedResultsReservation({...reservation(f),kind:'semantic-bootstrap-child-capture'})).toThrow()
  expect(() => encodeSelectedResultsReservation({...reservation(f),version:2})).toThrow()
  let called=false
  expect(() => captureSelectedResultsCaptureRequest({...f,get core(){called=true;return f.core}})).toThrow()
  expect(called).toBe(false)
})
it('requires canonical UTF-8 and a trailing LF', () => {
  const bytes=encodeSelectedResultsReservation(reservation(fixture()))
  expect(() => parseSelectedResultsReservation(Buffer.from(Buffer.from(bytes).toString('utf8').trim()))).toThrow()
  expect(() => parseSelectedResultsReservation(Buffer.from([0xff]))).toThrow()
})

it('matches an independently generated canonical reservation digest', async () => {
  const { createHash } = await import('node:crypto')
  const bytes=encodeSelectedResultsReservation(reservation(fixture()))
  expect(bytes.length).toBe(704)
  expect(createHash('sha256').update(bytes).digest('hex')).toBe('849fc6eda87f3ec69c31161a250d3ecb32679f05afaf1dcdb6b7f578569c1cad')
})
it('rejects noncanonical encodings, hidden and symbol keys, and oversize bytes', () => {
  const f=fixture(), r=reservation(f), bytes=encodeSelectedResultsReservation(r)
  expect(() => parseSelectedResultsReservation(Buffer.concat([Buffer.from(' '),bytes]))).toThrow()
  expect(() => parseSelectedResultsReservation(new Uint8Array(262145))).toThrow()
  expect(() => captureSelectedResultsCaptureRequest({...f,[Symbol('extra')]:1})).toThrow()
  const hidden={...f}; Object.defineProperty(hidden,'extra',{value:1})
  expect(() => captureSelectedResultsCaptureRequest(hidden)).toThrow()
  expect(() => encodeSelectedResultsReservation({...r,extra:true})).toThrow()
})
