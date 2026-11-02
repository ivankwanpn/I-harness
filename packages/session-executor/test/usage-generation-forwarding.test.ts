import {expect,it} from 'vitest'
import {mkdtemp} from 'node:fs/promises'
import {join} from 'node:path'
import {createJsonlTaskTransitionCoordinator} from '../../session-persistence-jsonl/src/task-document-factory.ts'
import {taskDocumentStorageContract} from '../../subagent/src/task/storage-contract.ts'
import {openExecutorDocument} from '../src/lifecycle/managed-document.ts'
import {openLiteralInputExecution} from '../src/lifecycle/literal-input.ts'
import {createTitleGenerationContext} from '../src/lifecycle/title-generation.ts'
import {runManualGeneration} from '../src/lifecycle/manual-generation.ts'
import {createSessionAssembly,type SessionAssembly} from '../src/assembly.ts'
import type {PassiveProducerRecord} from '@i-harness/llm-seam/internal/passive-observation'

it.each(['literal','title','manual'] as const)('original %s factory forwards acknowledged facts without adding transport or another action owner',async mode=>{
 const root=await mkdtemp(join(process.env.IH_CONFIG_DIR!,'usage-factory-')),coordinator=createJsonlTaskTransitionCoordinator(join(root,'sessions'),{lock:{enabled:true}},taskDocumentStorageContract)
 const rows:PassiveProducerRecord[]=[],warnings:string[]=[],observer={capture(row:PassiveProducerRecord){rows.push(row)},unavailable(reason:string){warnings.push(reason)}}
 let assembly:SessionAssembly|undefined,calls=0
 try{
  const {id}=await coordinator.create(),attachment=await openExecutorDocument({coordinator,sessionId:id}),signal=new AbortController().signal
  if(mode==='literal'){
   await attachment.inbox.admit({inputId:'literal-input',text:'Original literal input',delivery:'queue',intent:'user',provenance:{kind:'human',authority:'request',scope:'turn',producer:'session.prompt'}},signal)
   const original=await openLiteralInputExecution({attachment,ownerSessionId:id,input:attachment.inbox.pending()[0]!,signal,start:{wall:Date.now(),monotonic:performance.now()},selectedClient:()=>undefined,localTestEnabled:false,passiveGeneration:observer})
   await original.close()
  }else if(mode==='title'){
   await attachment.document!.inputs.start(undefined,{type:'user/message',text:'Original title input',provenance:{kind:'human',authority:'request',scope:'turn',producer:'session.prompt'}})
   const seq=attachment.session.events.findLast(e=>e.type==='user/message')!.seq!,action=attachment.factOwner.beginAction(signal)
   const original=createTitleGenerationContext(attachment.factOwner,id,action,{selectedClient:()=>undefined,passiveGeneration:observer})
   try{const title=await original.open!(seq,30000);await title.close('completed')}finally{await original.drain();action.finish()}
  }else{
   await runManualGeneration({ownerSessionId:id,signal,passiveGeneration:observer,acquire:()=>openExecutorDocument({coordinator,sessionId:id}),async assemble(){return assembly=await createSessionAssembly({workspace:root,coordinator,sessionId:id,modelPolicy:'required',model:{async *stream(){calls++;throw Error('No context to compact; no transport permitted')}}})}})
  }
  const facts=rows.filter(r=>r.kind==='fact')
  expect(facts.filter(r=>r.event.type==='context/action'&&r.event.op==='open')).toHaveLength(1)
  expect(facts.filter(r=>r.event.type==='context/action'&&r.event.op==='close')).toHaveLength(1)
  for(const row of facts){expect(row.source).toBe('journal-fact');expect(attachment.session.events[row.factSeq]).toEqual(row.event)}
  expect(rows.some(r=>r.kind==='handoff')).toBe(false);expect(calls).toBe(0);expect(warnings).toEqual([])
 }finally{await assembly?.dispose();await coordinator.close()}
})
