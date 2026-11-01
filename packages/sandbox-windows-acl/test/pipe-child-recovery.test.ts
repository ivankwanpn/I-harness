import { expect, it } from 'vitest'
import { createPipeChildOwner } from '../src/pipe-child.ts'
import { createWin32OutputPipe, type Win32PipeApi } from '../src/win32-overlapped-read.ts'
import type { NativePtr } from '../src/ffi.ts'
import type { createChannelWaitCredit } from '../src/channel-wait-credit.ts'

function gate<T>() { let resolve!: (v:T)=>void, reject!: (e:unknown)=>void; const promise=new Promise<T>((a,b)=>{resolve=a;reject=b});return {promise,resolve,reject} }
const tick=()=>new Promise(resolve=>setImmediate(resolve))
function channel(credit:ReturnType<typeof createChannelWaitCredit>, mode:'read'|'connect'|'healthy', trace:string[], unknown=false) {
  let next=100n, error=535, observations=0, readIssues=0, connectIssues=0, cancelled=false
  const live=new Set<NativePtr>(), memory=new Map<NativePtr,NativePtr|number>(), events:NativePtr[]=[]
  const first=gate<void>(), terminal=gate<void>(), failure=new Error('known registration failure')
  const allocate=()=>{const p=next++ as NativePtr;live.add(p);return p}
  const api:Win32PipeApi={
    alloc:()=>allocate(),free:p=>{trace.push('free');expect(live.delete(p)).toBe(true)},zero(){},pointer(){},
    uint32:p=>Number(memory.get(p)??0),decodePointer:p=>memory.get(p) as NativePtr,bytes:()=>Buffer.alloc(0),securityAttributes(){},
    convertSecurity:(_s,slot)=>{memory.set(slot,allocate());return 1},localFree:p=>{expect(live.delete(p)).toBe(true);return null},
    createEvent:()=>allocate(),createNamedPipe:()=>allocate(),openClient:()=>allocate(),
    clientPid:(_h,slot)=>{memory.set(slot,process.pid);return 1},
    connect:()=>{connectIssues++;error=mode==='connect'?997:535;return 0},
    read:()=>{readIssues++;error=mode==='healthy'?109:997;return 0},
    result:()=>{trace.push('result');expect(cancelled).toBe(true);error=995;return 0},
    cancel:()=>{trace.push('cancel');cancelled=true;return 1},reset:()=>1,
    close:p=>{trace.push('handle-close');expect(live.delete(p)).toBe(true);return 1},lastError:()=>error,
    observe:event=>{
      const reservation=credit.reserve();observations++;events.push(event);trace.push(`observe-${observations}`)
      let closed=false
      return {signalled:observations===1?first.promise:terminal.promise,async close(){
        if(unknown) throw new Error('unknown unregister consumption')
        if(!closed) {trace.push('observer-close');reservation.release();closed=true}
      }}
    },
  }
  return {pipe:createWin32OutputPipe('S-1-5-5-1-2',api),live,events,failure,first,terminal,
    observations:()=>observations,readIssues:()=>readIssues,connectIssues:()=>connectIssues}
}

function fixture(mode:'read'|'connect',unknown=false) {
  const trace:string[]=[],root=gate<void>()
  let reservations=0,releases=0,clientReleases=0,launches=0,phase='not-issued'
  const client={ready:Promise.resolve(),reserve(){reservations++;let released=false;return {unregister:async()=>0 as never,rejoin(){},release(){expect(released).toBe(false);released=true;releases++}}},async release(){trace.push('client-release');clientReleases++}}
  const channels:ReturnType<typeof channel>[]=[]
  const native={prepare(){},issue(){launches++;phase='created'},phase:()=>phase,process:()=>1n,pid:()=>42,thread:()=>2n,closeLaunch:async()=>{},terminate(){trace.push('terminate');root.resolve()},exitCode:()=>0,cleanup(){trace.push('native-cleanup')}}
  const owner=createPipeChildOwner({command:'cmd',args:[],cwd:'C:\\'},{api:{} as never,token:1n as NativePtr,logonSid:'S-1-5-5-1-2',assertLaunchCurrent(){},acquireWaitClient:async()=>client},{
    native:()=>native as never,
    pipe:(_sid,credit,i)=>{const c=channel(credit,i===0?mode:'healthy',trace,unknown&&i===0);channels.push(c);return c.pipe},
    observe:(_handle,reservation)=>{let closed=false;return {setup:Promise.resolve(),signalled:root.promise,async close(){if(!closed){reservation.release();closed=true}}}},
  })
  return {owner,channels,trace,counts:()=>({reservations,releases,clientReleases,launches})}
}

it.each(['read','connect'] as const)('retains original %s event capacity through known failed registration and canceled I/O ACK',async mode=>{
  const f=fixture(mode),start=f.owner.start();void start.catch(()=>{})
  const child=mode==='read'?await start:undefined
  if(mode==='connect') await tick()
  const c=f.channels[0]!
  const originalStorage=[...c.live]
  expect(c.observations()).toBe(1);c.first.reject(c.failure)
  await tick()
  expect(f.trace).toContain('cancel')
  expect(c.observations()).toBe(2)
  expect(c.events[1]).toBe(c.events[0])
  expect(f.trace.indexOf('cancel')).toBeLessThan(f.trace.indexOf('observe-2'))
  expect(f.trace).not.toContain('result');expect(f.trace).not.toContain('client-release');expect([...c.live]).toEqual(originalStorage)
  c.terminal.resolve()
  if(child) await expect(child.wait()).rejects.toBe(c.failure)
  else await expect(start).rejects.toBe(c.failure)
  await f.owner.joinCleanup()
  expect(f.trace.indexOf('result')).toBeLessThan(f.trace.lastIndexOf('observer-close'))
  expect(c.live.size).toBe(0);expect(f.owner.pending()).toBe(false)
  expect(f.counts().reservations).toBe(f.counts().releases);expect(f.counts().clientReleases).toBe(1)
  expect(c.connectIssues()).toBe(1);expect(c.readIssues()).toBe(mode==='read'?1:0);expect(f.counts().launches).toBe(mode==='read'?1:0)
  if(child) {const historical=child.wait();expect(child.wait()).toBe(historical);await expect(historical).rejects.toBe(c.failure)}
  else {expect(f.owner.start()).toBe(start);await expect(start).rejects.toBe(c.failure)}
})

it('keeps unknown original observer consumption pinned without replacement or early release',async()=>{
  const f=fixture('read',true),child=await f.owner.start(),c=f.channels[0]!
  c.first.reject(c.failure);await expect(child.wait()).rejects.toBeInstanceOf(AggregateError)
  await expect(f.owner.joinCleanup()).rejects.toBeInstanceOf(AggregateError)
  expect(c.observations()).toBe(1);expect(c.live.size).toBeGreaterThan(0);expect(f.counts().clientReleases).toBe(0);expect(f.owner.pending()).toBe(true);expect(c.readIssues()).toBe(1)
})
