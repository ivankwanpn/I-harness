import {afterEach,expect,it,vi} from 'vitest'
const probe=vi.hoisted(()=>({
 views:0,ordinals:[] as number[],batches:[] as number[][],
 gate:undefined as undefined|{entered():void;wait:Promise<void>},
 historyObservations:0,settleHistory:undefined as undefined|(()=>Promise<void>),
}))
vi.mock('@i-harness/core-session',async load=>{const original=await load<typeof import('@i-harness/core-session')>();return {...original,createManagedSessionState(){probe.views++;throw Error('Inbox lookup constructed a complete view')}}})
vi.mock('../../session-persistence-jsonl/src/backend/archive-reader.ts',async load=>{const original=await load<typeof import('../../session-persistence-jsonl/src/backend/archive-reader.ts')>();return {...original,async readSessionArchive(...args:Parameters<typeof original.readSessionArchive>){const result=await original.readSessionArchive(...args);if(args[4]){probe.ordinals.push(...args[4].ordinals);probe.batches.push([...args[4].ordinals]);const gate=probe.gate;if(gate){probe.gate=undefined;gate.entered();await gate.wait}}return result}}})
vi.mock('../../session-persistence-jsonl/src/backend/process-read.ts',async load=>{
 const original=await load<typeof import('../../session-persistence-jsonl/src/backend/process-read.ts')>()
 return {...original,createJsonlProcessReadCapability(...args:Parameters<typeof original.createJsonlProcessReadCapability>){
  const capability=original.createJsonlProcessReadCapability(...args)
  return {...capability,openTaskHistory(...args:Parameters<typeof capability.openTaskHistory>){
   const read=capability.openTaskHistory(...args)
   return {
    observe(){probe.historyObservations++;return read.observe()},
    async settleResources(){await probe.settleHistory?.();return read.settleResources()},
    retryResources:read.retryResources.bind(read),
    hasDebt:read.hasDebt.bind(read),
   }
  }}
 }}
})
import {mkdtemp,readFile,writeFile} from 'node:fs/promises'
import {appendFileSync} from 'node:fs'
import {join} from 'node:path'
import {committedFactSeqs,contextUsageAnchorId,encodeFactBatch,legacyPrefixDigest,type AcceptedRequestAttributionV1} from '@i-harness/core-session'
import {createJsonlBackend} from '@i-harness/session-persistence-jsonl'
import {composeJsonlTaskTransitionCoordinator} from '@i-harness/session-persistence-jsonl/internal/task-document-factory'
import {taskDocumentStorageContract} from '../../subagent/src/task/storage-contract.ts'
import {acquireManagedExecution} from '../src/execution-internal.ts'
import {readRestoredConversation} from '@i-harness/core-session/internal/restoration'
const coordinators:ReturnType<typeof composeJsonlTaskTransitionCoordinator>[]=[]
afterEach(async()=>{probe.gate=undefined;probe.settleHistory=undefined;for(const c of coordinators.splice(0))await c.close();probe.views=0;probe.ordinals=[];probe.batches=[];probe.historyObservations=0})
async function fixture(){const root=await mkdtemp(join(process.env.IH_NATIVE_DEPENDENCY_EVIDENCE_ROOT!,'inbox-records-')),backend=createJsonlBackend(root),coordinator=composeJsonlTaskTransitionCoordinator(backend,{lock:{enabled:true}},taskDocumentStorageContract);coordinators.push(coordinator);await coordinator.create({sessionId:'inbox'});return {root,backend,coordinator}}

async function persistedExchanges() {
 const {root,coordinator}=await fixture()
 await coordinator.append('inbox', [
  {type:'turn/start'},
  {type:'user/message',text:'original request'},
  {type:'agent/input/admitted',version:1,inputId:'saved',text:'original input body',delivery:'queue',intent:'user'},
  {type:'agent/input/promoted',version:1,inputId:'saved'},
 ])
 const execution=await acquireManagedExecution(coordinator,'inbox'),action=execution.owner.beginAction()
 try {
  const provenance={kind:'human',authority:'request',scope:'turn',producer:'session.prompt'} as const
  const [admissionSeq]=committedFactSeqs(await action.facts.inputs.admit({
   type:'agent/input/admitted',version:1,inputId:'prepared',text:'/prepared',delivery:'queue',intent:'user',preparationPolicy:'human-host',provenance,
  }))
  const [actionSeq]=committedFactSeqs(await action.captureGeneration([{
   type:'context/action',version:1,op:'open',ownerSessionId:'inbox',actionId:'prepared-action',purpose:'main',
   origin:{kind:'input',seq:admissionSeq!},startedAt:100,expiresAt:3600100,trustedAt:100,
  }],()=>true).admit())
  const preparation={
   type:'agent/input/preparation',version:1,preparationId:'preparation',actionId:'prepared-action',actionSeq:actionSeq!,admissionSeq:admissionSeq!,inputId:'prepared',
  } as const
  committedFactSeqs(await action.captureInputPreparation({...preparation,op:'started',startedAt:100},()=>true).admit())
  const source=action.registerSettlementSource(async()=>{})
  try {
   const result={...preparation,op:'completed' as const,observations:[{producer:'host-preparation' as const,text:'expanded original request'}]}
   const [resultSeq]=committedFactSeqs(await source.inputPreparation.capture(result).admit())
   committedFactSeqs(await action.facts.inputs.start(
    {type:'agent/input/promoted',version:1,inputId:'prepared'},
    {type:'user/message',text:'/prepared',input:{inputId:'prepared',intent:'user'},provenance},
    {...result,seq:resultSeq!},
   ))
  } finally {await source.close()}
  committedFactSeqs(await action.facts.agent.lifecycle({type:'conversation/semantics',version:1,mode:'accepted-exchange-v1'}))
  for(let index=0;index<8;index++){
   const attemptId=`attempt-${index}`,actionId='saved-action'
   const [stepSeq]=committedFactSeqs(await action.facts.agent.lifecycle({type:'step/start',actionId,attemptId}))
   const exchange=action.captureModelExchange({type:'assistant/message',text:`original response ${index}`},{
    type:'model/exchange-accepted',version:1,exchangeId:`exchange-${index}`,actionId,attemptId,
    stepStartSeq:{kind:'prior',seq:stepSeq!,expectedType:'step/start'},
    assistantSeq:{kind:'group',position:0,expectedType:'assistant/message'},
    callSeqs:[],
   })
   committedFactSeqs(await exchange.admit())
   committedFactSeqs(await action.facts.agent.lifecycle({type:'step/end'}))
  }
  committedFactSeqs(await action.facts.agent.lifecycle({type:'turn/end'}))
 } finally {
  action.finish()
  await execution.close()
  await coordinator.close()
 }
 probe.ordinals=[]
 return root
}

it('reuses the verified archive for cold validation and opens the held reader for later dependencies',async()=>{
 const root=await persistedExchanges()
 const coordinator=composeJsonlTaskTransitionCoordinator(createJsonlBackend(root),{lock:{enabled:true}},taskDocumentStorageContract)
 coordinators.push(coordinator)
 const entered=Promise.withResolvers<void>(),release=Promise.withResolvers<void>()
 probe.settleHistory=async()=>{entered.resolve();await release.promise}
 const before=probe.historyObservations
 let published=false
 const attaching=acquireManagedExecution(coordinator,'inbox').then(execution=>{published=true;return execution})
 try{
  await Promise.race([entered.promise,attaching.then(()=>{throw Error('Execution attached before history cleanup')})])
  expect(published).toBe(false)
  expect(probe.historyObservations-before).toBe(1)
 }finally{release.resolve();probe.settleHistory=undefined}
 const execution=await attaching
 expect(probe.historyObservations-before).toBe(1)
 expect(probe.ordinals).toEqual([])
 const observation=execution.observe(),admission=await observation.inbox.admitted('saved')
 expect(admission).toMatchObject({text:'original input body'})
 expect(probe.ordinals).toEqual([admission?.seq])
 const lease=await execution.prepare()
 try{
  const {projection}=readRestoredConversation(lease,{ownerSessionId:'inbox'})
  const rendered=JSON.stringify(projection)
  expect(rendered).toContain('expanded original request')
  expect(rendered).toContain('original response 7')
 }finally{await lease.settle()}
 expect(probe.views).toBe(0)
},20000)

it('starts a fresh post-upgrade proof before attaching a writer to a predecessor',async()=>{
 const root=await mkdtemp(join(process.env.IH_NATIVE_DEPENDENCY_EVIDENCE_ROOT!,'predecessor-execution-'))
 const digest=legacyPrefixDigest(0,new Uint8Array())
 const journal={version:1,legacyBodyBytes:0,legacyEventCount:0,legacyPrefixDigest:digest,separatorBytes:0}
 const header={formatVersion:13,createdAt:'2026-01-01',sessionId:'inbox',journal}
 const path=join(root,'inbox.jsonl')
 const frame=encodeFactBatch('predecessor',digest,[{type:'plan/mode',mode:'on',seq:0}]).bytes
 await writeFile(path,Buffer.concat([Buffer.from(JSON.stringify(header)+'\n'),frame]))
 const coordinator=composeJsonlTaskTransitionCoordinator(createJsonlBackend(root),{lock:{enabled:true}},taskDocumentStorageContract)
 coordinators.push(coordinator)
 const execution=await acquireManagedExecution(coordinator,'inbox')
 expect(probe.historyObservations).toBe(2)
 expect(execution.observe()).toMatchObject({formatVersion:14,eventCount:1})
 const upgraded=await readFile(path)
 expect(upgraded.subarray(upgraded.indexOf(10)+1)).toEqual(Buffer.from(frame))
 const action=execution.owner.beginAction()
 try{expect(await action.facts.metadata.admit({type:'plan/mode',mode:'off'})).toMatchObject({kind:'committed',seqs:[1]})}
 finally{action.finish()}
},20000)

it('validates a warm usage append with one archive read for the remaining exchange dependencies',async()=>{
 const {backend,coordinator}=await fixture()
 const execution=await acquireManagedExecution(coordinator,'inbox')
 const action=execution.owner.beginAction()
 try{
  const digest='a'.repeat(64),actionId='action',attemptId='attempt',exchangeId='exchange'
  const request:AcceptedRequestAttributionV1={
   version:1,ownerSessionId:'inbox',observationLifetimeId:'live',candidateId:'candidate',sendId:'send',
   semanticId:digest,payloadId:digest,payloadKind:'http-json-body',executionEpochId:'epoch',coldCompatible:false,
   snapshot:{semanticRevision:digest,protectionRevision:digest,branchId:digest,contextEpoch:digest,surfaceRevision:digest},
   projectionRevision:0,
  }
  committedFactSeqs(await action.facts.agent.lifecycle({type:'conversation/semantics',version:1,mode:'accepted-exchange-v1'}))
  const [stepSeq]=committedFactSeqs(await action.facts.agent.lifecycle({type:'step/start',actionId,attemptId}))
  const [assistantSeq,acceptedSeq]=committedFactSeqs(await action.captureModelExchange({type:'assistant/message',text:'warm answer'},{
   type:'model/exchange-accepted',version:2,request,exchangeId,actionId,attemptId,
   stepStartSeq:{kind:'prior',seq:stepSeq!,expectedType:'step/start'},
   assistantSeq:{kind:'group',position:0,expectedType:'assistant/message'},callSeqs:[],
  }).admit())
  const accepted={acceptedSeq:acceptedSeq!,exchangeId,actionId,attemptId}
  const sample={
   version:2,accepted,request,bindingId:digest,shapeId:digest,pricingVersion:'projected-pricing-v2',
   normalizationVersion:'input-usage-v1',usageSemantics:'includes-cache',prefixId:digest,
   unitCount:1,heuristicPrefixTokens:10,reportedInputTokens:100,
  } as const
  const checkpoint={...sample,anchorId:contextUsageAnchorId(sample)}
  probe.batches=[]
  const [usageSeq]=committedFactSeqs(await action.facts.agent.usage({
   type:'context/usage',version:2,op:'sample',
   checkpoint:{...checkpoint,accepted:{...accepted,acceptedSeq:{kind:'prior',seq:acceptedSeq!,expectedType:'model/exchange-accepted'}}},
  }))
  expect(probe.batches).toEqual([[acceptedSeq],[stepSeq,assistantSeq]])
  expect((await backend.read('inbox')).events[usageSeq!]).toMatchObject({type:'context/usage',checkpoint})
 }finally{action.finish();await execution.close()}
},20000)

it('rejects a changed archive before publishing the cold execution attachment',async()=>{
 const root=await persistedExchanges();let changed=false
 const coordinator=composeJsonlTaskTransitionCoordinator(createJsonlBackend(root),{
  lock:{enabled:true},
  originalExecutionFoldFactory:()=>({
   appendValidated(unit){
    if(!changed&&unit.some(event=>event.type==='model/exchange-accepted')){
     changed=true
     appendFileSync(join(root,'inbox.jsonl'),'different history after validation began')
    }
   },
   finishRestore(){},
   snapshot(){return null},
   validateSnapshot(value){return value===null},
  }),
 },taskDocumentStorageContract)
 coordinators.push(coordinator)
 await expect(acquireManagedExecution(coordinator,'inbox')).rejects.toThrow('TASK_TRANSITION_FAILED')
 expect(changed).toBe(true)
},20000)

it('reads the original nonresident completed and cancelled records through the same native owner without a complete view',async()=>{
 const {backend,coordinator}=await fixture()
 await coordinator.append('inbox',[
  {type:'agent/input/admitted',version:1,inputId:'completed',text:'completed body',delivery:'queue',intent:'user',clientToken:'completed-token'},
  {type:'agent/input/promoted',version:1,inputId:'completed'},
  {type:'agent/input/admitted',version:1,inputId:'cancelled',text:'cancelled body',delivery:'queue',intent:'user',clientToken:'cancelled-token'},
  {type:'agent/input/cancelled',version:1,inputId:'cancelled',reason:'user stop'},
 ])
 const execution=await acquireManagedExecution(coordinator,'inbox'),observation=execution.observe(),full=await backend.read('inbox'),before=full.events.length
 expect(observation.inbox.pending()).toEqual([])
 for(const id of ['completed','cancelled']){
  const expected=full.events.find(event=>event.type==='agent/input/admitted'&&event.inputId===id)!
  expect(await observation.inbox.admitted(id)).toEqual(expected);observation.assertCurrent()
 }
 expect(observation.inbox.lastCancellationSeq('cancelled')).toBe(full.events.at(-1)!.seq)
 expect(observation.inbox.lastCancellationSeq('completed')).toBeUndefined()
 expect(probe.ordinals).toEqual(full.events.filter(event=>event.type==='agent/input/admitted').map(event=>event.seq))
 expect(probe.views).toBe(0);expect((await backend.read('inbox')).events).toHaveLength(before)
},20000)

it('expires committed observations on live writes and refuses whole-execution Stop during the actual original descriptor read',async()=>{
 const {coordinator,backend}=await fixture(),execution=await acquireManagedExecution(coordinator,'inbox'),source=execution.owner.registerReceivedInputSource(async()=>{}),before=execution.observe()
 const admitted=await source.captureAdmitted({type:'agent/input/admitted',version:1,inputId:'live',text:'original live body',delivery:'queue',intent:'user'}).admit();expect(admitted.kind).toBe('committed')
 await expect(before.inbox.admitted('live')).rejects.toThrow('expired')
 const current=execution.observe();expect(await current.inbox.admitted('live')).toMatchObject({inputId:'live',text:'original live body'})
 const cancelled=await source.captureCancellation({type:'agent/input/cancelled',version:1,inputId:'live'}).admit();if(cancelled.kind!=='committed')throw Error('Original cancellation failed')
 const observation=execution.observe();expect(observation.inbox.lastCancellationSeq('live')).toBe(cancelled.seqs[0]);expect(observation.inbox.pending()).toEqual([])
 const entered=Promise.withResolvers<void>(),release=Promise.withResolvers<void>();probe.gate={entered:entered.resolve,wait:release.promise};const reading=observation.inbox.admitted('live');void reading.catch(()=>{})
 await entered.promise;execution.revokeNewWork();release.resolve();await expect(reading).rejects.toMatchObject({code:'FACT_CLOSED'})
 expect(probe.views).toBe(0);expect((await backend.read('inbox')).events.at(-1)).toMatchObject({type:'agent/input/cancelled',inputId:'live'});await source.close()
},20000)
