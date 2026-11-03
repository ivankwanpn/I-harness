import {it,expect} from 'vitest'
import {createHash} from 'node:crypto'
import {mkdir,writeFile} from 'node:fs/promises'
import {join} from 'node:path'
import {createGatewayForkFixture} from './helpers/fork-fixture.ts'
import {createSelectedResultsIntent,readSelectedResultsCore,readSelectedResultsOperation} from '../../session-persistence/src/selected-results-fork-contract.ts'
it('does not adopt foreign byte-equal selected managed publications',async()=>{
 const f=await createGatewayForkFixture();try{
  await f.runtime.contextOutput.configure({enabled:true});await f.coordinator.adoptOwnership('source')
  const source=await f.runtime.sourceFor('source'),current=(await f.projects.resultReadScopeFor('source'))!,scope=f.runtime.contextOutput.registerResultScope({operationId:'selected-producer',sessionId:'source',callId:'retained',source},()=>{current();return !!f.coordinator.ownerOf('source')}),sink=await f.runtime.contextOutput.beginResult(scope,'text-utf8-v1');await sink.write(Buffer.from('selected managed'));const saved=await sink.finish('complete');if(saved.kind!=='committed')throw Error('Original artifact unavailable')
  await f.coordinator.append('source',[{type:'turn/start'},{type:'user/message',text:'selected'},{type:'step/start'},{type:'tool/call',callId:'retained',name:'read',args:{}},{type:'assistant/message',text:''},{type:'tool/result',callId:'retained',name:'read',envelope:{version:1,execution:{outcome:'succeeded',dispatch:'dispatched'},preview:'',media:[],retention:{kind:'artifact',ref:saved.ref}}},{type:'step/end'},{type:'turn/end'}])
  const core=readSelectedResultsCore({version:2,kind:'session-fork-core',sourceSessionId:'source',selection:{kind:'completed'},sourceCapture:'first-authorized-capture',metadata:{},results:'selected-results-v1'}),{intent,requestDigest}=createSelectedResultsIntent(core,{kind:'project',projectId:'p'}),invocation={version:1 as const,operationId:'selected-foreign-managed',targetSessionId:'target',createdAt:'2026-10-28T00:00:00.000Z',requestDigest},operation=readSelectedResultsOperation({version:2,kind:'session-fork-operation',prepared:{version:2,kind:'session-fork-prepared',core,requestIntent:intent,requestDigest},invocation}),holder=f.runtime.createSelectedSourceHolder(operation),captured=await holder.captureFirst();if(captured.kind!=='captured')throw Error('Capture unavailable')
  expect((await holder.confirmTarget()).kind).toBe('confirmed')
  const sha=(value:string)=>createHash('sha256').update(value).digest('hex'),base=join(f.root,'native','context-output','context-output',sha(f.runtime.workspaceKey),'managed-v1',saved.ref.id),pinId=sha('target'),binding={operationId:invocation.operationId,manifestDigest:JSON.parse(captured.headerBytes).semanticSeed.manifestDigest,sourceSessionId:'source',targetSessionId:'target',targetDocumentId:'target'}
  const pin={version:1,documentId:'target',sessionId:'target',operationId:'selected-producer',revision:saved.ref.revision,state:'committed',seedTransfer:binding},access={version:1,sessionId:'target',revision:saved.ref.revision,pinId}
  await mkdir(join(base,'pins'),{recursive:true});await mkdir(join(base,'access'),{recursive:true});await writeFile(join(base,'pins',pinId+'.json'),JSON.stringify(pin));await writeFile(join(base,'access',sha('target')+'.json'),JSON.stringify(access))
  expect((await holder.confirmManagedDependencies()).kind).toBe('blocked');await holder.close()
 }finally{await f.close()}
},60000)
