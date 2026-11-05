import { it,expect } from 'vitest'
import { mkdtemp } from 'node:fs/promises'
import { join } from 'node:path'
import { createJsonlBackend } from '@i-harness/session-persistence-jsonl'
import { createSessionCoordinator } from './helpers/composed.ts'
import { selectedSourceFor } from '../src/selected-source-owner.ts'
it('uses the original coordinator binding and managed witness and rejects copied coordinators',async()=>{
 const root=await mkdtemp(join(process.env.IH_NATIVE_DEPENDENCY_EVIDENCE_ROOT!,'source-forward-')),coordinator=createSessionCoordinator(createJsonlBackend(root),{lock:{enabled:true}})
 try{await coordinator.create({sessionId:'source'});const document=await coordinator.openManagedDocument('source'),owner=selectedSourceFor(coordinator);expect('captureSelected' in owner).toBe(false);expect(()=>selectedSourceFor({...coordinator})).toThrow();const binding=await owner.acquire({sessionIds:['source']});let calls=0;const witness=owner.retain(document,()=>{calls++;binding.revoke()});await binding.use(async()=>{expect(witness.view).toBe(document.view);witness.assertCurrent()});const writing=document.metadata.enterPlan('proposal');expect(calls).toBe(1);await writing;await binding.release();witness.unsubscribe()}finally{await coordinator.close()}
})
