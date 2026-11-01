import { beforeEach, expect, it, vi } from 'vitest'
const state=vi.hoisted(()=>({events:[] as string[],outputs:{process:20n,thread:21n,pid:42},decodeProcess:0,decodeThread:0,decodePid:0,issue:vi.fn(),status:259}))
vi.mock('../src/pipe-stdio.ts',()=>({acquireChildStdio:()=>[10n,11n,12n]}))
vi.mock('../src/startup-attributes.ts',()=>({prepareChildStartup:()=>({startupInfo:30n,creationFlags:0x80000,assertCurrent(){},close(){state.events.push('startup-close')}})}))
vi.mock('../src/pipe-process-info.ts',async original=>{
  const actual=await original<any>()
  return {...actual,createProcessInfoSlot:(_owner:any,issue:any)=>actual.createProcessInfoState({issue:()=>issue(40n),lastError:()=>5,
    readProcess:()=>{if(state.decodeProcess-->0) throw new Error('process decode');return state.outputs.process},
    readThread:()=>{if(state.decodeThread-->0) throw new Error('thread decode');return state.outputs.thread},
    readPid:()=>{if(state.decodePid-->0) throw new Error('pid decode');return state.outputs.pid},
  })}
})
vi.mock('../src/ffi.ts',async original=>({...await original<any>(),allocUint32:()=>50n,encodeUint32(){},decodeUint32:()=>state.status}))
vi.mock('koffi',async original=>{const actual=await original<any>();return {...actual,default:{...actual.default,free:()=>{state.events.push('free')}}}})
import { createPipeChildNative } from '../src/pipe-child-native.ts'
import type { NativePtr, Win32Bindings } from '../src/ffi.ts'
beforeEach(()=>{state.events=[];state.decodeProcess=state.decodeThread=state.decodePid=0;state.issue.mockReset();state.issue.mockReturnValue(1)})
function native(close=(p:NativePtr)=>{state.events.push(`close-${p}`);return 1}) {
  const api={createProcessAsUserExW:state.issue,closeHandle:close,getLastError:()=>5,terminateProcess:()=>{state.events.push('terminate');return 1},getExitCodeProcess:()=>{state.events.push('status');return 1}} as unknown as Win32Bindings
  return createPipeChildNative(api,1n as NativePtr,{command:'cmd',args:[],cwd:'C:\\'},()=>{})
}
it('issues the original slot once with exact inherited whitelist flags and caches signalled DWORD259',async()=>{
  const n=native();n.prepare(11n as NativePtr,12n as NativePtr);n.issue();expect(n.phase()).toBe('created');expect(state.issue.mock.calls[0]).toEqual([1n,null,'cmd',null,null,1,0x80000,null,'C:\\',30n,40n]);await n.closeLaunch();expect(n.exitCode()).toBe(259);expect(n.exitCode()).toBe(259);n.cleanup();n.cleanup();expect(state.events.filter(e=>e==='status')).toHaveLength(1);expect(state.events.filter(e=>e==='close-20')).toHaveLength(1);expect(state.issue).toHaveBeenCalledTimes(1)
})
it('retains successful issue before independent output decode failure and recovers originals without relaunch',async()=>{
  const n=native();n.prepare(11n as NativePtr,12n as NativePtr);n.issue();state.decodeProcess=1;await expect(n.closeLaunch()).rejects.toThrow('outputs unresolved');expect(n.phase()).toBe('created');expect(state.events).not.toContain('close-21');n.terminate();await n.closeLaunch();n.cleanup();expect(state.events).toContain('close-21');expect(state.events).toContain('close-20');expect(state.issue).toHaveBeenCalledTimes(1)
})
it('pins unknown-consuming handle close and never repeats it during explicit cleanup',async()=>{
  let closes=0;const n=native(()=>{closes++;throw 0});n.prepare(11n as NativePtr,12n as NativePtr);n.issue();await expect(n.closeLaunch()).rejects.toThrow('unknown');expect(()=>n.cleanup()).toThrow('unknown');expect(closes).toBe(1)
})
