import {afterEach,expect,it,vi} from 'vitest'
const probe=vi.hoisted(()=>({appends:0,lose:false}))
vi.mock('@i-harness/core-session',async load=>{const original=await load<typeof import('@i-harness/core-session')>();return{...original,createManagedSessionState(){throw Error('Runtime context built a full Session')}}})
vi.mock('../../session-persistence-jsonl/src/backend/fact-journal.ts',async load=>{const original=await load<typeof import('../../session-persistence-jsonl/src/backend/fact-journal.ts')>();return{...original,createFactJournalBackend(...args:Parameters<typeof original.createFactJournalBackend>){const backend=original.createFactJournalBackend(...args);return{...backend,async appendOwnedBatch(...input:Parameters<typeof backend.appendOwnedBatch>){probe.appends++;const result=await backend.appendOwnedBatch(...input);if(probe.lose&&result.kind==='committed'){probe.lose=false;return{kind:'unknown' as const,key:input[3].key}}return result}}}}})
import {mkdtemp} from 'node:fs/promises'
import {join} from 'node:path'
import {createContext} from '@i-harness/core-plugin'
import {createManagedExecutionDomain} from '@i-harness/core-session/internal/execution'
import {readRestoredConversation} from '@i-harness/core-session/internal/restoration'
import {createJsonlBackend} from '@i-harness/session-persistence-jsonl'
import {composeJsonlTaskTransitionCoordinator} from '@i-harness/session-persistence-jsonl/internal/task-document-factory'
import {taskDocumentStorageContract} from '../../subagent/src/task/storage-contract.ts'
import {createExecutorExecutionCache} from '../src/durable-session.ts'
import {createExecutionRuntimeContext} from '../src/lifecycle/execution-runtime-context.ts'
import {createPreparedRuntimeContext} from '@i-harness/runtime-context'
import {createRuntimeContextSource} from '../src/lifecycle/action-facts.ts'
const resources:(()=>Promise<void>)[]=[]
afterEach(async()=>{probe.lose=false;const errors:unknown[]=[];for(const close of resources.splice(0).reverse())try{await close()}catch(cause){errors.push(cause)};probe.appends=0;if(errors.length)throw new AggregateError(errors,'Runtime fixture cleanup incomplete')})
async function fixture(){const root=await mkdtemp(join(process.env.IH_NATIVE_DEPENDENCY_EVIDENCE_ROOT!,'managed-runtime-')),coordinator=composeJsonlTaskTransitionCoordinator(createJsonlBackend(root),{lock:{enabled:true}},taskDocumentStorageContract);resources.push(()=>coordinator.close());await coordinator.create({sessionId:'owner'});const cache=createExecutorExecutionCache({coordinator});resources.push(()=>cache.closeAll());const {execution}=await cache.get('owner'),domain=createManagedExecutionDomain(execution.identity,execution.owner,createContext()),runtime=createExecutionRuntimeContext(execution,domain);resources.push(()=>runtime.close());return{execution,domain,runtime}}
it('prepared runtime uses real current-floor dedup and preserves captured getter/order without a Session',async()=>{
 const {execution,runtime}=await fixture();let text='one',getters=0
 runtime.registerSection('actual',()=>{getters++;return text});probe.appends=0
 await runtime.render();expect(probe.appends).toBe(1);await runtime.render();expect(probe.appends).toBe(1)
 text='two';const first=runtime.render();text='three';const second=runtime.render();await Promise.all([first,second]);expect(getters).toBe(4);expect(probe.appends).toBe(3)
 const archive=await execution.prepare();try{expect(readRestoredConversation(archive,{ownerSessionId:'owner'}).projection.current).toMatchObject({kind:'runtime-context',sections:[{name:'actual',text:'three'}]})}finally{await archive.settle()}
})
it('runtime close across actual archive await prevents publication and joins its optional lease',async()=>{
 const {execution,domain}=await fixture(),entered=Promise.withResolvers<void>(),release=Promise.withResolvers<void>();let held:import('@i-harness/core-session/internal/restoration').PreparedConversationArchive|undefined
 const runtime=createPreparedRuntimeContext({ownerSessionId:'owner',async prepare(){const archive=await execution.prepare();held=archive;entered.resolve();await release.promise;return archive},assertCurrent(){domain.assertCurrent()}},createRuntimeContextSource(execution.owner));resources.push(()=>runtime.close())
 runtime.registerSection('actual',()=> 'held');probe.appends=0
 const rendering=runtime.render();void rendering.catch(()=>{});await entered.promise;held!.assertCurrent();const closing=runtime.close();release.resolve();await expect(rendering).rejects.toThrow('closed');await closing;expect(probe.appends).toBe(0);domain.assertCurrent();expect(()=>held!.assertCurrent()).toThrow()
})
it('runtime unknown commit settles same original publication under Stop without new capture or getter replay',async()=>{
 const {execution,runtime}=await fixture();let getters=0;runtime.registerSection('actual',()=>{getters++;return'original'});probe.appends=0;probe.lose=true
 await expect(runtime.render()).rejects.toThrow();expect(probe.appends).toBe(1);execution.revokeNewWork()
 await runtime.settleOriginals();expect(probe.appends).toBe(1);expect(getters).toBe(1);await expect(runtime.render()).rejects.toThrow()
})
it('prepared runtime refuses missing support, copied ownership and reader getter replacement before callbacks',async()=>{
 const {execution,domain}=await fixture(),source=createRuntimeContextSource(execution.owner);let callbacks=0
 expect(()=>createExecutionRuntimeContext({...execution},domain)).toThrow();expect(()=>createExecutionRuntimeContext(execution,{...domain})).toThrow()
 const reader={ownerSessionId:'owner',prepare:()=>execution.prepare(),assertCurrent:()=>domain.assertCurrent()}
 expect(()=>createPreparedRuntimeContext(reader,undefined as never)).toThrow()
 const hostile=Object.defineProperty({...reader},'prepare',{get(){callbacks++;throw Error('Getter prepare')}})
 expect(()=>createPreparedRuntimeContext(hostile,source)).toThrow();expect(callbacks).toBe(0)
 const runtime=createPreparedRuntimeContext(reader,source);resources.push(()=>runtime.close());runtime.registerSection('actual',()=> 'original')
 Object.defineProperty(reader,'assertCurrent',{get(){callbacks++;throw Error('Replaced currentness')}})
 probe.appends=0;await expect(runtime.render()).rejects.toThrow('changed');expect(callbacks).toBe(0);expect(probe.appends).toBe(0)
})
it.each([undefined,false,null])('genuine archive double failure preserves falsey currentness then cleanup (%j)',async primary=>{
 const {execution,domain}=await fixture();let held:import('@i-harness/core-session/internal/restoration').PreparedConversationArchive|undefined,fault=true,getters=0,ack=false,cleanupAttempts=0
 const cleanup={original:'archive cleanup'},originalDelete=Set.prototype.delete
 const spy=vi.spyOn(Set.prototype,'delete').mockImplementation(function(this:Set<unknown>,value:unknown){if(value===held){cleanupAttempts++;if(fault)throw cleanup}const deleted=originalDelete.call(this,value);if(value===held)ack=deleted;return deleted})
 const runtime=createPreparedRuntimeContext({ownerSessionId:'owner',async prepare(){held=await execution.prepare();return held},assertCurrent(){domain.assertCurrent();if(held)throw primary}},createRuntimeContextSource(execution.owner));resources.push(()=>runtime.close());runtime.registerSection('actual',()=>{getters++;return'original'})
 try{
  const failure=await runtime.render().then(()=>{throw Error('Unexpected publication success')},cause=>cause)
  expect(failure).toBeInstanceOf(AggregateError);expect(failure.errors).toHaveLength(2);expect(failure.errors[0]).toBe(primary);expect(failure.errors[1]).toBe(cleanup);expect(cleanupAttempts).toBe(1)
  expect(probe.appends).toBe(0);expect(getters).toBe(1)
  fault=false;await held!.settle();expect(ack).toBe(true);expect(cleanupAttempts).toBe(2);await runtime.settleOriginals();expect(getters).toBe(1);expect(probe.appends).toBe(0)
 }finally{fault=false;try{await held?.settle()}finally{spy.mockRestore()}}
})
it('genuine unknown publication and archive cleanup both survive before same-source recovery',async()=>{
 const {execution,domain}=await fixture();let held:import('@i-harness/core-session/internal/restoration').PreparedConversationArchive|undefined,fault=true,getters=0
 const cleanup=false,originalDelete=Set.prototype.delete,spy=vi.spyOn(Set.prototype,'delete').mockImplementation(function(this:Set<unknown>,value:unknown){if(value===held&&fault)throw cleanup;return originalDelete.call(this,value)})
 const runtime=createPreparedRuntimeContext({ownerSessionId:'owner',async prepare(){held=await execution.prepare();return held},assertCurrent(){domain.assertCurrent()}},createRuntimeContextSource(execution.owner));resources.push(()=>runtime.close());runtime.registerSection('actual',()=>{getters++;return'original'});probe.appends=0;probe.lose=true
 try{const failure=await runtime.render().then(()=>{throw Error('Unexpected publication success')},cause=>cause)
  expect(failure).toBeInstanceOf(AggregateError);expect(failure.errors[0]).toMatchObject({code:'FACT_RECOVERY_REQUIRED'});expect(failure.errors[1]).toBe(cleanup);expect(probe.appends).toBe(1)
  fault=false;await held!.settle();await runtime.settleOriginals();expect(probe.appends).toBe(1);expect(getters).toBe(1)
 }finally{fault=false;try{await held?.settle()}finally{spy.mockRestore()}}
})
