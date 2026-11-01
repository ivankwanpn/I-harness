import type { AclSandboxChild, AclSandboxChildResult } from './index.ts'
import type { NativePtr, Win32Bindings } from './ffi.ts'
import type { PipeChildOwner } from './pipe-child.ts'
import { createInheritedChildNative, type InheritedInput } from './inherited-child-native.ts'
import { createChannelWaitCredit } from './channel-wait-credit.ts'
import { registerWin32WaitWithReservation } from './win32-wait.ts'
import { WaitBridgeStartupFailure, type WaitDrainBridgeClient } from './native-wait-bridge-owner.ts'
import type { WaitDrainReservation } from './native-wait-bridge.ts'
type Native=ReturnType<typeof createInheritedChildNative>
type Observer=ReturnType<typeof registerWin32WaitWithReservation>
type Original={api:Win32Bindings;token:NativePtr;assertLaunchCurrent():void;acquireWaitClient():Promise<WaitDrainBridgeClient>}
export function createInheritedChildOwner(input:InheritedInput,original:Original,injected?:{native():Native;observe(handle:NativePtr,reservation:WaitDrainReservation):Observer}):PipeChildOwner{
 const boundary=injected??{native:()=>createInheritedChildNative(original.api,original.token,input,()=>original.assertLaunchCurrent()),observe:registerWin32WaitWithReservation}
 let start:Promise<AclSandboxChild>|undefined,whole:Promise<AclSandboxChildResult>|undefined,client:WaitDrainBridgeClient|undefined,credit:ReturnType<typeof createChannelWaitCredit>|undefined,native:Native|undefined,observer:Observer|undefined,root:Promise<void>|undefined,startupDebt:WaitBridgeStartupFailure|undefined
 let cleanupFlight:Promise<void>|undefined,recovery:Promise<void>|undefined,recoveryError:{error:unknown}|undefined,primary:{error:unknown}|undefined,cleaned=false,exited=false,code:number|undefined
 const failures:unknown[]=[];let notify!:()=>void;const failed=new Promise<void>(r=>{notify=r})
 function begin(error:unknown){
  if(!failures.some(e=>Object.is(e,error)))failures.push(error);primary??={error};notify()
  if(recovery)return
  try{if(native&&(native.phase()==='created'||native.phase()==='unknown')&&!exited)native.recover();recovery=Promise.resolve()}
  catch(e){recoveryError={error:e};recovery=Promise.resolve()}
 }
 function watch<T>(p:Promise<T>){void p.catch(begin);return p}
 function observe(){
  observer=boundary.observe(native!.process(),credit!.reserve());const owned=observer
  root=watch(owned.signalled.then(()=>{exited=true;code=native!.exitCode()}));return watch(owned.setup)
 }
 async function cleanup(){
  if(recovery)await recovery
  if(recoveryError){native!.recover();recoveryError=undefined}
  if(native?.phase()==='unknown')throw new Error('inherited process issue unknown; original debt pinned')
  if(native?.phase()==='created'){
   if(root)await root.catch(()=>{})
   if(!exited){if(observer){await observer.close();observer=undefined}await observe();await root}
   // Root evidence precedes process retirement; Job close supplies descendant
   // termination, never tree-empty/EOF evidence for the outer provider.
   native.closeJob()
  }
  credit?.fence()
  if(observer){await observer.close();observer=undefined}
  if(native){native.closeLaunch();native.cleanup()}
  if(startupDebt){await startupDebt.retryCleanup();startupDebt=undefined}
  if(client){await client.release();client=undefined}cleaned=true
 }
 function retry(){
  if(cleaned)return Promise.resolve();if(cleanupFlight)return cleanupFlight
  const p=cleanup();cleanupFlight=p;void p.finally(()=>{if(cleanupFlight===p)cleanupFlight=undefined}).catch(()=>{});return p
 }
 async function settle(){
  await Promise.race([root!.catch(()=>{}),failed])
  try{await retry()}catch(e){begin(e);throw new AggregateError([...failures,e],'inherited cleanup incomplete',{cause:primary?.error})}
  if(failures.length>1)throw new AggregateError(failures,'inherited failures',{cause:primary?.error});if(primary)throw primary.error
  return {stdout:Buffer.alloc(0),stderr:Buffer.alloc(0),exitCode:code!}
 }
 return {
  start(){
   if(start)return start
   start=Promise.resolve().then(async()=>{
    try{
     try{client=await original.acquireWaitClient()}catch(e){if(e instanceof WaitBridgeStartupFailure)startupDebt=e;throw e}
     await client.ready;credit=createChannelWaitCredit(client,client.reserve())
     native=boundary.native();native.prepare();native.issue();const pid=native.pid();native.process();native.thread();native.assign()
     await observe()
     if(primary)throw primary.error
     if(exited)throw new Error('inherited root exited before resume')
     original.assertLaunchCurrent();native.resume();native.closeLaunch()
     whole=settle();void whole.catch(()=>{});return Object.freeze({pid,wait:()=>whole!})
    }catch(e){begin(e);if(native?.phase()==='created'&&!observer){try{await observe()}catch{}}
     void retry().catch(()=>{});throw e}
   });void start.catch(()=>{});return start
  },
  async joinCleanup(){if(start)await start.catch(()=>{});if(whole)await whole.catch(()=>{});await retry()},pending:()=>!cleaned,
 }
}
