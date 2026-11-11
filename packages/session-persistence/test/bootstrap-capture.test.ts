import { expect, it } from 'vitest'
import { createJsonlBackend } from '@i-harness/session-persistence-jsonl'
import { createSessionCoordinator, createReadOnlySessionCoordinator, SessionLockUnsupportedError, createBootstrapRequestIntent, readForkRequestCore, captureBootstrapCaptureRequest, encodeBootstrapCaptureReservation, parseBootstrapCaptureReservation } from '../src/index.ts'
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
it.each(['checkBootstrapCaptureRoot','readBootstrapCapture','prepareBootstrapCapture','settleBootstrapCaptureIO','prepareBootstrapHeader','reconcileBootstrapHeader','readBootstrapState','confirmBootstrapFrames','appendOwnedBatch','reconcileOwnedBatch'])('P01 original construction preserves the required or optional backend gate (%s missing)',async name=>{
  const backend=createJsonlBackend('unused-capture-gate',{wrap(original){delete (original as unknown as Record<string,unknown>)[name]}})
  const required=new Set(['prepareBootstrapHeader','reconcileBootstrapHeader','readBootstrapState','confirmBootstrapFrames','appendOwnedBatch','reconcileOwnedBatch'])
  if(required.has(name)){
    expect(()=>createSessionCoordinator(backend,{lock:{enabled:true}})).toThrow('Original writable JSONL capability unavailable: '+name)
    return
  }
  const c=createSessionCoordinator(backend,{lock:{enabled:true}})
  try{expect(c.inspectBootstrapCapture).toBeUndefined();expect(c.bootstrapSemanticTargetWithCapture).toBeUndefined()}finally{await c.close()}
})
it('P01 enables original ownership by default and refuses an explicitly disabled writer',async()=>{
  const backend=createJsonlBackend('unused-capture-gate'),c=createSessionCoordinator(backend),reader=createReadOnlySessionCoordinator(backend)
  try{
    expect(c.inspectBootstrapCapture).toBeTypeOf('function');expect(c.bootstrapSemanticTargetWithCapture).toBeTypeOf('function')
    expect(()=>createSessionCoordinator(backend,{lock:{enabled:false}})).toThrow(SessionLockUnsupportedError)
    expect(reader.access).toBe('read');expect('bootstrapSemanticTargetWithCapture'in reader).toBe(false)
  }finally{await c.close();await reader.close()}
})
