import {beforeEach,expect,it,vi} from 'vitest'
import {win32 as path} from 'node:path'
import type {Win32ArtifactApi} from '../../fs-lock/src/win32-artifact-api.ts'
const input=vi.hoisted(()=>({api:undefined as Win32ArtifactApi|undefined,originalLock:true,originals:[] as import('../../fs-lock/src/index.ts').SessionLock[],countHeld:undefined as (()=>void)|undefined,heldHook:undefined as (()=>void)|undefined,heldResult:undefined as (()=>unknown)|undefined,failClose:false,failedPath:'',mutexCloses:0,mutexClosePaths:[] as string[],locks:new Map<string,object>()}))
vi.mock('@i-harness/fs-lock/internal/artifact-path',async()=>{
 const {createWin32ArtifactPathOwnerWithApi}=await import('../../fs-lock/src/win32-artifact-path.ts')
 return{createArtifactPathOwner:(root:string)=>createWin32ArtifactPathOwnerWithApi(root,input.api!)}
})
vi.mock('@i-harness/fs-lock',async()=>{
 const {createHash}=await import('node:crypto')
 const {heldLock}=await import('../../fs-lock/src/win32.ts')
 return{lockPathFor:(root:string,id:string)=>path.join(root,'.i-harness-locks',createHash('sha256').update(id).digest('hex').slice(0,24)+'.lock'),async acquireSessionLock({lockPath}:{lockPath:string}){
  if(input.locks.has(lockPath))throw Error('native conflict')
  const identity={};input.locks.set(lockPath,identity)
  const original=heldLock({createFileW(){throw Error('No real acquisition in injected held-constructor control')},lockFileEx(){throw Error('No real acquisition in injected held-constructor control')},unlockFileEx:()=>1,closeHandle:()=>{input.mutexCloses++;input.mutexClosePaths.push(lockPath);input.locks.delete(lockPath);if(input.failClose){input.failClose=false;input.failedPath=lockPath;throw undefined};return 1},getLastError:()=>0},1n,lockPath,2n)
  input.originals.push(original);if(input.originalLock)return original
  return{get held(){input.countHeld?.();input.heldHook?.();return input.heldResult?input.heldResult() as boolean:original.held},release:()=>original.release()}
 }}
})
import {createOwnership} from '../src/coordinator/ownership.ts'
import {heldLock} from '../../fs-lock/src/win32.ts'
import {originalHeldStateFor} from '../../fs-lock/src/held-state-internal.ts'
import {createWin32ArtifactPathOwnerWithApi} from '../../fs-lock/src/win32-artifact-path.ts'
import {associateArtifactPaths,assertArtifactCurrent,createArtifactCurrentGuard,withArtifactCurrentChecks,withImmediateArtifactCurrentChecks} from '../src/coordinator/artifact-path-association.ts'
import type {PersistenceBackend} from '../src/coordinator/types.ts'
import {createJsonlBackend} from '../../session-persistence-jsonl/src/backend-factory.ts'
import {LegacyFundingBatchOwner,fundingDescription,fundingPass,type FundingBatchContext} from '../../context-output/src/legacy/funding-batch.ts'
import {createWorkspaceMutationOwner} from '../../context-output/src/workspace-mutation.ts'
import {createLegacyUseGate} from '../../context-output/src/legacy/use-gate.ts'

function fixture(pure:boolean,originalLock=true){
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
 associateArtifactPaths(backend,Object.freeze({root:()=> 'C:\\store',session:(id:string)=>path.join('C:\\store',id+'.jsonl'),document:(id:string)=>path.join('C:\\store',id+'.doc.jsonl'),taskForParent:(id:string)=>path.join('C:\\store','task-'+id+'.doc.jsonl'),async prepareRoot(){},async prepareDocumentParents(){},assertOriginal:pure?createArtifactCurrentGuard(check):check}))
 const owner=createOwnership(backend,{lock:{enabled:true}})
 const delta=(before:ReturnType<typeof snapshot>)=>Object.fromEntries(Object.keys(counts).map(key=>[key,counts[key as keyof typeof counts]-before[key as keyof typeof counts]]))
 return{owner,api,counts,snapshot,delta,directories,handles,onCallback(value:(()=>void)|undefined){if(pure&&value)throw Error('Unknown callback cannot enter pure constructor');callback=value}}
}
beforeEach(()=>{input.api=undefined;input.originalLock=true;input.originals=[];input.countHeld=undefined;input.heldHook=undefined;input.heldResult=undefined;input.failClose=false;input.failedPath='';input.mutexCloses=0;input.mutexClosePaths=[];input.locks.clear()})

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
