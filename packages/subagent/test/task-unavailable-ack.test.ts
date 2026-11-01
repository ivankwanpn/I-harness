import {it,expect,vi} from 'vitest'
const scopeCut=vi.hoisted(()=>({path:'',armed:false,cause:undefined as unknown,attempts:0,entered:undefined as undefined|(()=>void),gate:undefined as undefined|Promise<void>}))
vi.mock('../../fs-lock/src/index.ts',async original=>{const real=await original<typeof import('../../fs-lock/src/index.ts')>();return {...real,async acquireSessionLock(options:import('../../fs-lock/src/index.ts').AcquireOptions){const lock=await real.acquireSessionLock(options);return {get held(){return lock.held},async release(){if(options.lockPath===scopeCut.path){scopeCut.entered?.();await scopeCut.gate;if(scopeCut.armed){scopeCut.attempts++;throw scopeCut.cause}}await lock.release()}}}}})
import {mkdtemp,rm} from 'node:fs/promises'
import {join} from 'node:path'
import {createJsonlTaskTransitionCoordinator} from '../../session-persistence-jsonl/src/task-document-factory.ts'
import {createTaskResultRetention} from '../../session-executor/src/lifecycle/task-result-retention.ts'
import {taskDocumentStorageContract} from '../src/task/storage-contract.ts'
import {SHIPPING_REPORT_POLICY} from '../src/report-policy.ts'
import {createTaskRegistry} from '../src/task/registry.ts'
import {captureOwnedTaskContext} from '../src/task/owned-context.ts'
import {lastOriginalTaskSave} from '../src/task/save-owner.ts'
import {lockPathFor} from '../../fs-lock/src/index.ts'
import {artifactPathsFor} from '../../session-persistence/src/coordinator/artifact-path-association.ts'
import {createJsonlBackend} from '../../session-persistence-jsonl/src/index.ts'
import {createContextOutputService} from '../../context-output/src/index.ts'
it.each([false,true])('original unavailable result acknowledgment is consumed once and never advertised durable (cold=%s)',async cold=>{
 const root=await mkdtemp(join(process.env.IH_NATIVE_DEPENDENCY_EVIDENCE_ROOT!,'task-result-ack-')),coordinator=createJsonlTaskTransitionCoordinator(root,{lock:{enabled:true}},taskDocumentStorageContract)
 let tasks:ReturnType<typeof createTaskRegistry>|undefined
 try{
  await coordinator.create({sessionId:'parent'});const document=await coordinator.openManagedDocument('parent')
  tasks=createTaskRegistry({coordinator,stateId:'parent',ownedTask:captureOwnedTaskContext(coordinator,document,document.view,'parent'),reportPolicy:SHIPPING_REPORT_POLICY,results:createTaskResultRetention(undefined,undefined,'parent')});await tasks.ready
  let task=tasks.submit({identity:{parentSessionId:'parent'},agentPath:'one',description:'one',prompt:'work',agent:'small',delivery:'tool'});await tasks.flushPersistence()
  tasks.terminalize({taskId:task.id,outcome:'completed',resultText:'done'});await tasks.retainResult(task.id)
  if(cold){tasks.retireOwnedLoad();await tasks.closeOwnedLoad();tasks=createTaskRegistry({coordinator,stateId:'parent',ownedTask:captureOwnedTaskContext(coordinator,document,document.view,'parent'),reportPolicy:SHIPPING_REPORT_POLICY,results:createTaskResultRetention(undefined,undefined,'parent')});await tasks.ready;expect(lastOriginalTaskSave(tasks)).toBeUndefined();task=tasks.get(task.id)!;await tasks.retainResult(task.id);expect(lastOriginalTaskSave(tasks)).toBeDefined()}
  const original=lastOriginalTaskSave(tasks);await tasks.retainResult(task.id);await tasks.flushPersistence()
  expect(lastOriginalTaskSave(tasks)).toBe(original);expect(task.retention).toBe('failed');expect(task.result).toMatchObject({kind:'retained',envelope:{retention:{kind:'unavailable'}}})
  await expect(tasks.readResult(task.id,{})).rejects.toThrow();tasks.retireOwnedLoad();await tasks.closeOwnedLoad()
 }finally{await tasks?.closeOwnedLoad();await coordinator.close();await rm(root,{recursive:true,force:true})}
})
it.each(['revision','descriptor'] as const)('original result ACK never certifies a %s replacement during its original native close',async change=>{
 const root=await mkdtemp(join(process.env.IH_NATIVE_DEPENDENCY_EVIDENCE_ROOT!,'task-ack-race-')),coordinator=createJsonlTaskTransitionCoordinator(root,{lock:{enabled:true}},taskDocumentStorageContract),entered=Promise.withResolvers<void>(),release=Promise.withResolvers<void>()
 let tasks:ReturnType<typeof createTaskRegistry>|undefined
 try{
  await coordinator.create({sessionId:'parent'});const document=await coordinator.openManagedDocument('parent')
  tasks=createTaskRegistry({coordinator,stateId:'parent',ownedTask:captureOwnedTaskContext(coordinator,document,document.view,'parent'),reportPolicy:SHIPPING_REPORT_POLICY,results:createTaskResultRetention(undefined,undefined,'parent')});await tasks.ready
  const task=tasks.submit({identity:{parentSessionId:'parent'},agentPath:'one',description:'one',prompt:'work',agent:'small',delivery:'tool'});await tasks.flushPersistence()
  const capture=artifactPathsFor(createJsonlBackend(root))!.document('task-parent') as {key:string};scopeCut.path=lockPathFor(root,'artifact-document-lease:'+capture.key);scopeCut.entered=entered.resolve;scopeCut.gate=release.promise
  tasks.terminalize({taskId:task.id,outcome:'completed',resultText:'done'});const retaining=tasks.retainResult(task.id);void retaining.catch(()=>{});await entered.promise
  const original=lastOriginalTaskSave(tasks),revision=task.result!.revision
  if(task.result?.kind!=='retained')throw Error('Original result not retained')
  task.result=change==='revision'?{...task.result,revision:'11111111-1111-4111-8111-111111111111'}:{...task.result,envelope:{...task.result.envelope,retention:{kind:'unavailable',reason:'quota'}}}
  release.resolve();await expect(retaining).rejects.toThrow('Original saved task result changed')
  expect((await coordinator.getDocument('task-parent') as {tasks:{result:{revision:string;envelope:{preview:string}}}[]}).tasks[0]!.result).toMatchObject({revision,envelope:{preview:''}})
  await expect(tasks.retainResult(task.id)).rejects.toThrow('Original saved task result changed');await expect(tasks.retainResult(task.id)).rejects.toThrow('Original saved task result changed');expect(lastOriginalTaskSave(tasks)).toBe(original);expect(task.retention).toBe('failed')
 }finally{release.resolve();scopeCut.path='';scopeCut.entered=undefined;scopeCut.gate=undefined;await tasks?.closeOwnedLoad();await coordinator.close();await rm(root,{recursive:true,force:true})}
})

it.each(['revision','descriptor','unchanged','cold'] as const)('original artifact-durable ACK refuses replacement without rewriting its original body (%s)',async mode=>{
 const root=await mkdtemp(join(process.env.IH_NATIVE_DEPENDENCY_EVIDENCE_ROOT!,'task-artifact-ack-')),coordinator=createJsonlTaskTransitionCoordinator(root,{lock:{enabled:true}},taskDocumentStorageContract)
 const service=createContextOutputService({root:join(root,'results'),workspaceId:'w'})
 let tasks:ReturnType<typeof createTaskRegistry>|undefined
 try{
  await coordinator.create({sessionId:'parent'});const document=await coordinator.openManagedDocument('parent')
  const options={coordinator,stateId:'parent',ownedTask:captureOwnedTaskContext(coordinator,document,document.view,'parent'),reportPolicy:SHIPPING_REPORT_POLICY,results:createTaskResultRetention(service,undefined,'parent')}
  tasks=createTaskRegistry(options);await tasks.ready
  let task=tasks.submit({identity:{parentSessionId:'parent'},agentPath:'one',description:'one',prompt:'work',agent:'small',delivery:'tool'});await tasks.flushPersistence()
  tasks.terminalize({taskId:task.id,outcome:'completed',resultText:'original durable artifact bytes'});await tasks.retainResult(task.id);await tasks.flushPersistence()
  expect(task.retention).toBe('durable');expect(task.result).toMatchObject({kind:'retained',envelope:{retention:{kind:'artifact'}}})
  const saved=await coordinator.getDocument('task-parent')
  if(mode==='cold'){
   tasks.retireOwnedLoad();await tasks.closeOwnedLoad();tasks=createTaskRegistry(options);await tasks.ready;task=tasks.get(task.id)!;expect(task.retention).toBe('durable');expect(lastOriginalTaskSave(tasks)).toBeUndefined()
  }
  const original=lastOriginalTaskSave(tasks)
  if(task.result?.kind!=='retained')throw Error('Original artifact result not retained')
  if(mode==='revision')task.result={...task.result,revision:'11111111-1111-4111-8111-111111111111'}
  if(mode==='descriptor')task.result={...task.result,envelope:{...task.result.envelope,execution:{...task.result.envelope.execution,dispatch:'unknown'}}}
  if(mode==='revision'||mode==='descriptor'){
   // Keeping the original memo makes a repeated refusal independent of the
   // mutable durable status; a replacement cannot borrow the original ACK.
   await expect(tasks.retainResult(task.id)).rejects.toThrow('Original saved task result changed')
   await expect(tasks.retainResult(task.id)).rejects.toThrow('Original saved task result changed')
  }else{
   await tasks.retainResult(task.id);await tasks.retainResult(task.id)
   expect(JSON.parse((await tasks.readResult(task.id,{})).data.text)).toEqual({resultText:'original durable artifact bytes'})
   expect(task.retention).toBe('durable')
  }
  await tasks.flushPersistence();expect(lastOriginalTaskSave(tasks)).toBe(original);expect(await coordinator.getDocument('task-parent')).toEqual(saved)
 }finally{await tasks?.closeOwnedLoad();await coordinator.close();await service.close();await rm(root,{recursive:true,force:true})}
})
it.each([undefined,false])('original unavailable ACK retains the same failed native close (%s)',async cause=>{
 const root=await mkdtemp(join(process.env.IH_NATIVE_DEPENDENCY_EVIDENCE_ROOT!,'task-ack-close-')),coordinator=createJsonlTaskTransitionCoordinator(root,{lock:{enabled:true}},taskDocumentStorageContract)
 let tasks:ReturnType<typeof createTaskRegistry>|undefined
 try{
  await coordinator.create({sessionId:'parent'});const document=await coordinator.openManagedDocument('parent')
  tasks=createTaskRegistry({coordinator,stateId:'parent',ownedTask:captureOwnedTaskContext(coordinator,document,document.view,'parent'),reportPolicy:SHIPPING_REPORT_POLICY,results:createTaskResultRetention(undefined,undefined,'parent')});await tasks.ready
  const task=tasks.submit({identity:{parentSessionId:'parent'},agentPath:'one',description:'one',prompt:'work',agent:'small',delivery:'tool'});await tasks.flushPersistence()
  const capture=artifactPathsFor(createJsonlBackend(root))!.document('task-parent') as {key:string};scopeCut.path=lockPathFor(root,'artifact-document-lease:'+capture.key);scopeCut.cause=cause;scopeCut.armed=true;scopeCut.attempts=0
  tasks.terminalize({taskId:task.id,outcome:'completed',resultText:'done'});await expect(tasks.retainResult(task.id)).rejects.toThrow()
  const original=lastOriginalTaskSave(tasks);expect(original).toBeDefined();expect(scopeCut.attempts).toBeGreaterThan(0);expect(task.retention).toBe('failed');await expect(tasks.flushPersistence()).rejects.toThrow()
  scopeCut.armed=false;await tasks.retainResult(task.id);expect(lastOriginalTaskSave(tasks)).toBe(original);await tasks.retainResult(task.id);expect(lastOriginalTaskSave(tasks)).toBe(original);expect(task.retention).toBe('failed');await tasks.flushPersistence()
 }finally{scopeCut.armed=false;scopeCut.path='';await tasks?.closeOwnedLoad();await coordinator.close();await rm(root,{recursive:true,force:true})}
})
