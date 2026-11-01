const cut=vi.hoisted(()=>({root:'',mode:'known' as 'known'|'unknown'|'unissued'|'post-ack',callbackFailure:undefined as unknown,failSync:false,syncCause:undefined as unknown,entered:undefined as undefined|(()=>void),gate:undefined as undefined|Promise<void>,stages:0,issues:0,write:undefined as undefined|object,locks:new Map<string,{held:boolean;release():void|Promise<void>}>()}))
vi.mock('../../fs-lock/src/index.ts',async load=>{const original=await load<typeof import('../../fs-lock/src/index.ts')>();return {...original,async acquireSessionLock(options:import('../../fs-lock/src/index.ts').AcquireOptions){const lock=await original.acquireSessionLock(options);cut.locks.set(options.lockPath,lock);return lock}}})
vi.mock('../../session-persistence-jsonl/src/backend/document-write.ts',async load=>{const original=await load<typeof import('../../session-persistence-jsonl/src/backend/document-write.ts')>();return {...original,createOwnedDocumentWrite(...args:Parameters<typeof original.createOwnedDocumentWrite>){const created=original.createOwnedDocumentWrite(...args),input=args[0],terminal=cut.root&&input.path.startsWith(cut.root)&&JSON.parse(Buffer.from(input.bytes).toString('utf8')).tasks?.some((task:{outcome?:string})=>task.outcome!==undefined);if(!terminal)return created;cut.stages++;const handle={async issue(){cut.issues++;if(cut.mode==='unissued'){cut.entered?.();await cut.gate}const outcome=await created.handle.issue();if(cut.mode!=='unissued'){cut.entered?.();await cut.gate}if(cut.mode==='post-ack')throw cut.callbackFailure;return cut.mode==='unknown'?{kind:'unknown' as const,cause:undefined,cleanupPending:false}:outcome},reconcile:created.handle.reconcile.bind(created.handle),retry:created.handle.retry.bind(created.handle),outcome:created.handle.outcome.bind(created.handle)};cut.write=handle;return {handle,settle:created.settle.bind(created)}}}})
vi.mock('node:fs/promises',async load=>{const original=await load<typeof import('node:fs/promises')>();return {...original,async open(...args:Parameters<typeof original.open>){const handle=await original.open(...args);if(cut.root&&String(args[0]).startsWith(cut.root)&&String(args[0]).endsWith('task-parent.doc.jsonl')){const sync=handle.sync.bind(handle);handle.sync=async()=>{if(cut.failSync)throw cut.syncCause;return sync()}}return handle}}})
import {it,expect,vi} from 'vitest'
import {mkdtemp,readFile} from 'node:fs/promises'
import {join} from 'node:path'
import {createJsonlTaskTransitionCoordinator} from '../../session-persistence-jsonl/src/task-document-factory.ts'
import {taskDocumentStorageContract} from '../src/task/storage-contract.ts'
import {captureOwnedTaskContext} from '../src/task/owned-context.ts'
import {createTaskRegistry} from '../src/task/registry.ts'
import {createTaskResultRetention} from '../../session-executor/src/lifecycle/task-result-retention.ts'
import {SHIPPING_REPORT_POLICY} from '../src/report-policy.ts'
import {lastOriginalTaskSave} from '../src/task/save-owner.ts'
import {taskDocumentOperationsFor} from '@i-harness/session-persistence/internal/task-document-operations'
import {originalTaskWriteLifetime,createOriginalTaskNativeStage,captureOriginalTaskWriteProducer,constructOriginalTaskWrite} from '../../session-persistence/src/coordinator/task-write-lifetime.ts'
import {lockPathFor} from '../../fs-lock/src/index.ts'
import {artifactPathsFor} from '../../session-persistence/src/coordinator/artifact-path-association.ts'
import {createJsonlBackend} from '../../session-persistence-jsonl/src/index.ts'

it.each(['known','unknown','unissued'] as const)('retires only the same original ordinary native write and preserves its proved disposition (%s)',async mode=>{
 const root=await mkdtemp(join(process.env.IH_NATIVE_DEPENDENCY_EVIDENCE_ROOT!,'ordinary-issued-')),c=createJsonlTaskTransitionCoordinator(root,{lock:{enabled:true}},taskDocumentStorageContract),entered=Promise.withResolvers<void>(),release=Promise.withResolvers<void>()
 let tasks:ReturnType<typeof createTaskRegistry>|undefined
 try{
  await c.create({sessionId:'parent'});const document=await c.openManagedDocument('parent'),owned=captureOwnedTaskContext(c,document,document.view,'parent')!
  tasks=createTaskRegistry({coordinator:c,stateId:'parent',reportPolicy:SHIPPING_REPORT_POLICY,ownedTask:owned,results:createTaskResultRetention(undefined,undefined,'parent')});await tasks.ready
  const task=tasks.submit({identity:{parentSessionId:'parent'},agentPath:'one',description:'one',prompt:'work',agent:'general',delivery:'tool'});await tasks.flushPersistence()
  cut.root=root;cut.mode=mode;cut.stages=cut.issues=0;cut.entered=entered.resolve;cut.gate=release.promise
  tasks.terminalize({taskId:task.id,outcome:'cancelled'});const retention=tasks.retainResult(task.id);void retention.catch(()=>{});await entered.promise
  const save=lastOriginalTaskSave(tasks)!,producer=originalTaskWriteLifetime(cut.write!)!;expect(producer.issued()).toBe(mode!=='unissued');expect(originalTaskWriteLifetime({...cut.write})).toBeUndefined()
  tasks.retireOwnedLoad();document.revokeNewWork();expect(()=>tasks!.assertReady()).toThrow();await expect(taskDocumentOperationsFor(c)!.begin(owned.parent)).rejects.toThrow()
  release.resolve();await retention.catch(()=>{});await tasks.closeOwnedLoad();expect(lastOriginalTaskSave(tasks)).toBe(save);expect(cut.stages).toBe(1);expect(cut.issues).toBe(1)
  const saved=JSON.parse(await readFile(join(root,'task-parent.doc.jsonl'),'utf8'));if(mode==='unissued'){expect(save.outcome()?.kind).toBe('not-issued');expect(saved.tasks[0]!.outcome).toBeUndefined()}else{expect(save.outcome()?.kind).toBe('committed');expect(saved.tasks[0]!.outcome).toBe('cancelled')}
  await c.close()
 }finally{release.resolve();cut.root='';cut.entered=undefined;cut.gate=undefined;await tasks?.closeOwnedLoad();await c.close()}
})
it('refuses copied/custom native stage tokens and producer registration outside the original constructor',()=>{
 expect(()=>createOriginalTaskNativeStage({} as never,async()=>{},()=>{})).toThrow('Original task scope unavailable')
 let built=0;expect(()=>constructOriginalTaskWrite({},{} as never,async()=>{},()=>{},'/foreign',new Uint8Array(),()=>{built++;return {handle:{} as never}})).toThrow('Foreign native Task write stage');expect(built).toBe(0)
 expect(captureOriginalTaskWriteProducer('/foreign',new Uint8Array(),{canReconcile(){return true},async reconcile(){throw Error('foreign')},async retireUnissued(){throw Error('foreign')}})).toBeUndefined()
})
it('keeps an issued ordinary native write unresolved after actual original native ownership loss',async()=>{
 const root=await mkdtemp(join(process.env.IH_NATIVE_DEPENDENCY_EVIDENCE_ROOT!,'ordinary-native-loss-')),c=createJsonlTaskTransitionCoordinator(root,{lock:{enabled:true}},taskDocumentStorageContract),entered=Promise.withResolvers<void>(),release=Promise.withResolvers<void>();let tasks:ReturnType<typeof createTaskRegistry>|undefined
 try{
  await c.create({sessionId:'parent'});const document=await c.openManagedDocument('parent');tasks=createTaskRegistry({coordinator:c,stateId:'parent',reportPolicy:SHIPPING_REPORT_POLICY,ownedTask:captureOwnedTaskContext(c,document,document.view,'parent'),results:createTaskResultRetention(undefined,undefined,'parent')});await tasks.ready
  const task=tasks.submit({identity:{parentSessionId:'parent'},agentPath:'one',description:'one',prompt:'work',agent:'general',delivery:'tool'});await tasks.flushPersistence();cut.root=root;cut.mode='unknown';cut.entered=entered.resolve;cut.gate=release.promise
  tasks.terminalize({taskId:task.id,outcome:'cancelled'});const retention=tasks.retainResult(task.id);void retention.catch(()=>{});await entered.promise
  const target=artifactPathsFor(createJsonlBackend(root))!.session('parent') as {key:string},lock=cut.locks.get(lockPathFor(root,'artifact-ownership:'+target.key))!;expect(lock).toBeDefined();await lock.release()
  tasks.retireOwnedLoad();document.revokeNewWork();release.resolve();await retention.catch(()=>{});await expect(tasks.closeOwnedLoad()).rejects.toThrow();await expect(c.close()).rejects.toThrow()
 }finally{release.resolve();cut.root='';cut.entered=undefined;cut.gate=undefined;await tasks?.closeOwnedLoad().catch(()=>{});await c.close().catch(()=>{})}
})

it.each([undefined,false,null])('retires post-ACK callback bookkeeping while preserving the exact original falsey failure (%j)',async failure=>{
 const root=await mkdtemp(join(process.env.IH_NATIVE_DEPENDENCY_EVIDENCE_ROOT!,'ordinary-post-ack-')),c=createJsonlTaskTransitionCoordinator(root,{lock:{enabled:true}},taskDocumentStorageContract),entered=Promise.withResolvers<void>(),release=Promise.withResolvers<void>();let tasks:ReturnType<typeof createTaskRegistry>|undefined
 try{
  await c.create({sessionId:'parent'});const document=await c.openManagedDocument('parent');tasks=createTaskRegistry({coordinator:c,stateId:'parent',reportPolicy:SHIPPING_REPORT_POLICY,ownedTask:captureOwnedTaskContext(c,document,document.view,'parent'),results:createTaskResultRetention(undefined,undefined,'parent')});await tasks.ready
  const task=tasks.submit({identity:{parentSessionId:'parent'},agentPath:'one',description:'one',prompt:'work',agent:'general',delivery:'tool'});await tasks.flushPersistence();cut.root=root;cut.mode='post-ack';cut.callbackFailure=failure;cut.entered=entered.resolve;cut.gate=release.promise;cut.stages=cut.issues=0
  tasks.terminalize({taskId:task.id,outcome:'cancelled'});const retention=tasks.retainResult(task.id);void retention.catch(()=>{});await entered.promise;const save=lastOriginalTaskSave(tasks)!;release.resolve()
  let rejected=false;await retention.catch(error=>{rejected=true;expect(error).toBe(failure)});expect(rejected).toBe(true);tasks.retireOwnedLoad();document.revokeNewWork();await tasks.closeOwnedLoad();expect(save.outcome()?.kind).toBe('committed');expect(cut.issues).toBe(1)
  let retryRejected=false;await save.retry().catch(error=>{retryRejected=true;expect(error).toBe(failure)});expect(retryRejected).toBe(true);let handoffRejected=false;try{save.assertHandoff()}catch(error){handoffRejected=true;expect(error).toBe(failure)}expect(handoffRejected).toBe(true);await c.close()
 }finally{release.resolve();cut.root='';cut.mode='known';cut.entered=undefined;cut.gate=undefined;await tasks?.closeOwnedLoad();await c.close()}
})
it('requires the same producer ACK and actual cleanup before its read-only retirement proof',async()=>{
 const root=await mkdtemp(join(process.env.IH_NATIVE_DEPENDENCY_EVIDENCE_ROOT!,'ordinary-ack-proof-')),c=createJsonlTaskTransitionCoordinator(root,{lock:{enabled:true}},taskDocumentStorageContract)
 try{
  await c.create({sessionId:'parent'});const document=await c.openManagedDocument('parent'),owned=captureOwnedTaskContext(c,document,document.view,'parent')!,operation=await owned.operations.begin(owned.parent),observed=await operation.observe();if(observed.kind!=='present')throw Error('original Task document absent')
  cut.root=root;cut.failSync=true;cut.syncCause=false;const write=operation.stageWrite(observed.witness,{formatVersion:2,tasks:[],notifications:[]}),unknown=await write.issue();expect(unknown.kind).toBe('unknown');expect(operation.retirementAcknowledged({} as never)).toBe(false)
  document.revokeNewWork();await expect(operation.close()).rejects.toThrow();expect(operation.retirementAcknowledged({} as never)).toBe(false);await expect(owned.operations.begin(owned.parent)).rejects.toThrow()
  cut.failSync=false;await operation.retryClose();const known=write.outcome();expect(known?.kind).toBe('committed');if(known?.kind!=='committed')throw Error('original ACK unavailable');expect(operation.retirementAcknowledged(known.ack)).toBe(true);expect(operation.retirementAcknowledged({...known.ack})).toBe(false);expect(()=>operation.retirementAcknowledged.call({...operation},known.ack)).toThrow();await c.close()
 }finally{cut.failSync=false;cut.root='';await c.close()}
})
