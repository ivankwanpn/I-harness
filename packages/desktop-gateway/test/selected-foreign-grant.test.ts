import {it,expect} from 'vitest'
import {createGatewayForkFixture} from './helpers/fork-fixture.ts'
import {createSelectedResultsIntent,readSelectedResultsCore,readSelectedResultsOperation} from '../../session-persistence/src/selected-results-fork-contract.ts'
it('does not adopt a preexisting equal target owner grant as its own transfer',async()=>{
 const f=await createGatewayForkFixture();try{
  await f.runtime.contextOutput.configure({enabled:true});const source=await f.runtime.sourceFor('source'),ref=await f.runtime.contextOutput.capture({sessionId:'source',callId:'legacy',label:'selected',text:'retained',complete:true,source});if(!ref)throw Error('Legacy source unavailable')
  await f.runtime.contextOutput.grant({sessionId:'source'},[ref.id],'target')
  await f.coordinator.append('source',[{type:'turn/start'},{type:'user/message',text:'selected'},{type:'step/start'},{type:'tool/call',callId:'legacy',name:'read',args:{}},{type:'assistant/message',text:''},{type:'tool/result',callId:'legacy',name:'read',output:'done'},{type:'step/end'},{type:'context/result-ref',ref},{type:'turn/end'}])
  const core=readSelectedResultsCore({version:2,kind:'session-fork-core',sourceSessionId:'source',selection:{kind:'completed'},sourceCapture:'first-authorized-capture',metadata:{},results:'selected-results-v1'}),{intent,requestDigest}=createSelectedResultsIntent(core,{kind:'project',projectId:'p'}),operation=readSelectedResultsOperation({version:2,kind:'session-fork-operation',prepared:{version:2,kind:'session-fork-prepared',core,requestIntent:intent,requestDigest},invocation:{version:1,operationId:'selected-foreign-grant',targetSessionId:'target',createdAt:'2026-10-28T00:00:00.000Z',requestDigest}}),holder=f.runtime.createSelectedSourceHolder(operation)
  expect((await holder.captureFirst()).kind).toBe('captured');expect((await holder.publishWarm()).kind).toBe('blocked');await expect(f.coordinator.openManagedDocument('target')).rejects.toThrow();await holder.close()
 }finally{await f.close()}
},60000)
