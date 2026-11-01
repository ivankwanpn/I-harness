import {expect,it,vi} from 'vitest'
const probe=vi.hoisted(()=>({unknownNext:false,appends:0}))
vi.mock('../../session-persistence-jsonl/src/backend/fact-journal.ts',async load=>{const original=await load<typeof import('../../session-persistence-jsonl/src/backend/fact-journal.ts')>();return {...original,createFactJournalBackend(...args:Parameters<typeof original.createFactJournalBackend>){const journal=original.createFactJournalBackend(...args),append=journal.appendOwnedBatch;return {...journal,async appendOwnedBatch(...input:Parameters<typeof append>){probe.appends++;const outcome=await append(...input);if(probe.unknownNext&&outcome.kind==='committed'){probe.unknownNext=false;return {kind:'unknown' as const,key:input[3].key}}return outcome}}}}})
import {mkdtemp} from 'node:fs/promises'
import {join} from 'node:path'
import {createJsonlBackend} from '../../session-persistence-jsonl/src/index.ts'
import {composeJsonlTaskTransitionCoordinator} from '../../session-persistence-jsonl/src/task-document-factory.ts'
import {taskDocumentStorageContract} from '../../subagent/src/task/storage-contract.ts'
import {acquireManagedExecution} from '../../session-persistence/src/execution-internal.ts'
import {createExecutionGenerationLifecycle} from '../../session-executor/src/lifecycle/generation-actions.ts'
import * as executionInternal from '@i-harness/core-session/internal/execution'

async function fixture(){const root=await mkdtemp(join(process.env.IH_NATIVE_DEPENDENCY_EVIDENCE_ROOT!,'source-generation-')),coordinator=composeJsonlTaskTransitionCoordinator(createJsonlBackend(root),{lock:{enabled:true}},taskDocumentStorageContract),{id}=await coordinator.create(),execution=await acquireManagedExecution(coordinator,id),action=execution.owner.beginAction(),source=action.registerSettlementSource(async()=>{});return {coordinator,id,execution,action,source}}
it('an already held original source reads the same changing generation fold after revoke while fresh observe stays retired',async()=>{
 const {coordinator,id,execution,action,source}=await fixture();let lifecycle:ReturnType<typeof createExecutionGenerationLifecycle>|undefined,generation:Awaited<ReturnType<NonNullable<typeof lifecycle>['open']>>|undefined
 try{const read=executionInternal.readManagedSourceGenerations;expect(read).toBeTypeOf('function');const admitted=await action.facts.inputs.admit({type:'agent/input/admitted',version:1,inputId:'actual',text:'work',intent:'user',delivery:'queue',provenance:{kind:'unknown',authority:'unknown',scope:'turn',producer:'fixture.literal'}});if(admitted.kind!=='committed')throw Error('Original admission missing')
  lifecycle=createExecutionGenerationLifecycle(execution,id,action);generation=await lifecycle.open('main',{kind:'input',seq:admitted.seqs[0]!})
  const opened=read(execution.identity,source);expect(opened).toHaveLength(1);expect(opened[0]!.opened.actionId).toBe(generation.actionId);expect(opened[0]!.closed).toBeUndefined();expect(Object.isFrozen(opened)).toBe(true)
  await generation.close('stopped');const closed=read(execution.identity,source);expect(closed[0]!.closed).toBe('stopped');expect(opened[0]!.closed).toBeUndefined()
  execution.revokeNewWork();expect(()=>execution.observe()).toThrow();expect(read(execution.identity,source)).toEqual(closed);expect(()=>read(execution.identity,{...source})).toThrow();await source.close();expect(()=>read(execution.identity,source)).toThrow();await lifecycle.drain()
 }finally{await generation?.close('failed');await lifecycle?.drain();await source.close();action.finish();await coordinator.close()}
})
it('source generation reads refuse copied identity, foreign source and replaced source method without invoking it',async()=>{
 const {coordinator,execution,action,source}=await fixture(),{id}=await coordinator.create(),foreign=await acquireManagedExecution(coordinator,id),other=foreign.owner.beginAction(),otherSource=other.registerSettlementSource(async()=>{});let called=0;const original=Object.getOwnPropertyDescriptor(source,'assertHeld')!
 try{const read=executionInternal.readManagedSourceGenerations;expect(read).toBeTypeOf('function');expect(read(execution.identity,source)).toEqual([]);expect(()=>read({...execution.identity},source)).toThrow();expect(()=>read(execution.identity,otherSource)).toThrow();Object.defineProperty(source,'assertHeld',{configurable:true,enumerable:true,get(){called++;return()=>{}}});expect(()=>read(execution.identity,source)).toThrow();expect(called).toBe(0);Object.defineProperty(source,'assertHeld',original);await source.close();expect(()=>read(execution.identity,source)).toThrow();expect(called).toBe(0)}finally{Object.defineProperty(source,'assertHeld',original);await source.close();action.finish();await otherSource.close();other.finish();await coordinator.close()}
})
it('source generation read refuses an unresolved original native frame until that same CAP reconciles',async()=>{
 const {coordinator,execution,action,source}=await fixture()
 try{const read=executionInternal.readManagedSourceGenerations;expect(read).toBeTypeOf('function');probe.appends=0;const capture=action.captureToolCall!({type:'tool/call',callId:'uncertain',name:'read',args:{}});probe.unknownNext=true;expect((await capture.admit()).kind).toBe('unknown');expect(()=>read(execution.identity,source)).toThrow();expect((await capture.reconcile()).kind).toBe('committed');expect(read(execution.identity,source)).toEqual([]);expect(probe.appends).toBe(1)}finally{probe.unknownNext=false;await source.close();action.finish();await coordinator.close()}
})
