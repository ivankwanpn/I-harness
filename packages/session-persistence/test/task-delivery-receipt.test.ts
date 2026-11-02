import {expect,it} from 'vitest'
import {mkdtemp,rm} from 'node:fs/promises'
import {join} from 'node:path'
import {committedFactSeqs} from '@i-harness/core-session'
import {createJsonlTaskTransitionCoordinator} from '../../session-persistence-jsonl/src/task-document-factory.ts'
import {taskDocumentStorageContract} from '../../subagent/src/task/storage-contract.ts'
import {inspectOriginalTaskDeliveryOpen} from '../src/retained-inspection-internal.ts'

it('original task delivery receipt rejects accessor and proxy bindings and cannot be rewritten',async()=>{
 const root=await mkdtemp(join(process.env.IH_NATIVE_DEPENDENCY_EVIDENCE_ROOT!,'task-open-'))
 const coordinator=createJsonlTaskTransitionCoordinator(root,{lock:{enabled:true}},taskDocumentStorageContract)
 try{
  await coordinator.create({sessionId:'parent'});const document=await coordinator.openManagedDocument('parent'),action=document.beginAction()
  await action.facts.inputs.admit({type:'agent/input/admitted',version:1,inputId:'human',text:'human',delivery:'queue',intent:'user',provenance:{kind:'human',authority:'request',scope:'turn',producer:'fixture'}})
  const source=document.registerReceivedInputSource(async()=>{}),event={type:'agent/delivery-generation' as const,version:1 as const,op:'open' as const,recipientSessionId:'parent',generationId:'original-generation',originInputSeq:0},binding={recipientSessionId:'parent',sourceNamespace:'parent',sourceId:'task-1',callSeq:1}
  let reads=0;const accessor={...binding,get sourceId(){reads++;return 'task-1'}}
  expect(()=>source.captureTaskDeliveryOpen!(event,()=>true,accessor)).toThrow();expect(reads).toBe(0)
  let traps=0;const proxy=new Proxy(binding,{ownKeys(target){traps++;return Reflect.ownKeys(target)},get(target,key,receiver){traps++;return Reflect.get(target,key,receiver)}})
  expect(()=>source.captureTaskDeliveryOpen!(event,()=>true,proxy)).toThrow();expect(traps).toBe(0)
  expect(()=>source.captureTaskDeliveryOpen!(event,()=>true,{...binding,extra:true} as typeof binding)).toThrow()
  const capture=source.captureTaskDeliveryOpen!(event,()=>true,binding);expect(()=>capture.preparation()).toThrow();committedFactSeqs(await capture.admit())
  const preparation=capture.preparation(),receipt=inspectOriginalTaskDeliveryOpen(preparation,document)!
  expect(receipt).toBeDefined();expect(Object.isFrozen(receipt)).toBe(true);expect(Object.isFrozen(receipt.binding)).toBe(true)
  const before=receipt.eventData;expect(()=>{(receipt as {eventData:string}).eventData='changed'}).toThrow();expect(receipt.eventData).toBe(before)
  expect(inspectOriginalTaskDeliveryOpen({...preparation},document)).toBeUndefined();expect(inspectOriginalTaskDeliveryOpen(preparation,document)).toBe(receipt)
  await source.close();action.finish()
 }finally{await coordinator.close();await rm(root,{recursive:true,force:true})}
})
