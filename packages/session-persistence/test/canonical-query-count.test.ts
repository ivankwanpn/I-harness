import {expect,it,vi} from 'vitest'
import {mkdtemp,rm} from 'node:fs/promises'
import {join,win32} from 'node:path'
import type {Win32ArtifactApi} from '../../fs-lock/src/win32-artifact-api.ts'
const probe=vi.hoisted(()=>({captures:0,opens:0,next:1n,nodes:new Map<string,{id:number;final:string;attributes?:number;sensitive?:number}>(),handles:new Map<bigint,{id:number;final:string;attributes?:number;sensitive?:number}>(),owners:new Map<object,import('../src/coordinator/binding-observation.ts').BindingObservations>(),onObserve:undefined as undefined|((id:string)=>Promise<void>)}))
vi.mock('../src/coordinator/binding-observation.ts',async load=>{const actual=await load<typeof import('../src/coordinator/binding-observation.ts')>();return {...actual,createBindingObservations(...args:Parameters<typeof actual.createBindingObservations>){const owner=actual.createBindingObservations(...args);probe.owners.set(args[1],owner);return owner}}})
vi.mock('../src/coordinator/ownership.ts',async load=>{const actual=await load<typeof import('../src/coordinator/ownership.ts')>();return {...actual,createOwnership(...args:Parameters<typeof actual.createOwnership>){const owner=actual.createOwnership(...args);latestOwners.push(owner);return owner}}})
const latestOwners=vi.hoisted(()=>[] as import('../src/coordinator/ownership.ts').Ownership[])
vi.mock('@i-harness/fs-lock/internal/artifact-path',async()=>{
 const {createWin32ArtifactPathOwnerWithApi}=await import('../../fs-lock/src/win32-artifact-path.ts')
 const api:Win32ArtifactApi={createFileW(name){probe.opens++;const node=probe.nodes.get(name);if(!node)return -1n;const handle=probe.next++;probe.handles.set(handle,{...node});return handle},getLastError:()=>3,getFileInformationByHandleEx(handle,kind,data){const node=probe.handles.get(handle)!;if(kind===18){data.writeBigUInt64LE(1n,0);data.writeUInt32LE(node.id,8)}else if(kind===23)data.writeUInt32LE(node.sensitive??0);else data.writeUInt32LE(node.attributes??0x10);return 1},getFinalPathNameByHandleW(handle,data){const name=probe.handles.get(handle)!.final;data.write(name+'\0','utf16le');return name.length},lcMapStringEx(_locale,_flags,value,_count,output){const name=value.toUpperCase();if(output)output.write(name,'utf16le');return name.length},closeHandle(handle){if(!probe.handles.delete(handle))throw Error('Foreign original handle');return 1}}
 return {createArtifactPathOwner(root:string){for(const directory of [root,win32.join(root,'.i-harness-locks')])if(!probe.nodes.has(directory))probe.nodes.set(directory,{id:probe.nodes.size+1,final:'\\Device\\TestVolume'+directory.slice(2)});const original=createWin32ArtifactPathOwnerWithApi(root,api);return {capture(name:string){probe.captures++;return original.capture(name)},settleResources:original.settleResources.bind(original)}}}
})
vi.mock('@i-harness/fs-lock',async()=>{
 const {createHash}=await import('node:crypto'),{heldLock}=await import('../../fs-lock/src/win32.ts')
 return {lockPathFor:(root:string,id:string)=>win32.join(root,'.i-harness-locks',createHash('sha256').update(id).digest('hex').slice(0,24)+'.lock'),async acquireSessionLock({lockPath}:{lockPath:string}){return heldLock({createFileW(){throw Error('Unexpected native acquisition')},lockFileEx(){throw Error('Unexpected native acquisition')},unlockFileEx:()=>1,closeHandle:()=>1,getLastError:()=>0},1n,lockPath,2n)}}
})
vi.mock('../../session-persistence-jsonl/src/backend/task-document-observation.ts',async load=>{const actual=await load<typeof import('../../session-persistence-jsonl/src/backend/task-document-observation.ts')>();return {...actual,createTaskDocumentObservation(...args:Parameters<typeof actual.createTaskDocumentObservation>){const original=actual.createTaskDocumentObservation(...args);return {...original,confirm:original.confirm.bind(original),stageWrite:original.stageWrite.bind(original),stageInitialize:original.stageInitialize.bind(original),settleResources:original.settleResources.bind(original),async observe(){const result=await original.observe();await probe.onObserve?.(args[2].parentSessionId);return result}}}}})
import {composeJsonlTaskTransitionCoordinator} from '../../session-persistence-jsonl/src/task-document-factory.ts'
import {createJsonlBackend} from '../../session-persistence-jsonl/src/backend-factory.ts'
import {taskDocumentStorageContract} from '../../subagent/src/task/storage-contract.ts'
import {taskDocumentOperationsFor} from '../src/task-document-internal.ts'
import {assertOutsideTaskDocumentOperation,assertOutsideTaskDocumentSessionOperation} from '../src/coordinator/task-document-operation.ts'
import {assertOutsideTaskTransition,assertOutsideTaskTransitionSession} from '../src/coordinator/task-document-transition.ts'
import {compareOriginalExclusionScopes,type Ownership} from '../src/coordinator/ownership.ts'
import {associateArtifactPaths,createArtifactCurrentGuard} from '../src/coordinator/artifact-path-association.ts'
import {createOwnership} from '../src/coordinator/ownership.ts'
import {createOriginalJsonlPathResolution} from '../src/coordinator/canonical-path-resolution.ts'
type QueryContext={owner:Ownership;backend:ReturnType<typeof createJsonlBackend>;root:string;admission:object;measure(work:()=>void):{captures:number;opens:number}}
const measure=(work:()=>void)=>{const before={captures:probe.captures,opens:probe.opens};work();return {captures:probe.captures-before.captures,opens:probe.opens-before.opens}}

async function methodContexts(check:(context:QueryContext)=>void|Promise<void>){
 const root=await mkdtemp(join(process.env.IH_NATIVE_DEPENDENCY_EVIDENCE_ROOT!,'canonical-query-'))
 const backend=createJsonlBackend(root),c=composeJsonlTaskTransitionCoordinator(backend,{lock:{enabled:true}},taskDocumentStorageContract),owner=latestOwners.at(-1)!
 const foreignRoot=await mkdtemp(join(process.env.IH_NATIVE_DEPENDENCY_EVIDENCE_ROOT!,'canonical-foreign-')),foreign=composeJsonlTaskTransitionCoordinator(createJsonlBackend(foreignRoot),{lock:{enabled:true}},taskDocumentStorageContract)
 const operations=taskDocumentOperationsFor(c)!,otherOperations=taskDocumentOperationsFor(foreign)!,opened:Array<Awaited<ReturnType<typeof operations.begin>>>=[]
 let checked=false,primary:{cause:unknown}|undefined
 try{
  await c.create({sessionId:'left-a'});await c.create({sessionId:'left-b'});await foreign.create({sessionId:'foreign'})
  const a=await operations.begin(operations.parent(await c.openManagedDocument('left-a'))),b=await operations.begin(operations.parent(await c.openManagedDocument('left-b'))),f=await otherOperations.begin(otherOperations.parent(await foreign.openManagedDocument('foreign')));opened.push(a,b,f)
  probe.onObserve=async id=>{
   if(id==='left-a'){await b.observe();return}if(id==='left-b'){await f.observe();return}if(id!=='foreign')return
   checked=true;await check({owner,backend,root,admission:probe.owners.get(owner)!.taskContextIdentity,measure})
  }
  await a.observe();expect(checked).toBe(true)
 }catch(cause){primary={cause}}finally{
  probe.onObserve=undefined;const errors:unknown[]=[]
  for(const close of [...opened.reverse().map(operation=>()=>operation.close()),()=>c.close(),()=>foreign.close()])try{await close()}catch(error){errors.push(error)}
  await rm(root,{recursive:true,force:true});await rm(foreignRoot,{recursive:true,force:true})
  if(primary||errors.length){const describe=(error:unknown):unknown=>error instanceof AggregateError?{message:error.message,errors:error.errors.map(describe)}:error instanceof Error?{message:error.message,cause:describe(error.cause),stack:error.stack}:String(error);console.info('CANONICAL_QUERY_PRIMARY',JSON.stringify({primary:primary&&describe(primary.cause),cleanup:errors.map(describe)}));throw new AggregateError([...(primary?[primary.cause]:[]),...errors],'Original query control and cleanup failed')}
 }
}

it.each([1,2] as const)('constructs one genuine query per matching original Task context, Q=%s',async resources=>{
 await methodContexts(({owner,admission,measure})=>{
  expect(measure(()=>resources===1?assertOutsideTaskDocumentSessionOperation(owner,'right'):assertOutsideTaskDocumentOperation(admission,['right'],['right-document']))).toEqual(resources===1?{captures:6,opens:12}:{captures:8,opens:16})
 })
})

it.each([1,2] as const)('constructs one query inside original nested transition contexts, Q=%s',async resources=>{
 const root=await mkdtemp(join(process.env.IH_NATIVE_DEPENDENCY_EVIDENCE_ROOT!,'canonical-transition-')),backend=createJsonlBackend(root),c=composeJsonlTaskTransitionCoordinator(backend,{lock:{enabled:true}},taskDocumentStorageContract),owner=latestOwners.at(-1)!
 const foreignRoot=await mkdtemp(join(process.env.IH_NATIVE_DEPENDENCY_EVIDENCE_ROOT!,'canonical-transition-foreign-')),foreign=composeJsonlTaskTransitionCoordinator(createJsonlBackend(foreignRoot),{lock:{enabled:true}},taskDocumentStorageContract)
 let checked=false
 try{
  probe.onObserve=async id=>{if(id==='transition-a'){await c.create({sessionId:'transition-b'});return}if(id==='transition-b'){await foreign.create({sessionId:'transition-foreign'});return}if(id!=='transition-foreign')return;checked=true
   expect(measure(()=>resources===1?assertOutsideTaskTransitionSession(owner,'right'):assertOutsideTaskTransition(probe.owners.get(owner)!.taskContextIdentity,['right'],['right-document']))).toEqual(resources===1?{captures:6,opens:12}:{captures:8,opens:16})
  }
  await c.create({sessionId:'transition-a'});expect(checked).toBe(true)
 }finally{probe.onObserve=undefined;await c.close();await foreign.close();await rm(root,{recursive:true,force:true});await rm(foreignRoot,{recursive:true,force:true})}
})

it('preserves foreign/all/empty short circuits and canonical alias conflicts',async()=>{
 await methodContexts(({owner,admission,measure})=>{
  expect(measure(()=>assertOutsideTaskDocumentOperation({},['right'],[],true))).toEqual({captures:0,opens:0})
  expect(measure(()=>expect(()=>assertOutsideTaskDocumentOperation(admission,[],[],true)).toThrow('TASK_DOCUMENT_CONFLICT'))).toEqual({captures:0,opens:0})
  expect(measure(()=>assertOutsideTaskDocumentOperation(admission,[],[]))).toEqual({captures:4,opens:8})
  expect(()=>assertOutsideTaskDocumentSessionOperation(owner,'LEFT-A')).toThrow('TASK_DOCUMENT_CONFLICT')
  expect(compareOriginalExclusionScopes(owner,['left-a'],[],['LEFT-A'],[])).toBe(true)
 })
})

it.each(['function','getter'] as const)('keeps the complete old sequence for a replaced exclusion %s',async mode=>{
 await methodContexts(({owner,admission,measure})=>{
  const descriptor=Object.getOwnPropertyDescriptor(owner,'exclusionScope')!,original=owner.exclusionScope;let calls=0
  if(mode==='function')owner.exclusionScope=(ids,keys)=>{calls++;return original(ids,keys)}
  else Object.defineProperty(owner,'exclusionScope',{configurable:true,get(){calls++;return original}})
  try{expect(measure(()=>assertOutsideTaskDocumentOperation(admission,['right'],['right-document']))).toEqual({captures:12,opens:24});expect(calls).toBe(6)}finally{Object.defineProperty(owner,'exclusionScope',descriptor)}
 })
})

it.each(['identity','case-policy','reparse'] as const)('recaptures after an await and rejects actual native %s replacement before effects',async mode=>{
 await methodContexts(async({owner,root})=>{
  assertOutsideTaskDocumentSessionOperation(owner,'right');await Promise.resolve()
  const node=probe.nodes.get(root)!,before={...node};let effects=0
  if(mode==='identity')node.id+=1000;else if(mode==='case-policy')node.sensitive=1;else node.attributes=0x410
  try{expect(()=>{assertOutsideTaskDocumentSessionOperation(owner,'right');effects++}).toThrow();expect(effects).toBe(0)}finally{node.id=before.id;node.sensitive=before.sensitive;node.attributes=before.attributes}
 })
})

it.each([false,true])('retains unknown exclusion callback mutation with reentry=%s instead of borrowing qualification',async reenter=>{
 await methodContexts(({owner,root})=>{
  const original=owner.exclusionScope,node=probe.nodes.get(root)!,identity=node.id;let calls=0,effects=0
  owner.exclusionScope=(ids,keys)=>{if(++calls===2){node.id=identity+1000;if(reenter)assertOutsideTaskDocumentSessionOperation(owner,'right')};return original(ids,keys)}
  try{expect(()=>{assertOutsideTaskDocumentSessionOperation(owner,'right');effects++}).toThrow();expect(effects).toBe(0);expect(calls).toBe(reenter?3:2)}finally{owner.exclusionScope=original;node.id=identity}
 })
})

it('keeps generic path callbacks on the old sequence even when their check has an existing pure-guard brand',async()=>{
 const root=await mkdtemp(join(process.env.IH_NATIVE_DEPENDENCY_EVIDENCE_ROOT!,'generic-path-')),backend={lockRoot:root} as import('../src/coordinator/types.ts').PersistenceBackend,calls:string[]=[]
 associateArtifactPaths(backend,Object.freeze({root:()=>root,session(id:string){calls.push('session:'+id);return join(root,id+'.jsonl')},document(key:string){calls.push('document:'+key);return join(root,key+'.doc.jsonl')},taskForParent:(id:string)=>join(root,'task-'+id+'.doc.jsonl'),async prepareRoot(){},async prepareDocumentParents(){},assertOriginal:createArtifactCurrentGuard(()=>{})}))
 const owner=createOwnership(backend,{lock:{enabled:true}})
 try{
  expect(compareOriginalExclusionScopes(owner,['left'],['task-left'],['right'],[])).toBeUndefined();expect(calls).toEqual([])
  expect(owner.exclusionScope(['left'],['task-left']).keys.some(key=>owner.exclusionScope(['right'],[]).keys.includes(key))).toBe(false)
  expect(calls).toEqual(['session:left','document:task-left','session:right','session:right'])
 }finally{await Promise.all(owner.releaseHeldLocks());await rm(root,{recursive:true,force:true})}
})

it('rejects changed original backend descriptors before a qualified comparison can publish an effect',async()=>{
 await methodContexts(({owner,backend})=>{
  const original=backend.getDocument;let effects=0;backend.getDocument=async()=>undefined
  try{expect(()=>{assertOutsideTaskDocumentSessionOperation(owner,'right');effects++}).toThrow('PROCESS_READ_UNAVAILABLE');expect(effects).toBe(0)}finally{backend.getDocument=original}
 })
})

it('retains the original shared JSONL path computation and rejects escaping path spellings',()=>{
 const root=join(process.env.IH_NATIVE_DEPENDENCY_EVIDENCE_ROOT!,'path-parity'),resolution=createOriginalJsonlPathResolution(root)
 expect(resolution.session('entry')).toBe(join(root,'entry.jsonl'));expect(resolution.document('entry')).toBe(join(root,'entry.doc.jsonl'));expect(resolution.taskForParent('entry')).toBe(join(root,'task-entry.doc.jsonl'))
 expect(resolution.artifactPath('entry','.tombstone')).toBe(join(root,'entry.tombstone'))
 expect(resolution.session('nested/../entry')).toBe(resolution.session('entry'))
 for(const id of ['../escape','..\\escape','\\rooted','C:\\elsewhere','D:relative','/absolute','prefix/../../escape'])expect(()=>resolution.session(id)).toThrow(/outside the JSONL store root/)
 expect(()=>resolution.bindBackend.call({...resolution},{} as never,{async prepareRoot(){},async prepareDocumentParents(){}})).toThrow('Original path constructor required')
})

it.each(['ids','keys'] as const)('declines revoked right %s without touching its proxy target during qualification',async field=>{
 await methodContexts(({owner})=>{
  const {proxy,revoke}=Proxy.revocable(['right'],{});revoke();let result:boolean|undefined
  expect(()=>{result=compareOriginalExclusionScopes(owner,['left-a'],[],field==='ids'?proxy:[],field==='keys'?proxy:[])}).not.toThrow()
  expect(result).toBeUndefined()
 })
})

it.each(['descriptor','native'] as const)('keeps original left %s failure before a revoked right query',async mode=>{
 await methodContexts(({admission,backend,root})=>{
  const {proxy,revoke}=Proxy.revocable(['right'],{});revoke()
  const getDocument=backend.getDocument,node=probe.nodes.get(root)!,identity=node.id
  if(mode==='descriptor')backend.getDocument=async()=>undefined;else node.id=identity+1000
  try{expect(()=>assertOutsideTaskDocumentOperation(admission,proxy,[])).toThrow(mode==='descriptor'?'PROCESS_READ_UNAVAILABLE':'Original artifact root changed')}
  finally{backend.getDocument=getDocument;node.id=identity}
 })
})

it('refuses copied/proxy owners and effectful array inputs without invoking them during qualification',async()=>{
 await methodContexts(({owner})=>{
  let calls=0;const proxy=new Proxy(owner,{get(){calls++;throw Error('Unexpected proxy getter')}})
  expect(compareOriginalExclusionScopes({...owner},['left-a'],[],['right'],[])).toBeUndefined()
  expect(compareOriginalExclusionScopes(proxy,['left-a'],[],['right'],[])).toBeUndefined();expect(calls).toBe(0)
  const ids:string[]=[];Object.defineProperty(ids,'0',{get(){calls++;return 'right'},enumerable:true});ids.length=1
  expect(compareOriginalExclusionScopes(owner,['left-a'],[],ids,[])).toBeUndefined();expect(calls).toBe(0)
 })
})
