import { expect, it } from 'vitest'
import koffi from 'koffi'
import { createInheritedChildNative } from '../src/inherited-child-native.ts'
import { STARTUPINFOEXW, type NativePtr, type Win32Bindings } from '../src/ffi.ts'
import { createInheritedChildOwner } from '../src/inherited-child.ts'
import { createRegisteredWait } from '../src/native-wait.ts'
import { createWaitBridgeOwner } from '../src/native-wait-bridge-owner.ts'
function fixture(windowsHide=false){
 let next=100n,error=122,assign=1,resume=1,create=1,jobClose=1
 const trace:string[]=[],borrowed:NativePtr[]=[];let startup:any,flags=0
 const api={getLastError:()=>error,formatMessageW:()=>0,
 createJobObjectW:()=>1000n,setInformationJobObject:()=>1,getCurrentProcess:()=>999n,
 getStdHandle:(kind:number)=>{const p=BigInt(200-kind) as NativePtr;borrowed.push(p);return p},
 duplicateHandle:(_a:unknown,source:NativePtr,_b:unknown,slot:NativePtr,_access:number,inherit:number)=>{expect(borrowed).toContain(source);expect(inherit).toBe(1);koffi.encode(slot,'void *',next++);return 1},
 initializeProcThreadAttributeList:(list:NativePtr|null,_count:number,_flags:number,size:NativePtr)=>{if(!list){error=122;koffi.encode(size,'size_t',128);return 0}return 1},updateProcThreadAttribute:()=>1,deleteProcThreadAttributeList:()=>{trace.push('delete-startup')},
 createProcessAsUserExW:(...args:any[])=>{trace.push('create');flags=args[6];startup=koffi.decode(args[9],STARTUPINFOEXW);if(!create){error=2;return 0}koffi.encode(args[10],0,'uint64',300n);koffi.encode(args[10],8,'uint64',301n);koffi.encode(args[10],16,'uint32',42);return create},
 assignProcessToJobObject:()=>{trace.push('assign');error=5;return assign},resumeThread:()=>{trace.push('resume');error=6;return resume},
 closeHandle:(p:NativePtr)=>{expect(borrowed).not.toContain(p);trace.push(`close-${p}`);if(p===1000n&&!jobClose){error=7;return 0}return 1},
 terminateProcess:()=>{trace.push('terminate');return 1},getExitCodeProcess:(_h:NativePtr,slot:NativePtr)=>{trace.push('status');koffi.encode(slot,'uint32',259);return 1},
 } as unknown as Win32Bindings
 const native=createInheritedChildNative(api,2n as NativePtr,{command:'missing.exe',args:[],cwd:'C:\\',windowsHide},()=>{})
 return {native,api,trace,borrowed,startup:()=>startup,flags:()=>flags,setCreate:(n:number)=>{create=n},setAssign:(n:number)=>{assign=n},setResume:(n:number)=>{resume=n},setJobClose:(n:number)=>{jobClose=n}}
}
it.each([false,true])('uses original slot and live inherited duplicates, preserving hidden startup=%s',async hidden=>{
 const f=fixture(hidden),n=f.native;n.prepare();n.issue();n.assign();n.resume();n.closeLaunch();expect(f.flags()).toBe(0x80004);expect(f.startup().StartupInfo.dwFlags).toBe(0x100|(hidden?1:0));expect(f.startup().StartupInfo.hStdInput).not.toBe(f.borrowed[0]);expect(n.pid()).toBe(42);expect(n.exitCode()).toBe(259);expect(n.exitCode()).toBe(259);n.closeJob();n.cleanup();n.cleanup();expect(f.trace.filter(e=>e==='status')).toHaveLength(1);expect(f.trace.filter(e=>e==='close-1000')).toHaveLength(1)
})
it('preserves CreateProcess failure code before cleanup and closes partial originals',()=>{
 const f=fixture();f.setCreate(0);f.native.prepare();expect(()=>f.native.issue()).toThrow(expect.objectContaining({api:'CreateProcessAsUserW',win32Code:2}));f.native.closeLaunch();f.native.cleanup();expect(f.trace).not.toContain('resume')
})
it('terminates original suspended process on failed assignment before retirement',()=>{
 const f=fixture();f.native.prepare();f.native.issue();f.setAssign(0);expect(()=>f.native.assign()).toThrow(expect.objectContaining({win32Code:5}));f.native.recover();expect(f.trace).toContain('terminate');expect(f.trace).not.toContain('resume');f.native.closeLaunch();f.native.cleanup()
})
it.each([0,2,0xffffffff,NaN])('never retries ResumeThread result %s',result=>{
 const f=fixture();f.native.prepare();f.native.issue();f.native.assign();f.setResume(result);expect(()=>f.native.resume()).toThrow();expect(()=>f.native.resume()).toThrow();expect(f.trace.filter(e=>e==='resume')).toHaveLength(1);f.native.recover();f.native.closeLaunch();if(Number.isNaN(result))expect(()=>f.native.cleanup()).toThrow('unknown');else f.native.cleanup()
})
it('Job close refusal triggers original termination before exposing retained cleanup',()=>{
 const f=fixture();f.native.prepare();f.native.issue();f.native.assign();f.setJobClose(0);expect(()=>f.native.recover()).toThrow();expect(f.trace).toContain('terminate');f.setJobClose(1);f.native.recover();f.native.closeLaunch();f.native.cleanup()
})
it('composes actual original launch/slot/startup, registered wait, channel credit and client lease',async()=>{
 const f=fixture();let signal!:()=>void,ack!:()=>void,exit!:()=>void
 const retired=new Promise<void>(r=>{ack=r}),workerExit=new Promise<void>(r=>{exit=r})
 const bridge=createWaitBridgeOwner(()=>{const service={ready:Promise.resolve(),reserve(){f.trace.push('reserve');return {unregister:async()=>({status:0,async acknowledge(){f.trace.push('unregister');await retired}}),rejoin(){},release(){f.trace.push('reservation-release')}}},async close(){f.trace.push('worker-close');await workerExit}};return {service:Promise.resolve(service),cleanup:()=>service.close()}})
 const owner=createInheritedChildOwner({command:'cmd',args:[],cwd:'C:\\'},{api:{} as never,token:1n as NativePtr,assertLaunchCurrent(){},acquireWaitClient:()=>bridge.acquire('root')},{native:()=>f.native,observe:(handle,reservation)=>{
  expect(handle).toBe(300n);const wait=createRegisteredWait({register(callback){f.trace.push('register');signal=callback;return handle},unregister:registration=>reservation.unregister(registration),rejoin:()=>reservation.rejoin(),release:()=>reservation.release()});return {...wait,setup:Promise.resolve()}
 }})
 const child=await owner.start();expect(f.trace.indexOf('reserve')).toBeLessThan(f.trace.indexOf('create'));expect(f.trace.indexOf('assign')).toBeLessThan(f.trace.indexOf('register'));expect(f.trace.indexOf('register')).toBeLessThan(f.trace.indexOf('resume'));signal();await new Promise(r=>setImmediate(r));expect(f.trace).not.toContain('close-300');ack();await new Promise(r=>setImmediate(r));expect(f.trace).toContain('close-300');expect(f.trace).toContain('worker-close');expect(owner.pending()).toBe(true);exit();expect((await child.wait()).exitCode).toBe(259);expect(owner.pending()).toBe(false)
})
it.each(['job','configure','stdin','stdout','stderr','attribute-query','attribute-update'] as const)('retains partial acquisition and cleans original resources after %s failure',stage=>{
 const f=fixture()
 if(stage==='job')f.api.createJobObjectW=()=>0n as NativePtr
 else if(stage==='configure')f.api.setInformationJobObject=()=>0
 else if(stage==='attribute-query')f.api.initializeProcThreadAttributeList=()=>0
 else if(stage==='attribute-update')f.api.updateProcThreadAttribute=()=>0
 else {const duplicate=f.api.duplicateHandle;let call=0;const fail=['stdin','stdout','stderr'].indexOf(stage)+1;f.api.duplicateHandle=(...args)=>++call===fail?0:duplicate(...args)}
 expect(()=>f.native.prepare()).toThrow();f.native.closeLaunch();f.native.cleanup();expect(f.trace).not.toContain('create');expect(f.trace).not.toContain('resume')
})
it.each(['assignment','resume','launch'] as const)('pins unknown %s outcome without retrying native issue',stage=>{
 const f=fixture();f.native.prepare()
 if(stage==='launch') {f.api.createProcessAsUserExW=()=>{throw false};expect(()=>f.native.issue()).toThrow()}
 else {f.native.issue();if(stage==='assignment'){f.api.assignProcessToJobObject=()=>{throw false};expect(()=>f.native.assign()).toThrow()}else{f.native.assign();f.api.resumeThread=()=>{throw false};expect(()=>f.native.resume()).toThrow()}}
 expect(()=>f.native.cleanup()).toThrow('unknown')
})
it('pins unknown Job consumption and starts fallback termination without repeating close',()=>{
 const f=fixture();f.native.prepare();f.native.issue();f.native.assign();const close=f.api.closeHandle;let attempts=0
 f.api.closeHandle=p=>{if(p===1000n){attempts++;throw undefined}return close(p)}
 expect(()=>f.native.recover()).toThrow();expect(f.trace).toContain('terminate');expect(()=>f.native.recover()).toThrow();expect(attempts).toBe(1)
})
