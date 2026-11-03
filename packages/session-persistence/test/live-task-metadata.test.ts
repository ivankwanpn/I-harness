import {expect,it,vi} from 'vitest'
const cut=vi.hoisted(()=>({hold:false,fail:false,entered:undefined as undefined|(()=>void),gate:undefined as Promise<void>|undefined}))
vi.mock('node:fs/promises',async load=>{const real=await load<typeof import('node:fs/promises')>();return {...real,async rename(...args:Parameters<typeof real.rename>){await real.rename(...args);if(cut.hold&&String(args[1]).endsWith('parent.jsonl')){cut.hold=false;cut.entered?.();await cut.gate;if(cut.fail)throw undefined}}}})
import {mkdtemp} from 'node:fs/promises'
import {join} from 'node:path'
import {createJsonlBackend} from '@i-harness/session-persistence-jsonl'
import {composeJsonlTaskTransitionCoordinator} from '@i-harness/session-persistence-jsonl/internal/task-document-factory'
import {taskDocumentStorageContract} from '../../subagent/src/task/storage-contract.ts'
import {createTaskRegistry} from '../../subagent/src/task/registry.ts'
import {captureOwnedTaskContext} from '../../subagent/src/task/owned-context.ts'
import * as managed from '../src/coordinator/managed-document.ts'
import {taskParentMetadataProjection} from '../src/coordinator/task-parent-metadata.ts'

it.each(['title','failed','authority'] as const)('retains only actual live Task currency after original metadata ACK: %s',async mode=>{
 const root=await mkdtemp(join(process.env.IH_NATIVE_DEPENDENCY_EVIDENCE_ROOT!,'task-meta-')),coordinator=composeJsonlTaskTransitionCoordinator(createJsonlBackend(root),{lock:{enabled:true}},taskDocumentStorageContract)
 const factory=vi.spyOn(managed,'createManagedDocument'),entered=Promise.withResolvers<void>(),gate=Promise.withResolvers<void>()
 let registry:ReturnType<typeof createTaskRegistry>|undefined,source:import('@i-harness/core-session').SettlementFacts|undefined,action:ReturnType<Awaited<ReturnType<typeof coordinator.openManagedDocument>>['beginAction']>|undefined
 try {
  await coordinator.create({sessionId:'parent'});const document=await coordinator.openManagedDocument('parent'),ownership=factory.mock.calls.at(-1)![4]
  registry=createTaskRegistry({coordinator,stateId:'parent',ownedTask:captureOwnedTaskContext(coordinator,document,document.view,'parent')});await registry.ready
  const fixed=managed.captureManagedReadyObservation(document,ownership),generic=managed.captureManagedParentReadiness(document,ownership),selected=managed.retainSelectedSourceRead(document,ownership,()=>{})
  action=document.beginAction();const originalSource=action.registerSettlementSource(async()=>{});source=originalSource
  const required=managed.captureManagedRequiredParent(document,ownership,originalSource)
  cut.hold=true;cut.fail=mode==='failed';cut.entered=entered.resolve;cut.gate=gate.promise
  const changing=coordinator.updateMeta('parent',mode==='authority'?{modelSelection:{provider:'fixture',model:'changed'}}:{title:'display title'});void changing.catch(()=>{})
  expect(()=>registry!.notifications()).toThrow();expect(()=>required.assertCurrent()).toThrow();expect(()=>fixed.assertCurrent()).toThrow()
  await entered.promise;expect(()=>registry!.notifications()).toThrow();gate.resolve()
  if(mode==='failed')await expect(changing).rejects.toMatchObject({message:'TASK_TRANSITION_FAILED',cause:undefined});else await changing
  expect(()=>fixed.assertCurrent()).toThrow();expect(()=>generic.assertCurrent()).toThrow();expect(()=>selected.assertCurrent()).toThrow();selected.unsubscribe()
  if(mode==='title'){
   expect(registry.notifications()).toEqual([]);required.assertCurrent()
   expect(()=>Reflect.apply(required.assertCurrent,{...required},[])).toThrow()
   const writer=await required.acquireWriter();writer.release()
   const task=registry.submit({identity:{parentSessionId:'parent'},agentPath:'root/next',description:'next',prompt:'next',agent:'general',delivery:'tool'});await registry.flushPersistence();expect(registry.get(task.id)).toBe(task)
   await originalSource.close();expect(()=>required.assertCurrent()).toThrow()
  }else{expect(()=>registry!.notifications()).toThrow();expect(()=>required.assertCurrent()).toThrow()}
 }finally{cut.hold=false;cut.fail=false;gate.resolve();await source?.close();action?.finish();await registry?.closeOwnedLoad();await coordinator.close();factory.mockRestore()}
})

it('classifies every known metadata field and refuses unclosed authority',()=>{
 const base={formatVersion:14,sessionId:'parent',createdAt:'2026-11-02T00:00:00.000Z'}
 expect(taskParentMetadataProjection({...base,title:'new display'})).toBe(taskParentMetadataProjection(base))
 for(const patch of [{archived:true},{workspaceId:'other'},{parentSession:'other'},{seedLength:1},{delegationDepth:1},{subagentProtocolVersion:1},{origin:'subagent'},{modelSelection:{provider:'fixture',model:'other'}}])expect(taskParentMetadataProjection({...base,...patch})).not.toBe(taskParentMetadataProjection(base))
 for(const patch of [{futureAuthority:true},{modelSelection:{provider:'fixture',model:'m',future:true}},{journal:{version:1}},{semanticSeed:{version:1}},{archived:'yes'},{workspaceId:undefined}])expect(()=>taskParentMetadataProjection({...base,...patch})).toThrow()
})
