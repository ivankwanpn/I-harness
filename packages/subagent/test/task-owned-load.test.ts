import { mkdtemp, rm, writeFile, unlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { createJsonlTaskTransitionCoordinator } from '../../session-persistence-jsonl/src/task-document-factory.ts'
import { taskDocumentStorageContract } from '../src/task/storage-contract.ts'
import { createTaskRegistry } from '../src/task/registry.ts'
import { createTaskStartupFacade } from '../src/task/startup-facade.ts'
import { captureOwnedTaskContext } from '../src/task/owned-context.ts'
const spawnProbe=vi.hoisted(()=>({armed:false,sources:0}))
vi.mock('../src/tools/spawn-source.ts',async original=>{const real=await original<typeof import('../src/tools/spawn-source.ts')>();return {...real,createSpawnSource(...args:Parameters<typeof real.createSpawnSource>){if(spawnProbe.armed){spawnProbe.sources++;throw Error('Unexpected cold spawn source')}return real.createSpawnSource(...args)}}})
const faults = vi.hoisted(() => ({ target: '', readFlag: '', failed: false, cause: undefined as unknown, closeFails: false, releaseFails: false, releasePath: '', entered: undefined as undefined | (() => void), gate: undefined as undefined | Promise<void>, renames: 0 }))
vi.mock('node:fs/promises', async original => {
 const fs = await original<typeof import('node:fs/promises')>()
 return { ...fs, async open(...args: Parameters<typeof fs.open>) {
  const handle = await fs.open(...args), read = handle.read.bind(handle), close = handle.close.bind(handle)
  if (String(args[0]) === faults.target) {
   handle.read = (async (...input: Parameters<typeof handle.read>) => { if (faults.failed && args[1] === faults.readFlag) throw faults.cause; return Reflect.apply(read, handle, input) }) as typeof handle.read
   handle.close = async () => { if (faults.closeFails && args[1] === 'r+') throw faults.cause; await close() }
  }
  return handle
 }, async rename(...args: Parameters<typeof fs.rename>) { faults.renames++; return fs.rename(...args) } }
})
vi.mock('../../fs-lock/src/index.ts', async original => {
 const locks=await original<typeof import('../../fs-lock/src/index.ts')>()
 return {...locks,async acquireSessionLock(options: import('../../fs-lock/src/index.ts').AcquireOptions){
  const lock=await locks.acquireSessionLock(options)
  return {get held(){return lock.held},async release(){if(options.lockPath===faults.releasePath){faults.entered?.();await faults.gate;if(faults.releaseFails)throw faults.cause}await lock.release()}}
 }}
})
import { lockPathFor } from '../../fs-lock/src/index.ts'
import { artifactPathsFor } from '../../session-persistence/src/coordinator/artifact-path-association.ts'
import { createJsonlBackend } from '../../session-persistence-jsonl/src/index.ts'
function taskLeasePath(root: string): string {
 const capture = artifactPathsFor(createJsonlBackend(root))!.document('task-parent') as {key: string}
 return lockPathFor(root, 'artifact-document-lease:' + capture.key)
}
import { fixtureGenerationFor } from './generation-fixture.ts'
import { registerSubagent } from '../src/index.ts'
import { createContext } from '@i-harness/core-plugin'
import { createToolRegistry } from '@i-harness/core-tools'
import { createMockClient } from '@i-harness/llm-mock'
import { registerExec } from '@i-harness/exec'
import { lastOriginalTaskSave } from '../src/task/save-owner.ts'
import { SHIPPING_REPORT_POLICY } from '../src/report-policy.ts'
import { childInitialCommitment, compileSemanticSeed, createChildBootstrapRequestIntent, captureChildBootstrapCaptureRequest } from '@i-harness/session-persistence'
import { appendStandalone } from './standalone-fixture.ts'
import { isColdBoundChild } from '../src/task/cold-bindings.ts'
const row = {id:'task-1',parentSessionId:'parent',toolCallId:'call',agentPath:'a',description:'d',prompt:'p',agent:'a',delivery:'tool' as const,status:'accepted' as const,timeCreated:1}
async function fixture(value?: unknown, arm?: (root: string) => void, withResults = false) {
 const root=await mkdtemp(join(process.env.IH_NATIVE_DEPENDENCY_EVIDENCE_ROOT ?? tmpdir(),'owned-load-'))
 const observations: unknown[] = []
 const validator = { ...taskDocumentStorageContract, validate(value: unknown) { taskDocumentStorageContract.validate(value); if (Object.isFrozen(value)) observations.push(value) } }
 const coordinator=createJsonlTaskTransitionCoordinator(root,{lock:{enabled:true}},validator)
 await coordinator.create({sessionId:'parent'});const document=await coordinator.openManagedDocument('parent')
 if(value===undefined)await unlink(join(root,'task-parent.doc.jsonl'));else await writeFile(join(root,'task-parent.doc.jsonl'),JSON.stringify(value))
 arm?.(root)
 const tasks=createTaskRegistry({coordinator,stateId:'parent',ownedTask:captureOwnedTaskContext(coordinator,document,document.view,'parent'),...(withResults?{reportPolicy:SHIPPING_REPORT_POLICY,results:{capture(){throw Error('unused')},async read(){throw Error('unused')}}}:{})})
 return {tasks,coordinator,document,root,observations,async close(){await coordinator.close();await rm(root,{recursive:true,force:true})}}
}
it.each([1,2,3] as const)('owned literal %s begins unavailable and installs detached rows',async version=>{
 const f=await fixture({formatVersion:version,tasks:[row],notifications:[]})
 try {expect(()=>f.tasks.list()).toThrow();await f.tasks.ready;expect(f.tasks.list()).toHaveLength(1);expect(f.tasks.get('task-1')).not.toBe(row);const source=f.observations.at(-1) as {tasks: typeof row[]};expect(Object.isFrozen(source.tasks[0])).toBe(true);expect(source.tasks[0]).toEqual(row)}finally{await f.close()}
})
it('requires the original ready physical task parent for v3 capability',async()=>{
 const f=await fixture({formatVersion:3,tasks:[],notifications:[]})
 try{await f.tasks.ready;const owned=captureOwnedTaskContext(f.coordinator,f.document,f.document.view,'parent')!;owned.operations.assertTaskV3Parent(owned.parent,'parent');expect(()=>owned.operations.assertTaskV3Parent({...owned.parent},'parent')).toThrow();expect(()=>owned.operations.assertTaskV3Parent.call({...owned.operations},owned.parent,'parent')).toThrow();const descriptor=Object.getOwnPropertyDescriptor(f.document,'view')!;Object.defineProperty(f.document,'view',{...descriptor,value:{...f.document.view}});expect(()=>owned.operations.assertTaskV3Parent(owned.parent,'parent')).toThrow();Object.defineProperty(f.document,'view',descriptor);owned.operations.assertTaskV3Parent(owned.parent,'parent');expect(()=>owned.operations.assertTaskV3Parent(owned.parent,'foreign')).toThrow();f.document.revokeNewWork();expect(()=>owned.operations.assertTaskV3Parent(owned.parent,'parent')).toThrow()}finally{await f.close()}
})
it('keeps owned literal1 bytes until a later result-aware save migrates them',async()=>{
 const f=await fixture({formatVersion:1,tasks:[row],notifications:[]},undefined,true)
 try{await f.tasks.ready;expect((await f.coordinator.getDocument('task-parent') as {formatVersion:number}).formatVersion).toBe(1);await f.tasks.save();expect((await f.coordinator.getDocument('task-parent') as {formatVersion:number}).formatVersion).toBe(2)}finally{await f.close()}
})
it('keeps owned literal3 on a later result-aware save',async()=>{
 const f=await fixture({formatVersion:3,tasks:[row],notifications:[]},undefined,true)
 try{await f.tasks.ready;await f.tasks.save();expect((await f.coordinator.getDocument('task-parent') as {formatVersion:number}).formatVersion).toBe(3)}finally{await f.close()}
})
it.each(['claimed','target','contradictory'])('installs an actual owned bound3 row with link=%s as cold after the original handoff',async link=>{
 const claimed=link==='claimed'
 const initial={inputId:'input',text:'p',startedAt:1,expiresAt:11,parentSessionId:'parent'}
 const lineage={origin:'subagent' as const,subagentProtocolVersion:1 as const,parentSession:'parent'}
 const payload={invocation:{version:1 as const,operationId:'op',targetSessionId:'child',createdAt:'2026-10-27T00:00:00.000Z',requestDigest:'a'.repeat(64)},target:{kind:'new' as const},metadata:{},lineage,seed:compileSemanticSeed({kind:'none'}),initial}
 const core={version:1 as const,kind:'child-bootstrap-core' as const,caller:{kind:'task' as const,taskId:'task-1',parentSessionId:'parent',toolCallId:'call'},history:{selection:{kind:'none' as const}},metadata:{},lineage,initial:childInitialCommitment(payload),execution:{roleName:'a',roleDigest:'b'.repeat(64),toolNames:[],model:{kind:'inherit-parent' as const},approval:'ordinary' as const}}
 const intent=createChildBootstrapRequestIntent(core,{kind:'unmanaged'})
 const request=captureChildBootstrapCaptureRequest({version:1,kind:'child-bootstrap-capture-request',invocation:{...payload.invocation,requestDigest:intent.requestDigest},core,requestIntent:intent.intent})
 const f=await fixture({formatVersion:3,tasks:[{...row,...(claimed?{childSessionId:'child'}:{}),childBirth:{version:1,kind:'task-child-birth',request}}],notifications:[]})
 try{
  await f.tasks.ready;expect(()=>f.tasks.submit({identity:{parentSessionId:'parent',toolCallId:'call'},agentPath:'a',description:'d',prompt:'p',agent:'a',delivery:'tool'})).toThrow('cold');const original=f.tasks.get('task-1')!;
  const alternatePayload={...payload,invocation:{...payload.invocation,targetSessionId:'other'}},alternateCore={...core,initial:childInitialCommitment(alternatePayload)},alternateIntent=createChildBootstrapRequestIntent(alternateCore,{kind:'unmanaged'}),alternateRequest=captureChildBootstrapCaptureRequest({version:1,kind:'child-bootstrap-capture-request',invocation:{...alternatePayload.invocation,requestDigest:alternateIntent.requestDigest},core:alternateCore,requestIntent:alternateIntent.intent}),alternateBirth={version:1 as const,kind:'task-child-birth' as const,request:alternateRequest}
  taskDocumentStorageContract.validate({formatVersion:3,tasks:[{...original,childSessionId:'other',childBirth:alternateBirth}],notifications:[]})
  expect(()=>{f.tasks.list()[0]!.childBirth=alternateBirth}).toThrow();expect(()=>{delete original.childBirth}).toThrow();expect(()=>{original.prompt='changed'}).toThrow();expect(()=>{original.childBirth!.request.core.execution.roleName='changed'}).toThrow();expect(f.tasks.get('task-1')?.childBirth).toBeDefined();expect(isColdBoundChild(f.tasks,'child')).toBe(true)
  const open=vi.spyOn(f.coordinator,'openManagedDocument'),{mounted,resolveModel,stream,instruction,generation}=mount(f,true)
  const entry=mounted.table.get('root/a')!;entry.taskId='task-1';if(link==='contradictory')entry.sessionId='contradictory';if(link==='target')entry.taskId='foreign';appendStandalone(entry.session,{type:'subagent/inbox',messageId:'consumed',message:'consumed'});appendStandalone(entry.session,{type:'subagent/inbox',messageId:'pending',message:'original pending'});const register=vi.spyOn(mounted.agents,'register')
  await mounted.ready
  expect(open).not.toHaveBeenCalled();expect(resolveModel).not.toHaveBeenCalled();expect(stream).not.toHaveBeenCalled();expect(instruction).not.toHaveBeenCalled();expect(generation).not.toHaveBeenCalled();expect(register).not.toHaveBeenCalled();expect(mounted.agents.get('child')).toBeUndefined()
  await mounted.dispose()
 }finally{await f.close()}
})
it('bad second row and missing fresh task poison all registry operations permanently',async()=>{
 const notification={id:'notif-1',submissionId:'task-1',parentSessionId:'parent',messageId:'m',state:'completed',description:'',text:'',status:'pending',attempts:0,timeCreated:1}
 for(const value of [undefined,
 {formatVersion:1,tasks:[row,{...row,id:'task-2'}],notifications:[]},
 {formatVersion:1,tasks:[row,row],notifications:[]},
 {formatVersion:1,tasks:[{...row,childSessionId:'c'},{...row,id:'task-2',toolCallId:'other',childSessionId:'c'}],notifications:[]},
 {formatVersion:1,tasks:[row],notifications:[notification,notification]},
 {formatVersion:1,tasks:[row],notifications:[{...notification,id:'notif-9007199254740991'}]},
 {formatVersion:1,tasks:[row,{...row,id:'task-9007199254740991'}],notifications:[]}
 ]){
 const f=await fixture(value)
 try {await expect(f.tasks.ready).rejects.toThrow();expect(()=>f.tasks.list()).toThrow();expect(()=>f.tasks.submit({identity:{parentSessionId:'parent'},agentPath:'b',description:'',prompt:'',agent:'a',delivery:'tool'})).toThrow();expect(()=>f.tasks.restore({formatVersion:1,tasks:[],notifications:[]})).toThrow();await expect(f.tasks.save()).rejects.toThrow();await f.coordinator.putDocumentStrict!('unrelated',{});await expect(f.tasks.flushPersistence()).rejects.toThrow();expect(()=>f.tasks.claim('task-1')).toThrow();expect(lastOriginalTaskSave(f.tasks)).toBeUndefined();await f.tasks.closeOwnedLoad()}finally{await f.close()}
 }
})

it.each(['r','r+','close','release'] as const)('original %s falsey cuts poison and retain cleanup',async phase=>{
 for(const cause of [undefined,null,false,0]){
  const f=await fixture({formatVersion:2,tasks:[row],notifications:[]},root=>{
   faults.target=join(root,'task-parent.doc.jsonl');faults.cause=cause
   faults.failed=phase==='r'||phase==='r+';faults.readFlag=phase;faults.closeFails=phase==='close'
   faults.releasePath=taskLeasePath(root);faults.releaseFails=phase==='release'
  })
  try {
   const result=await Promise.allSettled([f.tasks.ready]);expect(result[0].status).toBe('rejected')
   expect(()=>f.tasks.notifications()).toThrow();expect(()=>f.tasks.bindForegroundHandoff('task-1')).toThrow()
   expect(()=>f.tasks.terminalize({taskId:'task-1',outcome:'completed'})).toThrow();expect(()=>f.tasks.cancelTree('task-1')).toThrow()
   expect(()=>f.tasks.updateNotification('notif-1',{})).toThrow();expect(()=>f.tasks.retainResult('task-1')).toThrow()
   await expect(f.tasks.prepareResult('task-1')).rejects.toThrow();await expect(f.tasks.qualifyRestoredResults()).rejects.toThrow()
   faults.failed=faults.closeFails=faults.releaseFails=false
   f.document.revokeNewWork();await f.tasks.closeOwnedLoad()
   expect(()=>f.tasks.list()).toThrow();await expect(f.tasks.save()).rejects.toThrow()
  }finally{faults.failed=faults.closeFails=faults.releaseFails=false;faults.target=faults.releasePath='';await f.close()}
 }
})
it.each(['retire','parent','mutation'] as const)('original close-to-install %s cut never installs',async cut=>{
 const entered=Promise.withResolvers<void>(),release=Promise.withResolvers<void>()
 const f=await fixture({formatVersion:1,tasks:[row],notifications:[]},root=>{faults.releasePath=taskLeasePath(root);faults.entered=entered.resolve;faults.gate=release.promise})
 try {
  await entered.promise;expect(()=>f.tasks.list()).toThrow()
  let mutation:Promise<void>|undefined
  if(cut==='retire')f.tasks.retireOwnedLoad()
  if(cut==='parent')f.document.revokeNewWork()
  if(cut==='mutation')mutation=f.coordinator.putDocumentStrict!('task-parent',{formatVersion:1,tasks:[],notifications:[]})
  release.resolve();await expect(f.tasks.ready).rejects.toThrow();await mutation
  faults.gate=undefined;await f.tasks.closeOwnedLoad();expect(()=>f.tasks.list()).toThrow()
 }finally{release.resolve();faults.releasePath='';faults.gate=undefined;faults.entered=undefined;await f.close()}
})
function mount(f:Awaited<ReturnType<typeof fixture>>, restored:boolean){
 const model=createMockClient([]),stream=vi.spyOn(model,'stream'),instruction=vi.fn(()=>{throw Error('Unexpected instruction source')}),generation=vi.fn(fixtureGenerationFor)
 const ctx=createContext(),registry=createToolRegistry(ctx),resolveModel=vi.fn(async()=>({status:'unconfigured' as const,reason:'unused'}))
 const mounted=registerSubagent(ctx,registry,{...(restored?{createInstructionContext:instruction}:{}),generationFactoryFor:generation,parentSession:f.document.view,factOwner:f.document,parentModel:model,exec:registerExec(ctx),resolveModel,reportPolicy:SHIPPING_REPORT_POLICY,persist:{coordinator:f.coordinator,stateId:'parent',parentSessionId:'parent',parentSession:f.document.view},...(restored?{restoredState:{formatVersion:1 as const,roles:[],jobs:[{id:'subagent-1',owner:'root',kind:'subagent',label:'pending',status:'running' as const,output:'',terminal:false}],agentTable:[{path:'root/a',status:'waiting' as const,sessionId:'child',mailbox:['pending'],lastInboxSeq:0}]}}:{})})
 return {mounted,resolveModel,registry,stream,instruction,generation}
}
it.each([{restored:false,value:undefined},{restored:true,value:undefined},{restored:true,value:{formatVersion:1,tasks:[row,{...row,id:'task-2'}],notifications:[]}}])('actual startup %j has zero early producers',async ({restored,value})=>{
 const f=await fixture(value)
 try {
  await expect(f.tasks.ready).rejects.toThrow();const originalEvents=f.document.view.events.length
  const open=vi.spyOn(f.coordinator,'openManagedDocument'),write=vi.spyOn(f.coordinator,'putDocument');faults.renames=0
  const {mounted,resolveModel}=mount(f,restored)
  expect(()=>mounted.jobs.registerJob('root','subagent','bad')).toThrow()
  expect(()=>mounted.roles.remove('general')).toThrow()
  await expect(mounted.ready).rejects.toThrow();expect(open).not.toHaveBeenCalled();expect(write).not.toHaveBeenCalled();expect(resolveModel).not.toHaveBeenCalled();expect(mounted.agents.get('child')).toBeUndefined();expect(faults.renames).toBe(0);expect(f.document.view.events).toHaveLength(originalEvents)
  await expect(mounted.dispose()).rejects.toThrow();await mounted.dispose()
  open.mockRestore();write.mockRestore()
 }finally{await f.close()}
})
it('actual dispose retires a held original save before flushing',async()=>{
 const f=await fixture({formatVersion:2,tasks:[],notifications:[]})
 try{
  await f.tasks.ready;const {mounted}=mount(f,false);await mounted.ready
  const task=mounted.tasks.submit({identity:{parentSessionId:'parent'},agentPath:'a',description:'',prompt:'',agent:'general',delivery:'tool'});await mounted.tasks.flushPersistence()
  const handoff=mounted.tasks.bindForegroundHandoff(task.id)();expect(handoff.kind).toBe('parent');if(handoff.kind!=='parent')throw new Error('no held save')
  await handoff.save.done;await mounted.dispose();expect(()=>handoff.save.assertHandoff()).toThrow();await mounted.dispose()
  await mounted.tasks.flushPersistence();await mounted.flushPersistence()
  expect(()=>mounted.tasks.submit({identity:{parentSessionId:'parent'},agentPath:'late',description:'',prompt:'',agent:'general',delivery:'tool'})).toThrow()
  await expect(mounted.tasks.readResult(task.id,{})).rejects.toThrow();await expect(mounted.tasks.save()).rejects.toThrow()
 }finally{await f.close()}
})
it.each(['ready','false','undefined'] as const)('original facade cleanup joins pending load and preserves %s readiness outcome',async cut=>{
 const entered=Promise.withResolvers<void>(),release=Promise.withResolvers<void>()
 const f=await fixture({formatVersion:2,tasks:[],notifications:[]},root=>{faults.releasePath=taskLeasePath(root);faults.entered=entered.resolve;faults.gate=release.promise;faults.releaseFails=cut!=='ready';faults.cause=cut==='false'?false:undefined})
 const facade=createTaskStartupFacade(f.tasks,()=>{throw Error('Original work fenced')})
 try{
  await entered.promise;let settled=false
  const flush=facade.flushPersistence();void flush.then(()=>{settled=true},()=>{settled=true})
  await Promise.resolve();await Promise.resolve();expect(settled).toBe(false)
  release.resolve();const [loaded,flushed]=await Promise.allSettled([f.tasks.ready,flush])
  expect(flushed.status).toBe(loaded.status)
  if(loaded.status==='rejected'){expect(flushed).toMatchObject({status:'rejected',reason:loaded.reason});if(flushed.status==='rejected')expect(flushed.reason).toBe(loaded.reason);await expect(facade.closeOwnedLoad()).rejects.toThrow()}
  faults.releaseFails=false;f.tasks.retireOwnedLoad();await facade.closeOwnedLoad()
  if(loaded.status==='fulfilled')await facade.flushPersistence();else await expect(facade.flushPersistence()).rejects.toBe(loaded.reason)
  expect(()=>facade.submit({identity:{parentSessionId:'parent'},agentPath:'late',description:'',prompt:'',agent:'general',delivery:'tool'})).toThrow('work fenced');await expect(facade.save()).rejects.toThrow('work fenced')
 }finally{release.resolve();faults.releaseFails=false;faults.releasePath='';faults.gate=undefined;faults.entered=undefined;await f.tasks.closeOwnedLoad();await f.close()}
})
it('owned runtime mutation stays fenced while a restored mirror is still pending',async()=>{
 const f=await fixture({formatVersion:2,tasks:[],notifications:[]})
 const entered=Promise.withResolvers<void>(),release=Promise.withResolvers<void>()
 try{
  await f.tasks.ready;await f.coordinator.create({sessionId:'child',origin:'subagent',parentSession:'parent',seedLength:0})
  const original=f.coordinator.openManagedDocument.bind(f.coordinator)
  const spy=vi.spyOn(f.coordinator,'openManagedDocument').mockImplementation(async id=>{if(id==='child'){entered.resolve();await release.promise}return original(id)})
  const {mounted}=mount(f,true);await entered.promise
  expect(()=>mounted.jobs.registerJob('root','subagent','too early')).toThrow('pending')
  expect(()=>mounted.roles.remove('general')).toThrow('pending')
  await mounted.tasks.ready
  expect(()=>mounted.tasks.submit({identity:{parentSessionId:'parent'},agentPath:'early',description:'',prompt:'',agent:'general',delivery:'tool'})).toThrow('pending')
  expect(()=>mounted.tasks.claim('task-1')).toThrow('pending')
  expect(()=>mounted.tasks.terminalize({taskId:'task-1',outcome:'completed'})).toThrow('pending')
  expect(()=>mounted.tasks.bindForegroundHandoff('task-1')).toThrow('pending')
  await expect(mounted.tasks.save()).rejects.toThrow('pending')
  expect(mounted.tasks.list()).toHaveLength(0);expect(mounted.tasks.notifications()).toHaveLength(0);expect(lastOriginalTaskSave(mounted.tasks)).toBeUndefined()
  release.resolve();await mounted.ready
  expect(mounted.jobs.registerJob('root','subagent','after restore').id).toBeTruthy()
  await mounted.dispose();spy.mockRestore()
 }finally{release.resolve();await f.close()}
})

it.each([false,true])('genuine resident retirement with held save and parent revoked=%s drains original owners',async revoked=>{
 const f=await fixture({formatVersion:2,tasks:[],notifications:[]})
 try{
  await f.tasks.ready;const {mounted}=mount(f,false);await mounted.ready
  mounted.roles.register({name:'probe',description:'',systemPrompt:'probe',tools:[]})
  await f.coordinator.create({sessionId:'child',origin:'subagent',parentSession:'parent',seedLength:0})
  const child=await f.coordinator.openManagedDocument('child')
  const entry={path:'root/resident',status:'waiting' as const,session:child.view,factOwner:child,sessionId:'child',roleName:'probe',controller:new AbortController(),mailbox:[] as string[]}
  mounted.table.add(entry.path,entry)
  expect(await mounted.ensureResident(entry,new AbortController())).toBe(true)
  expect(mounted.agents.get('child')).toBeDefined();expect(mounted.table.get(entry.path)?.dispose).toBeTypeOf('function')
  const task=mounted.tasks.submit({identity:{parentSessionId:'parent'},agentPath:'held',description:'',prompt:'',agent:'probe',delivery:'tool'});await mounted.tasks.flushPersistence()
  const handoff=mounted.tasks.bindForegroundHandoff(task.id)();if(handoff.kind!=='parent')throw new Error('missing original held save')
  await handoff.save.done
  const changes:boolean[]=[];mounted.table.subscribe(change=>{if(change.entry.closing)changes.push(true)})
  if(revoked)f.document.revokeNewWork()
  await mounted.dispose();expect(mounted.agents.get('child')).toBeUndefined();expect(mounted.table.get(entry.path)?.closing).toBe(true);expect(changes).toHaveLength(1)
  expect(()=>handoff.save.assertHandoff()).toThrow();await mounted.dispose()
 }finally{await f.close()}
})

it('public task producers cannot enter the original qualification/classification await',async()=>{
 const f=await fixture({formatVersion:2,tasks:[row],notifications:[]})
 const entered=Promise.withResolvers<void>(),release=Promise.withResolvers<void>()
 try{
  await f.tasks.ready
  const original=f.coordinator.snapshot!.bind(f.coordinator)
  const spy=vi.spyOn(f.coordinator as typeof f.coordinator & {snapshot: NonNullable<typeof f.coordinator.snapshot>},'snapshot').mockImplementation(async id=>{entered.resolve();await release.promise;return original(id)})
  const {mounted}=mount(f,false);await mounted.tasks.ready;await entered.promise
  expect(()=>mounted.tasks.submit({identity:{parentSessionId:'parent'},agentPath:'early',description:'',prompt:'',agent:'general',delivery:'tool'})).toThrow('pending')
  expect(()=>mounted.tasks.claim('task-1','newchild')).toThrow('pending')
  expect(()=>mounted.tasks.terminalize({taskId:'task-1',outcome:'completed'})).toThrow('pending')
  await expect(mounted.tasks.save()).rejects.toThrow('pending')
  expect(mounted.tasks.list()).toHaveLength(1);expect(mounted.tasks.notifications()).toHaveLength(0);expect(lastOriginalTaskSave(mounted.tasks)).toBeUndefined()
  release.resolve();await mounted.ready
  const live=mounted.tasks.submit({identity:{parentSessionId:'parent'},agentPath:'live',description:'',prompt:'',agent:'general',delivery:'tool'})
  expect(live.status).toBe('accepted');expect(live.outcome).toBeUndefined()
  await mounted.tasks.flushPersistence();expect(mounted.tasks.get(live.id)?.outcome).toBeUndefined()
  await mounted.dispose();spy.mockRestore()
 }finally{release.resolve();await f.close()}
})
it.each([false,undefined])('post-install startup failure %s permanently fences the public task facade',async cause=>{
 const f=await fixture({formatVersion:2,tasks:[row],notifications:[]})
 try{
  await f.tasks.ready
  const spy=vi.spyOn(f.coordinator as typeof f.coordinator & {snapshot: NonNullable<typeof f.coordinator.snapshot>},'snapshot').mockRejectedValue(cause)
  const {mounted}=mount(f,false);await mounted.tasks.ready;await expect(mounted.ready).rejects.toBe(cause)
  expect(()=>mounted.tasks.submit({identity:{parentSessionId:'parent'},agentPath:'denied',description:'',prompt:'',agent:'general',delivery:'tool'})).toThrow('failed')
  expect(()=>mounted.tasks.claim('task-1')).toThrow('failed')
  expect(()=>mounted.tasks.cancelTree('task-1')).toThrow('failed')
  expect(()=>mounted.tasks.updateNotification('notif-1',{})).toThrow('failed')
  await expect(mounted.tasks.save()).rejects.toThrow('failed')
  await f.coordinator.putDocumentStrict!('unrelated',{})
  expect(()=>mounted.tasks.terminalize({taskId:'task-1',outcome:'completed'})).toThrow('failed')
  await expect(mounted.dispose()).rejects.toThrow();await mounted.dispose();spy.mockRestore()
 }finally{await f.close()}
})

it.each(['generic','task-only'])('logical14 %s parent cannot qualify v3 binding',async kind=>{
 const {createJsonlSessionCoordinator}=await import('../../session-persistence-jsonl/src/backend-factory.ts'),{createJsonlTaskDocumentCoordinator}=await import('../../session-persistence-jsonl/src/task-document-factory.ts'),{TaskPersistence}=await import('../src/task/persistence.ts')
 const root=await mkdtemp(join(process.env.IH_NATIVE_DEPENDENCY_EVIDENCE_ROOT!,'v3-unsupported-')),backend=createJsonlBackend(root)
 await backend.create('parent',{sessionId:'parent',formatVersion:14,createdAt:'x'});await writeFile(join(root,'task-parent.doc.jsonl'),'{"formatVersion":2,"tasks":[],"notifications":[]}')
 const coordinator=kind==='generic'?createJsonlSessionCoordinator(root,{lock:{enabled:true}}):createJsonlTaskDocumentCoordinator(root,{lock:{enabled:true}},taskDocumentStorageContract)
 try{
  await expect(coordinator.openManagedDocument('parent')).rejects.toThrow('TASK_TRANSITION_UNSUPPORTED');let snapshots=0;const owned=undefined
  const persistence=new TaskPersistence(coordinator,'parent',false,()=>{snapshots++;return {formatVersion:3,tasks:[],notifications:[]}},owned)
  expect(()=>persistence.captureBindingSave()).toThrow();expect(snapshots).toBe(0)
 }finally{await coordinator.close();await rm(root,{recursive:true,force:true})}
})

it.each([1,2] as const)('actual legacy%s ignored childBirth retains mirror and pending-inbox route',async version=>{
 const f=await fixture({formatVersion:version,tasks:[{...row,childSessionId:'child',childBirth:{ignored:true}}],notifications:[]})
 try{
  await f.tasks.ready;await f.coordinator.create({sessionId:'child',parentSession:'parent',origin:'subagent',seedLength:0});const child=await f.coordinator.openManagedDocument('child');await child.delivery.record({type:'subagent/inbox',messageId:'consumed',message:'consumed'});await child.delivery.record({type:'subagent/inbox',messageId:'pending',message:'legacy pending'})
  const open=vi.spyOn(f.coordinator,'openManagedDocument'),{mounted}=mount(f,true);const lookup=vi.spyOn(mounted.agents,'get');await mounted.ready;expect(open).toHaveBeenCalledWith('child');expect(lookup).toHaveBeenCalledWith('child');expect(isColdBoundChild(mounted.tasks,'child')).toBe(false);await mounted.dispose()
 }finally{await f.close()}
})
it('bootstrap header debt exposes no eligible parent until original cleanup and readiness finish',async()=>{
 const f=await fixture({formatVersion:2,tasks:[],notifications:[]})
 const {EMPTY_SEMANTIC_SEED_DIGEST,EMPTY_SEMANTIC_DEPENDENCY_DIGEST}=await import('@i-harness/core-session')
 const request={invocation:{version:1 as const,operationId:'boot',targetSessionId:'boot',createdAt:'2026-11-01T00:00:00.000Z',requestDigest:'a'.repeat(64)},target:{kind:'new' as const},metadata:{},lineage:{origin:'fork' as const,parentSession:'parent'},seed:{digest:EMPTY_SEMANTIC_SEED_DIGEST,dependencyDigest:EMPTY_SEMANTIC_DEPENDENCY_DIGEST,sourceObservation:{kind:'none' as const},records:[]}},guards={assertCurrent(){},dependencies:{async confirm(){throw Error('unused')},async reconcile(){throw Error('unused')}}}
 try{
  await f.tasks.ready;faults.target=join(f.root,'boot.jsonl');faults.cause=false;faults.closeFails=true
  expect((await f.coordinator.bootstrapSemanticTarget(request,guards)).kind).toBe('blocked')
  await expect(f.coordinator.openManagedDocument('boot')).rejects.toThrow()
  faults.closeFails=false
  const result=await f.coordinator.bootstrapSemanticTarget(request,guards);expect(['ready','already-ready']).toContain(result.kind)
  if(result.kind!=='ready'&&result.kind!=='already-ready')throw Error('Original bootstrap did not become ready')
  const owned=captureOwnedTaskContext(f.coordinator,result.document,result.document.view,'boot')!;owned.operations.assertTaskV3Parent(owned.parent,'boot')
 }finally{faults.closeFails=false;faults.target='';await f.close()}
})

it.each([false,true])('actual mounted ordinary replay of bound3 refuses before sources with routed=%s',async routed=>{
 const f=await fixture({formatVersion:2,tasks:[],notifications:[]})
 let mounted:ReturnType<typeof registerSubagent>|undefined,action:ReturnType<typeof f.document.beginAction>|undefined
 try{
  await f.tasks.ready
  const {receivedInputsFor}=await import('../../session-executor/src/lifecycle/received-inputs.ts'),{committedFactSeqs}=await import('@i-harness/core-session')
  await receivedInputsFor(f.document,'parent').inbox.admit({inputId:'human',text:'original ordinary call',intent:'user',delivery:'queue',provenance:{kind:'human',authority:'request',scope:'turn',producer:'session.prompt'}})
  action=f.document.beginAction()
  const args={task_name:'replay',message:'p',agent_type:'a',fork_turns:'none',background:false}
  const [callSeq]=committedFactSeqs(await action.facts.tools.call({type:'tool/call',callId:'replay',name:'spawn_agent',args}))
  committedFactSeqs(await action.facts.tools.dispatch('replay',{kind:'prior',seq:callSeq!,expectedType:'tool/call'}))
  const initial={inputId:'initial',text:'p',startedAt:1,expiresAt:11,parentSessionId:'parent'},lineage={origin:'subagent' as const,subagentProtocolVersion:1 as const,parentSession:'parent'},payload={invocation:{version:1 as const,operationId:'historical',targetSessionId:'historical-child',createdAt:'2026-11-01T00:00:00.000Z',requestDigest:'a'.repeat(64)},target:{kind:'new' as const},metadata:{},lineage,seed:compileSemanticSeed({kind:'none'}),initial}
  const core={version:1 as const,kind:'child-bootstrap-core' as const,caller:{kind:'task' as const,taskId:'task-1',parentSessionId:'parent',callEventSeq:callSeq!,toolCallId:'replay'},history:{selection:{kind:'none' as const}},metadata:{},lineage,initial:childInitialCommitment(payload),execution:{roleName:'a',roleDigest:'b'.repeat(64),toolNames:[],model:{kind:'inherit-parent' as const},approval:'ordinary' as const}},intent=createChildBootstrapRequestIntent(core,{kind:'unmanaged'}),request=captureChildBootstrapCaptureRequest({version:1,kind:'child-bootstrap-capture-request',invocation:{...payload.invocation,requestDigest:intent.requestDigest},core,requestIntent:intent.intent})
  await f.coordinator.putDocumentStrict!('task-parent',{formatVersion:3,tasks:[{...row,toolCallId:'replay',callEventSeq:callSeq!,agentPath:'root/replay',description:'replay',childBirth:{version:1,kind:'task-child-birth',request}}],notifications:[]})
  const ctx=createContext(),registry=createToolRegistry(ctx),model=createMockClient([]),stream=vi.spyOn(model,'stream'),instruction=vi.fn(()=>{throw Error('Unexpected instruction')}),generation=vi.fn(fixtureGenerationFor),resolver=vi.fn(async()=>({status:'unconfigured' as const,reason:'unused'}))
  mounted=registerSubagent(ctx,registry,{parentSession:f.document.view,factOwner:f.document,parentModel:model,exec:registerExec(ctx),resolveModel:resolver,generationFactoryFor:generation,createInstructionContext:instruction,reportPolicy:SHIPPING_REPORT_POLICY,persist:{coordinator:f.coordinator,stateId:'parent',parentSessionId:'parent'},restoredState:{formatVersion:1,roles:[{name:'a',description:'',systemPrompt:'a',tools:[]}],jobs:[],agentTable:[]}})
  await mounted.ready
  if(routed)mounted.tasks.get('task-1')!.delivery='parent'
  const create=vi.spyOn(f.coordinator,'create'),publish=vi.spyOn(mounted.agents,'register'),retain=vi.fn(()=>undefined)
  spawnProbe.sources=0;spawnProbe.armed=true
  const error=await registry.get('spawn_agent')!.execute(args,{session:f.document.view,sessionId:'parent',callEventSeq:callSeq!,callId:'replay',retainOutcome:retain} as never).then(()=>undefined,error=>error)
  expect({sources:spawnProbe.sources,retention:retain.mock.calls.length,child:create.mock.calls.length,instructions:instruction.mock.calls.length,generations:generation.mock.calls.length,resolver:resolver.mock.calls.length,agents:publish.mock.calls.length,streams:stream.mock.calls.length}).toEqual({sources:0,retention:0,child:0,instructions:0,generations:0,resolver:0,agents:0,streams:0})
  expect(error).toMatchObject({code:'TASK_COLD_BINDING_UNAVAILABLE'})
  expect(()=>mounted!.tasks.submit({identity:{parentSessionId:'parent',toolCallId:'replay',callEventSeq:callSeq!},agentPath:'root/replay',description:'replay',prompt:'p',agent:'a',delivery:'tool'})).toThrow('cold')
  const freshInput={identity:{parentSessionId:'parent',toolCallId:'fresh'},agentPath:'root/fresh',description:'fresh',prompt:'p',agent:'a',delivery:'tool' as const}
  const fresh=mounted.tasks.submit(freshInput);fresh.delivery='parent';fresh.status='running'
  expect(mounted.tasks.submit(freshInput)).toBe(fresh);await mounted.tasks.flushPersistence()
 }finally{spawnProbe.armed=false;action?.finish();await mounted?.dispose();await f.close()}
})
