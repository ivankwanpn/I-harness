import {expect,it,vi} from 'vitest'
const fault=vi.hoisted(()=>({close:false}))
vi.mock('../src/execution-internal.ts',async load=>{const original=await load<typeof import('../src/execution-internal.ts')>();return {...original,associateExecutionDependencies(backend:object,open:Parameters<typeof original.associateExecutionDependencies>[1]){original.associateExecutionDependencies(backend,(...args)=>{const scope=open(...args);return Object.freeze({assertCurrent:scope.assertCurrent.bind(scope),readEvent:scope.readEvent.bind(scope),async close(){if(fault.close)throw Error('controlled Team scope close');await scope.close()}})})}}})
import {mkdtemp} from 'node:fs/promises'
import {join} from 'node:path'
import {committedFactSeqs} from '@i-harness/core-session'
import {createManagedExecutionDomain,captureManagedTeamParent,assertOriginalManagedTeamParent} from '@i-harness/core-session/internal/execution'
import {createJsonlBackend} from '../../session-persistence-jsonl/src/index.ts'
import {composeJsonlTaskTransitionCoordinator} from '../../session-persistence-jsonl/src/task-document-factory.ts'
import {taskDocumentStorageContract} from '../../subagent/src/task/storage-contract.ts'
import {acquireManagedExecution} from '../src/execution-internal.ts'

it('retains the original Team ledger and live inbox membership without a parent view',async()=>{
 const root=await mkdtemp(join(process.env.IH_NATIVE_DEPENDENCY_EVIDENCE_ROOT!,'private-team-parent-')),coordinator=composeJsonlTaskTransitionCoordinator(createJsonlBackend(root),{lock:{enabled:true}},taskDocumentStorageContract)
 await coordinator.create({sessionId:'parent'});const execution=await acquireManagedExecution(coordinator,'parent'),domain=createManagedExecutionDomain(execution.identity,execution.owner,{}),action=execution.owner.beginAction(),source=action.registerSettlementSource(async()=>{})
 try{
  const event={type:'team/task' as const,version:1 as const,teamId:'team',task:{id:'task',revision:1,subject:'work',description:'work',status:'pending' as const,blockedBy:[],writeScopes:[]}}
  committedFactSeqs(await action.captureTeamTransaction([event]).admit())
  const parent=captureManagedTeamParent(domain)
  try{expect(()=>parent.ledger).toThrow();await parent.ready;assertOriginalManagedTeamParent(domain,parent);expect(parent.ledger).toEqual([expect.objectContaining(event)]);expect(parent.hasInbox('msg')).toBe(false)
   committedFactSeqs(await source.delivery.capture({type:'subagent/inbox',messageId:'msg',message:'hello'}).admit());expect(parent.hasInbox('msg')).toBe(true);expect(parent.ledger).toHaveLength(1)
   committedFactSeqs(await source.delivery.capture({type:'subagent/inbox',messageId:'',message:'legacy empty id'}).admit());expect(parent.hasInbox('')).toBe(true)
   committedFactSeqs(await action.captureTeamTransaction([{...event,task:{...event.task,revision:2,subject:'updated'}}]).admit());assertOriginalManagedTeamParent(domain,parent);expect(parent.ledger).toHaveLength(1)
   expect(()=>assertOriginalManagedTeamParent(domain,{...parent})).toThrow()
  }finally{await parent.close()}
  expect(()=>parent.hasInbox('msg')).toThrow();expect(Object.hasOwn(execution.owner,'view')).toBe(false)
  const stale=captureManagedTeamParent(domain);await stale.ready;committedFactSeqs(await action.facts.metadata.admit({type:'sandbox/mode',mode:'read-only'}));expect(()=>stale.ledger).toThrow('prefix changed');await stale.close()
  fault.close=true;const failed=captureManagedTeamParent(domain);await expect(failed.ready).rejects.toThrow('controlled Team scope close');expect(()=>domain.assertCurrent()).toThrow();fault.close=false;await failed.close();domain.assertCurrent()
 }finally{fault.close=false;await source.close();action.finish();await coordinator.close()}
},20000)

it('excludes inherited fork Team events from the original local ledger',async()=>{
 const root=await mkdtemp(join(process.env.IH_NATIVE_DEPENDENCY_EVIDENCE_ROOT!,'private-team-fork-')),backend=createJsonlBackend(root),coordinator=composeJsonlTaskTransitionCoordinator(backend,{lock:{enabled:true}},taskDocumentStorageContract)
 try{
  await coordinator.create({sessionId:'fork',parentSession:'parent',seedLength:1,origin:'fork'})
  const task={id:'task',revision:1,subject:'work',description:'work',status:'pending' as const,blockedBy:[],writeScopes:[]}
  await backend.append('fork',[{type:'team/task',version:1,teamId:'inherited',task,seq:0},{type:'team/task',version:1,teamId:'local',task,seq:1}])
  const execution=await acquireManagedExecution(coordinator,'fork'),domain=createManagedExecutionDomain(execution.identity,execution.owner,{}),parent=captureManagedTeamParent(domain)
  try{await parent.ready;expect(parent.ledger).toEqual([expect.objectContaining({teamId:'local',seq:1})])}finally{await parent.close()}
 }finally{await coordinator.close()}
},20000)
