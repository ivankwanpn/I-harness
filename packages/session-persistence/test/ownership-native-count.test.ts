import { coldLegacyFixture } from '../../context-output/test/fixtures/cold-selected-legacy.ts'
import { originalResultRevocationFor } from '../src/coordinator/result-revocation.ts'
import { ContextStore, referenceId, digest } from '../../context-output/src/store.ts'
import { createHash } from 'node:crypto'
import { mkdtemp, rm, readFile, writeFile, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { createContextOutputService, prepareOriginalResultRevocation, registerOriginalLegacyOrdering, type OriginalResultRevocationPreparation } from '../../context-output/src/service.ts'
import { createSessionCoordinatorCore } from '../src/coordinator-factory.ts'
import {beforeEach,describe,expect,it,vi} from 'vitest'
import {win32 as path} from 'node:path'
import type {Win32ArtifactApi} from '../../fs-lock/src/win32-artifact-api.ts'
const input=vi.hoisted(()=>({api:undefined as Win32ArtifactApi|undefined,originalLock:true,originals:[] as import('../../fs-lock/src/index.ts').SessionLock[],countHeld:undefined as (()=>void)|undefined,heldHook:undefined as (()=>void)|undefined,heldResult:undefined as (()=>unknown)|undefined,failClose:false,failedPath:'',acquisitionOrder:[] as string[],acquireHook:undefined as undefined|((path:string)=>void),acquireWait:undefined as undefined|((path:string)=>Promise<void>),fileClose:undefined as undefined|((path:string,close:()=>Promise<void>)=>Promise<void>),bodyOpens:0,admission:undefined as undefined|import('../src/coordinator/result-revocation.ts').ResultRevocationAdmission,revocationScope:undefined as undefined|import('../src/coordinator/result-revocation.ts').OriginalResultRevocationScope,mutexCloses:0,mutexClosePaths:[] as string[],locks:new Map<string,object>()}))
// Observe only the genuine constructor-issued scope; do not replace its owner or port.
vi.mock('../src/coordinator/result-revocation.ts',async original=>{
 const module=await original<typeof import('../src/coordinator/result-revocation.ts')>()
 return{...module,issueOriginalResultRevocationScope(...args:Parameters<typeof module.issueOriginalResultRevocationScope>){const scope=module.issueOriginalResultRevocationScope(...args);input.admission=args[0];input.revocationScope=scope;return scope}}
})
vi.mock('node:fs/promises',async original=>{
 const fs=await original<typeof import('node:fs/promises')>()
 return{...fs,async open(...args:Parameters<typeof fs.open>){const name=String(args[0]);if(/(?:[\\/](?:body|index|leaves)|blobs[\\/]|index.sqlite$)/.test(name))input.bodyOpens++;const handle=await fs.open(...args),close=handle.close.bind(handle);handle.close=()=>input.fileClose?input.fileClose(name,close):close();return handle}}
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
beforeEach(()=>{input.api=undefined;input.originalLock=true;input.originals=[];input.countHeld=undefined;input.heldHook=undefined;input.heldResult=undefined;input.failClose=false;input.failedPath='';input.acquisitionOrder=[];input.acquireHook=undefined;input.acquireWait=undefined;input.fileClose=undefined;input.bodyOpens=0;input.admission=undefined;input.revocationScope=undefined;input.mutexCloses=0;input.mutexClosePaths=[];input.locks.clear()})

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

async function originalPreparationFixture(){
 const f=fixture(true),coordinator=createSessionCoordinatorCore(f.backend,{lock:{enabled:true}}),root=await mkdtemp(join(process.env.IH_RESULT_INTEGRITY_EVIDENCE_ROOT!,'passive-'))
 const service=createContextOutputService({root,workspaceId:'w'});registerOriginalLegacyOrdering(service,coordinator)
 return{...f,coordinator,root,service,async close(){input.fileClose=undefined;await service.close();await coordinator.close();await rm(root,{recursive:true,force:true})}}
}
async function legacyMetadata(root:string,sessionId:string,callId:string,expiresAt:number,owners:readonly string[]){
 const id=referenceId('w',sessionId,callId,'r'),directory=join(root,'context-output',digest('w'))
 await mkdir(join(directory,'artifacts'),{recursive:true});await mkdir(join(directory,'owners'),{recursive:true})
 const metadata=JSON.stringify({ref:{id,workspaceId:'w',sessionId,callId,label:'metadata only',revision:'r',bytes:1,originalBytes:1,complete:true,expiresAt}})
 await writeFile(join(directory,'artifacts',id+'.json'),metadata);await writeFile(join(directory,'owners',id+'.json'),JSON.stringify(owners))
 return{path:join(directory,'artifacts',id+'.json'),metadata}
}
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
