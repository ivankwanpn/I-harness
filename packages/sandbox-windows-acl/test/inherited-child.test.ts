import { expect, it } from 'vitest'
import { createInheritedChildOwner } from '../src/inherited-child.ts'
function gate<T>() {let resolve!:(v:T)=>void,reject!:(e:unknown)=>void;const promise=new Promise<T>((a,b)=>{resolve=a;reject=b});return {promise,resolve,reject}}
function fixture(){
 const ready=gate<void>(),setup=gate<void>(),signal=gate<void>(),ack=gate<void>(),exit=gate<void>(),trace:string[]=[]
 let phase='not-issued'
 const native={prepare(){trace.push('prepare')},issue(){phase='created';trace.push('create')},phase:()=>phase,process:()=>1n,thread:()=>2n,pid:()=>7,assign(){trace.push('assign')},resume(){trace.push('resume')},closeLaunch(){trace.push('launch-close')},recover(){trace.push('recover');signal.resolve()},closeJob(){trace.push('job-close')},exitCode:()=>259,cleanup(){trace.push('native-cleanup')}}
 const client={ready:ready.promise,reserve(){trace.push('reserve');return {unregister:async()=>0 as never,rejoin(){},release(){trace.push('credit-release')}}},async release(){trace.push('release');await exit.promise}}
 const owner=createInheritedChildOwner({command:'cmd',args:[],cwd:'C:\\'},{api:{} as never,token:1n as never,assertLaunchCurrent(){},acquireWaitClient:async()=>client},{native:()=>native as never,observe:(_h,r)=>({setup:setup.promise,signalled:signal.promise,async close(){await ack.promise;r.release()}})})
 return {owner,native,client,trace,ready,setup,signal,ack,exit}
}
it('admits before creation, observes before one resume, and joins callback/client retirement',async()=>{
 const f=fixture(),start=f.owner.start();expect(f.owner.start()).toBe(start);await Promise.resolve();expect(f.trace).toEqual([]);f.ready.resolve();await new Promise(r=>setImmediate(r));expect(f.trace).toEqual(['reserve','prepare','create','assign']);f.setup.resolve();const child=await start;expect(f.trace.filter(x=>x==='resume')).toHaveLength(1);const wait=child.wait();expect(child.wait()).toBe(wait);f.signal.resolve();await new Promise(r=>setImmediate(r));expect(f.trace).not.toContain('native-cleanup');f.ack.resolve();await new Promise(r=>setImmediate(r));expect(f.trace).toContain('release');let done=false;void wait.then(()=>{done=true});await Promise.resolve();expect(done).toBe(false);f.exit.resolve();expect(await wait).toEqual({stdout:Buffer.alloc(0),stderr:Buffer.alloc(0),exitCode:259});expect(f.owner.pending()).toBe(false)
})
it('never resumes or publishes an externally signalled suspended root while setup is held',async()=>{
 const f=fixture(),start=f.owner.start();void start.catch(()=>{});f.ready.resolve();await new Promise(r=>setImmediate(r));f.signal.resolve();await Promise.resolve();f.setup.resolve();await expect(start).rejects.toThrow('before resume');expect(f.trace).not.toContain('resume');f.ack.resolve();f.exit.resolve();await f.owner.joinCleanup()
})
it('initiates recovery on falsey setup failure before root joins and retains cleanup debt',async()=>{
 const f=fixture(),start=f.owner.start();void start.catch(()=>{});f.ready.resolve();await new Promise(r=>setImmediate(r));f.setup.reject(false);await expect(start).rejects.toBe(false);expect(f.trace).toContain('recover');f.ack.resolve();f.exit.resolve();await f.owner.joinCleanup();expect(f.trace).not.toContain('resume')
})
it('exposes refused recovery debt before an unresolved original root join',async()=>{
 const f=fixture();f.native.assign=()=>{throw new Error('assignment')};f.native.recover=()=>{f.trace.push('refused');throw 0}
 const start=f.owner.start();void start.catch(()=>{});f.ready.resolve();f.setup.resolve();await expect(start).rejects.toThrow('assignment');await expect(f.owner.joinCleanup()).rejects.toBe(0);expect(f.trace).not.toContain('resume');expect(f.trace).not.toContain('native-cleanup');f.native.recover=()=>{f.signal.resolve()};f.ack.resolve();f.exit.resolve();await f.owner.joinCleanup();expect(f.owner.pending()).toBe(false)
})
it('retains signalled exit on falsey status failure and cleans before whole wait rejection',async()=>{
 const f=fixture();f.native.exitCode=()=>{throw undefined};const start=f.owner.start();f.ready.resolve();f.setup.resolve();const child=await start;f.signal.resolve();f.ack.resolve();f.exit.resolve();await expect(child.wait()).rejects.toBeUndefined();expect(f.owner.pending()).toBe(false);expect(f.trace).not.toContain('recover')
})
it('capacity refusal rejects before any CreateProcess and releases its original client',async()=>{
 const f=fixture();f.client.reserve=()=>{throw undefined};const start=f.owner.start();f.ready.resolve();f.exit.resolve();await expect(start).rejects.toBeUndefined();await f.owner.joinCleanup();expect(f.trace).not.toContain('create');expect(f.trace).toContain('release')
})
