import {expect,it,vi} from 'vitest'
const probe=vi.hoisted(()=>({views:0}))
vi.mock('@i-harness/core-session',async load=>{const original=await load<typeof import('@i-harness/core-session')>();return {...original,createManagedSessionState(){probe.views++;throw Error('Private source constructed a public view')}}})
import {mkdtemp,rm} from 'node:fs/promises'
import {join} from 'node:path'
import {createJsonlBackend} from '@i-harness/session-persistence-jsonl'
import {composeJsonlTaskTransitionCoordinator} from '@i-harness/session-persistence-jsonl/internal/task-document-factory'
import {taskDocumentStorageContract} from '../../subagent/src/task/storage-contract.ts'
import {acquireManagedExecution} from '../src/execution-internal.ts'
it('private execution retains ordinary received-source open and refuses public task receipt before issue',async()=>{
 const root=await mkdtemp(join(process.env.IH_NATIVE_DEPENDENCY_EVIDENCE_ROOT!,'private-delivery-')),coordinator=composeJsonlTaskTransitionCoordinator(createJsonlBackend(root),{lock:{enabled:true}},taskDocumentStorageContract)
 try{
  await coordinator.create({sessionId:'parent'});const execution=await acquireManagedExecution(coordinator,'parent'),source=execution.owner.registerReceivedInputSource(async()=>{})
  const admitted=await source.captureAdmitted({type:'agent/input/admitted',version:1,inputId:'human',text:'human',delivery:'queue',intent:'user',provenance:{kind:'human',authority:'request',scope:'turn',producer:'fixture'}}).admit();expect(admitted.kind).toBe('committed');if(admitted.kind!=='committed')throw Error('human unavailable')
  const event={type:'agent/delivery-generation' as const,version:1 as const,op:'open' as const,recipientSessionId:'parent',generationId:'generation',originInputSeq:admitted.seqs[0]!},before=execution.observe().eventCount
  expect(()=>source.captureTaskDeliveryOpen!(event,()=>true,{recipientSessionId:'parent',sourceNamespace:'parent',sourceId:'task-1',callSeq:0})).toThrowError(expect.objectContaining({code:'TASK_DELIVERY_RECEIPT_UNAVAILABLE'}))
  expect(execution.observe().eventCount).toBe(before)
  const opened=await source.captureDeliveryOpen(event,()=>true).admit();expect(opened.kind).toBe('committed');expect(execution.observe().eventCount).toBe(before+1);expect(probe.views).toBe(0);await source.close()
 }finally{await coordinator.close();await rm(root,{recursive:true,force:true})}
},20_000)
