import { describe, it, expect } from 'vitest'
import { createPipeChildOwner } from '../src/pipe-child.ts'
import { createWaitBridgeOwner, WaitBridgeStartupFailure, type WaitDrainBridgeClient } from '../src/native-wait-bridge-owner.ts'
import { createChannelWaitCredit } from '../src/channel-wait-credit.ts'
import type { WaitDrainReservation } from '../src/native-wait-bridge.ts'

function gate<T>() { let resolve!: (v: T) => void, reject!: (e: unknown) => void; const promise = new Promise<T>((a,b) => { resolve=a; reject=b }); return {promise,resolve,reject} }
function fixture(acquire?: () => Promise<WaitDrainBridgeClient>) {
  const root = gate<void>(), out = gate<Buffer>(), err = gate<Buffer>(), release = gate<void>()
  const events: string[] = []; let phase = 'not-issued', reserves = 0, failReserve = 0, issueError: unknown, unknown = false, setupError: unknown, badSetup = false
  const channelCredits: ReturnType<typeof createChannelWaitCredit>[] = []
  const pipes = [out,err].map((g,i) => ({ initialize: async () => {}, writer: () => BigInt(i+10) as never, closeWriter: async () => { events.push('writer') }, readAll: () => g.promise,
    cleanup: async () => { events.push(`cancel${i}`); g.resolve(Buffer.alloc(0)) }, cancel: async () => { events.push(`cancel${i}`); g.resolve(Buffer.alloc(0)) } }))
  const reservation = () => ({unregister: async () => 0 as never, rejoin() {}, release() {events.push('credit-release')} })
  const client = {ready:Promise.resolve(), reserve() { reserves++; events.push('reserve'); if (reserves === failReserve) throw new Error('capacity'); return reservation() }, async release() {events.push('client-release'); await release.promise} }
  const native = {prepare() { events.push('prepare') }, issue() {events.push('issue'); phase = unknown ? 'unknown' : 'created'; if(issueError !== undefined) throw issueError}, phase: () => phase,
    process: () => 20n, thread: () => 21n, pid: () => 42, closeLaunch: async () => {events.push('launch-close')},
    terminate() { events.push('terminate'); root.resolve() }, exitCode: () => 259, cleanup() {events.push('native-cleanup')} }
  const owner = createPipeChildOwner({command:'cmd',args:[],cwd:'C:\\'}, { api:{} as never, token:1n as never,logonSid:'S-1-5-5-1-2',assertLaunchCurrent() {}, acquireWaitClient:acquire ?? (async () => client) }, {
    native: () => native as never, pipe: (_sid, credit, i) => {channelCredits[i]=credit;return pipes[i]!}, observe: (_handle, reservation) => {let closed=false; return {setup:badSetup ? Promise.reject(setupError) : Promise.resolve(),signalled:badSetup ? Promise.reject(setupError) : root.promise,close:async () => {events.push('wait-close');if(!closed) {reservation.release();closed=true}}} },
  })
  return {owner,events,root,out,err,release, native, client, pipes, channelCredits, setReserveFailure(n:number) {failReserve=n}, failIssue(e:unknown,u=false) {issueError=e; unknown=u}, failSetup(e:unknown) {badSetup=true;setupError=e} }
}
describe('original pipe child ownership', () => {
  it('constructs without effects, launches once, preserves tail and awaits last client exit', async () => {
    const f=fixture(); expect(f.events).toEqual([]); const start=f.owner.start(); expect(f.owner.start()).toBe(start)
    const child=await start; expect(Object.keys(child).sort()).toEqual(['pid','wait']); const wait=child.wait(); expect(child.wait()).toBe(wait)
    expect(f.events.slice(0,f.events.indexOf('issue')).filter(e=>e==='reserve')).toHaveLength(3)
    f.root.resolve(); f.out.resolve(Buffer.from('tail')); let done=false; void wait.then(()=>{done=true}); await Promise.resolve(); expect(done).toBe(false)
    f.err.resolve(Buffer.alloc(0)); await new Promise(r=>setImmediate(r)); expect(f.events).toContain('client-release'); expect(done).toBe(false)
    f.release.resolve(); expect(await wait).toEqual({stdout:Buffer.from('tail'),stderr:Buffer.alloc(0),exitCode:259}); expect(f.owner.pending()).toBe(false); expect(f.events.filter(x=>x==='issue')).toHaveLength(1)
  })
  it('reserves three credits before launch and cleans partial admission without launch', async () => {
    const f=fixture(); f.setReserveFailure(3); f.release.resolve(); await expect(f.owner.start()).rejects.toThrow('capacity'); await f.owner.joinCleanup(); expect(f.events).not.toContain('issue'); expect(f.events.filter(x=>x==='credit-release')).toHaveLength(2); expect(f.owner.pending()).toBe(false)
  })
  it('starts root termination and sibling cancellation before joining failed output', async () => {
    const f=fixture(); const child=await f.owner.start(); f.out.reject(0); await new Promise(r=>setImmediate(r)); expect(f.events).toContain('terminate'); expect(f.events).toContain('cancel1'); f.release.resolve(); await expect(child.wait()).rejects.toBe(0); expect(f.owner.pending()).toBe(false)
  })
  it('preserves independent falsey output failures in the immutable whole wait', async () => {
    const f=fixture();const child=await f.owner.start();f.out.reject(0);f.err.reject(undefined);f.release.resolve();const failure=await child.wait().catch(e=>e)
    expect(failure).toBeInstanceOf(AggregateError);expect(failure.errors).toEqual([0,undefined]);expect(f.owner.pending()).toBe(false)
  })
  it('retains unknown launch debt without replay or freeing the slot', async () => {
    const f=fixture(); f.failIssue(new Error('unknown'),true); await expect(f.owner.start()).rejects.toThrow('unknown'); await expect(f.owner.joinCleanup()).rejects.toThrow(); expect(f.events).not.toContain('native-cleanup'); expect(f.owner.pending()).toBe(true); expect(f.events.filter(x=>x==='issue')).toHaveLength(1)
  })
  it('cancels a pending connect sibling before waiting for initialization', async () => {
    const f=fixture(), connect=gate<void>(); f.pipes[0]!.initialize=() => connect.promise
    f.pipes[0]!.cancel=async () => {f.events.push('connect-cancel');connect.resolve()}
    f.pipes[1]!.initialize=async () => {throw new Error('connect failure')}; f.release.resolve()
    await expect(f.owner.start()).rejects.toThrow('connect failure'); await f.owner.joinCleanup(); expect(f.events).toContain('connect-cancel'); expect(f.events).not.toContain('issue')
  })
  it('recovers a created process from original fields after initial pid decode failure', async () => {
    const f=fixture(); let n=0; f.native.pid=() => {if(n++===0) throw new Error('pid decode');return 42}; f.release.resolve()
    await expect(f.owner.start()).rejects.toThrow('pid decode'); await f.owner.joinCleanup(); expect(f.events).toContain('terminate');expect(f.events).toContain('wait-close');expect(f.owner.pending()).toBe(false)
  })
  it('retains root registration failure without publishing success or claiming root exit', async () => {
    const f=fixture(); f.failSetup(false); await expect(f.owner.start()).rejects.toBe(false); await expect(f.owner.joinCleanup()).rejects.toBe(false); expect(f.events).toContain('terminate'); expect(f.events).not.toContain('native-cleanup'); expect(f.owner.pending()).toBe(true)
  })
  it('writer close failure starts recovery and retries only cleanup', async () => {
    const f=fixture(); let closes=0; f.pipes[0]!.closeWriter=async () => {if(closes++===0) throw new Error('writer close')}; f.release.resolve()
    await expect(f.owner.start()).rejects.toThrow('writer close'); await f.owner.joinCleanup(); expect(f.events).toContain('terminate'); expect(f.owner.pending()).toBe(false); expect(f.events.filter(e=>e==='issue')).toHaveLength(1)
  })
  it('keeps historical whole-wait failure while explicit cleanup retries last client release', async () => {
    const f=fixture(); let releases=0; f.client.release=async () => {if(releases++===0) throw new Error('last exit')}
    const child=await f.owner.start(); f.root.resolve(); f.out.resolve(Buffer.alloc(0)); f.err.resolve(Buffer.alloc(0)); const wait=child.wait()
    await expect(wait).rejects.toThrow('last exit'); expect(f.owner.pending()).toBe(true); await f.owner.joinCleanup(); expect(f.owner.pending()).toBe(false); expect(child.wait()).toBe(wait); await expect(wait).rejects.toThrow('last exit'); expect(releases).toBe(2)
  })
  it('disposal joins healthy admitted work without termination', async () => {
    const f=fixture(); await f.owner.start(); const disposal=f.owner.joinCleanup(); await Promise.resolve(); expect(f.events).not.toContain('terminate'); f.root.resolve(); f.out.resolve(Buffer.alloc(0)); f.err.resolve(Buffer.alloc(0)); f.release.resolve(); await disposal; expect(f.owner.pending()).toBe(false)
  })
  it('rejects whole wait on refused rollback requests before a still-pending root can join', async () => {
    const f=fixture(); f.native.terminate=()=>{throw new Error('termination refused')}; const child=await f.owner.start(); f.out.reject(false)
    await expect(child.wait()).rejects.toBeInstanceOf(AggregateError);expect(f.owner.pending()).toBe(true);expect(f.events).not.toContain('native-cleanup')
    f.native.terminate=()=>{f.root.resolve()};f.release.resolve();await f.owner.joinCleanup();expect(f.owner.pending()).toBe(false)
  })
  it('reaches the exact failed-startup cleanup capability without acquiring native resources', async () => {
    let retries=0;const failure=new WaitBridgeStartupFailure(0,false,async()=>{retries++})
    const f=fixture(async()=>{throw failure});await expect(f.owner.start()).rejects.toBe(failure);await f.owner.joinCleanup();expect(retries).toBe(1);expect(f.events).not.toContain('issue');expect(f.owner.pending()).toBe(false)
  })
  it('two independent child owners share accepted client leases and only the last joins service exit', async () => {
    let starts=0,closes=0;const exit=gate<void>();const bridge=createWaitBridgeOwner(()=>{starts++;const service={ready:Promise.resolve(),reserve:()=>({unregister:async()=>0 as never,rejoin(){},release(){}}),close:async()=>{closes++;await exit.promise}};return {service:Promise.resolve(service),cleanup:()=>service.close()}})
    const a=fixture(()=>bridge.acquire('root')),b=fixture(()=>bridge.acquire('root'));const [ca,cb]=await Promise.all([a.owner.start(),b.owner.start()]);expect(starts).toBe(1)
    a.root.resolve();a.out.resolve(Buffer.alloc(0));a.err.resolve(Buffer.alloc(0));await ca.wait();expect(closes).toBe(0);expect(b.owner.pending()).toBe(true)
    b.root.resolve();b.out.resolve(Buffer.alloc(0));b.err.resolve(Buffer.alloc(0));let done=false;void cb.wait().then(()=>{done=true});await new Promise(r=>setImmediate(r));expect(closes).toBe(1);expect(done).toBe(false);exit.resolve();await cb.wait()
  })
  it('supplies the original channel credits for connect then fresh read generations without fourth admission', async () => {
    const f=fixture()
    f.pipes.forEach((pipe,i)=>{
      pipe.initialize=async()=>{f.events.push('connect');f.channelCredits[i]!.reserve().release()}
      const read=pipe.readAll;pipe.readAll=()=>{f.events.push('read');f.channelCredits[i]!.reserve().release();return read()}
    })
    const child=await f.owner.start();expect(f.events.slice(0,f.events.indexOf('connect')).filter(e=>e==='reserve')).toHaveLength(3)
    expect(f.events.filter(e=>e==='reserve')).toHaveLength(7);f.root.resolve();f.out.resolve(Buffer.alloc(0));f.err.resolve(Buffer.alloc(0));f.release.resolve();await child.wait();expect(f.events.filter(e=>e==='credit-release')).toHaveLength(7)
  })
  it('retains renewal failure and fences the acknowledged old generation without double release or launch', async () => {
    const f=fixture();let registration:WaitDrainReservation;f.setReserveFailure(4)
    f.pipes[0]!.initialize=async()=>{registration=f.channelCredits[0]!.reserve();registration.release()}
    f.pipes[0]!.cancel=async()=>{registration.release()};f.release.resolve()
    await expect(f.owner.start()).rejects.toThrow('capacity');await f.owner.joinCleanup();expect(f.events).not.toContain('issue');expect(f.events.filter(e=>e==='credit-release')).toHaveLength(3);expect(f.owner.pending()).toBe(false)
  })
})
