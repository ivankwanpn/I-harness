import {lockPathFor} from '../../fs-lock/src/index.ts'
import {artifactPathsFor} from '../../session-persistence/src/coordinator/artifact-path-association.ts'
import {createJsonlBackend} from '../../session-persistence-jsonl/src/index.ts'
vi.mock('../../fs-lock/src/index.ts',async load=>{const original=await load<typeof import('../../fs-lock/src/index.ts')>();return {...original,async acquireSessionLock(options:import('../../fs-lock/src/index.ts').AcquireOptions){const lock=await original.acquireSessionLock(options);queueGate.locks.set(options.lockPath,lock);return {get held(){return lock.held},async release(){if(options.lockPath===queueGate.closePath){queueGate.closeEntered?.();await queueGate.closeGate;if(queueGate.closeArmed){queueGate.closeAttempts++;throw queueGate.closeCause}}await lock.release()}}}}})
const queueGate=vi.hoisted(()=>({root:'',blocked:false,ackEntered:undefined as undefined|(()=>void),ackGate:undefined as undefined|Promise<void>,stages:[] as string[],closePath:'',closeArmed:false,closeCause:undefined as unknown,closeAttempts:0,closeEntered:undefined as undefined|(()=>void),closeGate:undefined as undefined|Promise<void>,locks:new Map<string,{readonly held:boolean;release():void|Promise<void>}>()}))
vi.mock('../../session-persistence-jsonl/src/backend/document-write.ts',async load=>{
 const original=await load<typeof import('../../session-persistence-jsonl/src/backend/document-write.ts')>()
 return {...original,createOwnedDocumentWrite(...args:Parameters<typeof original.createOwnedDocumentWrite>){
  const created=original.createOwnedDocumentWrite(...args),input=args[0],terminal=input.path.startsWith(queueGate.root)&&JSON.parse(Buffer.from(input.bytes).toString('utf8')).tasks?.some((task:{outcome?:string})=>task.outcome!==undefined)
  if(!queueGate.root||!terminal)return created
  queueGate.stages.push(Buffer.from(input.bytes).toString('utf8'))
  const apply=async(retry:boolean)=>{const outcome=retry?await created.handle.retry():await created.handle.issue();queueGate.ackEntered?.();await queueGate.ackGate;return queueGate.blocked?{kind:'unknown' as const,cause:undefined,cleanupPending:false}:outcome}
  return {handle:{issue:()=>apply(false),retry:()=>apply(true),reconcile:created.handle.reconcile.bind(created.handle),outcome:created.handle.outcome.bind(created.handle)},settle:created.settle.bind(created)}
 }}
})
import {lastOriginalTaskSave} from '../src/task/save-owner.ts'
import {it,expect,vi} from 'vitest'
import {mkdtemp} from 'node:fs/promises'
import {join} from 'node:path'
import {createJsonlTaskTransitionCoordinator} from '../../session-persistence-jsonl/src/task-document-factory.ts'
import {taskDocumentStorageContract} from '../src/task/storage-contract.ts'
import {captureOwnedTaskContext} from '../src/task/owned-context.ts'
import {createTaskRegistry} from '../src/task/registry.ts'
import {bindRequiredTaskSettlement,type RequiredTaskSettlement} from '../src/task/required-settlement.ts'
import {createTaskResultRetention} from '../../session-executor/src/lifecycle/task-result-retention.ts'
import {SHIPPING_REPORT_POLICY} from '../src/report-policy.ts'
import {taskDocumentOperationsFor} from '@i-harness/session-persistence/internal/task-document-operations'

it.each([true,false])('retains original retired data and rejects ordinary/copied authority (reportPolicy=%s)',async(reportPolicy)=>{
 const root=await mkdtemp(join(process.env.IH_NATIVE_DEPENDENCY_EVIDENCE_ROOT!,'required-owner-')),c=createJsonlTaskTransitionCoordinator(root,{lock:{enabled:true}},taskDocumentStorageContract)
 let tasks:ReturnType<typeof createTaskRegistry>|undefined,required:RequiredTaskSettlement|undefined
 try{
  await c.create({sessionId:'parent'});const document=await c.openManagedDocument('parent'),owned=captureOwnedTaskContext(c,document,document.view,'parent')!
  tasks=createTaskRegistry({coordinator:c,stateId:'parent',ownedTask:owned,reportPolicy:reportPolicy?SHIPPING_REPORT_POLICY:undefined,results:createTaskResultRetention(undefined,undefined,'parent')});await tasks.ready
  const task=tasks.submit({identity:{parentSessionId:'parent'},agentPath:'one',description:'one',prompt:'work',agent:'general',delivery:'tool'});await tasks.flushPersistence()
  const action=document.beginAction(),source=action.registerSettlementSource(async()=>{await required?.settle()})
  required=(await bindRequiredTaskSettlement(tasks,task,source,async()=>({taskId:task.id,outcome:'cancelled'})))!
  await expect(bindRequiredTaskSettlement(tasks,{...task},source,async()=>({taskId:task.id,outcome:'cancelled'}))).rejects.toThrow()
  await expect(owned.operations.requiredParent(document,{...source})).rejects.toThrow()
  await expect(owned.operations.begin({})).rejects.toThrow()
  const last=lastOriginalTaskSave(tasks),heldMethod=source.assertHeld;source.assertHeld=()=>{};await expect(required.settle()).rejects.toThrow();expect(lastOriginalTaskSave(tasks)).toBe(last);source.assertHeld=heldMethod
  tasks.retireOwnedLoad();document.revokeNewWork()
  expect(()=>tasks!.assertReady()).toThrow();expect(()=>taskDocumentOperationsFor(c)!.parent(document)).toThrow()
  await expect(owned.operations.begin(owned.parent)).rejects.toThrow()
  const first=required.settle(),second=required.reconcile();expect(second).toBe(first)
  const terminal=await first;expect(terminal.outcome).toBe('cancelled');expect(terminal.retention).toBe('failed');expect(terminal.result).toMatchObject({kind:'retained',envelope:{retention:{kind:'unavailable'}}})
  const saved=await c.getDocument('task-parent') as {tasks:{outcome:string}[]};expect(saved.tasks[0]!.outcome).toBe('cancelled')
  await required.release();await source.close();action.finish();await tasks.closeOwnedLoad()
 }catch(cause){console.info('required-owner-primary',cause);throw cause}finally{await tasks?.closeOwnedLoad();await c.close()}
})

it('keeps a Stop winner and its exact original acknowledged save instead of capturing a completion replacement',async()=>{
 const root=await mkdtemp(join(process.env.IH_NATIVE_DEPENDENCY_EVIDENCE_ROOT!,'required-stop-')),c=createJsonlTaskTransitionCoordinator(root,{lock:{enabled:true}},taskDocumentStorageContract)
 let tasks:ReturnType<typeof createTaskRegistry>|undefined,required:RequiredTaskSettlement|undefined
 try{
  await c.create({sessionId:'parent'});const document=await c.openManagedDocument('parent');tasks=createTaskRegistry({coordinator:c,stateId:'parent',ownedTask:captureOwnedTaskContext(c,document,document.view,'parent'),reportPolicy:SHIPPING_REPORT_POLICY,results:createTaskResultRetention(undefined,undefined,'parent')});await tasks.ready
  const task=tasks.submit({identity:{parentSessionId:'parent'},agentPath:'one',description:'one',prompt:'work',agent:'general',delivery:'tool'});await tasks.flushPersistence()
  const action=document.beginAction(),source=action.registerSettlementSource(async()=>{await required?.settle()});required=(await bindRequiredTaskSettlement(tasks,task,source,async()=>({taskId:task.id,outcome:'completed',resultText:'late result'})))!
  tasks.terminalize({taskId:task.id,outcome:'cancelled',error:'Stop won'});await tasks.retainResult(task.id);const save=lastOriginalTaskSave(tasks),revision=task.result!.revision
  tasks.retireOwnedLoad();document.revokeNewWork();const terminal=await required.settle();expect(terminal.outcome).toBe('cancelled');expect(terminal.result!.revision).toBe(revision);expect(lastOriginalTaskSave(tasks)).toBe(save)
  await required.release();await source.close();action.finish();await tasks.closeOwnedLoad()
 }finally{await tasks?.closeOwnedLoad();await c.close()}
})

it('reserves A and B on the one queue, blocks B behind unknown A and captures each final snapshot once',async()=>{
 const root=await mkdtemp(join(process.env.IH_NATIVE_DEPENDENCY_EVIDENCE_ROOT!,'required-queue-')),c=createJsonlTaskTransitionCoordinator(root,{lock:{enabled:true}},taskDocumentStorageContract)
 let tasks:ReturnType<typeof createTaskRegistry>|undefined
 const producerB=Promise.withResolvers<void>()
 const obligations:RequiredTaskSettlement[]=[],sources:import('@i-harness/core-session').SettlementFacts[]=[]
 try{
  await c.create({sessionId:'parent'});const document=await c.openManagedDocument('parent');tasks=createTaskRegistry({coordinator:c,stateId:'parent',ownedTask:captureOwnedTaskContext(c,document,document.view,'parent'),reportPolicy:SHIPPING_REPORT_POLICY,results:createTaskResultRetention(undefined,undefined,'parent')});await tasks.ready
  for(const name of ['a','b']){
   const task=tasks.submit({identity:{parentSessionId:'parent',toolCallId:name},agentPath:name,description:name,prompt:'work',agent:'general',delivery:'tool'});await tasks.flushPersistence()
   const action=document.beginAction();let obligation:RequiredTaskSettlement|undefined;const source=action.registerSettlementSource(async()=>{await obligation?.settle()});sources.push(source)
   obligation=(await bindRequiredTaskSettlement(tasks,task,source,async()=>{if(name==='b')await producerB.promise;return {taskId:task.id,outcome:'cancelled'}}))!;obligations.push(obligation);action.finish()
  }
  queueGate.root=root;queueGate.blocked=true;queueGate.stages=[];tasks.retireOwnedLoad();document.revokeNewWork()
  await expect(obligations[0]!.settle()).rejects.toThrow();expect(queueGate.stages).toHaveLength(1)
  producerB.resolve();await expect(obligations[1]!.settle()).rejects.toThrow();expect(queueGate.stages).toHaveLength(1)
  queueGate.blocked=false;await obligations[0]!.reconcile();await obligations[1]!.reconcile();expect(queueGate.stages).toHaveLength(2)
  const first=JSON.parse(queueGate.stages[0]!),second=JSON.parse(queueGate.stages[1]!);expect(first.tasks.map((t:{outcome?:string})=>t.outcome)).toEqual(['cancelled',undefined]);expect(second.tasks.map((t:{outcome?:string})=>t.outcome)).toEqual(['cancelled','cancelled'])
  for(const obligation of obligations)await obligation.release();for(const source of sources)await source.close();await tasks.closeOwnedLoad()
 }finally{producerB.resolve();queueGate.blocked=false;queueGate.root='';await tasks?.closeOwnedLoad();await c.close()}
})

it.each([undefined,false])('keeps original falsey native cleanup debt and same acknowledged Task snapshot (%s)',async cause=>{
 const root=await mkdtemp(join(process.env.IH_NATIVE_DEPENDENCY_EVIDENCE_ROOT!,'required-close-')),c=createJsonlTaskTransitionCoordinator(root,{lock:{enabled:true}},taskDocumentStorageContract)
 let tasks:ReturnType<typeof createTaskRegistry>|undefined,required:RequiredTaskSettlement|undefined
 try{
  await c.create({sessionId:'parent'});const document=await c.openManagedDocument('parent');tasks=createTaskRegistry({coordinator:c,stateId:'parent',ownedTask:captureOwnedTaskContext(c,document,document.view,'parent'),reportPolicy:SHIPPING_REPORT_POLICY,results:createTaskResultRetention(undefined,undefined,'parent')});await tasks.ready
  const task=tasks.submit({identity:{parentSessionId:'parent'},agentPath:'one',description:'one',prompt:'work',agent:'general',delivery:'tool'});await tasks.flushPersistence()
  const action=document.beginAction(),source=action.registerSettlementSource(async()=>{await required?.settle()});required=(await bindRequiredTaskSettlement(tasks,task,source,async()=>({taskId:task.id,outcome:'cancelled'})))!
  const capture=artifactPathsFor(createJsonlBackend(root))!.document('task-parent') as {key:string};queueGate.closePath=lockPathFor(root,'artifact-document-lease:'+capture.key);queueGate.closeCause=cause;queueGate.closeArmed=true;queueGate.closeAttempts=0
  tasks.retireOwnedLoad();document.revokeNewWork();let refused=false;await required.settle().then(()=>{},()=>{refused=true});expect(refused).toBe(true);expect(queueGate.closeAttempts).toBeGreaterThan(0);const save=lastOriginalTaskSave(tasks);await expect(c.close()).rejects.toThrow()
  queueGate.closeArmed=false;await required.reconcile();expect(lastOriginalTaskSave(tasks)).toBe(save);await required.release();await source.close();action.finish();await tasks.closeOwnedLoad();await c.close()
 }finally{queueGate.closeArmed=false;queueGate.closePath='';await tasks?.closeOwnedLoad();await c.close()}
})

it('refuses a cold row and a replaced installed registry incarnation before required writes',async()=>{
 const root=await mkdtemp(join(process.env.IH_NATIVE_DEPENDENCY_EVIDENCE_ROOT!,'required-cold-')),c=createJsonlTaskTransitionCoordinator(root,{lock:{enabled:true}},taskDocumentStorageContract)
 let tasks:ReturnType<typeof createTaskRegistry>|undefined,fresh:ReturnType<typeof createTaskRegistry>|undefined,required:RequiredTaskSettlement|undefined
 try{
  await c.create({sessionId:'parent'});const document=await c.openManagedDocument('parent'),owned=captureOwnedTaskContext(c,document,document.view,'parent')!
  const options={coordinator:c,stateId:'parent',ownedTask:owned,reportPolicy:SHIPPING_REPORT_POLICY,results:createTaskResultRetention(undefined,undefined,'parent')}
  tasks=createTaskRegistry(options);await tasks.ready;const task=tasks.submit({identity:{parentSessionId:'parent'},agentPath:'one',description:'one',prompt:'work',agent:'general',delivery:'tool'});await tasks.flushPersistence()
  const action=document.beginAction(),source=action.registerSettlementSource(async()=>{})
  required=(await bindRequiredTaskSettlement(tasks,task,source,async()=>({taskId:task.id,outcome:'cancelled'})))!
  fresh=createTaskRegistry(options);await fresh.ready;const before=JSON.stringify(await c.getDocument('task-parent'))
  await expect(bindRequiredTaskSettlement(fresh,fresh.get(task.id)!,source,async()=>({taskId:task.id,outcome:'cancelled'}))).rejects.toThrow()
  await expect(required.settle()).rejects.toThrow('incarnation replaced');expect(JSON.stringify(await c.getDocument('task-parent'))).toBe(before)
  await source.close();action.finish()
 }finally{await fresh?.closeOwnedLoad();await tasks?.closeOwnedLoad();await c.close()}
})

it('refuses genuine original Native ownership loss before Task write and retains truthful source debt',async()=>{
 const root=await mkdtemp(join(process.env.IH_NATIVE_DEPENDENCY_EVIDENCE_ROOT!,'required-generation-')),c=createJsonlTaskTransitionCoordinator(root,{lock:{enabled:true}},taskDocumentStorageContract)
 await c.create({sessionId:'parent'});const document=await c.openManagedDocument('parent'),owned=captureOwnedTaskContext(c,document,document.view,'parent')!,tasks=createTaskRegistry({coordinator:c,stateId:'parent',ownedTask:owned,reportPolicy:SHIPPING_REPORT_POLICY,results:createTaskResultRetention(undefined,undefined,'parent')});await tasks.ready
 const task=tasks.submit({identity:{parentSessionId:'parent'},agentPath:'one',description:'one',prompt:'work',agent:'general',delivery:'tool'});await tasks.flushPersistence()
 const action=document.beginAction();let required:RequiredTaskSettlement|undefined;const source=action.registerSettlementSource(async()=>{await required?.settle()});required=(await bindRequiredTaskSettlement(tasks,task,source,async()=>({taskId:task.id,outcome:'cancelled'})))!
 const capture=artifactPathsFor(createJsonlBackend(root))!.session('parent') as {key:string},lock=queueGate.locks.get(lockPathFor(root,'artifact-ownership:'+capture.key))!;expect(lock?.held).toBe(true)
 const before=lastOriginalTaskSave(tasks);await lock.release();expect(lock.held).toBe(false)
 await expect(required.settle()).rejects.toThrow();expect(lastOriginalTaskSave(tasks)).toBe(before);expect(()=>document.assertReady()).toThrow()
 await expect(c.close()).rejects.toThrow();await tasks.closeOwnedLoad()
})

it('refuses a changed terminal alias after native Task ACK instead of publishing a different outcome',async()=>{
 const root=await mkdtemp(join(process.env.IH_NATIVE_DEPENDENCY_EVIDENCE_ROOT!,'required-terminal-alias-')),c=createJsonlTaskTransitionCoordinator(root,{lock:{enabled:true}},taskDocumentStorageContract),entered=Promise.withResolvers<void>(),release=Promise.withResolvers<void>()
 let tasks:ReturnType<typeof createTaskRegistry>|undefined,required:RequiredTaskSettlement|undefined
 try{
  await c.create({sessionId:'parent'});const document=await c.openManagedDocument('parent');tasks=createTaskRegistry({coordinator:c,stateId:'parent',ownedTask:captureOwnedTaskContext(c,document,document.view,'parent'),reportPolicy:SHIPPING_REPORT_POLICY,results:createTaskResultRetention(undefined,undefined,'parent')});await tasks.ready
  const task=tasks.submit({identity:{parentSessionId:'parent'},agentPath:'one',description:'one',prompt:'work',agent:'general',delivery:'tool'});await tasks.flushPersistence();const action=document.beginAction(),source=action.registerSettlementSource(async()=>{await required?.settle()});required=(await bindRequiredTaskSettlement(tasks,task,source,async()=>({taskId:task.id,outcome:'cancelled'})))!
  const capture=artifactPathsFor(createJsonlBackend(root))!.document('task-parent') as {key:string};queueGate.closePath=lockPathFor(root,'artifact-document-lease:'+capture.key);queueGate.closeEntered=entered.resolve;queueGate.closeGate=release.promise
  const saving=required.settle();void saving.catch(()=>{});await entered.promise;const originalSave=lastOriginalTaskSave(tasks)
  // Corrupt only the live alias; the actual native snapshot already contains cancellation.
  task.outcome='completed';task.status='completed';release.resolve();await expect(saving).rejects.toThrow('terminal changed');expect(lastOriginalTaskSave(tasks)).toBe(originalSave)
  expect((await c.getDocument('task-parent') as {tasks:{outcome:string}[]}).tasks[0]!.outcome).toBe('cancelled')
  task.outcome='cancelled';task.status='cancelled';const terminal=await required.reconcile();expect(terminal.outcome).toBe('cancelled');expect(Object.isFrozen(terminal)).toBe(true);await required.release();await source.close();action.finish()
 }finally{release.resolve();queueGate.closePath='';queueGate.closeEntered=undefined;queueGate.closeGate=undefined;await tasks?.closeOwnedLoad();await c.close()}
})

it('retries the exact Stop-owned unknown save after retirement without replacing CAS or snapshot',async()=>{
 const root=await mkdtemp(join(process.env.IH_NATIVE_DEPENDENCY_EVIDENCE_ROOT!,'required-stop-unknown-')),c=createJsonlTaskTransitionCoordinator(root,{lock:{enabled:true}},taskDocumentStorageContract)
 let tasks:ReturnType<typeof createTaskRegistry>|undefined,required:RequiredTaskSettlement|undefined,primary:{cause:unknown}|undefined
 try{
  await c.create({sessionId:'parent'});const document=await c.openManagedDocument('parent');tasks=createTaskRegistry({coordinator:c,stateId:'parent',ownedTask:captureOwnedTaskContext(c,document,document.view,'parent'),reportPolicy:SHIPPING_REPORT_POLICY,results:createTaskResultRetention(undefined,undefined,'parent')});await tasks.ready
  const task=tasks.submit({identity:{parentSessionId:'parent'},agentPath:'one',description:'one',prompt:'work',agent:'general',delivery:'tool'});await tasks.flushPersistence()
  const action=document.beginAction(),source=action.registerSettlementSource(async()=>{await required?.settle()});required=(await bindRequiredTaskSettlement(tasks,task,source,async()=>({taskId:task.id,outcome:'completed',resultText:'late result'})))!
  queueGate.root=root;queueGate.blocked=true;queueGate.stages=[];expect(tasks.cancelTree(task.id,'Original Stop won').cancelled).toBe(1)
  await expect(tasks.retainResult(task.id)).rejects.toThrow();const save=lastOriginalTaskSave(tasks),revision=task.result!.revision;expect(queueGate.stages).toHaveLength(1)
  tasks.retireOwnedLoad();document.revokeNewWork();queueGate.blocked=false
  const terminal=await required.reconcile();expect(terminal.outcome).toBe('cancelled');expect(terminal.result!.revision).toBe(revision);expect(lastOriginalTaskSave(tasks)).toBe(save);expect(queueGate.stages).toHaveLength(1)
  await required.release();await source.close();action.finish();await tasks.closeOwnedLoad()
 }catch(cause){primary={cause};console.info('required-stop-unknown-primary',cause)}finally{
  queueGate.blocked=false;queueGate.root='';const cleanup=await Promise.allSettled([tasks?.closeOwnedLoad(),c.close()]);const errors=cleanup.flatMap(result=>result.status==='rejected'?[result.reason]:[]);if(primary||errors.length)throw new AggregateError([...(primary?[primary.cause]:[]),...errors],'Original Stop unknown recovery failed')
 }
})

it.each(['revision','descriptor'] as const)('refuses a cached required Stop ACK for a changed %s while its original producer remains held',async change=>{
 const root=await mkdtemp(join(process.env.IH_NATIVE_DEPENDENCY_EVIDENCE_ROOT!,'required-stop-ack-alias-')),c=createJsonlTaskTransitionCoordinator(root,{lock:{enabled:true}},taskDocumentStorageContract),producer=Promise.withResolvers<import('../src/task/types.ts').TaskTerminalizeInput>()
 let tasks:ReturnType<typeof createTaskRegistry>|undefined,required:RequiredTaskSettlement|undefined,task:import('../src/task/types.ts').TaskRecord|undefined,original:import('../src/task/types.ts').TaskRecord['result'],source:import('@i-harness/core-session').SettlementFacts|undefined,action:ReturnType<import('@i-harness/session-persistence').ManagedDocument['beginAction']>|undefined
 try{
  await c.create({sessionId:'parent'});const document=await c.openManagedDocument('parent');tasks=createTaskRegistry({coordinator:c,stateId:'parent',ownedTask:captureOwnedTaskContext(c,document,document.view,'parent'),reportPolicy:SHIPPING_REPORT_POLICY,results:createTaskResultRetention(undefined,undefined,'parent')});await tasks.ready
  task=tasks.submit({identity:{parentSessionId:'parent'},agentPath:'one',description:'one',prompt:'work',agent:'general',delivery:'tool'});await tasks.flushPersistence();action=document.beginAction();source=action.registerSettlementSource(async()=>{await required?.settle()});required=(await bindRequiredTaskSettlement(tasks,task,source,()=>producer.promise))!
  tasks.cancelTree(task.id,'Original Stop won');await tasks.retainResult(task.id);const save=lastOriginalTaskSave(tasks);original=task.result;expect(original?.kind).toBe('retained');if(original?.kind!=='retained')throw Error('Actual retained Stop result required')
  task.result=change==='revision'?{...original,revision:'11111111-1111-4111-8111-111111111111'}:{...original,envelope:{...original.envelope,retention:{kind:'unavailable',reason:'quota'}}}
  await expect(tasks.retainResult(task.id)).rejects.toThrow('changed');await expect(tasks.retainResult(task.id)).rejects.toThrow('changed');expect(lastOriginalTaskSave(tasks)).toBe(save)
 }finally{if(task&&original)task.result=original;producer.resolve({taskId:task?.id??'unissued',outcome:'completed',resultText:'late result'});if(required){await required.settle();await required.release()}await source?.close();action?.finish();await tasks?.closeOwnedLoad();await c.close()}
})

it.each([false,true])('holds native Task IO and parks only its parent exclusion on same-operation UNKNOWN (%s)',async unknown=>{
 const root=await mkdtemp(join(process.env.IH_NATIVE_DEPENDENCY_EVIDENCE_ROOT!,'required-exclusion-')),c=createJsonlTaskTransitionCoordinator(root,{lock:{enabled:true}},taskDocumentStorageContract),entered=Promise.withResolvers<void>(),release=Promise.withResolvers<void>()
 let tasks:ReturnType<typeof createTaskRegistry>|undefined,required:RequiredTaskSettlement|undefined
 try{
  await c.create({sessionId:'parent'});const document=await c.openManagedDocument('parent');tasks=createTaskRegistry({coordinator:c,stateId:'parent',ownedTask:captureOwnedTaskContext(c,document,document.view,'parent'),reportPolicy:SHIPPING_REPORT_POLICY,results:createTaskResultRetention(undefined,undefined,'parent')});await tasks.ready
  const task=tasks.submit({identity:{parentSessionId:'parent'},agentPath:'one',description:'one',prompt:'work',agent:'general',delivery:'tool'});await tasks.flushPersistence()
  const action=document.beginAction(),source=action.registerSettlementSource(async()=>{await required?.settle()});required=(await bindRequiredTaskSettlement(tasks,task,source,async()=>({taskId:task.id,outcome:'cancelled'})))!
  queueGate.root=root;queueGate.stages=[];queueGate.blocked=unknown;queueGate.ackEntered=entered.resolve;queueGate.ackGate=release.promise
  const settling=required.settle();void settling.catch(()=>{});await entered.promise;const save=lastOriginalTaskSave(tasks),count=document.view.events.length
  let admitted=false;const parentFact=action.facts.metadata.admit({type:'plan/mode',mode:'on'}).then(outcome=>{admitted=true;return outcome})
  await Promise.resolve();await Promise.resolve();expect(admitted).toBe(false);expect(document.view.events).toHaveLength(count)
  release.resolve();if(unknown){await expect(settling).rejects.toThrow();expect(await parentFact).toMatchObject({kind:'committed'});expect(()=>required!.assertProjectionCurrent()).toThrow();expect(lastOriginalTaskSave(tasks)).toBe(save);queueGate.blocked=false;await required.reconcile()}else await settling
  expect(await parentFact).toMatchObject({kind:'committed'});expect(queueGate.stages).toHaveLength(1);expect(lastOriginalTaskSave(tasks)).toBe(save)
  await required.release();await source.close();action.finish();await tasks.closeOwnedLoad()
 }finally{release.resolve();queueGate.blocked=false;queueGate.root='';queueGate.ackEntered=undefined;queueGate.ackGate=undefined;await tasks?.closeOwnedLoad();await c.close()}
})

it('parks parent scheduling after native UNKNOWN and cleanup failure, then resumes that exact operation after parent facts advance',async()=>{
 const root=await mkdtemp(join(process.env.IH_NATIVE_DEPENDENCY_EVIDENCE_ROOT!,'required-park-cleanup-')),c=createJsonlTaskTransitionCoordinator(root,{lock:{enabled:true}},taskDocumentStorageContract);let tasks:ReturnType<typeof createTaskRegistry>|undefined,required:RequiredTaskSettlement|undefined
 try{
  await c.create({sessionId:'parent'});const document=await c.openManagedDocument('parent');tasks=createTaskRegistry({coordinator:c,stateId:'parent',ownedTask:captureOwnedTaskContext(c,document,document.view,'parent'),reportPolicy:SHIPPING_REPORT_POLICY,results:createTaskResultRetention(undefined,undefined,'parent')});await tasks.ready
  const task=tasks.submit({identity:{parentSessionId:'parent'},agentPath:'one',description:'one',prompt:'work',agent:'general',delivery:'tool'});await tasks.flushPersistence();const action=document.beginAction(),source=action.registerSettlementSource(async()=>{await required?.settle()});required=(await bindRequiredTaskSettlement(tasks,task,source,async()=>({taskId:task.id,outcome:'cancelled'})))!
  queueGate.root=root;queueGate.stages=[];queueGate.blocked=true;await expect(required.settle()).rejects.toThrow();const save=lastOriginalTaskSave(tasks),target=artifactPathsFor(createJsonlBackend(root))!.document('task-parent') as {key:string};queueGate.blocked=false;queueGate.closePath=lockPathFor(root,'artifact-document-lease:'+target.key);queueGate.closeCause=false;queueGate.closeArmed=true
  let cleanupFailed=false;await required.recoverCapturedAcknowledgment().catch(cause=>{cleanupFailed=true;expect(cause).toBe(false)});expect(cleanupFailed).toBe(true);expect(()=>required!.assertProjectionCurrent()).toThrow();expect(await action.facts.metadata.admit({type:'plan/mode',mode:'on'})).toMatchObject({kind:'committed'});expect(queueGate.stages).toHaveLength(1);expect(lastOriginalTaskSave(tasks)).toBe(save)
  queueGate.closeArmed=false;await required.reconcile();expect(lastOriginalTaskSave(tasks)).toBe(save);expect(queueGate.stages).toHaveLength(1);await required.release();await source.close();action.finish();await tasks.closeOwnedLoad()
 }finally{queueGate.blocked=false;queueGate.root='';queueGate.closeArmed=false;queueGate.closePath='';await tasks?.closeOwnedLoad();await c.close()}
})
