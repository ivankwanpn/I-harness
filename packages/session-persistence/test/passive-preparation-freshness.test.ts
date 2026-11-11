import {afterEach,expect,it,vi} from 'vitest'
import {win32 as windows,join,resolve,sep} from 'node:path'
import {mkdtemp,rm} from 'node:fs/promises'
import type {Win32ArtifactApi} from '../../fs-lock/src/win32-artifact-api.ts'
const native=vi.hoisted(()=>({api:undefined as Win32ArtifactApi|undefined,locks:new Set<string>()}))
vi.mock('@i-harness/fs-lock/internal/artifact-path',async original=>{
 const module=await original<typeof import('@i-harness/fs-lock/internal/artifact-path')>()
 const {createWin32ArtifactPathOwnerWithApi}=await import('../../fs-lock/src/win32-artifact-path.ts')
 return{...module,createArtifactPathOwner:(root:string)=>createWin32ArtifactPathOwnerWithApi(root,native.api!)}
})
vi.mock('@i-harness/fs-lock',async()=>{
 const {createHash}=await import('node:crypto'),{heldLock}=await import('../../fs-lock/src/win32.ts')
 return{lockPathFor:(root:string,id:string)=>windows.join(root,'.i-harness-locks',createHash('sha256').update(id).digest('hex').slice(0,24)+'.lock'),async acquireSessionLock({lockPath}:{lockPath:string}){
  if(native.locks.has(lockPath))throw Error('Injected original native conflict');native.locks.add(lockPath)
  return heldLock({createFileW(){throw Error('No actual native acquisition')},lockFileEx(){throw Error('No actual native acquisition')},unlockFileEx:()=>1,closeHandle:()=>{native.locks.delete(lockPath);return 1},getLastError:()=>0},1n,lockPath,2n)
 }}
})
import {createContextOutputService,prepareOriginalResultRevocation,registerOriginalLegacyOrdering,type OriginalResultRevocationPreparation} from '../../context-output/src/service.ts'
import {ContextStore} from '../../context-output/src/store.ts'
import {LegacyIndexLifecycle} from '../../context-output/src/legacy/index-lifecycle.ts'
import {createJsonlBackend} from '../../session-persistence-jsonl/src/backend-factory.ts'
import {createSessionCoordinatorCore} from '../src/coordinator-factory.ts'
function installOriginalApi(){
 const directories=new Map([['C:\\store',{id:1,final:'\\Device\\Volume\\store'}],['C:\\store\\.i-harness-locks',{id:2,final:'\\Device\\Volume\\store\\.i-harness-locks'}]])
 const handles=new Map<bigint,{id:number;final:string}>();let next=1n
 native.api={createFileW(path){const item=directories.get(path);if(!item)return -1n;const handle=next++;handles.set(handle,{...item});return handle},getLastError:()=>3,
  getFileInformationByHandleEx(handle,kind,data){const item=handles.get(handle)!;if(kind===18){data.writeBigUInt64LE(1n,0);data.writeUInt32LE(item.id,8)}else if(kind===23)data.writeUInt32LE(0);else data.writeUInt32LE(0x10);return 1},
  getFinalPathNameByHandleW(handle,data){const value=handles.get(handle)!.final;data.write(value+'\0','utf16le');return value.length},
  lcMapStringEx(_locale,_flags,value,_count,output){const folded=value.toUpperCase();if(output)output.write(folded,'utf16le');return folded.length},closeHandle(handle){if(!handles.delete(handle))throw Error('Wrong original handle');return 1}}
 return handles
}
afterEach(()=>{vi.restoreAllMocks();native.locks.clear()})
it.each(['unchanged','remote-cache-present','remote-cache-absent'] as const)('preserves original cache association through passive-only preparation with authority=%s',async mode=>{
 const changed=mode!=='unchanged'
 const handles=installOriginalApi(),base=process.env.IH_RESULT_INTEGRITY_EVIDENCE_ROOT!,root=await mkdtemp(join(base,'passive-freshness-'))
 const coordinator=createSessionCoordinatorCore(createJsonlBackend('C:\\store'),{lock:{enabled:true}})
 const local=createContextOutputService({root,workspaceId:'w',config:{enabled:true}}),remote=createContextOutputService({root,workspaceId:'w',config:{enabled:true}})
 registerOriginalLegacyOrdering(local,coordinator);registerOriginalLegacyOrdering(remote,coordinator)
 let cleanup:OriginalResultRevocationPreparation|undefined
 try{
  const ref=await local.capture({sessionId:'source',callId:'call',label:'fixture',text:'original cache bytes',complete:true});if(!ref)throw Error('Original fixture capture refused')
  expect((await local.read({sessionId:'source'},{refId:ref.id})).text).toBe('original cache bytes')
  if(changed){await remote.grant({sessionId:'source'},[ref.id],'remote');expect((await remote.read({sessionId:'remote'},{refId:ref.id})).text).toBe('original cache bytes');if(mode==='remote-cache-present')expect((await remote.search({sessionId:'remote'},{query:'original'})).hits.some(hit=>hit.ref.id===ref.id)).toBe(true)}
  const open=vi.spyOn(ContextStore.prototype,'open'),rebuild=vi.spyOn(LegacyIndexLifecycle.prototype,'rebuild'),invalidate=vi.spyOn(LegacyIndexLifecycle.prototype,'invalidate')
  const prepared=await prepareOriginalResultRevocation(local,coordinator,{kind:'session',sessionIds:['unrelated'],documents:[]},value=>{cleanup=value})
  prepared.assertCovered(['unrelated']);await prepared.close();expect(open).not.toHaveBeenCalled();expect(rebuild).not.toHaveBeenCalled()
  expect((await local.read({sessionId:changed?'remote':'source'},{refId:ref.id})).text).toBe('original cache bytes')
  expect(open).not.toHaveBeenCalled();expect(rebuild).not.toHaveBeenCalled()
  if(changed)expect(invalidate).toHaveBeenCalledWith(expect.objectContaining({message:'Original authority changed while idle'}))
  else expect(invalidate).not.toHaveBeenCalled()
 }finally{
  await cleanup?.close();await local.close();await remote.close();await coordinator.close()
  if(!resolve(root).startsWith(resolve(base)+sep))throw Error('Fixture root escaped assigned evidence')
  await rm(root,{recursive:true,force:true});expect(handles.size).toBe(0);expect(native.locks.size).toBe(0)
 }
})
