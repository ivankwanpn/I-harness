import { expect,it } from 'vitest'
import { mkdtemp } from 'node:fs/promises'
import { join } from 'node:path'
import { createBootstrapCaptureBackend } from '../src/backend/bootstrap-capture.ts'
import { heldFactOwner,issuingFactOwner } from '../../session-persistence/src/coordinator/fact-owner.ts'
import { createOwnership } from '../../session-persistence/src/coordinator/ownership.ts'
import { createSelectedResultsIntent,readSelectedResultsCore } from '../../session-persistence/src/selected-results-fork-contract.ts'
import { compileSelectedResultsSemanticSeed } from '../../session-persistence/src/semantic-seed.ts'
import { codecSeed } from '../../core-session/test/fixtures/selected-results.ts'
import { createSelectedCaptureAttempt } from '../../session-persistence/src/coordinator/selected-capture-attempt.ts'
it('reserves once and retains the original captured request for passive warm inspection',async()=>{
 const root=await mkdtemp(join(process.env.IH_NATIVE_DEPENDENCY_EVIDENCE_ROOT!,'b2-')),ownership=createOwnership({lockRoot:root},{lock:{enabled:true}}),claim=await ownership.pinOwnership('target'),held=heldFactOwner({sessionId:'target',incarnation:'one'},ownership,()=>claim.assertHeld()),issuer=issuingFactOwner(held,()=>held.assertHeld()),backend=createBootstrapCaptureBackend(id=>join(root,id+'.jsonl'),async()=>{},root)
 try{
  const core=readSelectedResultsCore({version:2,kind:'session-fork-core',sourceSessionId:'source',selection:{kind:'completed'},sourceCapture:'first-authorized-capture',metadata:{},results:'selected-results-v1'}),{intent,requestDigest}=createSelectedResultsIntent(core,{kind:'unmanaged'}),invocation={version:1 as const,operationId:'op',targetSessionId:'target',createdAt:'2026-10-28T00:00:00.000Z',requestDigest},route={protocol:'public-results-v1' as const,request:{invocation,core,requestIntent:intent}}
  let calls=0;const request={invocation,target:{kind:'new'},metadata:{},lineage:{origin:'fork',parentSession:'source'},seed:structuredClone(compileSelectedResultsSemanticSeed(codecSeed('public-completed')))}
  const attempt=createSelectedCaptureAttempt(backend,issuer,route,async()=>{calls++;return request})
  const [first,second]=await Promise.all([attempt.capture(),attempt.capture()]);expect(first.kind).toBe('captured');expect(second).toBe(first);expect(calls).toBe(1);expect(attempt.inspect()).toBe(first);if(first.kind==='captured'){const snapshot=JSON.stringify(first.seed);(request.seed.records as unknown as unknown[]).length=0;expect(JSON.stringify(first.seed)).toBe(snapshot);expect(Object.isFrozen(first.seed)).toBe(true)}
  let replay=0;const other=createSelectedCaptureAttempt(backend,issuer,route,async()=>{replay++;return request});expect((await other.capture()).kind).toBe('unavailable');expect((await other.capture()).kind).toBe('unavailable');expect(replay).toBe(0)
  await backend.settleBootstrapCaptureIO('target',held)
 }finally{await claim.release()}
})


it('spends the reservation if the original capture throws and never calls it again',async()=>{
 const root=await mkdtemp(join(process.env.IH_NATIVE_DEPENDENCY_EVIDENCE_ROOT!,'b2-spent-')),ownership=createOwnership({lockRoot:root},{lock:{enabled:true}}),claim=await ownership.pinOwnership('target'),held=heldFactOwner({sessionId:'target',incarnation:'two'},ownership,()=>claim.assertHeld()),issuer=issuingFactOwner(held,()=>held.assertHeld()),backend=createBootstrapCaptureBackend(id=>join(root,id+'.jsonl'),async()=>{},root)
 try {
  const core=readSelectedResultsCore({version:2,kind:'session-fork-core',sourceSessionId:'source',selection:{kind:'completed'},sourceCapture:'first-authorized-capture',metadata:{},results:'selected-results-v1'}),{intent,requestDigest}=createSelectedResultsIntent(core,{kind:'unmanaged'}),invocation={version:1 as const,operationId:'op',targetSessionId:'target',createdAt:'2026-10-28T00:00:00.000Z',requestDigest},route={protocol:'public-results-v1' as const,request:{invocation,core,requestIntent:intent}}
  let calls=0;const attempt=createSelectedCaptureAttempt(backend,issuer,route,async()=>{calls++;throw Error('source lost')})
  expect((await attempt.capture()).kind).toBe('spent');expect((await attempt.capture()).kind).toBe('spent');expect(attempt.inspect().kind).toBe('spent');expect(calls).toBe(1);await backend.settleBootstrapCaptureIO('target',held)
 }finally{await claim.release()}
})
