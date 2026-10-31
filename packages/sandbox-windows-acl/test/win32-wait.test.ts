import { beforeEach, expect, it, vi } from 'vitest'
const state = vi.hoisted(() => ({
  setupFailure: undefined as unknown, failSetup: false, failBinding: false, failAlloc: false, registerThrows: false, decoded: 77n, nativeCalls: 0, freeFails: 0, registered: 1, decodeFails: 0, releaseFails: 0, frees: 0, releases: 0,
  immediate: false, callback: undefined as (() => void) | undefined,
  nativeArguments: [] as unknown[],
  prototypeArguments: [] as unknown[],
}))
vi.mock('koffi', () => ({ default: {
  proto: (...args: unknown[]) => { state.prototypeArguments = args; return 'callback' },
  pointer: (type: unknown) => ({ type }),
  alloc: () => { if(state.failAlloc) throw state.setupFailure; return 10n },
  encode: () => {},
  decode: () => { if (state.decodeFails-- > 0) throw new Error('decode failed'); return state.decoded },
  free: () => { if(state.freeFails-- > 0) throw new Error('slot free held'); state.frees++ },
  register: (callback: () => void) => { state.callback = callback; return 20n },
  unregister: () => { state.releases++; if (state.releaseFails-- > 0) throw new Error('callback release failed') },
  load: () => { if(state.failSetup) throw state.setupFailure; return { func: (_abi: string, name: string) => { if(state.failBinding) throw state.setupFailure; return name === 'GetLastError' ? () => 5 : (...args: unknown[]) => { state.nativeCalls++; state.nativeArguments = args; if(state.immediate) state.callback!(); if(state.registerThrows) throw state.setupFailure; return state.registered } } } },
} }))
import { registerWin32Wait, registerWin32WaitWithReservation } from '../src/win32-wait.ts'
import type { NativePtr } from '../src/ffi.ts'
function provider(unregister: (handle: NativePtr) => Promise<number>) { return { reserve: () => ({ unregister: async (handle: NativePtr) => ({ status: await unregister(handle), acknowledge: async () => {} }), release: () => {}, rejoin: () => {} }) } }
beforeEach(() => { state.immediate = false; state.failSetup = false; state.failBinding = false; state.failAlloc = false; state.registerThrows = false; state.decoded = 77n; state.setupFailure = undefined; state.nativeCalls = 0; state.freeFails = 0; state.registered = 1; state.decodeFails = 0; state.releaseFails = 0; state.frees = 0; state.releases = 0 })

it('uses BOOLEAN callback ABI and one-shot infinite wait, retaining native slot until ACK', async () => {
  let ack!: (code: number) => void
  const unregister = vi.fn(() => new Promise<number>(r => { ack = r }))
  const wait = registerWin32Wait(42n as NativePtr, provider(unregister))
  expect(state.prototypeArguments).toEqual(['__stdcall', 'void', ['void *', 'uint8']])
  expect(state.nativeArguments).toEqual([10n, 42n, 20n, null, 0xffffffff, 8])
  state.callback!()
  await wait.signalled
  const closing = wait.close()
  expect(state.frees).toBe(0); expect(state.releases).toBe(0)
  ack(0); await closing
  expect(unregister).toHaveBeenCalledWith(77n)
  expect(state.frees).toBe(1); expect(state.releases).toBe(1)
})

it('returns an owned failed observer for native registration failure', async () => {
  state.registered = 0
  const unregister = vi.fn(async () => 0)
  const wait = registerWin32Wait(42n as NativePtr, provider(unregister))
  await expect(wait.signalled).rejects.toMatchObject({ api: 'RegisterWaitForSingleObject', win32Code: 5 })
  expect(state.frees).toBe(0)
  await wait.close()
  expect(unregister).not.toHaveBeenCalled()
  expect(state.frees).toBe(1)
})

it('retains a successful native registration even if decoding its out-slot throws', async () => {
  state.decodeFails = 1
  const unregister = vi.fn(async () => 0)
  const wait = registerWin32Wait(42n as NativePtr, provider(unregister))
  await expect(wait.signalled).rejects.toThrow('decode failed')
  await wait.close()
  expect(unregister).toHaveBeenCalledWith(77n)
  expect(state.frees).toBe(1)
})

it('retries failed trampoline release without resubmitting native unregister', async () => {
  state.releaseFails = 1
  const unregister = vi.fn(async () => 0)
  const wait = registerWin32Wait(42n as NativePtr, provider(unregister))
  await expect(wait.close()).rejects.toThrow('callback release failed')
  expect(state.frees).toBe(0)
  await wait.close()
  expect(unregister).toHaveBeenCalledTimes(1)
  expect(state.frees).toBe(1)
})
it('returns original failed setup ownership after legacy reserve with no native registration/unregister', async () => {
  const setup = new Error('allocation failed');state.failAlloc=true;state.setupFailure=setup
  let reserves=0,releases=0,unregisters=0,refuse=true
  const service={reserve(){reserves++;return {unregister:async()=>{unregisters++;return {status:0,acknowledge:async()=>{}}},rejoin(){},release(){releases++;if(refuse)throw new Error('original release refused')}}}}
  const wait=registerWin32Wait(42n as NativePtr,service)
  await expect(wait.signalled).rejects.toBe(setup)
  const failure=await wait.close().catch(error=>error)
  expect(failure.errors[0]).toBe(setup)
  refuse=false;await wait.close()
  expect(reserves).toBe(1);expect(releases).toBe(2);expect(unregisters).toBe(0);expect(state.nativeCalls).toBe(0)
})
it('supplied active credit survives falsey binding failure, fence and exact original cleanup without renewal', async () => {
  const {createChannelWaitCredit}=await import('../src/channel-wait-credit.ts')
  state.failSetup=true;state.setupFailure=undefined
  let reserves=0,releases=0,unregisters=0
  const initial={unregister:async()=>{unregisters++;return {status:0,acknowledge:async()=>{}}},rejoin(){},release(){releases++}}
  const credit=createChannelWaitCredit({reserve(){reserves++;return initial}},initial)
  const wait=registerWin32WaitWithReservation(42n as NativePtr,credit.reserve())
  await expect(wait.signalled).rejects.toBeUndefined()
  credit.fence();await wait.close();await wait.close()
  expect(reserves).toBe(0);expect(releases).toBe(1);expect(unregisters).toBe(0);expect(state.nativeCalls).toBe(0)
})
import { EventEmitter } from 'node:events'
import { createChannelWaitCredit } from '../src/channel-wait-credit.ts'
import { createWaitBridgeOwner } from '../src/native-wait-bridge-owner.ts'
import { createWaitDrainService } from '../src/native-wait-bridge.ts'
import { createDrainWorkerProtocol, type WorkerMessage } from '../src/native-wait-protocol.mjs'
const turn=()=>new Promise<void>(resolve=>setImmediate(resolve))
async function issued(refuse?:()=>boolean) {
  const port=new EventEmitter() as EventEmitter & {postMessage(message:unknown):void}
  const replies:WorkerMessage[]=[];const addresses:bigint[]=[];let drains=0,reserves=0
  const handle=createDrainWorkerProtocol({epoch:'credit',capacity:3,drain:p=>{addresses.push(p);drains++;return 0},send:reply=>{if(reply.type==='shutdown')queueMicrotask(()=>{port.emit('message',reply);port.emit('exit',0)});else replies.push(reply)},shutdown(){}})
  port.postMessage=message=>handle(message)
  const raw=createWaitDrainService(port,'credit',3);port.emit('message',{type:'ready',epoch:'credit'})
  const service={ready:raw.ready,reserve(){reserves++;return raw.reserve()},close:()=>raw.close()}
  const owner=createWaitBridgeOwner(()=>({service:Promise.resolve(service),cleanup:()=>service.close()}))
  const client=await owner.acquire('owned'),token=client.reserve(),initial=refuse?{unregister:(p:NativePtr)=>token.unregister(p),rejoin:()=>token.rejoin(),release(){if(refuse())throw new Error('original release held');token.release()}}:token,credit=createChannelWaitCredit(client,initial)
  const deliver=(type:string)=>{const index=replies.findIndex(reply=>reply.type===type);expect(index).toBeGreaterThanOrEqual(0);port.emit('message',replies.splice(index,1)[0])}
  return{client,credit,deliver,replies,port,addresses,reserves:()=>reserves,drains:()=>drains}
}
it('supplied registration keeps its issued client credit through native result, handoff, trampoline and slot ACK before one renewal',async()=>{
  const f=await issued();const wait=registerWin32WaitWithReservation(42n as NativePtr,f.credit.reserve())
  expect(f.reserves()).toBe(1);expect(state.nativeCalls).toBe(1)
  state.callback!();await wait.signalled
  const closing=wait.close();void closing.catch(()=>{});await turn()
  expect(f.drains()).toBe(1);expect(f.reserves()).toBe(1);expect(state.releases+state.frees).toBe(0)
  f.deliver('result');await turn();expect(f.reserves()).toBe(1);expect(state.releases).toBe(0)
  state.releaseFails=1;f.deliver('acknowledged');await expect(closing).rejects.toThrow(/callback release failed/)
  expect(state.frees).toBe(0);expect(f.reserves()).toBe(1)
  state.freeFails=1;await expect(wait.close()).rejects.toThrow(/slot free held/)
  expect(state.releases).toBe(2);expect(state.frees).toBe(0);expect(f.reserves()).toBe(1)
  await wait.close();expect(state.releases).toBe(2);expect(state.frees).toBe(1);expect(f.reserves()).toBe(2);expect(f.drains()).toBe(1)
  expect(state.nativeArguments[1]).toBe(42n);expect(f.addresses).toEqual([77n])
  f.credit.fence();f.credit.fence();await f.client.release()
})
it('fences an active supplied registration without early release or renewal and releases an unused final generation once',async()=>{
  const f=await issued();const wait=registerWin32WaitWithReservation(42n as NativePtr,f.credit.reserve())
  f.credit.fence();await expect(f.client.release()).rejects.toThrow(/unresolved/)
  const closing=wait.close();await turn();f.deliver('result');await turn();f.deliver('acknowledged');await closing
  expect(f.reserves()).toBe(1);f.credit.fence();await f.client.release()
})
it('unknown original unregister keeps supplied credit/client pinned with no renewal or new drain',async()=>{
  const f=await issued();const wait=registerWin32WaitWithReservation(42n as NativePtr,f.credit.reserve())
  const closing=wait.close();void closing.catch(()=>{});await turn()
  f.port.emit('message',{type:'unknown',epoch:'credit',id:'1',reason:'lost native outcome'})
  await expect(closing).rejects.toMatchObject({outcome:'unknown'})
  f.credit.fence();await expect(wait.close()).rejects.toMatchObject({outcome:'unknown'})
  await expect(f.client.release()).rejects.toThrow(/unresolved/)
  expect(f.drains()).toBe(1);expect(f.reserves()).toBe(1);expect(state.releases+state.frees).toBe(0)
})
it('supplied setup failure returns a live exact-client cleanup capability, including refusing release',async()=>{
  let refuse=true;const f=await issued(()=>refuse);state.failBinding=true;const setup=new Error('bind');state.setupFailure=setup
  const wait=registerWin32WaitWithReservation(42n as NativePtr,f.credit.reserve());await expect(wait.signalled).rejects.toBe(setup)
  f.credit.fence();const failure=await wait.close().catch(error=>error);expect(failure.errors[0]).toBe(setup);await expect(f.client.release()).rejects.toThrow(/unresolved/);refuse=false;await wait.close();await wait.close();expect(f.reserves()).toBe(1);expect(f.drains()).toBe(0);await f.client.release()
})
it('falsey renewal failure retains old release ACK and exact wait-close retry completes only after fence',async()=>{
  let releases=0,reserves=0
  const original={unregister:async()=>({status:0,acknowledge:async()=>{}}),rejoin(){},release(){releases++}}
  const credit=createChannelWaitCredit({reserve(){reserves++;throw undefined}},original)
  const wait=registerWin32WaitWithReservation(42n as NativePtr,credit.reserve())
  await expect(wait.close()).rejects.toBeUndefined();await expect(wait.close()).rejects.toBeUndefined()
  expect(releases).toBe(1);expect(reserves).toBe(1);expect(state.releases).toBe(1);expect(state.frees).toBe(1)
  credit.fence();await wait.close();await wait.close();expect(releases).toBe(1);expect(reserves).toBe(1)
})
it('binds legacy APIs before reserving and accepts supplied platform failure as owned cleanup',async()=>{
  let reserves=0,releases=0
  const reservation={unregister:async()=>{throw Error('must not unregister')},rejoin(){},release(){releases++}}
  state.failSetup=true;state.setupFailure=new Error('load failed')
  expect(()=>registerWin32Wait(42n as NativePtr,{reserve(){reserves++;return reservation}})).toThrow('load failed');expect(reserves).toBe(0)
  state.failSetup=false
  const platform=Object.getOwnPropertyDescriptor(process,'platform')!
  let wait:ReturnType<typeof registerWin32WaitWithReservation>
  try{Object.defineProperty(process,'platform',{value:'unsupported'});wait=registerWin32WaitWithReservation(42n as NativePtr,reservation)}finally{Object.defineProperty(process,'platform',platform)}
  await expect(wait!.signalled).rejects.toThrow(/Windows x64/);await wait!.close();expect(releases).toBe(1);expect(state.nativeCalls).toBe(0)
})
it('uses a supplied native registration with all three pre-admitted original credits and no fourth reserve',async()=>{
  const f=await issued(),root=f.client.reserve(),stderr=f.client.reserve()
  expect(f.reserves()).toBe(3)
  const wait=registerWin32WaitWithReservation(42n as NativePtr,f.credit.reserve());expect(f.reserves()).toBe(3)
  f.credit.fence();root.release();stderr.release()
  const closing=wait.close();await turn();f.deliver('result');await turn();f.deliver('acknowledged');await closing
  expect(f.reserves()).toBe(3);await f.client.release()
})
it('unknown native registration with no recoverable outslot stays active and preserves a falsey original failure',async()=>{
  const f=await issued();state.registerThrows=true;state.setupFailure=null;state.decoded=0n
  const wait=registerWin32WaitWithReservation(42n as NativePtr,f.credit.reserve())
  await expect(wait.signalled).rejects.toBeNull()
  const failure=await wait.close().catch(error=>error);expect(failure.errors[0]).toBeNull();expect(failure.errors[1]).toMatchObject({outcome:'unknown'})
  f.credit.fence();const retry=await wait.close().catch(error=>error);expect(retry.errors[1]).toBe(failure.errors[1])
  await expect(f.client.release()).rejects.toThrow(/unresolved/)
  expect(state.nativeCalls).toBe(1);expect(f.drains()).toBe(0);expect(f.reserves()).toBe(1);expect(state.frees+state.releases).toBe(0)
})

it('setup completes while the root signal remains pending, and ignores late callback after close', async () => {
  const wait = registerWin32WaitWithReservation(42n as NativePtr, provider(async () => 0).reserve())
  let signalled = false; void wait.signalled.then(() => { signalled = true })
  await wait.setup; expect(signalled).toBe(false)
  await wait.close(); state.callback!(); await Promise.resolve(); expect(signalled).toBe(false)
})
it('setup succeeds even when the callback already fired', async () => {
  state.immediate = true
  const wait = registerWin32WaitWithReservation(42n as NativePtr, provider(async () => 0).reserve())
  await wait.setup; await wait.signalled; await wait.close()
})
it('setup reports original known failure and retains close ownership', async () => {
  state.registered = 0
  const wait = registerWin32WaitWithReservation(42n as NativePtr, provider(async () => 0).reserve())
  const signal = wait.signalled.catch(value => value)
  const error = await wait.setup.catch(value => value)
  expect(await signal).toBe(error)
  expect(error).toMatchObject({ api: 'RegisterWaitForSingleObject' }); await wait.close()
})
it('setup reports exact falsey unknown registration failure', async () => {
  state.registerThrows = true; state.setupFailure = null; state.decoded = 0n
  const wait = registerWin32WaitWithReservation(42n as NativePtr, provider(async () => 0).reserve())
  const signal = wait.signalled.catch(value => value)
  await expect(wait.setup).rejects.toBeNull(); expect(await signal).toBeNull()
  await expect(wait.close()).rejects.toMatchObject({ errors: [null, expect.objectContaining({ outcome: 'unknown' })] })
})


