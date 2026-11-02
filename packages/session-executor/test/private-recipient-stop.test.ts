import {expect,it,vi} from 'vitest'
const probe=vi.hoisted(()=>({handoffKey:'',closeKey:'',holdHandoff:false,holdClose:false,failClose:false,appends:[] as string[],reconciles:[] as string[]}))
vi.mock('../../session-persistence-jsonl/src/backend/fact-journal.ts',async load=>{
 const original=await load<typeof import('../../session-persistence-jsonl/src/backend/fact-journal.ts')>()
 return {...original,createFactJournalBackend(...args:Parameters<typeof original.createFactJournalBackend>){
  const backend=original.createFactJournalBackend(...args)
  return {...backend,async appendOwnedBatch(...input:Parameters<typeof backend.appendOwnedBatch>){
   const result=await backend.appendOwnedBatch(...input),bytes=Buffer.from(input[3].bytes).toString('utf8'),key=input[3].key.batchId
   if(bytes.includes('"type":"agent/delivery-handoff"')&&probe.holdHandoff){probe.handoffKey=key;probe.appends.push(key);return {kind:'unknown' as const,key:input[3].key}}
   if(bytes.includes('"op":"close"')&&bytes.includes('"type":"agent/delivery-generation"')&&probe.holdClose){probe.closeKey=key;probe.appends.push(key);return {kind:'unknown' as const,key:input[3].key}}
   return result
  },async reconcileOwnedBatch(...input:Parameters<typeof backend.reconcileOwnedBatch>){
   const key=input[3].key.batchId;probe.reconciles.push(key)
   if(key===probe.closeKey&&probe.failClose)throw false
   if(key===probe.handoffKey&&probe.holdHandoff||key===probe.closeKey&&probe.holdClose)return {kind:'unknown' as const,key:input[3].key}
   return backend.reconcileOwnedBatch(...input)
  }}
 }}
})
import {mkdtemp} from 'node:fs/promises'
import {join} from 'node:path'
import {createContext} from '@i-harness/core-plugin'
import {committedFactSeqs} from '@i-harness/core-session'
import {createManagedExecutionDomain} from '@i-harness/core-session/internal/execution'
import {createJsonlBackend} from '../../session-persistence-jsonl/src/index.ts'
import {composeJsonlTaskTransitionCoordinator} from '../../session-persistence-jsonl/src/task-document-factory.ts'
import {taskDocumentStorageContract} from '../../subagent/src/task/storage-contract.ts'
import {acquireManagedExecution} from '../../session-persistence/src/execution-internal.ts'
import {receivedExecutionInputsFor} from '../src/lifecycle/execution-inputs.ts'

async function fixture(kind:'code'|'exec'='code'){
 Object.assign(probe,{handoffKey:'',closeKey:'',holdHandoff:false,holdClose:false,failClose:false,appends:[],reconciles:[]})
 const root=await mkdtemp(join(process.env.IH_NATIVE_DEPENDENCY_EVIDENCE_ROOT!,'private-recipient-stop-')),backend=createJsonlBackend(root),coordinator=composeJsonlTaskTransitionCoordinator(backend,{lock:{enabled:true}},taskDocumentStorageContract)
 await coordinator.create({sessionId:'parent'})
 const execution=await acquireManagedExecution(coordinator,'parent'),domain=createManagedExecutionDomain(execution.identity,execution.owner,createContext()),inputs=receivedExecutionInputsFor(execution),recipient=inputs.codeDelivery(domain),action=execution.owner.beginAction(),producer=action.registerSettlementSource(async()=>{})
 committedFactSeqs(await inputs.facts().admit({type:'agent/input/admitted',version:1,inputId:'human',text:'run',delivery:'queue',intent:'user',provenance:{kind:'human',authority:'request',scope:'turn',producer:'fixture'}}))
 const name=kind==='code'?'code_exec':'shell',[callSeq]=committedFactSeqs(await action.facts.tools.call({type:'tool/call',name,callId:'call',args:{}}))
 committedFactSeqs(await action.facts.tools.dispatch('call',{kind:'prior',seq:callSeq!,expectedType:'tool/call'}))
 const identity={sessionId:'parent',callId:'call',callSeq:callSeq!,sourceId:'source'}
 const prepared=kind==='code'?await recipient.prepareCodeLaunch({...identity,cellId:'cell'}):await recipient.prepareExecLaunch(identity)
 if(prepared.kind!=='bound')throw Error('Original recipient unavailable')
 const capture=kind==='code'?action.captureCodeDeliverySource!({type:'agent/delivery-source',version:1,kind:'code',...prepared.binding,sourceNamespace:'code',cellId:'cell',delivery:'tool'},prepared.isCurrent):action.captureExecDeliverySource!({type:'agent/delivery-source',version:1,kind:'exec',...prepared.binding,sourceNamespace:'exec',delivery:'tool'},prepared.isCurrent)
 const [sourceSeq]=committedFactSeqs(await capture.admit())
 return {backend,execution,inputs,recipient,prepared,producer,sourceSeq:sourceSeq!,async close(){probe.holdHandoff=false;probe.holdClose=false;probe.failClose=false;await producer.close();action.finish();await inputs.close();await coordinator.close()}}
}

it.each(['code','exec'] as const)('Stop fences the original %s recipient while its handoff ACK is unknown',async kind=>{
 const f=await fixture(kind)
 try{
  probe.holdHandoff=true
  const handoff=f.producer.delivery.capture({type:'agent/delivery-handoff',version:1,kind,sourceSeq:f.sourceSeq})
  expect((await handoff.admit()).kind).toBe('unknown')
  expect(()=>f.execution.observe()).toThrow()
  const stop=f.recipient.requestClose('user-stop')
  await expect(stop.settled).rejects.toThrow()
  probe.holdHandoff=false;committedFactSeqs(await handoff.reconcile())
  // The close has not reached ACK, but its original synchronous fence survives
  // reconciliation of the older writer and denies another source issuance.
  expect(f.prepared.isCurrent()).toBe(false)
  probe.holdClose=true
  await expect(f.recipient.closeReceipt(stop.fenceId)).rejects.toThrow()
  expect(probe.closeKey).not.toBe('')
  probe.holdClose=false
  const receipt=await f.recipient.closeReceipt(stop.fenceId)
  expect(receipt).toMatchObject({fenceId:stop.fenceId,durability:'durable'})
  expect(await f.recipient.closeReceipt(stop.fenceId)).toEqual(receipt)
  const events=(await f.backend.read('parent')).events
  expect(events.filter(e=>e.type==='agent/delivery-handoff')).toHaveLength(1)
  expect(events.filter(e=>e.type==='agent/delivery-generation'&&e.op==='close')).toEqual([expect.objectContaining({fenceId:stop.fenceId,seq:receipt.closeSeq})])
  expect(probe.appends.filter(key=>key===probe.handoffKey)).toHaveLength(1)
  expect(probe.appends.filter(key=>key===probe.closeKey)).toHaveLength(1)
 }finally{await f.close()}
},20000)

it('returns only same-owner acknowledged close receipts and refuses copied receivers before fencing',async()=>{
 const f=await fixture()
 try{
  expect(()=>f.recipient.requestClose.call({...f.recipient},'user-stop')).toThrow()
  expect(()=>f.recipient.requestClose('foreign' as never)).toThrow()
  expect(f.prepared.isCurrent()).toBe(true)
  const stop=f.recipient.requestClose('user-stop'),seqs=await stop.settled
  await f.recipient.settle()
  const receipt=await f.recipient.closeReceipt(stop.fenceId)
  expect(receipt).toEqual({fenceId:stop.fenceId,closeSeq:seqs[0],durability:'durable'})
  await expect(f.recipient.closeReceipt('foreign')).rejects.toThrow()
  await expect(f.recipient.closeReceipt.call({...f.recipient},stop.fenceId)).rejects.toThrow()
  await expect(f.recipient.closeReceipt({toString(){throw false}} as never)).rejects.toThrow()
  await f.inputs.close()
  await expect(f.recipient.closeReceipt(stop.fenceId)).rejects.toThrow()
  expect(()=>f.recipient.requestClose('user-stop')).toThrow()
 }finally{await f.close()}
},20000)

it('preserves falsey close recovery failure and retries the same retained source during cleanup',async()=>{
 const f=await fixture()
 try{
  probe.holdClose=true;probe.failClose=true
  const stop=f.recipient.requestClose('user-stop')
  await expect(stop.settled).rejects.toBe(false)
  await expect(f.recipient.closeReceipt(stop.fenceId)).rejects.toBe(false)
  const failure=await f.inputs.close().catch(error=>error)
  expect(failure).toBeInstanceOf(AggregateError)
  expect(failure.errors).toContain(false)
  probe.holdClose=false;probe.failClose=false
  const receipt=await f.recipient.closeReceipt(stop.fenceId)
  expect(receipt).toMatchObject({fenceId:stop.fenceId,durability:'durable'})
  await f.inputs.close()
  expect((await f.backend.read('parent')).events.filter(e=>e.type==='agent/delivery-generation'&&e.op==='close')).toHaveLength(1)
  expect(probe.appends.filter(key=>key===probe.closeKey)).toHaveLength(1)
 }finally{await f.close()}
},20000)
