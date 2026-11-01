import { AsyncLocalStorage } from 'node:async_hooks'
import { createProcessAwareResultService } from '../../session-executor/src/lifecycle/process-result-service.ts'
import { createBindingObservations } from '../src/coordinator/binding-observation.ts'
import { associateOriginalResultOrdering } from '../src/result-ordering-internal.ts'
import { associateOriginalResultRevocation } from '../src/coordinator/result-revocation.ts'
import { coldLegacyFixture } from '../../context-output/test/fixtures/cold-selected-legacy.ts'
import { originalResultRevocationFor, captureOriginalRevocationDomain, beginOriginalRevocationOrdering, runOriginalRevocationOrdering, completeOriginalRevocationOrdering } from '../src/coordinator/result-revocation.ts'
import { ContextStore, referenceId, digest } from '../../context-output/src/store.ts'
import { createHash } from 'node:crypto'
import { mkdtemp, rm, readFile, writeFile, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { createContextOutputService, prepareOriginalResultRevocation, registerOriginalLegacyOrdering, type OriginalResultRevocationPreparation } from '../../context-output/src/service.ts'
import { createSessionCoordinatorCore } from '../src/coordinator-factory.ts'
import {beforeEach,describe,expect,it,vi} from 'vitest'
import {win32 as path} from 'node:path'
import type {Win32ArtifactApi} from '../../fs-lock/src/win32-artifact-api.ts'
const input=vi.hoisted(()=>({owners:[] as import('../src/coordinator/ownership.ts').Ownership[],api:undefined as Win32ArtifactApi|undefined,originalLock:true,originals:[] as import('../../fs-lock/src/index.ts').SessionLock[],countHeld:undefined as (()=>void)|undefined,heldHook:undefined as (()=>void)|undefined,heldResult:undefined as (()=>unknown)|undefined,failClose:false,failedPath:'',acquisitionOrder:[] as string[],acquireHook:undefined as undefined|((path:string)=>void),acquireWait:undefined as undefined|((path:string)=>Promise<void>),fileClose:undefined as undefined|((path:string,close:()=>Promise<void>)=>Promise<void>),removeHook:undefined as undefined|((path:string,remove:()=>Promise<void>)=>Promise<void>),bodyOpens:0,admission:undefined as undefined|import('../src/coordinator/result-revocation.ts').ResultRevocationAdmission,revocationScope:undefined as undefined|import('../src/coordinator/result-revocation.ts').OriginalResultRevocationScope,mutexCloses:0,mutexClosePaths:[] as string[],locks:new Map<string,object>()}))
vi.mock('../src/coordinator/ownership.ts',async original=>{
 const module=await original<typeof import('../src/coordinator/ownership.ts')>()
 return{...module,createOwnership(...args:Parameters<typeof module.createOwnership>){const owner=module.createOwnership(...args);input.owners.push(owner);return owner}}
})
// Observe only the genuine constructor-issued scope; do not replace its owner or port.
vi.mock('../src/coordinator/result-revocation.ts',async original=>{
 const module=await original<typeof import('../src/coordinator/result-revocation.ts')>()
 return{...module,issueOriginalResultRevocationScope(...args:Parameters<typeof module.issueOriginalResultRevocationScope>){const scope=module.issueOriginalResultRevocationScope(...args);input.admission=args[0];input.revocationScope=scope;return scope}}
})
vi.mock('node:fs/promises',async original=>{
 const fs=await original<typeof import('node:fs/promises')>()
 return{...fs,async rm(...args:Parameters<typeof fs.rm>){if(input.removeHook)return input.removeHook(String(args[0]),()=>fs.rm(...args));return fs.rm(...args)},async open(...args:Parameters<typeof fs.open>){const name=String(args[0]);if(/(?:[\\/](?:body|index|leaves)|blobs[\\/]|index.sqlite$)/.test(name))input.bodyOpens++;const handle=await fs.open(...args),close=handle.close.bind(handle);handle.close=()=>input.fileClose?input.fileClose(name,close):close();return handle}}
})
vi.mock('@i-harness/fs-lock/internal/artifact-path',async()=>{
 const {createWin32ArtifactPathOwnerWithApi}=await import('../../fs-lock/src/win32-artifact-path.ts')
 return{createArtifactPathOwner:(root:string)=>createWin32ArtifactPathOwnerWithApi(root,input.api!)}
})
vi.mock('@i-harness/fs-lock',async()=>{
 const {createHash}=await import('node:crypto')
 const {heldLock}=await import('../../fs-lock/src/win32.ts')
 return{lockPathFor:(root:string,id:string)=>path.join(root,'.i-harness-locks',createHash('sha256').update(id).digest('hex').slice(0,24)+'.lock'),async acquireSessionLock({lockPath}:{lockPath:string}){
  input.acquisitionOrder.push(lockPath);input.acquireHook?.(lockPath);await input.acquireWait?.(lockPath)
  if(input.locks.has(lockPath))throw Error('native conflict')
  const identity={};input.locks.set(lockPath,identity)
  const original=heldLock({createFileW(){throw Error('No real acquisition in injected held-constructor control')},lockFileEx(){throw Error('No real acquisition in injected held-constructor control')},unlockFileEx:()=>1,closeHandle:()=>{input.mutexCloses++;input.mutexClosePaths.push(lockPath);input.locks.delete(lockPath);if(input.failClose){input.failClose=false;input.failedPath=lockPath;throw undefined};return 1},getLastError:()=>0},1n,lockPath,2n)
  input.originals.push(original);if(input.originalLock)return original
  return{get held(){input.countHeld?.();input.heldHook?.();return input.heldResult?input.heldResult() as boolean:original.held},release:()=>original.release()}
 }}
})
import {createOwnership,reserveOriginalOwnershipBatch} from '../src/coordinator/ownership.ts'
import {heldLock} from '../../fs-lock/src/win32.ts'
import {originalHeldStateFor} from '../../fs-lock/src/held-state-internal.ts'
import {createWin32ArtifactPathOwnerWithApi} from '../../fs-lock/src/win32-artifact-path.ts'
import {associateArtifactPaths,assertArtifactCurrent,createArtifactCurrentGuard,withArtifactCurrentChecks,withImmediateArtifactCurrentChecks} from '../src/coordinator/artifact-path-association.ts'
import type {PersistenceBackend,SessionBindingObservationRequest,SessionBindingObservation} from '../src/coordinator/types.ts'
import {createJsonlBackend} from '../../session-persistence-jsonl/src/backend-factory.ts'
import {LegacyFundingBatchOwner,fundingDescription,fundingPass,type FundingBatchContext} from '../../context-output/src/legacy/funding-batch.ts'
import {createWorkspaceMutationOwner} from '../../context-output/src/workspace-mutation.ts'
import {createLegacyUseGate} from '../../context-output/src/legacy/use-gate.ts'

function fixture(pure:boolean,originalLock=true,taskPath?:(id:string)=>string){
 input.originalLock=originalLock
 const directories=new Map([['C:\\store',{id:1,final:'\\Device\\Volume\\store'}],['C:\\store\\.i-harness-locks',{id:2,final:'\\Device\\Volume\\store\\.i-harness-locks'}]])
 const handles=new Map<bigint,{id:number;final:string}>();let next=1n
 const counts={open:0,info:0,final:0,fold:0,close:0,callbacks:0,held:0}
 const snapshot=()=>({...counts})
 const api:Win32ArtifactApi={
  createFileW(name){counts.open++;const dir=directories.get(name);if(!dir)return -1n;const handle=next++;handles.set(handle,{...dir});return handle},
  getLastError:()=>3,
  getFileInformationByHandleEx(handle,kind,data){counts.info++;const dir=handles.get(handle)!;if(kind===18){data.writeBigUInt64LE(1n,0);data.writeUInt32LE(dir.id,8)}else if(kind===23)data.writeUInt32LE(0);else data.writeUInt32LE(0x10);return 1},
  getFinalPathNameByHandleW(handle,data){counts.final++;const value=handles.get(handle)!.final;data.write(value+'\0','utf16le');return value.length},
  lcMapStringEx(_locale,_flags,value,_count,output){counts.fold++;const folded=value.toUpperCase();if(output)output.write(folded,'utf16le');return folded.length},
  closeHandle(handle){counts.close++;if(!handles.delete(handle))throw Error('wrong original handle');return 1},
 }
 input.api=api
 input.countHeld=()=>{counts.held++}
 let callback:(()=>void)|undefined
 const check=()=>{counts.callbacks++;const descriptor=Object.getOwnPropertyDescriptor(backend,'lockRoot');if(!descriptor||!('value'in descriptor)||descriptor.value!=='C:\\store')throw Error('original backend changed');if(!pure)return callback?.()}
 const backend={lockRoot:'C:\\store'} as PersistenceBackend
 associateArtifactPaths(backend,Object.freeze({root:()=> 'C:\\store',session:(id:string)=>path.join('C:\\store',id+'.jsonl'),document:(id:string)=>path.join('C:\\store',id+'.doc.jsonl'),taskForParent:(id:string)=>taskPath?taskPath(id):path.join('C:\\store','task-'+id+'.doc.jsonl'),async prepareRoot(){},async prepareDocumentParents(){},assertOriginal:pure?createArtifactCurrentGuard(check):check}))
 const owner=createOwnership(backend,{lock:{enabled:true}})
 const delta=(before:ReturnType<typeof snapshot>)=>Object.fromEntries(Object.keys(counts).map(key=>[key,counts[key as keyof typeof counts]-before[key as keyof typeof counts]]))
 return{backend,owner,api,counts,snapshot,delta,directories,handles,onCallback(value:(()=>void)|undefined){if(pure&&value)throw Error('Unknown callback cannot enter pure constructor');callback=value}}
}
beforeEach(()=>{input.owners=[];input.api=undefined;input.originalLock=true;input.originals=[];input.countHeld=undefined;input.heldHook=undefined;input.heldResult=undefined;input.failClose=false;input.failedPath='';input.acquisitionOrder=[];input.acquireHook=undefined;input.acquireWait=undefined;input.fileClose=undefined;input.bodyOpens=0;input.removeHook=undefined;input.admission=undefined;input.revocationScope=undefined;input.mutexCloses=0;input.mutexClosePaths=[];input.locks.clear()})

it.each(['replacement','lost'] as const)('refuses original slot held evidence %s before effects while original cleanup remains callable',async mode=>{
 const f=fixture(true),first=await f.owner.pinOwnership('source'),claim=await f.owner.pinOwnership('source');let substitutes=0,effects=0
 const original=input.originals.at(-1)!
 try{
  if(mode==='replacement')Object.defineProperty(original,'held',{get(){substitutes++;return true}})
  else await original.release()
  expect(()=>{claim.assertHeld();effects++}).toThrow();expect(effects).toBe(0);expect(substitutes).toBe(0)
 }finally{await claim.release();await first.release();await Promise.all(f.owner.releaseHeldLocks())}
})

it('retains consumed falsey original mutex cleanup without fresh lock or no-op acknowledgment',async()=>{
 const f=fixture(true),claim=await f.owner.pinOwnership('source')
 input.failClose=true
 await expect(claim.release()).rejects.toBeUndefined();const failed=input.failedPath,count=()=>input.mutexClosePaths.filter(value=>value===failed).length
 await expect(claim.release()).rejects.toBeUndefined();expect(count()).toBe(1)
 await expect(f.owner.pinOwnership('source')).rejects.toBeUndefined();expect(count()).toBe(1)
 await Promise.allSettled(f.owner.releaseHeldLocks());expect(count()).toBe(1);expect(f.handles.size).toBe(0)
})
it('revalidates after raw held callback mutation before the guarded consumer effect',async()=>{
 const f=fixture(true,false),first=await f.owner.pinOwnership('source'),claim=await f.owner.pinOwnership('source');let effects=0
 try{input.heldHook=()=>{f.directories.get('C:\\store')!.id=9};expect(()=>{claim.assertHeld();effects++}).toThrow(/changed|unavailable/i);expect(effects).toBe(0)}
 finally{input.heldHook=undefined;await claim.release();await first.release();await Promise.all(f.owner.releaseHeldLocks())}
})
it('refuses a nonboolean unknown held result before any guarded effect',async()=>{
 const f=fixture(true,false),first=await f.owner.pinOwnership('source'),claim=await f.owner.pinOwnership('source');let effects=0
 try{input.heldResult=()=>Promise.resolve(true);expect(()=>{claim.assertHeld();effects++}).toThrow(/held state unavailable/);expect(effects).toBe(0)}
 finally{input.heldResult=undefined;await claim.release();await first.release();await Promise.all(f.owner.releaseHeldLocks())}
})

it('keeps fresh session and document native traversal counts unchanged',async()=>{
 const f=fixture(true),session=await f.owner.pinOwnership('source'),document=await f.owner.pinDocumentOwnership('other')
 try{let before=f.snapshot();session.assertHeld();expect(f.delta(before).open).toBe(12);before=f.snapshot();document.assertHeld();expect(f.delta(before).open).toBe(6)}
 finally{await document.release();await session.release();await Promise.all(f.owner.releaseHeldLocks())}
})
it('uses the genuine JSONL descriptor-only constructor guard and refuses its method mutation',async()=>{
 const f=fixture(true),backend=createJsonlBackend('C:\\store'),owner=createOwnership(backend,{lock:{enabled:true}})
 const first=await owner.pinOwnership('source'),claim=await owner.pinOwnership('source');let effects=0
 const original=backend.getDocument
 try{
  const before=f.snapshot();claim.assertHeld();expect(f.delta(before).open).toBe(8)
  backend.getDocument=async()=>undefined
  expect(()=>{claim.assertHeld();effects++}).toThrow('PROCESS_READ_UNAVAILABLE');expect(effects).toBe(0)
 }finally{backend.getDocument=original;await claim.release();await first.release();await Promise.all(owner.releaseHeldLocks())}
})
it('does not lend a pending frame to a reentrant unknown owner callback',async()=>{
 const f=fixture(false),first=await f.owner.pinOwnership('source'),claim=await f.owner.pinOwnership('source');let calls=0,effects=0
 try{
  f.onCallback(()=>{if(++calls===2){f.onCallback(undefined);f.directories.get('C:\\store')!.id=7;claim.assertHeld();effects++}})
  expect(()=>withArtifactCurrentChecks(()=>claim.assertHeld())).toThrow(/changed|unavailable/i);expect(effects).toBe(0)
 }finally{f.onCallback(undefined);await claim.release();await first.release();await Promise.all(f.owner.releaseHeldLocks())}
})
it.each([false,true])('counts every original funding allocation guard and rejects mutation across awaits=%s',async mutate=>{
 const f=fixture(true),first=await f.owner.pinOwnership('source'),claim=await f.owner.pinOwnership('source')
 let bytes=0,effects=0,inventories=0,guards=0
 const root='C:\\store',descriptions=[fundingDescription(path.join(root,'fork','revoke'),'slots',['root'],[{key:'0',peakGrowth:1}]),fundingDescription(path.join(root,'fork','applied.json'),'application',['application'],[{key:'0',peakGrowth:1}])]
 const gate=createLegacyUseGate(),workspace=createWorkspaceMutationOwner({root:process.env.IH_LEGACY_FORK_EVIDENCE_ROOT!,workspaceId:'count-context'})
 const summary=()=>{const pass=fundingPass();for(const d of descriptions)pass.add(d);return pass.finish()}
 const before=f.snapshot()
 try{
  const running=gate.exclusive(undefined,lease=>workspace.mutate(async turn=>{
   const use=Object.freeze({assertCurrent(){turn.assertCurrent();lease.assertExclusive()},get(){throw Error('No derived read in allocator control')},all(){throw Error('No derived read in allocator control')}})
   const context:FundingBatchContext=Object.freeze({turn,lease,use,quota:64,guard(){guards++;claim.assertHeld()}})
   const retirement=(value:FundingBatchContext)=>{if(value!==context)throw Error('foreign context');workspace.assertTurn(value.turn);gate.assertLease(value.lease,'exclusive');value.use.assertCurrent()}
   const batch=new LegacyFundingBatchOwner(root,value=>{retirement(value);value.guard()},retirement,async()=>{inventories++;return bytes},async()=>{})
   await batch.run(context,async()=>{context.guard();await Promise.resolve();context.guard();return summary()},async scope=>{
   for(const [index,d]of descriptions.entries()){
    const allocation=batch.enter(scope,d);batch.assertAllocation(allocation,d.key);await Promise.resolve()
    if(mutate&&index===1)f.directories.get(root)!.id=9
    batch.issued(allocation,'0',1);bytes++;effects++;batch.finish(allocation)
   }
   return summary()
   })
  }))
  if(mutate){await expect(running).rejects.toThrow(/changed|unavailable/i);expect(effects).toBe(1)}
  else{await running;expect(effects).toBe(2);expect(inventories).toBe(2);const count=f.delta(before);expect(count.open).toBe(guards*8);expect(count.callbacks).toBe(guards*4);console.info('ORIGINAL_FUNDING_GUARD_COUNTS',JSON.stringify({guards,inventories,effects,native:count}))}
  expect(f.handles.size).toBe(0)
 }finally{await workspace.close();await claim.release();await first.release();await Promise.all(f.owner.releaseHeldLocks())}
})

it('recognizes original false distinctly and refuses copied proxy or replaced getter evidence',()=>{
 let closes=0,substitutes=0
 const lock=heldLock({createFileW(){throw Error('No real acquisition in injected held-constructor control')},lockFileEx(){throw Error('No real acquisition in injected held-constructor control')},unlockFileEx:()=>0,closeHandle:()=>{closes++;return 1},getLastError:()=>5},1n,'original',2n)
 const state=originalHeldStateFor(lock)!
 expect(state.read()).toBe(true);expect(originalHeldStateFor({...lock})).toBeUndefined();expect(originalHeldStateFor(new Proxy(lock,{}))).toBeUndefined()
 expect(()=>lock.release()).toThrow(/UnlockFileEx/);expect(originalHeldStateFor(lock)!.read()).toBe(false);lock.release();expect(closes).toBe(1)
 Object.defineProperty(lock,'held',{get(){substitutes++;return true}})
 expect(()=>originalHeldStateFor(lock)).toThrow(/Changed original/);expect(()=>state.read()).toThrow(/Changed original/);expect(substitutes).toBe(0)
})
it('uses fresh native proofs per frame and await and never coalesces equal-path distinct captures',async()=>{
 const f=fixture(true),nativeOwner=createWin32ArtifactPathOwnerWithApi('C:\\store',f.api)
 const a=nativeOwner.capture('C:\\store\\same.jsonl'),b=nativeOwner.capture('C:\\store\\same.jsonl')
 let before=f.snapshot();withArtifactCurrentChecks(()=>{assertArtifactCurrent(a);assertArtifactCurrent(a)})
 expect(f.counts.open-before.open).toBe(2)
 before=f.snapshot();withArtifactCurrentChecks(()=>{assertArtifactCurrent(a);assertArtifactCurrent(b)});expect(f.counts.open-before.open).toBe(4)
 before=f.snapshot();withArtifactCurrentChecks(()=>assertArtifactCurrent(a));await Promise.resolve();withArtifactCurrentChecks(()=>assertArtifactCurrent(a));expect(f.counts.open-before.open).toBe(4)
 expect(f.handles.size).toBe(0)
})
it('preserves falsey unknown callback failure and rejects an async owner assertion before effects',async()=>{
 const f=fixture(false),first=await f.owner.pinOwnership('source'),reused=await f.owner.pinOwnership('source')
 let caught=false,value:unknown,effects=0
 try{
  f.onCallback(()=>{throw undefined})
  try{reused.assertHeld();effects++}catch(error){caught=true;value=error}
  expect(caught).toBe(true);expect(value).toBeUndefined();expect(effects).toBe(0)
  f.onCallback(async()=>{})
  expect(()=>{reused.assertHeld();effects++}).toThrow(/synchronous/);expect(effects).toBe(0)
 }finally{f.onCallback(undefined);await reused.release();await first.release();await Promise.all(f.owner.releaseHeldLocks())}
})

it('flushes pending native proof before a raw untrusted held getter can perform an effect',async()=>{
 const f=fixture(true,false),first=await f.owner.pinOwnership('source'),reused=await f.owner.pinOwnership('source')
 let effects=0
 try{
  f.directories.get('C:\\store')!.id=8
  input.heldHook=()=>{effects++}
  expect(()=>withArtifactCurrentChecks(()=>reused.assertHeld())).toThrow(/changed|unavailable/i)
  expect(effects).toBe(0)
 }finally{input.heldHook=undefined;await reused.release();await first.release();await Promise.all(f.owner.releaseHeldLocks())}
})
it('flushes before the next unknown original-owner callback instead of skipping its invocation',async()=>{
 const f=fixture(false),first=await f.owner.pinOwnership('source'),reused=await f.owner.pinOwnership('source')
 let callbacks=0,effects=0
 try{
  f.onCallback(()=>{if(++callbacks===1)f.directories.get('C:\\store')!.id=8;else effects++})
  expect(()=>withArtifactCurrentChecks(()=>reused.assertHeld())).toThrow(/changed|unavailable/i)
  expect(effects).toBe(0)
 }finally{f.onCallback(undefined);await reused.release();await first.release();await Promise.all(f.owner.releaseHeldLocks())}
})

it('counts original native leaf traversals for exact reused claims outside and inside existing pure frames',async()=>{
 const f=fixture(true),first=await f.owner.pinOwnership('source'),reused=await f.owner.pinOwnership('source')
 try{
  let before=f.snapshot();reused.assertHeld();const outside=f.delta(before)
  before=f.snapshot();withArtifactCurrentChecks(()=>reused.assertHeld());const framed=f.delta(before)
  console.info('OWNERSHIP_NATIVE_COUNTS',JSON.stringify({outside,framed}))
  expect(outside).toEqual(framed);expect(outside.open).toBe(8);expect(outside.callbacks).toBe(4)
  expect(f.handles.size).toBe(0);first.assertHeld();reused.assertHeld()
 }finally{await reused.release();await first.release();await Promise.all(f.owner.releaseHeldLocks())}
})

it('does not eliminate original callback invocations or retain proof across an explicit unknown callback boundary',async()=>{
 const f=fixture(false),first=await f.owner.pinOwnership('source'),reused=await f.owner.pinOwnership('source')
 try{
  let called=0
  f.onCallback(()=>{called++})
  reused.assertHeld();expect(called).toBe(4)
  expect(()=>withArtifactCurrentChecks(()=>{reused.assertHeld();withImmediateArtifactCurrentChecks(()=>{f.directories.get('C:\\store')!.id=9});reused.assertHeld()})).toThrow(/changed|unavailable/i)
  expect(f.handles.size).toBe(0)
 }finally{f.onCallback(undefined);await reused.release();await first.release();await Promise.all(f.owner.releaseHeldLocks())}
})

it('rejects invalidation inside an unknown callback before the guarded consumer effect',async()=>{
 const f=fixture(false),first=await f.owner.pinOwnership('source'),reused=await f.owner.pinOwnership('source')
 try{
  let callbacks=0,effects=0
  f.onCallback(()=>{if(++callbacks===2)f.directories.get('C:\\store')!.id=7})
  expect(()=>{reused.assertHeld();effects++}).toThrow(/changed|unavailable/i)
  expect(effects).toBe(0)
 }finally{f.onCallback(undefined);await reused.release();await first.release();await Promise.all(f.owner.releaseHeldLocks())}
})


async function originalPreparationFixture(){
 const f=fixture(true),coordinator=createSessionCoordinatorCore(f.backend,{lock:{enabled:true}}),root=await mkdtemp(join(process.env.IH_RESULT_INTEGRITY_EVIDENCE_ROOT!,'passive-'))
 const service=createContextOutputService({root,workspaceId:'w'});registerOriginalLegacyOrdering(service,coordinator)
 return{...f,nativeOwner:input.owners.at(-1)!,coordinator,root,service,async close(){input.fileClose=undefined;await service.close();await coordinator.close();await rm(root,{recursive:true,force:true})}}
}
async function legacyMetadata(root:string,sessionId:string,callId:string,expiresAt:number,owners:readonly string[]){
 const id=referenceId('w',sessionId,callId,'r'),directory=join(root,'context-output',digest('w'))
 await mkdir(join(directory,'artifacts'),{recursive:true});await mkdir(join(directory,'owners'),{recursive:true})
 const metadata=JSON.stringify({ref:{id,workspaceId:'w',sessionId,callId,label:'metadata only',revision:'r',bytes:1,originalBytes:1,complete:true,expiresAt}})
 await writeFile(join(directory,'artifacts',id+'.json'),metadata);await writeFile(join(directory,'owners',id+'.json'),JSON.stringify(owners))
 return{path:join(directory,'artifacts',id+'.json'),metadata}
}
describe('original revocation batch',()=>{
it('acquires complete original session and Task resource sets in canonical batch order',async()=>{
 const f=fixture(true),ids=['z','a'];let cleanup:import('../src/coordinator/ownership.ts').OwnershipCleanup|undefined
 const batch=await reserveOriginalOwnershipBatch(f.owner,ids,value=>{cleanup=value})
 try{const keys=ids.flatMap(id=>[f.owner.artifacts!.session(id),f.owner.artifacts!.taskForParent(id)]).map(capture=>{if(capture.kind!=='ready')throw Error('Expected original ready capture');return 'artifact-ownership:'+capture.key}).sort();expect(input.acquisitionOrder).toEqual(keys.map(key=>path.join('C:\\store','.i-harness-locks',createHash('sha256').update(key).digest('hex').slice(0,24)+'.lock')));batch.assertCovered(['a','z']);expect(()=>batch.assertCovered(['foreign'])).toThrow();expect(input.locks.size).toBe(4);expect(()=>batch.assertCovered.call({...batch},ids)).toThrow()}
 finally{await batch.close();cleanup!.assertSettled()}
 expect(input.locks.size).toBe(0)
})
it('reuses the exact healthy original captures and slots in batch without reprepare or reacquire',async()=>{
 const f=fixture(true),first=await f.owner.pinOwnership('source'),before=input.originals.length
 const batch=await reserveOriginalOwnershipBatch(f.owner,['source'],()=>{})
 try{batch.assertCovered(['source']);first.assertHeld();expect(input.originals.length).toBe(before)}finally{await batch.close();first.assertHeld();await first.release()}
})


it('connects actual original coordinator and service passive managed inventory to covered batch',async()=>{
 const f=fixture(true),coordinator=createSessionCoordinatorCore(f.backend,{lock:{enabled:true}})
 const root=await mkdtemp(join(process.env.IH_RESULT_INTEGRITY_EVIDENCE_ROOT!,'inventory-'))
 const service=createContextOutputService({root,workspaceId:'w'});registerOriginalLegacyOrdering(service,coordinator)
 let cleanup:OriginalResultRevocationPreparation|undefined
 try{
  const scope=service.registerResultScope({operationId:'o',sessionId:'real-session',documentId:'different-document',callId:'c'},()=>true)
  const sink=await service.beginResult(scope,'text-utf8-v1');await sink.write(Buffer.from('kept bytes'));const result=await sink.finish('complete');expect(result.kind).toBe('committed')
  const prepared=await prepareOriginalResultRevocation(service,coordinator,{kind:'session',sessionIds:['requested'],documents:['different-document']},value=>{cleanup=value})
  prepared.assertCovered(['requested','real-session']);expect(prepared.frontier).toBeGreaterThan(0)
  expect(()=>prepared.assertCovered(['different-document'])).toThrow();expect(()=>prepared.assertCovered.call({...prepared},['requested'])).toThrow()
  await prepared.close();expect(()=>prepared.assertCovered(['requested'])).toThrow()
 }finally{await cleanup?.close();await service.close();await coordinator.close();await rm(root,{recursive:true,force:true})}
})
it('refuses an unregistered actual service before inventory or native acquisition',async()=>{
 const f=fixture(true),coordinator=createSessionCoordinatorCore(f.backend,{lock:{enabled:true}}),root=await mkdtemp(join(process.env.IH_RESULT_INTEGRITY_EVIDENCE_ROOT!,'unregistered-'))
 const service=createContextOutputService({root,workspaceId:'w'});let cleanup:OriginalResultRevocationPreparation|undefined
 const before=input.originals.length
 try{await expect(prepareOriginalResultRevocation(service,coordinator,{kind:'session',sessionIds:['s'],documents:[]},value=>{cleanup=value})).rejects.toThrow(/registration/);expect(input.originals.length).toBe(before)}
 finally{await cleanup?.close();await service.close();await coordinator.close();await rm(root,{recursive:true,force:true})}
})

it('refuses overlapping original session and Task captures before native batch acquisition',async()=>{
 const f=fixture(true,true,()=>path.join('C:\\store','a.jsonl'));let cleanup:import('../src/coordinator/ownership.ts').OwnershipCleanup|undefined
 await expect(reserveOriginalOwnershipBatch(f.owner,['a','b'],value=>{cleanup=value})).rejects.toThrow(/Overlapping/)
 expect(input.originals.length).toBe(0);await cleanup!.close();cleanup!.assertSettled()
})
it('retains exact partial original batch acquisitions after a falsey pre-return failure',async()=>{
 const f=fixture(true);let cleanup:import('../src/coordinator/ownership.ts').OwnershipCleanup|undefined,calls=0
 input.acquireHook=()=>{if(++calls===2)throw undefined}
 await expect(reserveOriginalOwnershipBatch(f.owner,['a','b'],value=>{cleanup=value})).rejects.toBeUndefined()
 const acquired=input.originals.length;input.acquireHook=undefined;await cleanup!.close();cleanup!.assertSettled();expect(input.originals.length).toBe(acquired);expect(input.locks.size).toBe(0)
})
it('keeps consumed falsey native cleanup debt on the same original batch',async()=>{
 const f=fixture(true);let cleanup:import('../src/coordinator/ownership.ts').OwnershipCleanup|undefined
 const batch=await reserveOriginalOwnershipBatch(f.owner,['a','b'],value=>{cleanup=value});input.failClose=true
 await expect(batch.close()).rejects.toBeUndefined();const failed=input.failedPath,count=()=>input.mutexClosePaths.filter(path=>path===failed).length
 await expect(cleanup!.close()).rejects.toBeUndefined();expect(count()).toBe(1);expect(()=>cleanup!.assertSettled()).toThrow()
})
it('refuses lower fresh resources without dropping a genuine healthy original bundle',async()=>{
 const f=fixture(true),claim=await f.owner.pinOwnership('z'),before=input.originals.length;let cleanup:import('../src/coordinator/ownership.ts').OwnershipCleanup|undefined
 try{await expect(reserveOriginalOwnershipBatch(f.owner,['a','z'],value=>{cleanup=value})).rejects.toThrow(/reordered/);expect(input.originals.length).toBe(before);claim.assertHeld();await cleanup!.close();claim.assertHeld()}finally{await claim.release()}
})

it('includes actual global expiry owners in session coverage and fixes the pass-two frontier',async()=>{
 const f=await originalPreparationFixture(),now=vi.spyOn(Date,'now').mockReturnValue(3000);let cleanup:OriginalResultRevocationPreparation|undefined
 try{
  const expired=await legacyMetadata(f.root,'original','expired',2000,['global-owner']),later=await legacyMetadata(f.root,'original','later',4000,['later-owner']);input.bodyOpens=0
  const prepared=await prepareOriginalResultRevocation(f.service,f.coordinator,{kind:'session',sessionIds:['requested'],documents:[]},value=>{cleanup=value})
  prepared.assertCovered(['global-owner','requested']);expect(prepared.frontier).toBe(3000);now.mockReturnValue(5000)
  expect(()=>prepared.assertCovered(['later-owner'])).toThrow();expect(prepared.frontier).toBe(3000);expect(input.bodyOpens).toBe(0)
  expect(await readFile(expired.path,'utf8')).toBe(expired.metadata);expect(await readFile(later.path,'utf8')).toBe(later.metadata)
 }finally{now.mockRestore();await cleanup?.close();await f.close()}
})
it('retries changed pre-effect expiry inventory with original cleanup before broader claims',async()=>{
 const f=await originalPreparationFixture(),now=vi.spyOn(Date,'now').mockReturnValue(1000);let cleanup:OriginalResultRevocationPreparation|undefined,changed=false
 try{
  await legacyMetadata(f.root,'original','expiry-drift',2000,['global-owner'])
  input.acquireHook=path=>{if(!changed&&path.startsWith('C:\\store')){changed=true;now.mockReturnValue(3000)}}
  const prepared=await prepareOriginalResultRevocation(f.service,f.coordinator,{kind:'session',sessionIds:['requested'],documents:[]},value=>{cleanup=value})
  expect(changed).toBe(true);prepared.assertCovered(['global-owner','requested']);expect(prepared.frontier).toBe(3000)
  expect(input.mutexClosePaths.some(path=>path.startsWith('C:\\store'))).toBe(true)
 }finally{input.acquireHook=undefined;now.mockRestore();await cleanup?.close();await f.close()}
})
it('original coordinator close joins discovery resources before batch retirement',async()=>{
 const f=await originalPreparationFixture();let cleanup:OriginalResultRevocationPreparation|undefined
 try{
  const prepared=await prepareOriginalResultRevocation(f.service,f.coordinator,{kind:'session',sessionIds:['s'],documents:[]},value=>{cleanup=value});prepared.assertCovered(['s'])
  await f.coordinator.close();expect(()=>prepared.assertCovered(['s'])).toThrow();expect(input.locks.size).toBe(0)
 }finally{await cleanup?.close();await f.close()}
})
it('retains consumed falsey discovery cleanup before any target native acquisition',async()=>{
 const f=await originalPreparationFixture();let cleanup:OriginalResultRevocationPreparation|undefined,closes=0
 const scope=f.service.registerResultScope({operationId:'o',sessionId:'s',callId:'c'},()=>true),sink=await f.service.beginResult(scope,'text-utf8-v1');await sink.write(Buffer.from('unchanged'));await sink.finish('complete')
 input.fileClose=async(path,close)=>{await close();if(path.endsWith('operation.json')){closes++;throw undefined}}
 await expect(prepareOriginalResultRevocation(f.service,f.coordinator,{kind:'session',sessionIds:['s'],documents:['s']},value=>{cleanup=value})).rejects.toBeUndefined()
 expect(input.acquisitionOrder.filter(path=>path.startsWith('C:\\store'))).toHaveLength(0)
 input.fileClose=undefined;await expect(cleanup!.close()).rejects.toBeUndefined();expect(closes).toBe(1)
 await expect(f.service.close()).rejects.toThrow();await expect(f.coordinator.close()).rejects.toThrow();expect(closes).toBe(1)
 // The injected native lifetime remains uncertain; consumed real metadata file is closed.
 await rm(f.root,{recursive:true,force:true})
})

it('covers two actual service participants and preserves held batch currency after aggregate extension',async()=>{
 const f=await originalPreparationFixture(),second=createContextOutputService({root:f.root,workspaceId:'w'}),third=createContextOutputService({root:f.root,workspaceId:'w'});let cleanup:OriginalResultRevocationPreparation|undefined
 try{
  registerOriginalLegacyOrdering(second,f.coordinator)
  const prepared=await prepareOriginalResultRevocation(f.service,f.coordinator,{kind:'session',sessionIds:['s'],documents:[]},value=>{cleanup=value}),before=input.originals.length
  registerOriginalLegacyOrdering(third,f.coordinator);prepared.assertCovered(['s']);expect(input.originals.length).toBe(before)
 }finally{await cleanup?.close();await second.close();await third.close();await f.close()}
})
it('refuses actual original legacy job self-entry before discovery or target acquisition',async()=>{
 const f=await originalPreparationFixture(),stop=Error('Stop original producer after refusal')
 try{
  await f.service.configure({enabled:true})
  await expect(f.service.capture({sessionId:'s',callId:'c',label:'self',text:'unused',complete:true},undefined,async()=>{
   const before=input.originals.length
   await expect(prepareOriginalResultRevocation(f.service,f.coordinator,{kind:'session',sessionIds:['s'],documents:[]},()=>{throw Error('No retained attempt on self-entry')})).rejects.toThrow(/reentry/)
   expect(input.originals.length).toBe(before);throw stop
  })).rejects.toBe(stop)
 }finally{await f.close()}
})
it('discovers real managed companion and catalog metadata without opening either body or index',async()=>{
 const f=await originalPreparationFixture();let cleanup:OriginalResultRevocationPreparation|undefined
 try{
  const member=f.service.registerResultScope({operationId:'member',sessionId:'s',callId:'member'},()=>true),sink=await f.service.beginResult(member,'exec-frames-v1')
  await sink.write(Buffer.from('IHEXEC01\n{"channel":"stdout","frame":0,"offset":0,"end":true,"data":"eA=="}\n'));const result=await sink.finish('complete');if(result.kind!=='committed')throw Error('Original member refused')
  const entries:import('../../core-session/src/index.ts').ResultDependency[]=[{kind:'exec-frames',sourceId:'native',retention:{kind:'artifact',ref:result.ref}}]
  const scope=f.service.registerResultDependencyScope({operationId:'catalog',sessionId:'s',callId:'catalog'},()=>true,entries),catalog=await f.service.beginResult(scope,'json-utf8-v1')
  await catalog.write(Buffer.from(JSON.stringify({version:1,kind:'result-dependencies',entries})));const published=await catalog.finish('complete');if(published.kind!=='committed')throw Error('Original catalog refused')
  expect(await f.service.settleResultDependencyMembership(scope,published.ref)).toBe('ready');input.bodyOpens=0
  const prepared=await prepareOriginalResultRevocation(f.service,f.coordinator,{kind:'session',sessionIds:['s'],documents:['s']},value=>{cleanup=value});prepared.assertCovered(['s']);expect(input.bodyOpens).toBe(0)
 }finally{await cleanup?.close();await f.close()}
})

it('rejects copied scopes coordinators and caller target getters without invoking them',async()=>{
 const f=await originalPreparationFixture();let cleanup:OriginalResultRevocationPreparation|undefined,calls=0
 try{
  expect(()=>originalResultRevocationFor({...f.coordinator})).toThrow()
  const admission=originalResultRevocationFor(f.coordinator)
  expect(()=>admission.begin({} as import('../src/coordinator/result-revocation.ts').OriginalResultRevocationScope)).toThrow()
  const prepared=await prepareOriginalResultRevocation(f.service,f.coordinator,{kind:'session',sessionIds:['s'],documents:[]},value=>{cleanup=value})
  const ids=['s'];Object.defineProperty(ids,'0',{get(){calls++;return 's'}})
  expect(()=>prepared.assertCovered(ids)).toThrow(/target data/);expect(calls).toBe(0)
 }finally{await cleanup?.close();await f.close()}
})
it('refuses changed original coordinator descriptors after native await while retaining exact cleanup',async()=>{
 const f=await originalPreparationFixture(),method=f.coordinator.withSessionBindingObservation;let cleanup:OriginalResultRevocationPreparation|undefined,calls=0,changed=false
 try{
  input.acquireHook=path=>{if(!changed&&path.startsWith('C:\\store')){changed=true;f.coordinator.withSessionBindingObservation=<T>(request:SessionBindingObservationRequest,run:(observation:SessionBindingObservation)=>Promise<T>)=>{calls++;return method!<T>(request,run)}}}
  await expect(prepareOriginalResultRevocation(f.service,f.coordinator,{kind:'session',sessionIds:['s'],documents:[]},value=>{cleanup=value})).rejects.toThrow(/Changed original/)
  expect(changed).toBe(true);expect(calls).toBe(0);expect([...input.locks.keys()].some(path=>path.startsWith('C:\\store'))).toBe(true)
  input.acquireHook=undefined;await cleanup!.close();expect(calls).toBe(0)
 }finally{input.acquireHook=undefined;f.coordinator.withSessionBindingObservation=method;await cleanup?.close();await f.close()}
})

it('refuses aggregate registration during original batch await and joins concurrent close',async()=>{
 const f=await originalPreparationFixture(),second=createContextOutputService({root:f.root,workspaceId:'w'}),entered=Promise.withResolvers<void>(),release=Promise.withResolvers<void>();let cleanup:OriginalResultRevocationPreparation|undefined
 try{
  input.acquireWait=async path=>{if(path.startsWith('C:\\store')){input.acquireWait=undefined;entered.resolve();await release.promise}}
  const preparing=prepareOriginalResultRevocation(f.service,f.coordinator,{kind:'session',sessionIds:['s'],documents:[]},value=>{cleanup=value}),outcome=preparing.then(()=>false,()=>true)
  await entered.promise;expect(()=>registerOriginalLegacyOrdering(second,f.coordinator)).toThrow(/busy/)
  const closing=f.coordinator.close();release.resolve();await closing;expect(await outcome).toBe(true);expect(input.locks.size).toBe(0)
 }finally{release.resolve();input.acquireWait=undefined;await cleanup?.close();await second.close();await f.close()}
})
it('validates actual V2 legacy authority and expired global owners without body verification or store open',async()=>{
 const f=fixture(true),coordinator=createSessionCoordinatorCore(f.backend,{lock:{enabled:true}}),legacy=await coldLegacyFixture();let cleanup:OriginalResultRevocationPreparation|undefined
 registerOriginalLegacyOrdering(legacy.service,coordinator)
 const now=vi.spyOn(Date,'now').mockReturnValue(legacy.ref.expiresAt+1),open=vi.spyOn(ContextStore.prototype,'open'),body=vi.spyOn(ContextStore.prototype,'verifyBody')
 try{
  const before=await readFile(join(legacy.directory,'revoke.1'))
  const prepared=await prepareOriginalResultRevocation(legacy.service,coordinator,{kind:'session',sessionIds:['unrelated'],documents:[]},value=>{cleanup=value})
  prepared.assertCovered(['source','target','unrelated']);expect(open).not.toHaveBeenCalled();expect(body).not.toHaveBeenCalled();expect(await readFile(join(legacy.directory,'revoke.1'))).toEqual(before)
 }finally{now.mockRestore();open.mockRestore();body.mockRestore();await cleanup?.close();await coordinator.close();await legacy.close();await rm(legacy.root,{recursive:true,force:true})}
})

it.each(['manifest','pending'] as const)('refuses standalone original managed authority %s drift before target native acquisition',async mode=>{
 const f=await originalPreparationFixture();let cleanup:OriginalResultRevocationPreparation|undefined
 try{
  const scope=f.service.registerResultScope({operationId:'o',sessionId:'s',callId:'c'},()=>true),sink=await f.service.beginResult(scope,'text-utf8-v1');await sink.write(Buffer.from('untouched'));const result=await sink.finish('complete');if(result.kind!=='committed')throw Error('Original artifact unavailable')
  const directory=join(f.root,'context-output',digest('w'),'managed-v1',result.ref.id)
  if(mode==='manifest'){const path=join(directory,'manifest.json'),value=JSON.parse(await readFile(path,'utf8'));value.contentDigest='0'.repeat(64);await writeFile(path,JSON.stringify(value))}
  else await writeFile(join(directory,'operation.json.'+'0'.repeat(64)+'.pending'),'{}')
  const before=input.acquisitionOrder.filter(path=>path.startsWith('C:\\store')).length
  let rejected=false
  try{await prepareOriginalResultRevocation(f.service,f.coordinator,{kind:'session',sessionIds:['s'],documents:['s']},value=>{cleanup=value})}catch{rejected=true}
  expect(rejected).toBe(true)
  expect(input.acquisitionOrder.filter(path=>path.startsWith('C:\\store'))).toHaveLength(before)
 }finally{await cleanup?.close();await f.close()}
})

it.each(['getter','copy','proxy'] as const)('authenticates original revocation ticket before any supplied %s method effect',async kind=>{
 const f=await originalPreparationFixture();let cleanup:OriginalResultRevocationPreparation|undefined
 try{
  await prepareOriginalResultRevocation(f.service,f.coordinator,{kind:'session',sessionIds:['s'],documents:[]},value=>{cleanup=value})
  const admission=input.admission!,genuine=admission.begin(input.revocationScope!);await genuine.join();await admission.acquireTargets(genuine,['s']);admission.assertCovered(genuine,['s'])
  let effects=0
  const supplied=kind==='getter'?Object.defineProperty({},'assertCurrent',{get(){effects++;throw undefined}}):kind==='copy'?{...genuine,assertCurrent(){effects++;throw undefined}}:new Proxy(genuine,{get(){effects++;throw undefined}})
  const before=input.originals.length;let acquireRefused=false,coverageRefused=false
  try{await admission.acquireTargets(supplied as typeof genuine,['foreign'])}catch(error){acquireRefused=error instanceof Error}
  try{admission.assertCovered(supplied as typeof genuine,['foreign'])}catch(error){coverageRefused=error instanceof Error}
  expect({acquireRefused,coverageRefused,effects,acquisitions:input.originals.length-before}).toEqual({acquireRefused:true,coverageRefused:true,effects:0,acquisitions:0})
  admission.assertCovered(genuine,['s']);await f.coordinator.close();expect(()=>admission.assertCovered(genuine,['s'])).toThrow();expect(input.locks.size).toBe(0)
 }finally{await cleanup?.close();await f.close()}
})

})


describe('original covered public clear',()=>{
 it('refuses distinct original Ownership topology before public clear inventory or native waits',async()=>{
  const f=await originalPreparationFixture(),other=createSessionCoordinatorCore(f.backend,{lock:{enabled:true}})
  try{
   registerOriginalLegacyOrdering(f.service,other)
   const before=input.originals.length;let refused=false
   try{await f.service.clear('s')}catch(error){refused=error instanceof Error&&/topology|domain/i.test(error.message)}
   expect({refused,acquisitions:input.originals.length-before}).toEqual({refused:true,acquisitions:0})
  }finally{await other.close();await f.close()}
 })
 it('authenticates exact native domain before sharing and refuses alias owners by original identity',async()=>{
  const f=await originalPreparationFixture(),other=createSessionCoordinatorCore(f.backend,{lock:{enabled:true}})
  try{
   const first=originalResultRevocationFor(f.coordinator),second=originalResultRevocationFor(other),before=input.originals.length
   expect(()=>captureOriginalRevocationDomain([first,second])).toThrow(/distinct original/i)
   expect(()=>captureOriginalRevocationDomain([{...first}])).toThrow(/Original/i)
   expect(input.originals.length).toBe(before)
  }finally{await other.close();await f.close()}
 })
 it.each(['distinct-local','same-local'] as const)('joins every constructor-associated local admission with %s sharing in the same original owner',async mode=>{
  const f=fixture(true),root=await mkdtemp(join(process.env.IH_RESULT_INTEGRITY_EVIDENCE_ROOT!,'shared-owner-')),service=createContextOutputService({root,workspaceId:'w'})
  const make=(observations=createBindingObservations(f.backend,f.owner),admission=observations.createResultRevocationAdmission(f.owner))=>{
   const unavailable=():never=>{throw Error('Unsupported operation on this constructor-associated admission facade')},unavailableAsync=async()=>unavailable()
   const coordinator:import('../src/coordinator/types.ts').SessionCoordinator={
    create:unavailableAsync,withSessionBindingObservation:observations.withSessionBindingObservation,async close(){await observations.closeAdmission()()},
    bootstrapSemanticTarget:unavailableAsync,resumeSemanticTarget:unavailableAsync,inspectBootstrap:unavailableAsync,openManagedDocument:unavailableAsync,revokeManagedDocumentNewWork:unavailable,closeManagedDocument:unavailableAsync,
    append:unavailableAsync,enqueue:unavailable,load:unavailableAsync,loadOwned:unavailableAsync,list:unavailableAsync,profile:unavailableAsync,updateMeta:unavailableAsync,flush:unavailableAsync,putDocument:unavailableAsync,getDocument:unavailableAsync,ownerOf:f.owner.ownerOf,adoptOwnership:unavailableAsync,releaseOwnership:unavailableAsync,
   }
   associateOriginalResultOrdering(coordinator,f.owner);associateOriginalResultRevocation(coordinator,admission,f.owner);registerOriginalLegacyOrdering(service,coordinator)
   return{observations,coordinator,admission}
  }
  const a=make(),b=mode==='same-local'?make(a.observations,a.admission):make(),first=Promise.withResolvers<void>(),second=Promise.withResolvers<void>(),leaveFirst=Promise.withResolvers<void>(),leaveSecond=Promise.withResolvers<void>();let cleanup:OriginalResultRevocationPreparation|undefined
  const hold=(record:ReturnType<typeof make>,entered:PromiseWithResolvers<void>,release:PromiseWithResolvers<void>)=>{let closed=false;const registration=record.observations.registerOwnedDocumentOperation('s','held-document',{revoke(){},assertOutside(){},async close(){if(closed)return;entered.resolve();await release.promise;closed=true;registration.unregister()},async retryClose(){await this.close()}});return registration}
  hold(a,first,leaveFirst);if(mode==='distinct-local')hold(b,second,leaveSecond)
  try{
   const preparing=service.clear('s')
   await first.promise;expect(input.acquisitionOrder.filter(path=>path.startsWith('C:\\store'))).toHaveLength(0);leaveFirst.resolve()
   if(mode==='distinct-local'){await second.promise;expect(input.acquisitionOrder.filter(path=>path.startsWith('C:\\store'))).toHaveLength(0);leaveSecond.resolve()}
   const result=await preparing
   expect(result.results).toBe(0);expect(input.acquisitionOrder.filter(path=>path.startsWith('C:\\store'))).toHaveLength(2)
  }finally{leaveFirst.resolve();leaveSecond.resolve();await cleanup?.close();await service.close();await a.coordinator.close();await b.coordinator.close();await rm(root,{recursive:true,force:true})}
 })

 it('connects public clear to the original covered Store continuation and canonical native claims',async()=>{
  const f=await originalPreparationFixture(),apply=vi.spyOn(ContextStore.prototype,'applyCoveredClear')
  try{
   await f.service.configure({enabled:true});const ref=await f.service.capture({sessionId:'source',callId:'clear',label:'fixture',text:'original clear bytes',complete:true});if(!ref)throw Error('Original capture unavailable')
   const before=input.acquisitionOrder.filter(path=>path.startsWith('C:\\store')).length
   await f.service.clear('source')
   expect(apply).toHaveBeenCalledTimes(1);expect(input.acquisitionOrder.filter(path=>path.startsWith('C:\\store')).length-before).toBe(2)
   expect(input.locks.size).toBe(0)
   await expect(f.service.read({sessionId:'source'},{refId:ref.id})).rejects.toThrow()
   await f.service.close();expect(input.locks.size).toBe(0)
  }finally{apply.mockRestore();await f.close()}
 })

 it('joins healthy clear and configure callers until original native cleanup acknowledges',async()=>{
  const f=await originalPreparationFixture(),other=createSessionCoordinatorCore(f.backend,{lock:{enabled:true}}),entered=Promise.withResolvers<void>(),leave=Promise.withResolvers<void>(),apply=vi.spyOn(ContextStore.prototype,'applyCoveredClear');let configured=false,second=false,closed=false
  try{
   await f.service.configure({enabled:true});const ref=await f.service.capture({sessionId:'source',callId:'queue',label:'queue',text:'queue bytes',complete:true});if(!ref)throw Error('Fixture unavailable')
   input.acquireWait=async path=>{if(path.startsWith('C:\\store')){input.acquireWait=undefined;entered.resolve();await leave.promise}}
   const first=f.service.clear('source');await entered.promise
   expect(()=>registerOriginalLegacyOrdering(f.service,other)).toThrow(/topology.*busy/i)
   const configure=f.service.configure({maxReadBytes:4096}).then(value=>{configured=true;expect(input.mutexClosePaths.filter(path=>path.startsWith('C:\\store')).length).toBeGreaterThanOrEqual(2);return value})
   const next=f.service.clear('source').then(value=>{second=true;return value}),closing=f.service.close().then(()=>{closed=true})
   await Promise.resolve();expect(configured).toBe(false);expect(second).toBe(false);expect(closed).toBe(false);expect(apply).not.toHaveBeenCalled()
   leave.resolve();await Promise.all([first,configure,next,closing]);expect(closed).toBe(true);expect(configured).toBe(true);expect(second).toBe(true);expect(apply).toHaveBeenCalledTimes(2);expect(f.service.status().config.maxReadBytes).toBe(4096);expect(input.locks.size).toBe(0)
  }finally{leave.resolve();input.acquireWait=undefined;apply.mockRestore();await other.close();await f.close()}
 })
 it('refuses own public clear operation reentry before publishing another transition',async()=>{
  const f=await originalPreparationFixture();let entered=false
  try{
   await f.service.configure({enabled:true});await f.service.capture({sessionId:'source',callId:'reentry',label:'reentry',text:'reentry bytes',complete:true});const before=f.service.status().config.maxReadBytes
   input.fileClose=async(path,close)=>{
    if(!entered&&path.includes('artifacts')&&path.endsWith('.json')){entered=true;const count=input.originals.length;await expect(f.service.configure({maxReadBytes:4096})).rejects.toThrow(/reentry/);await expect(f.service.clear('other')).rejects.toThrow(/reentry/);expect(input.originals.length).toBe(count)}
    await close()
   }
   await f.service.clear('source');expect(entered).toBe(true);expect(f.service.status().config.maxReadBytes).toBe(before);expect(input.locks.size).toBe(0)
  }finally{input.fileClose=undefined;await f.close()}
 })
 it('keeps generic no-op public clear outside cold native topology',async()=>{
  fixture(true);const root=await mkdtemp(join(process.env.IH_RESULT_INTEGRITY_EVIDENCE_ROOT!,'generic-clear-')),service=createContextOutputService({root,workspaceId:'w'})
  try{const before=input.originals.length;expect((await service.clear()).results).toBe(0);expect(input.originals.length).toBe(before)}finally{await service.close();await rm(root,{recursive:true,force:true})}
 })

 it('preserves target grants after source-only clear and protects actual managed bodies',async()=>{
  const f=await originalPreparationFixture()
  try{
   await f.service.configure({enabled:true});const ref=await f.service.capture({sessionId:'source',callId:'survivor',label:'survivor',text:'surviving bytes',complete:true});if(!ref)throw Error('Original capture unavailable')
   await f.service.grant({sessionId:'source'},[ref.id],'target')
   const scope=f.service.registerResultScope({operationId:'protected',sessionId:'managed',callId:'protected'},()=>true),sink=await f.service.beginResult(scope,'text-utf8-v1');await sink.write(Buffer.from('protected managed bytes'));const managed=await sink.finish('complete');if(managed.kind!=='committed')throw Error('Original managed result unavailable')
   const body=join(f.root,'context-output',digest('w'),'managed-v1',managed.ref.id,'body'),before=await readFile(body)
   const status=await f.service.clear('source');expect(status.protectedResults).toBe(1);expect(status.clearDisposition).toBe('protected');expect(await readFile(body)).toEqual(before)
   expect((await f.service.read({sessionId:'target'},{refId:ref.id})).text).toBe('surviving bytes')
   await f.service.clear('target');await expect(f.service.read({sessionId:'target'},{refId:ref.id})).rejects.toThrow();expect(await readFile(body)).toEqual(before)
  }finally{await f.close()}
 })
 it('uses the actual pass-two expiry frontier without removing a later expired unclaimed result',async()=>{
  const f=await originalPreparationFixture();let clock=Date.now();const now=vi.spyOn(Date,'now').mockImplementation(()=>clock)
  const originalPrepare=ContextStore.prototype.prepareCoveredClear;let second:import('../../context-output/src/types.ts').ContextResultRef|undefined
  const prepare=vi.spyOn(ContextStore.prototype,'prepareCoveredClear').mockImplementation(async function(this:ContextStore,...args:Parameters<ContextStore['prepareCoveredClear']>){const token=await originalPrepare.apply(this,args);clock=second!.expiresAt+1;return token})
  try{
   await f.service.configure({enabled:true});const first=await f.service.capture({sessionId:'old',callId:'old',label:'old',text:'old bytes',complete:true});if(!first)throw Error('Original first capture unavailable')
   clock+=1000;second=await f.service.capture({sessionId:'late',callId:'late',label:'late',text:'late bytes',complete:true});if(!second)throw Error('Original second capture unavailable')
   clock=first.expiresAt+1;await f.service.clear('unrelated')
   const directory=join(f.root,'context-output',digest('w'))
   await expect(readFile(join(directory,'blobs',first.id+'.txt'))).rejects.toHaveProperty('code','ENOENT')
   expect((await readFile(join(directory,'blobs',second.id+'.txt'))).toString()).toBe('late bytes')
   expect(prepare).toHaveBeenCalledTimes(1)
  }finally{prepare.mockRestore();now.mockRestore();await f.close()}
 })
 it('retains original issued clear progress and cleanup debt without rediscovery or primitive replay',async()=>{
  const f=await originalPreparationFixture(),apply=vi.spyOn(ContextStore.prototype,'applyCoveredClear');let removals=0
  await f.service.configure({enabled:true});await f.service.capture({sessionId:'source',callId:'partial',label:'partial',text:'partial bytes',complete:true})
  input.removeHook=async(path,remove)=>{await remove();if(path.includes('blobs')&&path.endsWith('.txt')){removals++;throw undefined}}
  await expect(f.service.clear('source')).rejects.toBeUndefined();expect(removals).toBe(1);expect([...input.locks.keys()].some(path=>path.startsWith('C:\\store'))).toBe(true)
  const native=input.originals.length;input.removeHook=undefined
  await expect(f.service.clear('source')).rejects.toBeUndefined();await expect(f.service.configure({maxReadBytes:4096})).rejects.toBeUndefined();expect(input.originals.length).toBe(native);expect(apply).toHaveBeenCalledTimes(1);expect(removals).toBe(1)
  await expect(f.service.close()).rejects.toBeUndefined();await expect(f.coordinator.close()).rejects.toThrow();expect(removals).toBe(1);expect([...input.locks.keys()].some(path=>path.startsWith('C:\\store'))).toBe(true)
  apply.mockRestore();await rm(f.root,{recursive:true,force:true})
 })

 it('bounds actual pass-two inventory drift before any clear effect and retains the original finite request',async()=>{
  const f=await originalPreparationFixture(),original=ContextStore.prototype.passiveInventory,apply=vi.spyOn(ContextStore.prototype,'applyCoveredClear');let reads=0,path=''
  const inventory=vi.spyOn(ContextStore.prototype,'passiveInventory').mockImplementation(async function(this:ContextStore,...args:Parameters<ContextStore['passiveInventory']>){const result=await original.apply(this,args);if(path&&args[1]==='source'&&args.length===3&&++reads%2===1)await writeFile(path,JSON.stringify(['source','foreign-'+reads]));return result})
  try{
   await f.service.configure({enabled:true});const ref=await f.service.capture({sessionId:'source',callId:'drift',label:'drift',text:'drift bytes',complete:true});if(!ref)throw Error('Original capture unavailable')
   path=join(f.root,'context-output',digest('w'),'owners',ref.id+'.json')
   await expect(f.service.clear('source')).rejects.toThrow(/changed repeatedly/);expect(reads).toBe(6);expect(apply).not.toHaveBeenCalled();expect(input.locks.size).toBe(0)
   const native=input.originals.length;await expect(f.service.clear('source')).rejects.toThrow(/changed repeatedly/);expect(reads).toBe(6);expect(input.originals.length).toBe(native)
   expect((await readFile(join(f.root,'context-output',digest('w'),'blobs',ref.id+'.txt'))).toString()).toBe('drift bytes')
  }finally{inventory.mockRestore();apply.mockRestore();await f.close()}
 })

 it('cancels the exact static constructor registration and preserves a falsey original failure',async()=>{
  const f=await originalPreparationFixture();let cleanup:OriginalResultRevocationPreparation|undefined
  try{
   const before=input.originals.length;let failed=false,primary:unknown
   try{createProcessAwareResultService({root:f.root,workspaceId:'w',orderingCoordinators:[f.coordinator],coordinatorFor:()=>f.coordinator,sourceFor:async()=>({sourceId:'unused'}),genericVisible:async()=>false,documentDeletions(){throw false}})}catch(cause){failed=true;primary=cause}
   expect(failed).toBe(true);expect(primary).toBe(false);expect(input.originals.length).toBe(before)
   const prepared=await prepareOriginalResultRevocation(f.service,f.coordinator,{kind:'session',sessionIds:['probe'],documents:[]},value=>{cleanup=value});prepared.assertCovered(['probe'])
  }finally{await cleanup?.close();await f.close()}
 })

 it.each(['healthy','lost-cleanup'] as const)('orders two original services and clears before external fresh ownership dependency=%s',async mode=>{
  const f=await originalPreparationFixture(),second=createContextOutputService({root:f.root,workspaceId:'second',config:{enabled:true}});registerOriginalLegacyOrdering(second,f.coordinator)
  const trace=new AsyncLocalStorage<string>(),enteredA=Promise.withResolvers<void>(),leaveA=Promise.withResolvers<void>(),enteredB=Promise.withResolvers<void>(),leaveB=Promise.withResolvers<void>()
  const paths=new Map<string,Set<string>>(),flags:boolean[]=[],originalInventory=ContextStore.prototype.passiveInventory;let heldA=false,heldB=false,bReadsBeforeAck=0,removals=0
  const closed=(kind:string)=>{const keys=paths.get(kind);return keys?.size===2&&[...keys].every(path=>input.mutexClosePaths.includes(path))}
  const inventory=vi.spyOn(ContextStore.prototype,'passiveInventory').mockImplementation(async function(this:ContextStore,...args:Parameters<ContextStore['passiveInventory']>){if(trace.getStore()==='B'&&!closed('A'))bReadsBeforeAck++;return originalInventory.apply(this,args)})
  const results:Promise<unknown>[]=[]
  try{
   await f.service.configure({enabled:true});await f.service.capture({sessionId:'a',callId:'a',label:'a',text:'a bytes',complete:true});await second.capture({sessionId:'b',callId:'b',label:'b',text:'b bytes',complete:true})
   input.acquireWait=async path=>{
    const kind=trace.getStore();if(!kind||!path.startsWith('C:\\store'))return
    let keys=paths.get(kind);if(!keys){keys=new Set();paths.set(kind,keys)};keys.add(path)
    if(kind==='B'){flags.push(closed('A'));if(!heldB){heldB=true;enteredB.resolve();await leaveB.promise}}
    if(kind==='fresh')flags.push(closed('A')&&closed('B'))
    if(kind==='A'&&!heldA){heldA=true;enteredA.resolve();await leaveA.promise}
   }
   if(mode==='lost-cleanup')input.removeHook=async(path,remove)=>{await remove();if(trace.getStore()==='A'&&path.includes('blobs')&&path.endsWith('.txt')){removals++;throw false}}
   const a=trace.run('A',()=>f.service.clear('a')).then(value=>({ok:true,value}),cause=>({ok:false,cause}));results.push(a);await enteredA.promise
   const b=trace.run('B',()=>second.clear('b')).then(value=>({ok:true,value}),cause=>({ok:false,cause}));results.push(b)
   const fresh=trace.run('fresh',()=>f.nativeOwner.pinOwnership('external-fresh')).then(claim=>({ok:true,claim}),cause=>({ok:false,cause}));results.push(fresh)
   await new Promise<void>(resolve=>setImmediate(resolve));expect(bReadsBeforeAck).toBe(0);expect(paths.has('B')).toBe(false);expect(paths.has('fresh')).toBe(false)
   leaveA.resolve()
   if(mode==='healthy'){
    const next=await Promise.race([enteredB.promise.then(()=>true),b.then(()=>false)]);expect(next).toBe(true);expect(paths.has('fresh')).toBe(false);leaveB.resolve()
    const first=await a,other=await b,external=await fresh;expect(first.ok).toBe(true);expect(other.ok).toBe(true);expect(external.ok).toBe(true)
    if('claim'in external){external.claim.assertHeld();await external.claim.release()}
    expect(flags.length).toBeGreaterThan(0);expect(flags.every(Boolean)).toBe(true);expect(input.locks.size).toBe(0)
   }else{
    const first=await a,other=await b,external=await fresh
    expect(first).toEqual({ok:false,cause:false});expect(other).toEqual({ok:false,cause:false});expect(external).toEqual({ok:false,cause:false});expect(removals).toBe(1);expect(paths.has('B')).toBe(false);expect(paths.has('fresh')).toBe(false)
    input.removeHook=undefined;await f.nativeOwner.retryResultOrdering();const count=input.originals.length
    await expect(f.nativeOwner.pinOwnership('retry-after-empty-waiter')).rejects.toBe(false);expect(input.originals.length).toBe(count)
    await expect(f.service.close()).rejects.toBe(false);expect([...input.locks.keys()].some(path=>path.startsWith('C:\\store'))).toBe(true)
   }
  }finally{
   leaveA.resolve();leaveB.resolve();input.acquireWait=undefined;input.removeHook=undefined;await Promise.allSettled(results);inventory.mockRestore()
   if(mode==='healthy'){await second.close();await f.close()}
   else{await second.close().catch(()=>{});await f.service.close().catch(()=>{});await f.coordinator.close().catch(()=>{});await rm(f.root,{recursive:true,force:true})}
  }
 })
 it('refuses copied stale and cancelled original ordering origins without granting through their context',async()=>{
  const f=await originalPreparationFixture(),domain=captureOriginalRevocationDomain([originalResultRevocationFor(f.coordinator)]),origin=beginOriginalRevocationOrdering(domain);let effects=0
  try{
   await expect(runOriginalRevocationOrdering(domain,{...origin},async()=>{effects++})).rejects.toThrow(/Original/);expect(effects).toBe(0)
   await expect(runOriginalRevocationOrdering(domain,origin,async()=>{await expect(f.nativeOwner.pinOwnership('nested-origin-fresh')).rejects.toThrow(/reentry/);throw false})).rejects.toBe(false)
   const count=input.originals.length;await expect(f.nativeOwner.pinOwnership('cancelled-origin-fresh')).rejects.toBe(false);expect(input.originals.length).toBe(count)
   completeOriginalRevocationOrdering(domain,origin)
   await expect(runOriginalRevocationOrdering(domain,origin,async()=>{effects++})).rejects.toThrow(/Original/);expect(effects).toBe(0)
   const claim=await f.nativeOwner.pinOwnership('after-original-cancel-ack');await claim.release()
  }finally{await f.close()}
 })

})
