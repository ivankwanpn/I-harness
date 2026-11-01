import { afterEach, expect, it, vi } from 'vitest'
const probe=vi.hoisted(()=>({lose:false,appends:0,allowPublic:false}))
vi.mock('../../session-persistence-jsonl/src/backend/fact-journal.ts',async load=>{const original=await load<typeof import('../../session-persistence-jsonl/src/backend/fact-journal.ts')>();return{...original,createFactJournalBackend(...args:Parameters<typeof original.createFactJournalBackend>){const backend=original.createFactJournalBackend(...args);return{...backend,async appendOwnedBatch(...input:Parameters<typeof backend.appendOwnedBatch>){probe.appends++;const outcome=await backend.appendOwnedBatch(...input);if(probe.lose&&outcome.kind==='committed'){probe.lose=false;return{kind:'unknown' as const,key:input[3].key}}return outcome}}}}})
vi.mock('@i-harness/core-session',async load=>{const original=await load<typeof import('@i-harness/core-session')>();return{...original,createManagedSessionState(...args:Parameters<typeof original.createManagedSessionState>){if(!probe.allowPublic)throw Error('Private executor materialized public view');return original.createManagedSessionState(...args)}}})
import { mkdtemp } from 'node:fs/promises'
import { join } from 'node:path'
import { createJsonlBackend } from '@i-harness/session-persistence-jsonl'
import { composeJsonlTaskTransitionCoordinator } from '@i-harness/session-persistence-jsonl/internal/task-document-factory'
import { taskDocumentStorageContract } from '../../subagent/src/task/storage-contract.ts'
import { createExecutorExecutionCache,createDurableSessionLoader } from '../src/durable-session.ts'
import { createExecutionGenerationLifecycle,assertExecutionGeneration } from '../src/lifecycle/generation-actions.ts'
import { createExecutionInputPreparationOwner } from '../src/lifecycle/execution-input-preparation.ts'
import type { PassiveProducerRecord } from '@i-harness/llm-seam/internal/passive-observation'
const coordinators:ReturnType<typeof composeJsonlTaskTransitionCoordinator>[]=[]
afterEach(async()=>{probe.lose=false;for(const owner of coordinators.splice(0))await owner.close();probe.appends=0;probe.allowPublic=false})
async function setup(){const root=await mkdtemp(join(process.env.IH_NATIVE_DEPENDENCY_EVIDENCE_ROOT!,'executor-private-'));const backend=createJsonlBackend(root),coordinator=composeJsonlTaskTransitionCoordinator(backend,{lock:{enabled:true}},taskDocumentStorageContract);coordinators.push(coordinator);await coordinator.create({sessionId:'owner'});return{backend,coordinator,cache:createExecutorExecutionCache({coordinator})}}
it('private execution cache coalesces original acquisition and never builds a public Session',async()=>{
 const {cache}=await setup();await expect(cache.get.call({...cache},'owner')).rejects.toThrow('Original execution cache')
 const a=cache.get('owner'),b=cache.get('owner');expect(a).toBe(b)
 const owned=await a;expect(Object.hasOwn(owned.execution.owner,'view')).toBe(false);expect(owned.execution.observe().eventCount).toBe(0)
 await cache.close('owner');await expect(cache.get('owner')).rejects.toThrow('closed')
})
it('original private input adapters retain all-history duplicate identity after claim and cancellation',async()=>{
 const {cache}=await setup(),owned=await cache.get('owner'),inbox=owned.inputs.inbox
 await inbox.admit({inputId:'first',text:'original',delivery:'steer',intent:'user'})
 expect(inbox.pending()).toMatchObject([{inputId:'first'}]);await inbox.claimAtStepBoundary();expect(inbox.pending()).toEqual([]);expect(inbox.everAdmitted('first')).toBe(true)
 await expect(inbox.admit({inputId:'first',text:'again',delivery:'queue',intent:'user'})).rejects.toThrow()
 await inbox.admit({inputId:'second',text:'cancel',delivery:'queue',intent:'user'});expect(await inbox.cancel('second')).toBe(true)
 expect(await inbox.cancel('second')).toBe(false);expect(inbox.pending()).toEqual([]);expect(inbox.everAdmitted('second')).toBe(true)
 await expect(inbox.admit({inputId:'second',text:'again',delivery:'queue',intent:'user'})).rejects.toThrow()
 await cache.close('owner')
})
it('close installed synchronously prevents late private publication and original new work',async()=>{
 const {cache}=await setup(),pending=cache.get('owner');void pending.catch(()=>{})
 const closed=cache.close('owner');await expect(pending).rejects.toThrow('closed');await closed
 await expect(cache.get('owner')).rejects.toThrow('closed')
})
it('only acknowledged closure allows a fresh execution incarnation in the same cache',async()=>{
 const {cache}=await setup(),first=await cache.get('owner')
 expect(()=>cache.releaseClosed('owner')).toThrow()
 await cache.close('owner');cache.releaseClosed('owner')
 const next=await cache.get('owner');expect(next.execution.identity).not.toBe(first.execution.identity)
 expect(()=>first.execution.observe()).toThrow();await cache.close('owner')
})
it('private generation consumes original folds and emits original acknowledged R5 facts without a view',async()=>{
 const {cache}=await setup(),owned=await cache.get('owner'),seq=await owned.inputs.inbox.admit({inputId:'first',text:'original',delivery:'queue',intent:'user',provenance:{kind:'human',authority:'request',scope:'turn',producer:'fixture'}})
 const action=owned.execution.owner.beginAction(),rows:PassiveProducerRecord[]=[],gaps:string[]=[]
 const lifecycle=createExecutionGenerationLifecycle(owned.execution,'owner',action,undefined,{async beforeDrain(){},passiveGeneration:{capture(row){rows.push(row)},unavailable(reason){gaps.push(reason)}}})
 const generation=await lifecycle.open('main',{kind:'input',seq});expect(owned.execution.observe().generations()).toHaveLength(1)
 assertExecutionGeneration(owned.execution,generation,action)
 let methodReads=0;Object.defineProperty(generation,'bind',{configurable:true,get(){methodReads++;throw Error('Replaced generation method')}})
 expect(()=>assertExecutionGeneration(owned.execution,generation,action)).toThrow();expect(methodReads).toBe(0);Reflect.deleteProperty(generation,'bind')
 assertExecutionGeneration(owned.execution,generation,action)
 expect(()=>assertExecutionGeneration(owned.execution,{...generation},action)).toThrow()
 const foreignAction=owned.execution.owner.beginAction();expect(()=>assertExecutionGeneration(owned.execution,generation,foreignAction)).toThrow();foreignAction.finish()
 const request=await owned.execution.prepareRequest(action)
 const prepare=createExecutionInputPreparationOwner(owned.execution,action,{cancel:id=>owned.inputs.inbox.cancel(id)})
 const prepared=await prepare.prepare('first',generation)
 expect(()=>request.assertCurrent()).toThrow();await request.settle()
 let reads=0;const hostile=Object.defineProperty({},'admissionSeq',{get(){reads++;throw Error('Hostile preparation')}})
 expect(()=>generation.adoptExecution(owned.execution.identity,'first',hostile as never,new AbortController().signal)).toThrow();expect(reads).toBe(0)
 expect(()=>generation.adoptExecution(owned.execution.identity,'first',{...prepared},new AbortController().signal)).toThrow()
 generation.adoptExecution(owned.execution.identity,'first',prepared,new AbortController().signal)
 await generation.close('stopped');await prepare.close();await lifecycle.drain();action.finish()
 expect(gaps).toEqual([]);expect(rows.filter(row=>row.kind==='fact').map(row=>row.event.op)).toEqual(['open','close'])
 expect(rows.every(row=>row.kind!=='fact'||row.factSeq===row.event.seq&&row.event.trustedAt>0)).toBe(true)
 await cache.close('owner')
})
it('private manual adoption uses the original issued generation and identity, not a Session',async()=>{
 const {cache}=await setup(),{execution}=await cache.get('owner'),action=execution.owner.beginAction()
 const outcome=await action.facts.metadata.admit({type:'command/run',commandId:'original',name:'compact',source:{kind:'user'}})
 if(outcome.kind!=='committed')throw Error('Original command not committed')
 const lifecycle=createExecutionGenerationLifecycle(execution,'owner',action),generation=await lifecycle.open('manual',{kind:'command',seq:outcome.seqs[0]!})
 expect(()=>generation.adoptManualExecution({} as never,new AbortController().signal)).toThrow()
 generation.adoptManualExecution(execution.identity,new AbortController().signal)
 expect(()=>generation.adoptManualExecution(execution.identity,new AbortController().signal)).toThrow()
 await generation.close('stopped');await lifecycle.drain();action.finish();await cache.close('owner')
})
it.each(['getter','no-op'] as const)('original action assertion currency refuses %s replacement without callbacks',async kind=>{
 const {cache}=await setup(),{execution,inputs}=await cache.get('owner'),seq=await inputs.inbox.admit({inputId:'guarded',text:'original',delivery:'queue',intent:'user',provenance:{kind:'human',authority:'request',scope:'turn',producer:'fixture'}})
 const action=execution.owner.beginAction(),descriptor=Object.getOwnPropertyDescriptor(action,'assertOpen')!,lifecycle=createExecutionGenerationLifecycle(execution,'owner',action),generation=await lifecycle.open('main',{kind:'input',seq})
 let callbacks=0
 try{
  if(kind==='getter')Object.defineProperty(action,'assertOpen',{configurable:true,get(){callbacks++;throw Error('Replaced action getter')}})
  else Object.defineProperty(action,'assertOpen',{...descriptor,value(){callbacks++}})
  expect(()=>assertExecutionGeneration(execution,generation,action)).toThrow()
  expect(()=>generation.assertOpen()).toThrow();expect(callbacks).toBe(0)
  Object.defineProperty(action,'assertOpen',descriptor);assertExecutionGeneration(execution,generation,action)
  action.stop();expect(()=>assertExecutionGeneration(execution,generation,action)).toThrow()
 }finally{Object.defineProperty(action,'assertOpen',descriptor);await generation.close('stopped');await lifecycle.drain();action.finish();await cache.close('owner')}
})
it('unknown physically landed admission reconciles the same capture and appends once',async()=>{
 const {cache}=await setup(),owned=await cache.get('owner');probe.appends=0;probe.lose=true
 await owned.inputs.inbox.admit({inputId:'unknown',text:'original',delivery:'queue',intent:'user'})
 expect(probe.appends).toBe(1);expect(owned.inputs.inbox.pending()).toHaveLength(1)
 await expect(owned.inputs.inbox.admit({inputId:'unknown',text:'original',delivery:'queue',intent:'user'})).rejects.toThrow()
 expect(probe.appends).toBe(1);await cache.close('owner')
})
it('explicit public loader keeps complete Session compatibility and cannot promote its owner privately',async()=>{
 const {backend,coordinator,cache}=await setup();await coordinator.append('owner',[{type:'turn/start'},{type:'user/message',text:'full original history'}])
 probe.allowPublic=true;const session=await createDurableSessionLoader(coordinator)('owner');expect(session.events).toHaveLength((await backend.read('owner')).events.length);expect(session.events[1]).toMatchObject({type:'user/message',text:'full original history'})
 await expect(cache.get('owner')).rejects.toThrow()
})
it('Stop during original preparation refuses adoption and settles retained cleanup without replaying the transform',async()=>{
 const {cache}=await setup(),{execution,inputs}=await cache.get('owner'),seq=await inputs.inbox.admit({inputId:'held',text:'original',preparationPolicy:'human-host',delivery:'queue',intent:'user',provenance:{kind:'human',authority:'request',scope:'turn',producer:'session.prompt'}})
 const action=execution.owner.beginAction(),lifecycle=createExecutionGenerationLifecycle(execution,'owner',action),generation=await lifecycle.open('main',{kind:'input',seq}),held=Promise.withResolvers<void>(),entered=Promise.withResolvers<void>();let transforms=0
 const owner=createExecutionInputPreparationOwner(execution,action,{async transform(text){transforms++;entered.resolve();await held.promise;return text},cancel:id=>inputs.inbox.cancel(id)})
 const preparing=owner.prepare('held',generation);void preparing.catch(()=>{});await entered.promise;action.stop();held.resolve();await expect(preparing).rejects.toThrow()
 await expect(owner.prepare('held',generation)).rejects.toThrow();expect(transforms).toBe(1)
 await generation.close('stopped');await owner.close();await lifecycle.drain();action.finish();await cache.close('owner')
})
