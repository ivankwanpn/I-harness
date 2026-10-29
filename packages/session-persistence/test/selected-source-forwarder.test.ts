import { it,expect } from 'vitest'
import { mkdtemp } from 'node:fs/promises'
import { join } from 'node:path'
import { createJsonlBackend } from '@i-harness/session-persistence-jsonl'
import { createSessionCoordinator } from '../src/index.ts'
import { selectedSourceFor } from '../src/selected-source-owner.ts'
it('uses the original coordinator binding and managed witness and rejects copied coordinators',async()=>{
 const root=await mkdtemp(join(process.env.IH_NATIVE_DEPENDENCY_EVIDENCE_ROOT!,'source-forward-')),coordinator=createSessionCoordinator(createJsonlBackend(root),{lock:{enabled:true}})
 try{await coordinator.create({sessionId:'source'});const document=await coordinator.openManagedDocument('source'),owner=selectedSourceFor(coordinator);expect(()=>selectedSourceFor({...coordinator})).toThrow();const binding=await owner.acquire({sessionIds:['source']});let calls=0;const witness=owner.retain(document,()=>{calls++;binding.revoke()});await binding.use(async()=>{expect(witness.view).toBe(document.view);witness.assertCurrent()});const writing=document.metadata.enterPlan('proposal');expect(calls).toBe(1);await writing;await binding.release();witness.unsubscribe()}finally{await coordinator.close()}
})
import { createSelectedResultsIntent,readSelectedResultsCore } from '../src/selected-results-fork-contract.ts'
it('refuses reentrant selected target capture before creating its registry entry',async()=>{
 const root=await mkdtemp(join(process.env.IH_NATIVE_DEPENDENCY_EVIDENCE_ROOT!,'selected-reentrant-')),coordinator=createSessionCoordinator(createJsonlBackend(root),{lock:{enabled:true}})
 try{await coordinator.create({sessionId:'target'});const owner=selectedSourceFor(coordinator),binding=await owner.acquire({sessionIds:['target']}),core=readSelectedResultsCore({version:2,kind:'session-fork-core',sourceSessionId:'source',selection:{kind:'completed'},sourceCapture:'first-authorized-capture',metadata:{},results:'selected-results-v1'}),{intent,requestDigest}=createSelectedResultsIntent(core,{kind:'unmanaged'}),route={protocol:'public-results-v1' as const,request:{core,requestIntent:intent,invocation:{version:1 as const,operationId:'op',targetSessionId:'target',createdAt:'2026-10-28T00:00:00.000Z',requestDigest}}}
 await binding.use(async()=>{expect(()=>owner.captureSelected(route,()=>{},async()=>({}))).toThrow()});await binding.release();expect(await coordinator.openManagedDocument('target')).toBeDefined()
 }finally{await coordinator.close()}
})
