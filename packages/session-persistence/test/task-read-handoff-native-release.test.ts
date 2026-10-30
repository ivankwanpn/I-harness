import { expect,it,vi } from 'vitest'
import type { SessionLock } from '../../fs-lock/src/index.ts'
const fault=vi.hoisted(()=>({path:'',cause:undefined as unknown,armed:false,calls:0,acquires:0,heldAfter:undefined as boolean|undefined,resources:[] as {path:string;raw:SessionLock}[]}))
vi.mock('../../fs-lock/src/index.ts',async original=>{
 const real=await original<typeof import('../../fs-lock/src/index.ts')>()
 return {...real,async acquireSessionLock(options:Parameters<typeof real.acquireSessionLock>[0]){
  const raw=await real.acquireSessionLock(options);fault.resources.push({path:options.lockPath,raw});if(options.lockPath===fault.path)fault.acquires++
  return {get held(){return raw.held},async release(){
   if(options.lockPath===fault.path&&fault.armed){fault.calls++;fault.armed=false;await raw.release();fault.heldAfter=raw.held;throw fault.cause}
   await raw.release()
  }}
 }}
})
import { mkdtemp,rm } from 'node:fs/promises'
import { join,sep } from 'node:path'
import { lockPathFor } from '../../fs-lock/src/index.ts'
import { createJsonlTaskTransitionCoordinator } from '../../session-persistence-jsonl/src/task-document-factory.ts'
import { taskDocumentStorageContract } from '../../subagent/src/task/storage-contract.ts'
import { taskDocumentOperationsFor } from '@i-harness/session-persistence/internal/task-document-operations'
function retains(error:unknown,cause:unknown):boolean{
 if(Object.is(error,cause))return true
 if(!error||typeof error!=='object')return false
 return error instanceof AggregateError&&error.errors.some(e=>retains(e,cause))||Object.hasOwn(error,'cause')&&retains((error as Error).cause,cause)
}
it.each([false,undefined] as const)('native release consumes held state then throws %s inside original sticky Ownership guard',async cause=>{
 const root=await mkdtemp(join(process.env.IH_NATIVE_DEPENDENCY_EVIDENCE_ROOT!,'read-native-consumed-')),coordinator=createJsonlTaskTransitionCoordinator(root,{lock:{enabled:true}},taskDocumentStorageContract)
 let original:Awaited<ReturnType<NonNullable<ReturnType<typeof taskDocumentOperationsFor>>['begin']>>|undefined
 try{
  await coordinator.create({sessionId:'parent'});const document=await coordinator.openManagedDocument('parent'),ops=taskDocumentOperationsFor(coordinator)!,parent=ops.parent(document)
  fault.path=lockPathFor(root,'doc:task-parent');fault.cause=cause;fault.calls=fault.acquires=0;fault.heldAfter=undefined
  original=await ops.begin(parent);const seen=await original.observe();if(seen.kind!=='present')throw Error('missing original task');expect((await original.confirm(seen.witness)).kind).toBe('confirmed');const handle=original.prepareReadHandoff(seen.witness)
  fault.armed=true;await expect(original.close()).rejects.toBe(cause);expect(fault.heldAfter).toBe(false);expect(fault.calls).toBe(1);expect(fault.acquires).toBe(1)
  expect(()=>handle.consume()).toThrow();handle.abandon();handle.abandon()
  // Injection is now disabled. The original guard must retain the exact debt
  // instead of invoking raw.release again and accepting its no-op as success.
  await expect(original.retryClose()).rejects.toBe(cause);await expect(original.retryClose()).rejects.toBe(cause)
  await expect(ops.joinTaskDocumentIO()).rejects.toMatchObject({errors:[cause]});expect(()=>handle.consume()).toThrow();expect(()=>original!.assertHandoff()).toThrow()
  await expect(ops.begin(parent)).rejects.toBeDefined();expect(fault.calls).toBe(1);expect(fault.acquires).toBe(1)
  let closeFailed=false,closeError:unknown;try{await coordinator.close()}catch(error){closeFailed=true;closeError=error}
  expect(closeFailed).toBe(true);expect(retains(closeError,cause)).toBe(true);await expect(original.retryClose()).rejects.toBe(cause);expect(fault.calls).toBe(1)
 }finally{
  fault.armed=false
  // Bounded teardown preserves the original failed guard/operation. Close is
  // expected to fail; dispose only still-held raw native test resources so no
  // renewal timer survives the test. Never reset/recreate the failed guard.
  let failed=false,error:unknown;try{await coordinator.close()}catch(caught){failed=true;error=caught}
  expect(failed).toBe(true);expect(retains(error,cause)).toBe(true)
  for(const entry of fault.resources.filter(entry=>entry.path.startsWith(root+sep)))if(entry.raw.held)await entry.raw.release()
  if(original)await expect(original.retryClose()).rejects.toBe(cause)
  fault.path='';await rm(root,{recursive:true,force:true})
 }
})
