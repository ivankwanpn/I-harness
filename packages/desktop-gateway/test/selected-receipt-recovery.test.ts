import {it,expect,vi} from 'vitest'
import {join} from 'node:path'
import {createGatewayForkFixture} from './helpers/fork-fixture.ts'
import {createSelectedResultsIntent,readSelectedResultsCore,readSelectedResultsOperation} from '../../session-persistence/src/selected-results-fork-contract.ts'
import {readBootstrapFactJournal} from '@i-harness/core-session/internal/bootstrap'
it('refuses a forged selected seed receipt and recovers only the original issued frame',async()=>{
 const f=await createGatewayForkFixture();try{
  await f.coordinator.append('source',[{type:'turn/start'},{type:'user/message',text:'selected'},{type:'turn/end'}])
  const core=readSelectedResultsCore({version:2,kind:'session-fork-core',sourceSessionId:'source',selection:{kind:'completed'},sourceCapture:'first-authorized-capture',metadata:{},results:'selected-results-v1'}),{intent,requestDigest}=createSelectedResultsIntent(core,{kind:'project',projectId:'p'}),operation=readSelectedResultsOperation({version:2,kind:'session-fork-operation',prepared:{version:2,kind:'session-fork-prepared',core,requestIntent:intent,requestDigest},invocation:{version:1,operationId:'selected-forged-ack',targetSessionId:'target',createdAt:'2026-10-28T00:00:00.000Z',requestDigest}}),holder=f.runtime.createSelectedSourceHolder(operation),captured=await holder.captureFirst();if(captured.kind!=='captured')throw Error('Capture unavailable')
  const original=f.backend.selectedJournal.appendOwnedBatch.bind(f.backend.selectedJournal),spy=vi.spyOn(f.backend.selectedJournal,'appendOwnedBatch').mockImplementationOnce(async(...args)=>{const outcome=await original(...args);return outcome.kind==='committed'?{...outcome,receipt:{...outcome.receipt,owner:{...outcome.receipt.owner,incarnation:'forged'}}}:outcome})
  expect((await holder.publishWarm()).kind).toBe('blocked');spy.mockRestore()
  const {readFile}=await import('node:fs/promises'),path=join(f.sessions,'target.jsonl'),before=await readFile(path),meta=JSON.parse(captured.headerBytes);expect(readBootstrapFactJournal(before.subarray(Buffer.byteLength(captured.headerBytes)),meta.journal,meta.formatVersion,meta).frames).toHaveLength(1)
  await (await f.coordinator.openManagedDocument('source')).metadata.enterPlan('revoke');const flush=vi.spyOn(f.coordinator,'flush');expect((await holder.reconcilePassive()).kind).toBe('committed');expect(flush).not.toHaveBeenCalled();expect(await readFile(path)).toEqual(before);await expect(f.coordinator.openManagedDocument('target')).rejects.toThrow();flush.mockRestore();await holder.close()
 }finally{await f.close()}
},60000)
