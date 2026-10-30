import {it,expect,vi} from 'vitest'
const cut=vi.hoisted(()=>({applied:false}))
vi.mock('node:fs/promises',async original=>{const fs=await original<typeof import('node:fs/promises')>();return {...fs,link:async(...args:Parameters<typeof fs.link>)=>{if(cut.applied&&String(args[1]).endsWith('applied.json')){cut.applied=false;throw Error('original applied publication cut')}return fs.link(...args)}}})
import {createGatewayForkFixture} from './helpers/fork-fixture.ts'
import {createSelectedResultsIntent,readSelectedResultsCore,readSelectedResultsOperation} from '../../session-persistence/src/selected-results-fork-contract.ts'
it('passively finishes the original issued V2 application after source revocation',async()=>{
 const f=await createGatewayForkFixture();try{
  await f.runtime.contextOutput.configure({enabled:true});const source=await f.runtime.sourceFor('source'),ref=await f.runtime.contextOutput.capture({sessionId:'source',callId:'legacy',label:'selected',text:'retained',complete:true,source});if(!ref)throw Error('Legacy source unavailable')
  await f.coordinator.append('source',[{type:'turn/start'},{type:'user/message',text:'selected'},{type:'step/start'},{type:'tool/call',callId:'legacy',name:'read',args:{}},{type:'assistant/message',text:''},{type:'tool/result',callId:'legacy',name:'read',output:'done'},{type:'step/end'},{type:'context/result-ref',ref},{type:'turn/end'}])
  const core=readSelectedResultsCore({version:2,kind:'session-fork-core',sourceSessionId:'source',selection:{kind:'completed'},sourceCapture:'first-authorized-capture',metadata:{},results:'selected-results-v1'}),{intent,requestDigest}=createSelectedResultsIntent(core,{kind:'project',projectId:'p'}),operation=readSelectedResultsOperation({version:2,kind:'session-fork-operation',prepared:{version:2,kind:'session-fork-prepared',core,requestIntent:intent,requestDigest},invocation:{version:1,operationId:'selected-passive-application',targetSessionId:'target',createdAt:'2026-10-28T00:00:00.000Z',requestDigest}}),holder=f.runtime.createSelectedSourceHolder(operation)
  expect((await holder.captureFirst()).kind).toBe('captured');expect((await holder.confirmTarget()).kind).toBe('confirmed');cut.applied=true;expect((await holder.confirmLegacyDependencies()).kind).toBe('blocked');expect(cut.applied).toBe(false)
  await (await f.coordinator.openManagedDocument('source')).metadata.enterPlan('revoke');const flush=vi.spyOn(f.coordinator,'flush');expect((await holder.reconcilePassive()).kind).toBe('committed');expect(flush).not.toHaveBeenCalled();flush.mockRestore();await holder.close()
 }finally{cut.applied=false;await f.close()}
},60000)
