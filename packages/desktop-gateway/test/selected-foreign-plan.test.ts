import {it,expect} from 'vitest'
import {createHash} from 'node:crypto'
import {mkdir,writeFile} from 'node:fs/promises'
import {join} from 'node:path'
import {createGatewayForkFixture} from './helpers/fork-fixture.ts'
import {createSelectedResultsIntent,readSelectedResultsCore,readSelectedResultsOperation} from '../../session-persistence/src/selected-results-fork-contract.ts'
import {selectedResultsPreparationFacts} from '../../session-persistence/src/coordinator/selected-results-preparation.ts'
import {canonicalRecord,recordHash,sourceHash,streamHash} from '../../context-output/src/legacy/fork-codec.ts'
it('rejects a foreign byte-equal V2 legacy binding before target publication',async()=>{
 const f=await createGatewayForkFixture();try{
  await f.runtime.contextOutput.configure({enabled:true});const source=await f.runtime.sourceFor('source'),ref=await f.runtime.contextOutput.capture({sessionId:'source',callId:'legacy',label:'selected',text:'retained',complete:true,source});if(!ref)throw Error('Legacy source unavailable')
  await f.coordinator.append('source',[{type:'turn/start'},{type:'user/message',text:'selected'},{type:'step/start'},{type:'tool/call',callId:'legacy',name:'read',args:{}},{type:'assistant/message',text:''},{type:'tool/result',callId:'legacy',name:'read',output:'done'},{type:'step/end'},{type:'context/result-ref',ref},{type:'turn/end'}])
  const core=readSelectedResultsCore({version:2,kind:'session-fork-core',sourceSessionId:'source',selection:{kind:'completed'},sourceCapture:'first-authorized-capture',metadata:{},results:'selected-results-v1'}),{intent,requestDigest}=createSelectedResultsIntent(core,{kind:'project',projectId:'p'}),invocation={version:1 as const,operationId:'selected-foreign-plan',targetSessionId:'target',createdAt:'2026-10-28T00:00:00.000Z',requestDigest},operation=readSelectedResultsOperation({version:2,kind:'session-fork-operation',prepared:{version:2,kind:'session-fork-prepared',core,requestIntent:intent,requestDigest},invocation}),holder=f.runtime.createSelectedSourceHolder(operation),captured=await holder.captureFirst();if(captured.kind!=='captured')throw Error('Capture unavailable')
  expect((await holder.confirmTarget()).kind).toBe('confirmed');const facts=selectedResultsPreparationFacts(captured.stage,captured.seed.records),binding={workspaceId:f.runtime.workspaceKey,invocation,manifestDigest:facts.manifestDigest,sourceSessionId:'source',targetSessionId:'target',targetDocumentId:'target',semanticSeedDigest:facts.seedDigest,sourceObservationDigest:facts.sourceObservation.digest,selection:facts.semantic.selection,targetSourceDigest:sourceHash(source.sourceId),turnDomainDigest:streamHash('ih.legacy-fork.turn-domain.v1',facts.semantic.turns).digest,totalTurns:facts.semantic.turns.total,unframedPrefix:facts.semantic.turns.unframedPrefix,selectedResults:facts.semantic.results},sha=(value:string)=>createHash('sha256').update(value).digest('hex'),directory=join(f.root,'native','context-output','context-output',sha(f.runtime.workspaceKey),'legacy-fork-v1',recordHash('binding',invocation))
  await mkdir(directory,{recursive:true});const foreign=canonicalRecord({version:2,kind:'legacy-fork-binding',binding});await writeFile(join(directory,'binding.json'),JSON.stringify(foreign))
  expect(await holder.confirmLegacyDependencies()).toEqual({kind:'blocked',reason:'unavailable'});await expect(f.coordinator.openManagedDocument('target')).rejects.toThrow();await holder.close()
 }finally{await f.close()}
},60000)
