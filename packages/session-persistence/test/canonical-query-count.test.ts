import {expect,it,vi} from 'vitest'
import {mkdtemp,rm} from 'node:fs/promises'
import {join,win32} from 'node:path'
import type {Win32ArtifactApi} from '../../fs-lock/src/win32-artifact-api.ts'
const probe=vi.hoisted(()=>({captures:0,opens:0,next:1n,nodes:new Map<string,{id:number;final:string;attributes?:number;sensitive?:number}>(),handles:new Map<bigint,{id:number;final:string;attributes?:number;sensitive?:number}>(),owners:new Map<object,import('../src/coordinator/binding-observation.ts').BindingObservations>(),onObserve:undefined as undefined|((id:string)=>Promise<void>),sourceCurrent:undefined as undefined|(()=>void),sourceHeld:undefined as undefined|(()=>void)}))
vi.mock('../src/coordinator/binding-observation.ts',async load=>{const actual=await load<typeof import('../src/coordinator/binding-observation.ts')>();return {...actual,createBindingObservations(...args:Parameters<typeof actual.createBindingObservations>){const owner=actual.createBindingObservations(...args);probe.owners.set(args[1],owner);return owner}}})
vi.mock('../src/coordinator/ownership.ts',async load=>{const actual=await load<typeof import('../src/coordinator/ownership.ts')>();return {...actual,createOwnership(...args:Parameters<typeof actual.createOwnership>){const owner=actual.createOwnership(...args);latestOwners.push(owner);return owner}}})
const latestOwners=vi.hoisted(()=>[] as import('../src/coordinator/ownership.ts').Ownership[])
vi.mock('../src/coordinator/managed-execution-source.ts',async load=>{const actual=await load<typeof import('../src/coordinator/managed-execution-source.ts')>();return {...actual,createManagedExecutionSource(...args:Parameters<typeof actual.createManagedExecutionSource>){const source=actual.createManagedExecutionSource(...args);if(probe.sourceCurrent){const original=source.assertCurrent;source.assertCurrent=()=>{original();probe.sourceCurrent?.();original()}}return source}}})
vi.mock('../src/coordinator/settlement-source.ts',async load=>{const actual=await load<typeof import('../src/coordinator/settlement-source.ts')>();return {...actual,createSettlementSource(...args:Parameters<typeof actual.createSettlementSource>){const operations=args[1],capture=operations.captureMembers;if(!probe.sourceHeld||!capture)return actual.createSettlementSource(...args);operations.captureMembers=source=>{const original=source.assertHeld;source.assertHeld=()=>{original();probe.sourceHeld?.();original()};return Reflect.apply(capture,operations,[source])};try{return actual.createSettlementSource(...args)}finally{operations.captureMembers=capture}}}})
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

it('deduplicates the shared original lock proof in synchronous live and held bundle predicates',async()=>{
 await methodContexts(({owner,measure})=>{
  const bundle=measure(()=>owner.assertHeld('left-a'))
  const live=measure(()=>expect(owner.hasLiveOwnership('left-a')).toBe(true))
  expect(bundle).toEqual({captures:0,opens:8})
  expect(live).toEqual({captures:0,opens:8})
 })
})
it.each(['identity','case-policy','reparse'] as const)('rechecks held predicates after await and rejects original native %s changes',async mode=>{
 let refused=false
 await expect(methodContexts(async({owner,root})=>{
  owner.assertHeld('left-a');expect(owner.hasLiveOwnership('left-a')).toBe(true)
  await Promise.resolve()
  const node=probe.nodes.get(root)!,before={...node};let effects=0
  if(mode==='identity')node.id+=1000;else if(mode==='case-policy')node.sensitive=1;else node.attributes=0x410
  try{
   expect(()=>{owner.assertHeld('left-a');effects++}).toThrow()
   expect(()=>{owner.hasLiveOwnership('left-a');effects++}).toThrow()
   expect(effects).toBe(0);refused=true
  }finally{Object.assign(node,before)}
 })).rejects.toThrow('Original query control and cleanup failed')
 expect(refused).toBe(true)
})
it('coalesces genuine original ownership constituents without skipping logical checks',async()=>{
 const {originalOwnershipArtifactGuard}=await import('../src/coordinator/ownership.ts'),{composeOriginalArtifactGuards}=await import('../src/coordinator/artifact-path-association.ts'),{heldFactOwner}=await import('../src/coordinator/fact-owner.ts')
 await methodContexts(({owner,measure})=>{
  const original=originalOwnershipArtifactGuard(owner,'left-a')!;expect(original).toBeTypeOf('function')
  const fallback=heldFactOwner({sessionId:'left-a',incarnation:'fallback'},owner,()=>owner.assertHeld('left-a'))
  expect(measure(()=>fallback.assertHeld())).toEqual({captures:0,opens:16})
  const held=heldFactOwner({sessionId:'left-a',incarnation:'fixture'},owner,composeOriginalArtifactGuards(original))
  expect(measure(()=>held.assertHeld())).toEqual({captures:0,opens:8})
  const method=owner.assertHeld;let replacementCalls=0
  owner.assertHeld=()=>{replacementCalls++}
  try{expect(()=>held.assertHeld()).toThrow('Original ownership assertion changed');expect(replacementCalls).toBe(0)}finally{owner.assertHeld=method}
 })
})
it('flushes original ownership before an unknown liveness callback retargets a native path',async()=>{
 const {originalOwnershipArtifactGuard}=await import('../src/coordinator/ownership.ts'),{withArtifactCurrentChecks}=await import('../src/coordinator/artifact-path-association.ts'),{heldFactOwner}=await import('../src/coordinator/fact-owner.ts')
 let refused=false
 await expect(methodContexts(({owner,root})=>{
  const guard=originalOwnershipArtifactGuard(owner,'left-a')!,node=probe.nodes.get(root)!,before={...node};let effects=0,callbackChecks=0
  const held=heldFactOwner({sessionId:'left-a',incarnation:'fixture'},owner,()=>{callbackChecks++;node.id+=1000})
  try{expect(()=>withArtifactCurrentChecks(()=>{guard();held.assertHeld();effects++})).toThrow();expect(callbackChecks).toBe(1);expect(effects).toBe(0);refused=true}finally{Object.assign(node,before)}
 })).rejects.toThrow('Original query control and cleanup failed')
 expect(refused).toBe(true)
})
it('propagates genuine held ownership through original settlement source guards',async()=>{
 const {originalOwnershipArtifactGuard}=await import('../src/coordinator/ownership.ts'),{composeOriginalArtifactGuards,isArtifactCurrentGuard}=await import('../src/coordinator/artifact-path-association.ts'),{heldFactOwner}=await import('../src/coordinator/fact-owner.ts'),{createSettlementSource}=await import('../src/coordinator/settlement-source.ts')
 await methodContexts(async({owner,measure})=>{
  const original=originalOwnershipArtifactGuard(owner,'left-a')!,held=heldFactOwner({sessionId:'left-a',incarnation:'fixture'},owner,composeOriginalArtifactGuards(original))
  expect(isArtifactCurrentGuard(held.assertHeld)).toBe(true)
  const operations={assertHeld:held.assertHeld,async admitCaptured(){throw Error('unused')},async reconcile(){throw Error('unused')},status(){return undefined},quarantineCapture(){},holdRecovery(){},releaseRecovery(){},onCloseRequested(){}}
  const source=createSettlementSource(async()=>{},operations,()=>{})
  expect(isArtifactCurrentGuard(source.assertHeld)).toBe(true)
  expect(measure(()=>{source.assertHeld();source.assertHeld()})).toEqual({captures:0,opens:16})
  expect(measure(()=>composeOriginalArtifactGuards(source.assertHeld,source.assertHeld)())).toEqual({captures:0,opens:8})
  const method=operations.assertHeld;let replacements=0;operations.assertHeld=()=>{replacements++}
  try{expect(()=>source.assertHeld()).toThrow('Original settlement ownership assertion changed');expect(replacements).toBe(0)}finally{operations.assertHeld=method}
  await source.close();expect(()=>source.assertHeld()).toThrow('Settlement source is closed')
 })
})
it('flushes before an unknown settlement guard retargets the original native path',async()=>{
 const {originalOwnershipArtifactGuard}=await import('../src/coordinator/ownership.ts'),{withArtifactCurrentChecks}=await import('../src/coordinator/artifact-path-association.ts'),{createSettlementSource}=await import('../src/coordinator/settlement-source.ts');let refused=false
 await expect(methodContexts(async({owner,root})=>{
  const guard=originalOwnershipArtifactGuard(owner,'left-a')!,node=probe.nodes.get(root)!,before={...node};let effects=0,callbacks=0
  const source=createSettlementSource(async()=>{},{assertHeld(){callbacks++;node.id+=1000;guard()},async admitCaptured(){throw Error('unused')},async reconcile(){throw Error('unused')},status(){return undefined},quarantineCapture(){},holdRecovery(){},releaseRecovery(){},onCloseRequested(){}},()=>{})
  try{expect(()=>withArtifactCurrentChecks(()=>{guard();source.assertHeld();effects++})).toThrow();expect(callbacks).toBe(1);expect(effects).toBe(0);refused=true}finally{Object.assign(node,before);await source.close().catch(()=>{});Object.assign(node,before)}
 })).rejects.toThrow('Original query control and cleanup failed');expect(refused).toBe(true)
})
it('coalesces exact original capture currentness constituents before its command',async()=>{
 const {originalOwnershipArtifactGuard}=await import('../src/coordinator/ownership.ts'),{createExecutionMemberOwner}=await import('../../core-session/src/managed/execution-members.ts'),{captureFactGroup}=await import('../../core-session/src/managed/groups.ts')
 await methodContexts(({owner,measure})=>{
  const guard=originalOwnershipArtifactGuard(owner,'left-a')!,members=createExecutionMemberOwner(guard),source={},capture=captureFactGroup({kind:'metadata',event:{type:'plan/mode',mode:'off'}});if(capture.kind!=='captured')throw Error('Original group required');let commands=0
  const operations={async admit(){return {kind:'not-issued' as const,code:'FACT_CANCELLED' as const}},async observe(){commands++;return {kind:'not-issued' as const,code:'FACT_CANCELLED' as const}},async reconcile(){return {kind:'not-issued' as const,code:'FACT_CANCELLED' as const}}}
  const original=members.capture(capture.group,operations,source,guard)
  expect(measure(()=>{void original.observe()})).toEqual({captures:0,opens:8});expect(commands).toBe(1)
  const fallback=members.capture(capture.group,operations,source,()=>guard())
  expect(measure(()=>{void fallback.observe()})).toEqual({captures:0,opens:16});expect(commands).toBe(2);members.releaseSource(source)
 })
})

it('flushes capture ownership before an unknown source callback retargets native identity',async()=>{
 const {originalOwnershipArtifactGuard}=await import('../src/coordinator/ownership.ts'),{createExecutionMemberOwner}=await import('../../core-session/src/managed/execution-members.ts'),{captureFactGroup}=await import('../../core-session/src/managed/groups.ts');let refused=false
 await expect(methodContexts(({owner,root})=>{
  const guard=originalOwnershipArtifactGuard(owner,'left-a')!,members=createExecutionMemberOwner(guard),source={},node=probe.nodes.get(root)!,before={...node},capture=captureFactGroup({kind:'metadata',event:{type:'plan/mode',mode:'off'}});if(capture.kind!=='captured')throw Error('Original group required');let commands=0,callbacks=0
  const operations={async admit(){return {kind:'not-issued' as const,code:'FACT_CANCELLED' as const}},async observe(){commands++;return {kind:'not-issued' as const,code:'FACT_CANCELLED' as const}},async reconcile(){return {kind:'not-issued' as const,code:'FACT_CANCELLED' as const}}}
  let armed=false;const handle=members.capture(capture.group,operations,source,()=>{callbacks++;if(armed)node.id+=1000;guard()});armed=true;callbacks=0
  try{expect(()=>handle.observe()).toThrow();expect(callbacks).toBe(1);expect(commands).toBe(0);refused=true}finally{Object.assign(node,before);members.releaseSource(source)}
 })).rejects.toThrow('Original query control and cleanup failed');expect(refused).toBe(true)
})

it('coalesces original private Task parent readiness without changing its logical checks',async()=>{
 const {acquireManagedExecution}=await import('../src/execution-internal.ts'),{captureManagedTaskParentReadiness}=await import('../src/coordinator/managed-document.ts')
 const root=await mkdtemp(join(process.env.IH_NATIVE_DEPENDENCY_EVIDENCE_ROOT!,'private-parent-guard-')),coordinator=composeJsonlTaskTransitionCoordinator(createJsonlBackend(root),{lock:{enabled:true}},taskDocumentStorageContract),owner=latestOwners.at(-1)!
 try{await coordinator.create({sessionId:'parent'});const execution=await acquireManagedExecution(coordinator,'parent'),proof=captureManagedTaskParentReadiness(execution.owner as unknown as import('../src/coordinator/fact-types.ts').ManagedDocument,owner)
  expect(measure(()=>proof.assertCurrent())).toEqual({captures:0,opens:8});expect(measure(()=>(execution.owner as unknown as import('../src/coordinator/fact-types.ts').ManagedDocument).assertReady())).toEqual({captures:0,opens:8})
 }finally{await coordinator.close();await rm(root,{recursive:true,force:true})}
})

it('keeps an unknown private parent source callback outside the native batching interval',async()=>{
 const {acquireManagedExecution}=await import('../src/execution-internal.ts'),{captureManagedTaskParentReadiness}=await import('../src/coordinator/managed-document.ts'),{originalOwnershipArtifactGuard}=await import('../src/coordinator/ownership.ts'),{withArtifactCurrentChecks}=await import('../src/coordinator/artifact-path-association.ts')
 const root=await mkdtemp(join(process.env.IH_NATIVE_DEPENDENCY_EVIDENCE_ROOT!,'private-parent-unknown-'));let armed=false,callbacks=0,effects=0
 probe.sourceCurrent=()=>{if(armed){callbacks++;probe.nodes.get(root)!.id+=1000}}
 const coordinator=composeJsonlTaskTransitionCoordinator(createJsonlBackend(root),{lock:{enabled:true}},taskDocumentStorageContract),owner=latestOwners.at(-1)!
 let changed=false
 try{await coordinator.create({sessionId:'parent'});const execution=await acquireManagedExecution(coordinator,'parent'),proof=captureManagedTaskParentReadiness(execution.owner as unknown as import('../src/coordinator/fact-types.ts').ManagedDocument,owner),guard=originalOwnershipArtifactGuard(owner,'parent')!,node=probe.nodes.get(root)!,before={...node}
  armed=true
  try{expect(()=>withArtifactCurrentChecks(()=>{guard();proof.assertCurrent();effects++})).toThrow();expect(callbacks).toBe(1);expect(effects).toBe(0);changed=true}finally{armed=false;Object.assign(node,before)}
 }finally{probe.sourceCurrent=undefined;if(changed)await expect(coordinator.close()).rejects.toThrow();else await coordinator.close();await rm(root,{recursive:true,force:true})}
})
it('preserves original held-binding and owner descriptor provenance through genuine ACK reads',async()=>{
 const {acquireManagedExecution}=await import('../src/execution-internal.ts'),{createManagedExecutionDomain,readManagedAcknowledgedMembers}=await import('../../core-session/src/managed/execution-state.ts')
 const root=await mkdtemp(join(process.env.IH_NATIVE_DEPENDENCY_EVIDENCE_ROOT!,'private-core-guard-')),coordinator=composeJsonlTaskTransitionCoordinator(createJsonlBackend(root),{lock:{enabled:true}},taskDocumentStorageContract)
 let action:ReturnType<Awaited<ReturnType<typeof acquireManagedExecution>>['owner']['beginAction']>|undefined
 try{await coordinator.create({sessionId:'parent'});const execution=await acquireManagedExecution(coordinator,'parent'),domain=createManagedExecutionDomain(execution.identity,execution.owner,{},'parent');action=execution.owner.beginAction()
  const capture=action.captureMetadata!({type:'plan/mode',mode:'off'}),outcome=await capture.admit();expect(outcome.kind).toBe('committed')
  expect(measure(()=>expect(readManagedAcknowledgedMembers(domain,capture,outcome)).toHaveLength(1))).toEqual({captures:0,opens:16})
  const document=execution.owner as unknown as import('../src/coordinator/fact-types.ts').ManagedDocument,ready=document.assertReady;let replacements=0;document.assertReady=()=>{replacements++}
  try{expect(()=>readManagedAcknowledgedMembers(domain,capture,outcome)).toThrow('Original owner readiness changed');expect(replacements).toBe(0)}finally{document.assertReady=ready}
 }finally{action?.finish();await coordinator.close();await rm(root,{recursive:true,force:true})}
})

it('coalesces genuine registered-source currentness during an original durable source ACK read',async()=>{
 const {acquireManagedExecution}=await import('../src/execution-internal.ts'),{createManagedExecutionDomain,readManagedSourceAcknowledgedMembers}=await import('../../core-session/src/managed/execution-state.ts')
 const root=await mkdtemp(join(process.env.IH_NATIVE_DEPENDENCY_EVIDENCE_ROOT!,'private-source-guard-')),coordinator=composeJsonlTaskTransitionCoordinator(createJsonlBackend(root),{lock:{enabled:true}},taskDocumentStorageContract)
 let action:ReturnType<Awaited<ReturnType<typeof acquireManagedExecution>>['owner']['beginAction']>|undefined,source:ReturnType<NonNullable<typeof action>['registerSettlementSource']>|undefined
 try{await coordinator.create({sessionId:'parent'});const execution=await acquireManagedExecution(coordinator,'parent'),domain=createManagedExecutionDomain(execution.identity,execution.owner,{},'parent');action=execution.owner.beginAction()
  expect((await action.facts.tools.call({type:'tool/call',callId:'source-call',name:'read',args:{}})).kind).toBe('committed')
  source=action.registerSettlementSource(async()=>{});const capture=source.tools.captureResult({type:'tool/result',callId:'source-call',name:'read',output:'original controlled result'}),outcome=await capture.admit();expect(outcome.kind).toBe('committed')
  expect(measure(()=>expect(readManagedSourceAcknowledgedMembers(domain,source!,capture,outcome)).toHaveLength(1))).toEqual({captures:0,opens:48})
 }finally{await source?.close();action?.finish();await coordinator.close();await rm(root,{recursive:true,force:true})}
})
it('keeps unknown registered-source callbacks immediate before an original source ACK read',async()=>{
 const {acquireManagedExecution}=await import('../src/execution-internal.ts'),{createManagedExecutionDomain,readManagedSourceAcknowledgedMembers}=await import('../../core-session/src/managed/execution-state.ts'),{originalOwnershipArtifactGuard}=await import('../src/coordinator/ownership.ts'),{withArtifactCurrentChecks}=await import('../src/coordinator/artifact-path-association.ts')
 const root=await mkdtemp(join(process.env.IH_NATIVE_DEPENDENCY_EVIDENCE_ROOT!,'private-source-unknown-'));let armed=false,callbacks=0,effects=0,changed=false
 probe.sourceHeld=()=>{if(armed){callbacks++;probe.nodes.get(root)!.id+=1000}}
 const coordinator=composeJsonlTaskTransitionCoordinator(createJsonlBackend(root),{lock:{enabled:true}},taskDocumentStorageContract),owner=latestOwners.at(-1)!
 let action:ReturnType<Awaited<ReturnType<typeof acquireManagedExecution>>['owner']['beginAction']>|undefined,source:ReturnType<NonNullable<typeof action>['registerSettlementSource']>|undefined
 try{await coordinator.create({sessionId:'parent'});const execution=await acquireManagedExecution(coordinator,'parent'),domain=createManagedExecutionDomain(execution.identity,execution.owner,{},'parent');action=execution.owner.beginAction()
  expect((await action.facts.tools.call({type:'tool/call',callId:'source-call',name:'read',args:{}})).kind).toBe('committed');source=action.registerSettlementSource(async()=>{})
  const capture=source.tools.captureResult({type:'tool/result',callId:'source-call',name:'read',output:'original controlled result'}),outcome=await capture.admit();expect(outcome.kind).toBe('committed')
  const guard=originalOwnershipArtifactGuard(owner,'parent')!,node=probe.nodes.get(root)!,before={...node};armed=true
  try{expect(()=>withArtifactCurrentChecks(()=>{guard();readManagedSourceAcknowledgedMembers(domain,source!,capture,outcome);effects++})).toThrow();expect(callbacks).toBe(1);expect(effects).toBe(0);changed=true}finally{armed=false;Object.assign(node,before)}
 }finally{probe.sourceHeld=undefined;if(changed){await expect(source!.close()).rejects.toThrow();action?.finish();await expect(coordinator.close()).rejects.toThrow()}else{await source?.close();action?.finish();await coordinator.close()}await rm(root,{recursive:true,force:true})}
})
it('measures one original full metadata observation without skipping fold callbacks',async()=>{
 const {acquireManagedExecution}=await import('../src/execution-internal.ts'),{createOwnedMetadataFold}=await import('../../session-executor/src/lifecycle/owned-metadata-fold.ts')
 const root=await mkdtemp(join(process.env.IH_NATIVE_DEPENDENCY_EVIDENCE_ROOT!,'observe-interval-'));
 const coordinator=composeJsonlTaskTransitionCoordinator(createJsonlBackend(root),{lock:{enabled:true},originalExecutionFoldFactory:createOwnedMetadataFold},taskDocumentStorageContract)
 try{await coordinator.create({sessionId:'parent'});const execution=await acquireManagedExecution(coordinator,'parent'),action=execution.owner.beginAction();try{expect((await action.facts.metadata.admit({type:'todo/write',version:1,items:[{content:'original snapshot',status:'pending'}]})).kind).toBe('committed')}finally{action.finish()}
  let observation:ReturnType<typeof execution.observe>|undefined
  const count=measure(()=>{observation=execution.observe()});console.info('ACTUAL_OBSERVE_COUNT',count);expect(count.captures).toBe(0);expect(observation!.metadata.todo).toMatchObject({kind:'available',snapshot:{kind:'present',items:[{content:'original snapshot',status:'pending'}]}});expect(Object.hasOwn(execution.owner,'view')).toBe(false)
 }finally{await coordinator.close();await rm(root,{recursive:true,force:true})}
})

it('batches original attachment action and Task parent checks while custom parent retarget stays opaque',async()=>{
 const {acquireManagedExecution}=await import('../src/execution-internal.ts'),{createTaskDocumentOperations}=await import('../src/coordinator/task-document-operation.ts'),{createOwnedMetadataFold}=await import('../../session-executor/src/lifecycle/owned-metadata-fold.ts')
 const root=await mkdtemp(join(process.env.IH_NATIVE_DEPENDENCY_EVIDENCE_ROOT!,'original-caller-batch-')),backend=createJsonlBackend(root),coordinator=composeJsonlTaskTransitionCoordinator(backend,{lock:{enabled:true},originalExecutionFoldFactory:createOwnedMetadataFold},taskDocumentStorageContract),ownership=latestOwners.at(-1)!
 let changed=false
 try{await coordinator.create({sessionId:'parent'});const execution=await acquireManagedExecution(coordinator,'parent'),operations=taskDocumentOperationsFor(coordinator)!,parent=operations.parent(execution.owner),action=execution.owner.beginAction()
  try{
   console.info('ORIGINAL_CALLER_BATCH_COUNT',{observe:measure(()=>{execution.observe()}),action:measure(()=>action.assertOpen()),parent:measure(()=>operations.assertParentSession(parent,'parent')),task:measure(()=>operations.assertTaskV3Parent(parent,'parent'))})
   const node=probe.nodes.get(root)!,before={...node};let callbacks=0,effects=0
   const custom=createTaskDocumentOperations(ownership,probe.owners.get(ownership)!,{captureParent(){return {id:'parent',assertCurrent(){callbacks++;execution.observe().assertCurrent();node.id+=1000;execution.observe().assertCurrent()},assertTaskV3Parent(){execution.observe().assertCurrent()}}},validator:{validate(){}},open(){throw Error('Unexpected custom open')}},async run=>run())
   const token=custom.parent(execution.owner)
   try{expect(()=>{custom.assertTaskV3Parent(token,'parent');effects++}).toThrow();expect(callbacks).toBe(1);expect(effects).toBe(0);changed=true}finally{Object.assign(node,before)}
   node.id+=1000;try{expect(()=>action.assertOpen()).toThrow();expect(()=>execution.observe()).toThrow();expect(()=>operations.assertTaskV3Parent(parent,'parent')).toThrow()}finally{Object.assign(node,before)}
  }finally{action.finish()}
 }finally{if(changed)await expect(coordinator.close()).rejects.toThrow();else await coordinator.close();await rm(root,{recursive:true,force:true})}
})

it('flushes around an opaque original fold snapshot and rejects native retarget before returning observation',async()=>{
 const {acquireManagedExecution}=await import('../src/execution-internal.ts'),{createOwnedMetadataFold}=await import('../../session-executor/src/lifecycle/owned-metadata-fold.ts')
 const root=await mkdtemp(join(process.env.IH_NATIVE_DEPENDENCY_EVIDENCE_ROOT!,'observe-retarget-'));let armed=false,callbacks=0,effects=0,changed=false
 const coordinator=composeJsonlTaskTransitionCoordinator(createJsonlBackend(root),{lock:{enabled:true},originalExecutionFoldFactory:input=>{const fold=createOwnedMetadataFold(input),original=fold.views.todo.snapshot;fold.views.todo.snapshot=prefix=>{if(armed){callbacks++;probe.nodes.get(root)!.id+=1000}return original(prefix)};return fold}},taskDocumentStorageContract)
 try{await coordinator.create({sessionId:'parent'});const execution=await acquireManagedExecution(coordinator,'parent'),node=probe.nodes.get(root)!,before={...node};armed=true
  try{expect(()=>{execution.observe();effects++}).toThrow();expect(callbacks).toBe(1);expect(effects).toBe(0);changed=true}finally{armed=false;Object.assign(node,before)}
 }finally{if(changed)await expect(coordinator.close()).rejects.toThrow();else await coordinator.close();await rm(root,{recursive:true,force:true})}
})
it('does not re-observe skipped readiness listeners and validates every actual callback',async()=>{
 const {acquireManagedExecution}=await import('../src/execution-internal.ts'),{subscribeManagedExecutionReadiness,createManagedExecutionDomain}=await import('../../core-session/src/managed/execution-state.ts'),{createOwnedMetadataFold}=await import('../../session-executor/src/lifecycle/owned-metadata-fold.ts')
 const root=await mkdtemp(join(process.env.IH_NATIVE_DEPENDENCY_EVIDENCE_ROOT!,'readiness-fanout-'));let snapshots=0,calls=0
 const coordinator=composeJsonlTaskTransitionCoordinator(createJsonlBackend(root),{lock:{enabled:true},originalExecutionFoldFactory:input=>{const fold=createOwnedMetadataFold(input),original=fold.views.todo.snapshot;fold.views.todo.snapshot=prefix=>{snapshots++;return original(prefix)};return fold}},taskDocumentStorageContract),offs:Array<()=>void>=[]
 try{await coordinator.create({sessionId:'parent'});const execution=await acquireManagedExecution(coordinator,'parent'),domain=createManagedExecutionDomain(execution.identity,execution.owner,{},'parent')
  for(let i=0;i<3;i++){offs.push(subscribeManagedExecutionReadiness(domain,()=>{calls++}));await new Promise(resolve=>setImmediate(resolve))}
  expect(calls).toBe(3);offs.push(subscribeManagedExecutionReadiness(domain,()=>{calls++}))
  const before=snapshots,opened=probe.opens;await new Promise(resolve=>setImmediate(resolve))
  console.info('READINESS_DELIVERY_NATIVE',{snapshots:snapshots-before,opens:probe.opens-opened});expect(snapshots-before).toBe(2);expect(calls).toBe(4)
 }finally{for(const off of offs)off();await coordinator.close();await rm(root,{recursive:true,force:true})}
})

it('reports original native ownership loss after the last readiness callback',async()=>{
 const {acquireManagedExecution}=await import('../src/execution-internal.ts'),{subscribeManagedExecutionReadiness,createManagedExecutionDomain}=await import('../../core-session/src/managed/execution-state.ts')
 const root=await mkdtemp(join(process.env.IH_NATIVE_DEPENDENCY_EVIDENCE_ROOT!,'readiness-last-loss-')),coordinator=composeJsonlTaskTransitionCoordinator(createJsonlBackend(root),{lock:{enabled:true}},taskDocumentStorageContract);let lost=0,calls=0,effects=0,changed=false;const offs:Array<()=>void>=[]
 try{await coordinator.create({sessionId:'parent'});const execution=await acquireManagedExecution(coordinator,'parent'),domain=createManagedExecutionDomain(execution.identity,execution.owner,{},'parent'),node=probe.nodes.get(root)!,before={...node}
  offs.push(subscribeManagedExecutionReadiness(domain,()=>{},()=>{lost++}));await new Promise(resolve=>setImmediate(resolve))
  offs.push(subscribeManagedExecutionReadiness(domain,()=>{calls++;node.id+=1000},()=>{lost++}))
  try{await new Promise(resolve=>setImmediate(resolve));expect(calls).toBe(1);expect(lost).toBe(2);expect(()=>{execution.observe();effects++}).toThrow();expect(effects).toBe(0);changed=true}finally{Object.assign(node,before)}
 }finally{for(const off of offs)off();if(changed)await expect(coordinator.close()).rejects.toThrow();else await coordinator.close();await rm(root,{recursive:true,force:true})}
})

it.each(['function','getter'] as const)('keeps a changed structuredClone %s opaque and rejects its native retarget',async mode=>{
 const {acquireManagedExecution}=await import('../src/execution-internal.ts'),{createOwnedMetadataFold}=await import('../../session-executor/src/lifecycle/owned-metadata-fold.ts')
 const root=await mkdtemp(join(process.env.IH_NATIVE_DEPENDENCY_EVIDENCE_ROOT!,'observe-clone-override-')),coordinator=composeJsonlTaskTransitionCoordinator(createJsonlBackend(root),{lock:{enabled:true},originalExecutionFoldFactory:createOwnedMetadataFold},taskDocumentStorageContract)
 const descriptor=Object.getOwnPropertyDescriptor(globalThis,'structuredClone')!,intrinsic=descriptor.value as typeof structuredClone;let calls=0,getters=0,effects=0,changed=false
 try{await coordinator.create({sessionId:'parent'});const execution=await acquireManagedExecution(coordinator,'parent'),node=probe.nodes.get(root)!,before={...node},opened=probe.opens
  const custom=(value:unknown)=>{calls++;expect(probe.opens).toBeGreaterThan(opened);node.id+=1000;return intrinsic(value)}
  Object.defineProperty(globalThis,'structuredClone',mode==='getter'?{configurable:true,get(){getters++;return custom}}:{...descriptor,value:custom})
  try{expect(()=>{execution.observe();effects++}).toThrow();expect(calls).toBe(1);expect(getters).toBe(mode==='getter'?1:0);expect(effects).toBe(0);changed=true}finally{Object.defineProperty(globalThis,'structuredClone',descriptor);Object.assign(node,before)}
 }finally{Object.defineProperty(globalThis,'structuredClone',descriptor);if(changed)await expect(coordinator.close()).rejects.toThrow();else await coordinator.close();await rm(root,{recursive:true,force:true})}
})
