import { mkdtemp, rm, writeFile, unlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { createJsonlTaskTransitionCoordinator } from '../../session-persistence-jsonl/src/task-document-factory.ts'
import { taskDocumentStorageContract } from '../src/task/storage-contract.ts'
import { createTaskRegistry } from '../src/task/registry.ts'
import { captureOwnedTaskContext } from '../src/task/owned-context.ts'
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
import { fixtureGenerationFor } from './generation-fixture.ts'
import { registerSubagent } from '../src/index.ts'
import { createContext } from '@i-harness/core-plugin'
import { createToolRegistry } from '@i-harness/core-tools'
import { createMockClient } from '@i-harness/llm-mock'
import { registerExec } from '@i-harness/exec'
import { lastOriginalTaskSave } from '../src/task/save-owner.ts'
import { SHIPPING_REPORT_POLICY } from '../src/report-policy.ts'
const row = {id:'task-1',parentSessionId:'parent',toolCallId:'call',agentPath:'a',description:'d',prompt:'p',agent:'a',delivery:'tool' as const,status:'accepted' as const,timeCreated:1}
async function fixture(value?: unknown, arm?: (root: string) => void) {
 const root=await mkdtemp(join(process.env.IH_NATIVE_DEPENDENCY_EVIDENCE_ROOT ?? tmpdir(),'owned-load-'))
 const observations: unknown[] = []
 const validator = { ...taskDocumentStorageContract, validate(value: unknown) { taskDocumentStorageContract.validate(value); if (Object.isFrozen(value)) observations.push(value) } }
 const coordinator=createJsonlTaskTransitionCoordinator(root,{lock:{enabled:true}},validator)
 await coordinator.create({sessionId:'parent'});const document=await coordinator.openManagedDocument('parent')
 if(value===undefined)await unlink(join(root,'task-parent.doc.jsonl'));else await writeFile(join(root,'task-parent.doc.jsonl'),JSON.stringify(value))
 arm?.(root)
 const tasks=createTaskRegistry({coordinator,stateId:'parent',ownedTask:captureOwnedTaskContext(coordinator,document,document.view,'parent')})
 return {tasks,coordinator,document,root,observations,async close(){await coordinator.close();await rm(root,{recursive:true,force:true})}}
}
it.each([1,2] as const)('owned literal %s begins unavailable and installs detached rows',async version=>{
 const f=await fixture({formatVersion:version,tasks:[row],notifications:[]})
 try {expect(()=>f.tasks.list()).toThrow();await f.tasks.ready;expect(f.tasks.list()).toHaveLength(1);expect(f.tasks.get('task-1')).not.toBe(row);const source=f.observations.at(-1) as {tasks: typeof row[]};expect(Object.isFrozen(source.tasks[0])).toBe(true);expect(source.tasks[0]).toEqual(row)}finally{await f.close()}
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
   faults.releasePath=lockPathFor(root,'doc:task-parent');faults.releaseFails=phase==='release'
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
 const f=await fixture({formatVersion:1,tasks:[row],notifications:[]},root=>{faults.releasePath=lockPathFor(root,'doc:task-parent');faults.entered=entered.resolve;faults.gate=release.promise})
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
 const ctx=createContext(),registry=createToolRegistry(ctx),resolveModel=vi.fn(async()=>({status:'unconfigured' as const,reason:'unused'}))
 const mounted=registerSubagent(ctx,registry,{generationFactoryFor:fixtureGenerationFor,parentSession:f.document.view,factOwner:f.document,parentModel:createMockClient([]),exec:registerExec(ctx),resolveModel,reportPolicy:SHIPPING_REPORT_POLICY,persist:{coordinator:f.coordinator,stateId:'parent',parentSessionId:'parent',parentSession:f.document.view},...(restored?{restoredState:{formatVersion:1 as const,roles:[],jobs:[{id:'subagent-1',owner:'root',kind:'subagent',label:'pending',status:'running' as const,output:'',terminal:false}],agentTable:[{path:'root/a',status:'waiting' as const,sessionId:'child',mailbox:['pending'],lastInboxSeq:0}]}}:{})})
 return {mounted,resolveModel,registry}
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
 }finally{await f.close()}
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
