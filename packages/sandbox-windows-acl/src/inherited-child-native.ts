import { NativeInitOwner } from './init-owner.ts'
import { createProcessInfoSlot } from './pipe-process-info.ts'
import { prepareChildStartup, type ChildStdioHandles } from './startup-attributes.ts'
import { decodeUint32, isInvalidHandle, type NativePtr, type Win32Bindings } from './ffi.ts'
import { Win32Error } from './errors.ts'
import { buildCommandLine } from './spawn.ts'
import type { PipeChildInput } from './pipe-child.ts'
import * as abi from './win32-abi.ts'

export type InheritedInput = PipeChildInput & {windowsHide?: boolean}
/** Separate finite owners keep launch retirement from invalidating original
 * process-slot recovery. Borrowed standard handles never enter these ledgers. */
export function createInheritedChildNative(api:Win32Bindings,token:NativePtr,input:InheritedInput,current:()=>void){
 const launch=new NativeInitOwner(api),duplicates=launch.scope(),storage=new NativeInitOwner(api),handles=new NativeInitOwner(api),jobOwner=new NativeInitOwner(api),status=new NativeInitOwner(api)
 let info:ReturnType<typeof createProcessInfoSlot>|undefined,startup:ReturnType<typeof prepareChildStartup>|undefined,job:NativePtr|undefined
 let process:NativePtr|undefined,thread:NativePtr|undefined,pid:number|undefined,closeProcess:(()=>void)|undefined,closeThread:(()=>void)|undefined,closeJob:(()=>void)|undefined
 let jobClosed=false,assigned:'unissued'|'assigned'|'failed'|'unknown'='unissued',resumed:'unissued'|'resumed'|'failed'|'unknown'='unissued'
 let terminated:'unissued'|'done'|'unknown'='unissued',terminationError:unknown,code:number|undefined,codeSlot:NativePtr|undefined
 const bool=(result:number)=>Number.isInteger(result)&&result>=-0x80000000&&result<=0x7fffffff
 const processHandle=():NativePtr=>{if(process===undefined){const value=info!.process() as NativePtr;process=value;closeProcess=handles.deferBool('CloseHandle(process)',()=>api.closeHandle(value))}return process}
 const threadHandle=():NativePtr=>{if(thread===undefined){const value=info!.thread() as NativePtr;thread=value;closeThread=handles.deferBool('CloseHandle(thread)',()=>api.closeHandle(value))}return thread}
 function terminate(){
  if(terminated==='done')return;if(terminated==='unknown')throw terminationError
  const handle=processHandle();terminated='unknown'
  try{const result=api.terminateProcess(handle,1);if(result===0){terminated='unissued';throw new Win32Error('TerminateProcess',api.getLastError())}if(!bool(result))throw new Error('TerminateProcess outcome unknown');terminated='done'}catch(e){terminationError=e;throw e}
 }
 return {
  prepare(){
   current();job=jobOwner.handle(()=>api.createJobObjectW(null,null),'CreateJobObjectW');const originalJob=job;closeJob=()=>{if(!jobClosed){jobOwner.release(originalJob,'handle');jobClosed=true}}
   const limits=Buffer.alloc(abi.JOBOBJECT_EXTENDED_LIMIT_SIZE);limits.writeUInt32LE(abi.JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,abi.JOBOBJECT_EXTENDED_LIMIT_FLAGS_OFFSET)
   const configured=api.setInformationJobObject(job,abi.JobObjectExtendedLimitInformation,limits,limits.length)
   if(configured===0)throw new Win32Error('SetInformationJobObject',api.getLastError())
   if(!bool(configured))throw new Error('Job configuration outcome unknown')
   const host=api.getCurrentProcess()
   const endpoints=[abi.STD_INPUT_HANDLE,abi.STD_OUTPUT_HANDLE,abi.STD_ERROR_HANDLE].map(kind=>{
    const borrowed=api.getStdHandle(kind);if(isInvalidHandle(borrowed))throw new Win32Error('GetStdHandle',api.getLastError())
    const slot=duplicates.slot();return duplicates.output(slot,'handle','DuplicateHandle',()=>api.duplicateHandle(host,borrowed,host,slot,0,1,2))
   }) as unknown as ChildStdioHandles
   startup=prepareChildStartup(launch,endpoints,input.windowsHide)
   info=createProcessInfoSlot(storage,slot=>{current();startup!.assertCurrent();return api.createProcessAsUserExW(token,null,buildCommandLine(input.command,input.args,input.argumentEncoding),null,null,1,abi.CREATE_SUSPENDED|startup!.creationFlags,null,input.cwd,startup!.startupInfo,slot)})
  },
  issue(){info!.issue()},phase:()=>info?.phase()??'not-issued',process:processHandle,thread:threadHandle,pid(){return pid??=info!.pid()},
  assign(){
   if(assigned!=='unissued')throw new Error('Job assignment already issued');const handle=processHandle();assigned='unknown'
   const result=api.assignProcessToJobObject(job!,handle)
   if(!bool(result))throw new Error('Job assignment outcome unknown')
   if(result===0){assigned='failed';throw new Win32Error('AssignProcessToJobObject',api.getLastError())}assigned='assigned'
  },
  resume(){
   if(assigned!=='assigned'||resumed!=='unissued')throw new Error('ResumeThread transition refused');const handle=threadHandle();resumed='unknown'
   const result=api.resumeThread(handle)
   if(!Number.isInteger(result)||result<0||result>0xffffffff)throw new Error('ResumeThread outcome unknown')
   if(result!==1){resumed='failed';if(result===0xffffffff)throw new Win32Error('ResumeThread',api.getLastError());throw new Error(`Unexpected ResumeThread suspend count ${result}`)}resumed='resumed'
  },
  closeLaunch(){
   const errors:unknown[]=[]
   if(info?.phase()==='created'||info?.phase()==='unknown'){
    try{processHandle()}catch(e){errors.push(e)}try{threadHandle()}catch(e){errors.push(e)}try{pid??=info.pid()}catch(e){errors.push(e)}
   }
   if(errors.length)throw new AggregateError(errors,'original inherited outputs unresolved')
   startup?.close();duplicates.cleanup();closeThread?.()
  },
  recover(){
   if(assigned==='assigned'){try{closeJob?.();return}catch(error){try{terminate()}catch(cause){throw new AggregateError([error,cause],'Job close and original termination incomplete')}throw error}}
   terminate()
  },
  closeJob(){closeJob?.()},
  exitCode(){if(code!==undefined)return code;codeSlot??=status.uint32();if(!api.getExitCodeProcess(processHandle(),codeSlot))throw new Win32Error('GetExitCodeProcess',api.getLastError());return code=decodeUint32(codeSlot)},
  cleanup(){
   if(info?.phase()==='unknown'||assigned==='unknown'||resumed==='unknown')throw new Error('inherited native transition outcome unknown; original resources pinned')
   if(info?.phase()==='created'){processHandle();threadHandle();pid??=info.pid();info.acknowledgeOutputHandoff()}
   closeThread?.();closeProcess?.();handles.cleanup();closeJob?.();jobOwner.cleanup();launch.cleanup();status.cleanup();storage.cleanup()
  },
 }
}
