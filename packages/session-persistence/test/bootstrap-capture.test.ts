import { expect, it } from 'vitest'
import { createJsonlBackend } from '@i-harness/session-persistence-jsonl'
import { createSessionCoordinator, createBootstrapRequestIntent, readForkRequestCore, captureBootstrapCaptureRequest, encodeBootstrapCaptureReservation, parseBootstrapCaptureReservation } from '../src/index.ts'
const core = () => readForkRequestCore({ version: 1, kind: 'session-fork-core', sourceSessionId: 'source', selection: { kind: 'completed' }, sourceCapture: 'first-authorized-capture', metadata: {} })
function request() { const value=core(), intent=createBootstrapRequestIntent(value,{kind:'unmanaged'});return {invocation:{version:1 as const,operationId:'op',targetSessionId:'target',createdAt:'2026-10-26T00:00:00.000Z',requestDigest:intent.requestDigest},core:value,requestIntent:intent.intent} }
it('P01 recomputes the complete intent binding and canonical reservation bytes',()=>{
  const r=request(),reservation={version:1 as const,kind:'semantic-bootstrap-capture' as const,request:r}
  expect(parseBootstrapCaptureReservation(encodeBootstrapCaptureReservation(reservation))).toEqual(reservation)
  expect(()=>parseBootstrapCaptureReservation(Buffer.from(JSON.stringify(reservation)+'\n'))).toThrow()
  expect(()=>captureBootstrapCaptureRequest({...r,core:{...r.core,metadata:{title:'changed'}}})).toThrow()
  expect(()=>captureBootstrapCaptureRequest(new Proxy(r,{}))).toThrow()
  expect(()=>captureBootstrapCaptureRequest({...r,invocation:{...r.invocation,targetSessionId:'../target'}})).toThrow()
  expect(()=>captureBootstrapCaptureRequest({...r,extra:undefined})).toThrow()
})
it.each(['checkBootstrapCaptureRoot','readBootstrapCapture','prepareBootstrapCapture','settleBootstrapCaptureIO','prepareBootstrapHeader','reconcileBootstrapHeader','readBootstrapState','confirmBootstrapFrames','appendOwnedBatch','reconcileOwnedBatch'])('P01 exposes both optional entries only with complete backend gate (%s missing)',name=>{
  const backend=createJsonlBackend('unused-capture-gate',{wrap(original){delete (original as unknown as Record<string,unknown>)[name]}})
  const c=createSessionCoordinator(backend,{lock:{enabled:true}})
  expect(c.inspectBootstrapCapture).toBeUndefined();expect(c.bootstrapSemanticTargetWithCapture).toBeUndefined()
})
it('P01 disables the optional entries without exclusive ownership',()=>{
  const c=createSessionCoordinator(createJsonlBackend('unused-capture-gate'))
  expect(c.inspectBootstrapCapture).toBeUndefined();expect(c.bootstrapSemanticTargetWithCapture).toBeUndefined()
})
