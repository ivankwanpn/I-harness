import {expect,it,vi} from 'vitest'
const probe=vi.hoisted(()=>({unknown:false,allow:false,key:'',keys:[] as string[],appends:0,onHuman:undefined as undefined|(()=>void)}))
vi.mock('../../session-persistence-jsonl/src/backend/fact-journal.ts',async load=>{
 const original=await load<typeof import('../../session-persistence-jsonl/src/backend/fact-journal.ts')>()
 return {...original,createFactJournalBackend(...args:Parameters<typeof original.createFactJournalBackend>){
  const backend=original.createFactJournalBackend(...args),append=backend.appendOwnedBatch,reconcile=backend.reconcileOwnedBatch
  return {...backend,async appendOwnedBatch(...input:Parameters<typeof append>){
   const result=await append(...input)
   if(probe.unknown&&Buffer.from(input[3].bytes).toString('utf8').includes('"type":"todo/write"')){probe.appends++;probe.key=input[3].key.batchId;probe.keys.push(probe.key);return {kind:'unknown' as const,key:input[3].key}}
   return result
  },async reconcileOwnedBatch(...input:Parameters<typeof reconcile>){if(input[3].key.batchId===probe.key){probe.keys.push(probe.key);if(!probe.allow)return {kind:'unknown' as const,key:input[3].key}}return reconcile(...input)}}
 }}
})
vi.mock('../../core-session/src/managed/groups.ts',async load=>{
 const original=await load<typeof import('../../core-session/src/managed/groups.ts')>()
 return {...original,captureFactGroup(...args:Parameters<typeof original.captureFactGroup>){const result=original.captureFactGroup(...args);const draft=args[0];if(draft.kind==='metadata'&&draft.event.type==='todo/write'&&draft.event.items[0]?.content==='human race'){const hook=probe.onHuman;probe.onHuman=undefined;hook?.()}return result}}
})
import {mkdtemp,rm} from 'node:fs/promises'
import {join} from 'node:path'
import {createJsonlBackend} from '../../session-persistence-jsonl/src/index.ts'
import {composeJsonlTaskTransitionCoordinator} from '../../session-persistence-jsonl/src/task-document-factory.ts'
import {taskDocumentStorageContract} from '../../subagent/src/task/storage-contract.ts'
import {acquireManagedExecution} from '../../session-persistence/src/execution-internal.ts'
import {createOwnedMetadataFold} from '../../session-executor/src/lifecycle/owned-metadata-fold.ts'
import {createSessionService} from '../../session-executor/src/service.ts'
import {createDesktopWorkState,TodoRevisionConflictError} from '../src/work-state.ts'

async function fixture(){
 const root=await mkdtemp(join(process.env.IH_NATIVE_DEPENDENCY_EVIDENCE_ROOT!,'owned-work-state-')),backend=createJsonlBackend(root),coordinator=composeJsonlTaskTransitionCoordinator(backend,{lock:{enabled:true},originalExecutionFoldFactory:createOwnedMetadataFold},taskDocumentStorageContract)
 await coordinator.create({sessionId:'main'});const execution=await acquireManagedExecution(coordinator,'main'),cleanups:Array<()=>Promise<void>>=[]
 const service=createSessionService({workspace:root,coordinator,modelPolicy:'required'})
 const snapshot=vi.spyOn(coordinator as typeof coordinator&{snapshot:NonNullable<typeof coordinator.snapshot>},'snapshot').mockImplementation(async()=>{throw Error('private read must not snapshot a Session')})
 const profile=vi.spyOn(coordinator,'profile').mockImplementation(async()=>{throw Error('private read must not load a profile')})
 const assembly=vi.spyOn(service,'assemblyFor').mockImplementation(async()=>{throw Error('private read must not construct an assembly')})
 const writable=vi.spyOn(service as typeof service&{writableSessionFor:NonNullable<typeof service.writableSessionFor>},'writableSessionFor').mockImplementation(async()=>{throw Error('private write must not materialize a Session')})
 const state=createDesktopWorkState(coordinator,service,{sessionFor:async()=>{throw Error('private access must not call Session loader')},managed:{current:id=>id==='main'?execution:undefined,retain(id,owner,close){expect(id).toBe('main');expect(owner).toBe(execution);cleanups.push(close)}}})
 return {backend,coordinator,execution,state,cleanups,snapshot,profile,assembly,writable,async close(){probe.unknown=false;probe.allow=true;probe.onHuman=undefined;for(const close of [...cleanups].reverse())await close();await state.close();snapshot.mockRestore();profile.mockRestore();assembly.mockRestore();writable.mockRestore();await service.close();await coordinator.close();await rm(root,{recursive:true,force:true})}}
}

it('reads and writes original private Todo/Goal folds with physical revisions and no Session/model acquisition',async()=>{
 const f=await fixture()
 try{
  const action=f.execution.owner.beginAction()
  try{expect((await action.facts.metadata.admit({type:'todo/write',version:1,items:[{content:'original',status:'pending'}]})).kind).toBe('committed');expect((await action.facts.metadata.admit({type:'goal/change',version:1,operation:'create',goal:{id:'g',revision:1,objective:'Finish',phase:'active'},updatedAt:1})).kind).toBe('committed')}finally{action.finish()}
  expect(await f.state.read('main')).toMatchObject({todos:[{content:'original',status:'pending'}],todosRevision:1,goal:{id:'g',revision:1,objective:'Finish'}})
  expect(f.cleanups).toHaveLength(1)
  expect(await f.state.writeTodos('main',{expectedRevision:1,items:[{content:'  human  ',status:'completed'}]})).toMatchObject({todos:[{content:'human',status:'completed'}],todosRevision:2})
  await expect(f.state.writeTodos('main',{expectedRevision:1,items:[]})).rejects.toBeInstanceOf(TodoRevisionConflictError)
  expect((await f.backend.read('main')).events.filter(event=>event.type==='todo/write')).toHaveLength(2)
  expect(Object.hasOwn(f.execution.owner,'view')).toBe(false)
  for(const spy of [f.snapshot,f.profile,f.assembly,f.writable])expect(spy).not.toHaveBeenCalled()
  await f.state.close();await expect(f.state.read('main')).rejects.toMatchObject({code:'FACT_CLOSED'})
  expect(f.execution.observe().todosRevision).toBe(2)
 }finally{await f.close()}
},30000)

it('rechecks the same original root after async admission and refuses a stale human replacement',async()=>{
 const f=await fixture();let competing:Promise<unknown>|undefined
 const other=f.execution.owner.beginAction()
 try{
  expect((await other.facts.metadata.admit({type:'todo/write',version:1,items:[{content:'before',status:'pending'}]})).kind).toBe('committed')
  probe.onHuman=()=>{competing=other.facts.metadata.admit({type:'todo/write',version:1,items:[{content:'owner wins',status:'completed'}]});void competing.catch(()=>{})}
  await expect(f.state.writeTodos('main',{expectedRevision:1,items:[{content:'human race',status:'pending'}]})).rejects.toBeInstanceOf(TodoRevisionConflictError)
  expect(competing).toBeDefined();await competing
  expect(await f.state.read('main')).toMatchObject({todos:[{content:'owner wins',status:'completed'}],todosRevision:2})
  expect((await f.backend.read('main')).events.filter(event=>event.type==='todo/write')).toHaveLength(2)
 }finally{other.finish();await f.close()}
},30000)

it('retains an UNKNOWN original Todo capture and reconciles the same write during close after new-work revoke',async()=>{
 const f=await fixture()
 try{
  await f.state.read('main');probe.unknown=true;probe.allow=false;probe.key='';probe.keys=[];probe.appends=0
  await expect(f.state.writeTodos('main',{expectedRevision:0,items:[{content:'retained',status:'pending'}]})).rejects.toMatchObject({code:'FACT_RECOVERY_REQUIRED'})
  await expect(f.state.writeTodos('main',{expectedRevision:0,items:[]})).rejects.toMatchObject({code:'FACT_RECOVERY_REQUIRED'})
  f.execution.revokeNewWork()
  await expect(f.cleanups[0]!()).rejects.toThrow()
  expect(probe.appends).toBe(1)
  probe.allow=true;await f.cleanups[0]!()
  expect(new Set(probe.keys).size).toBe(1);expect(probe.appends).toBe(1)
  const events=(await f.backend.read('main')).events.filter(event=>event.type==='todo/write')
  expect(events).toHaveLength(1);expect(events[0]).toMatchObject({items:[{content:'retained',status:'pending'}]})
 }finally{await f.close()}
},30000)

it('preserves cold public Todo read/write/CAS on the original composed coordinator without a model',async()=>{
 const root=await mkdtemp(join(process.env.IH_NATIVE_DEPENDENCY_EVIDENCE_ROOT!,'public-work-state-')),coordinator=composeJsonlTaskTransitionCoordinator(createJsonlBackend(root),{lock:{enabled:true}},taskDocumentStorageContract)
 await coordinator.create({sessionId:'public'});const service=createSessionService({workspace:root,coordinator,modelPolicy:'required'}),state=createDesktopWorkState(coordinator,service)
 try{
  expect(await state.read('public')).toEqual({todos:null,todosRevision:0,goal:null})
  expect(await state.writeTodos('public',{expectedRevision:0,items:[{content:'  public edit  ',status:'pending'}]})).toEqual({todos:[{content:'public edit',status:'pending'}],todosRevision:1,goal:null})
  await expect(state.writeTodos('public',{expectedRevision:0,items:[]})).rejects.toBeInstanceOf(TodoRevisionConflictError)
  expect(service.hasAssembly('public')).toBe(false)
 }finally{await state.close();await service.close();await coordinator.close();await rm(root,{recursive:true,force:true})}
},30000)
