import {expect,it} from 'vitest'
import {mkdtemp} from 'node:fs/promises'
import {join} from 'node:path'
import {createJsonlBackend} from '@i-harness/session-persistence-jsonl'
import {composeJsonlTaskTransitionCoordinator} from '@i-harness/session-persistence-jsonl/internal/task-document-factory'
import {taskDocumentStorageContract} from '../../subagent/src/task/storage-contract.ts'
import {createScheduleFoldSink,createAfterScheduleRecord} from '../../schedule/src/index.ts'
import {acquireManagedExecution} from '../src/execution-internal.ts'

it('installs the constructor fold on actual original restoration and live acknowledged writes',async()=>{
 const root=await mkdtemp(join(process.env.IH_NATIVE_DEPENDENCY_EVIDENCE_ROOT!,'schedule-constructor-')),backend=createJsonlBackend(root)
 const options={lock:{enabled:true},originalExecutionFoldFactory:createScheduleFoldSink}
 const coordinator=composeJsonlTaskTransitionCoordinator(backend,options,taskDocumentStorageContract)
 try {
  await coordinator.create({sessionId:'owner'})
  const record=createAfterScheduleRecord('schedule-1','test',60,Date.parse('2026-08-31T10:00:00Z'))
  await coordinator.append('owner',[{type:'schedule/change',version:1,operation:'create',schedule:record}])
  const execution=await acquireManagedExecution(coordinator,'owner')
  expect(execution.observe().schedules).toMatchObject({kind:'available',snapshot:{active:[record],seenIds:['schedule-1'],inactive:[]}})
  const action=execution.owner.beginAction()
  expect(await action.facts.metadata.admit({type:'schedule/change',version:1,operation:'delete',id:'schedule-1'})).toMatchObject({kind:'committed'})
  expect(execution.observe().schedules).toMatchObject({kind:'available',snapshot:{active:[],inactive:[{id:'schedule-1',state:'already-deleted'}]}})
  action.finish()
 } finally {await coordinator.close()}
})

it('reads original tools from current same-owner observations and refuses foreign observations',async()=>{
 const root=await mkdtemp(join(process.env.IH_NATIVE_DEPENDENCY_EVIDENCE_ROOT!,'schedule-tools-')),backend=createJsonlBackend(root)
 const coordinator=composeJsonlTaskTransitionCoordinator(backend,{lock:{enabled:true},originalExecutionFoldFactory:createScheduleFoldSink},taskDocumentStorageContract)
 try {
  await coordinator.create({sessionId:'owner'});await coordinator.create({sessionId:'foreign'})
  const execution=await acquireManagedExecution(coordinator,'owner'),foreign=await acquireManagedExecution(coordinator,'foreign')
  const action=execution.owner.beginAction()
  const {createScheduleTools}=await import('../../schedule/src/tools.ts')
  const [create,list,remove]=createScheduleTools({original:execution,metadata:action.facts.metadata} as any)
  await create.execute({prompt:'remind',after_seconds:60},{})
  expect(await list.execute({},{})).toMatchObject({schedules:[{id:'schedule-1'}]})
  expect(await remove.execute({id:'schedule-1'},{})).toEqual({deleted:'schedule-1'})
  expect(await remove.execute({id:'schedule-1'},{})).toEqual({id:'schedule-1',deleted:false,state:'already-deleted'})
  const [,foreignList]=createScheduleTools({original:{identity:execution.identity,observe:()=>foreign.observe()},metadata:action.facts.metadata} as any)
  await expect(foreignList.execute({},{})).rejects.toThrow()
  action.finish()
 } finally {await coordinator.close()}
})

it('drives original observations with atomic scheduled input and cleans up',async()=>{
 const root=await mkdtemp(join(process.env.IH_NATIVE_DEPENDENCY_EVIDENCE_ROOT!,'schedule-driver-')),backend=createJsonlBackend(root)
 const coordinator=composeJsonlTaskTransitionCoordinator(backend,{lock:{enabled:true},originalExecutionFoldFactory:createScheduleFoldSink},taskDocumentStorageContract)
 try {
  await coordinator.create({sessionId:'owner'})
  const record=createAfterScheduleRecord('schedule-1','remind',60,Date.parse('2026-08-31T10:00:00Z'))
  await coordinator.append('owner',[{type:'schedule/change',version:1,operation:'create',schedule:record}])
  const execution=await acquireManagedExecution(coordinator,'owner')
  const {createScheduleDriver}=await import('../../schedule/src/driver.ts')
  let disposed=0
  const driver=createScheduleDriver({sessions:()=>['owner'],original:()=>execution,now:()=>Date.parse('2026-08-31T10:02:00Z'),subscribeMutations:()=>()=>{disposed++},deliver:async (delivery: import('../../schedule/src/driver.ts').ScheduleDelivery)=>{
   const action=execution.owner.beginAction()
   try {expect(await action.facts.inputs.scheduled(delivery.dispatchEvents,{type:'agent/input/admitted',version:1,inputId:delivery.inputId,text:delivery.text,delivery:'steer',intent:'system',provenance:{kind:'plugin',authority:'observation',scope:'turn',producer:'session.schedule'}})).toMatchObject({kind:'committed'})} finally {action.finish()}
  }} as any)
  expect(await driver.start()).toMatchObject({delivered:1,deliveryErrors:[]})
  expect(execution.observe().schedules).toMatchObject({snapshot:{inactive:[{id:'schedule-1',state:'already-fired'}]}})
  const {createScheduleTools}=await import('../../schedule/src/tools.ts');const action=execution.owner.beginAction();const [, ,remove]=createScheduleTools({original:execution,metadata:action.facts.metadata});expect(await remove.execute({id:'schedule-1'},{})).toEqual({id:'schedule-1',deleted:false,state:'already-fired'});action.finish()
  await driver.close();expect(disposed).toBe(1)
 } finally {await coordinator.close()}
})

it('refuses stale and unavailable original observations without effects',async()=>{
 const root=await mkdtemp(join(process.env.IH_NATIVE_DEPENDENCY_EVIDENCE_ROOT!,'schedule-refusal-')),backend=createJsonlBackend(root)
 const coordinator=composeJsonlTaskTransitionCoordinator(backend,{lock:{enabled:true},originalExecutionFoldFactory:createScheduleFoldSink},taskDocumentStorageContract)
 const noAdapter=composeJsonlTaskTransitionCoordinator(createJsonlBackend(await mkdtemp(join(process.env.IH_NATIVE_DEPENDENCY_EVIDENCE_ROOT!,'schedule-unavailable-'))),{lock:{enabled:true}},taskDocumentStorageContract)
 try {
  await coordinator.create({sessionId:'owner'});await noAdapter.create({sessionId:'other'})
  const execution=await acquireManagedExecution(coordinator,'owner'),other=await acquireManagedExecution(noAdapter,'other'),action=execution.owner.beginAction()
  const old=execution.observe()
  await action.facts.metadata.admit({type:'plan/mode',mode:'on'})
  const {createScheduleTools}=await import('../../schedule/src/tools.ts')
  const [stale]=createScheduleTools({original:{identity:execution.identity,observe:()=>old},metadata:action.facts.metadata} as any)
  await expect(stale.execute({prompt:'no',after_seconds:60},{})).rejects.toThrow()
  const [,unavailable]=createScheduleTools({original:other,metadata:action.facts.metadata} as any)
  await expect(unavailable.execute({},{})).rejects.toThrow(/unavailable/)
  expect(execution.observe().schedules).toMatchObject({snapshot:{active:[],seenIds:[]}})
  action.finish()
 } finally {await coordinator.close();await noAdapter.close()}
})


it('restores fired and deleted dispositions for the original delete tool',async()=>{
 const root=await mkdtemp(join(process.env.IH_NATIVE_DEPENDENCY_EVIDENCE_ROOT!,'schedule-restored-inactive-')),backend=createJsonlBackend(root)
 const coordinator=composeJsonlTaskTransitionCoordinator(backend,{lock:{enabled:true},originalExecutionFoldFactory:createScheduleFoldSink},taskDocumentStorageContract)
 try {
  await coordinator.create({sessionId:'owner'})
  const fired=createAfterScheduleRecord('schedule-1','fired',60,Date.parse('2026-08-31T10:00:00Z')),deleted=createAfterScheduleRecord('schedule-2','deleted',60,Date.parse('2026-08-31T10:00:00Z'))
  await coordinator.append('owner',[{type:'schedule/change',version:1,operation:'create',schedule:fired},{type:'schedule/change',version:1,operation:'dispatch',id:fired.id},{type:'schedule/change',version:1,operation:'create',schedule:deleted},{type:'schedule/change',version:1,operation:'delete',id:deleted.id}])
  const execution=await acquireManagedExecution(coordinator,'owner'),action=execution.owner.beginAction()
  const {createScheduleTools}=await import('../../schedule/src/tools.ts')
  const [, ,remove]=createScheduleTools({original:execution,metadata:action.facts.metadata})
  expect(await remove.execute({id:fired.id},{})).toEqual({id:fired.id,deleted:false,state:'already-fired'})
  expect(await remove.execute({id:deleted.id},{})).toEqual({id:deleted.id,deleted:false,state:'already-deleted'})
  action.finish()
 } finally {await coordinator.close()}
})

it('excludes inherited schedules from the original constructor fold',async()=>{
 const root=await mkdtemp(join(process.env.IH_NATIVE_DEPENDENCY_EVIDENCE_ROOT!,'schedule-inherited-')),backend=createJsonlBackend(root)
 const coordinator=composeJsonlTaskTransitionCoordinator(backend,{lock:{enabled:true},originalExecutionFoldFactory:createScheduleFoldSink},taskDocumentStorageContract)
 try {
  await coordinator.create({sessionId:'owner',parentSession:'parent',seedLength:1,origin:'fork'})
  const inherited=createAfterScheduleRecord('schedule-1','parent',60,Date.parse('2026-08-31T10:00:00Z')),own=createAfterScheduleRecord('schedule-1','child',120,Date.parse('2026-08-31T10:00:00Z'))
  await backend.append('owner',[{type:'schedule/change',version:1,operation:'create',schedule:inherited,seq:0},{type:'schedule/change',version:1,operation:'create',schedule:own,seq:1}])
  const execution=await acquireManagedExecution(coordinator,'owner')
  expect(execution.observe().schedules).toMatchObject({kind:'available',snapshot:{active:[own],seenIds:['schedule-1'],inactive:[]}})
 } finally {await coordinator.close()}
})
