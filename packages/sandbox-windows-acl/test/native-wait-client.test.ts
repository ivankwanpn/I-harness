import { expect, it } from 'vitest'
import type { WaitDrainService } from '../src/native-wait-bridge.ts'
import { createWaitBridgeOwner } from '../src/native-wait-bridge-owner.ts'
import { createWaitDrainService } from '../src/native-wait-bridge.ts'
import { EventEmitter } from 'node:events'
import type { NativePtr } from '../src/ffi.ts'

function startup(service: Promise<WaitDrainService>, cleanup: () => Promise<void>) {
  // Thenable only for the controlled old-owner RED comparison, not a production fallback.
  return { service, cleanup, then: service.then.bind(service) }
}
function ready(service: WaitDrainService) { return startup(Promise.resolve(service), () => service.close()) }
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(yes => { resolve = yes }); return { promise, resolve } }
const fakeService = (): WaitDrainService => ({ ready: Promise.resolve(), reserve() { throw new Error('unused') }, close: async () => {} })
it('shares the original worker, fences leases and joins exit before replacement', async () => {
  class Port extends EventEmitter { messages: any[] = []; postMessage(m: any) { this.messages.push(m) } }
  const ports: Port[] = []
  const owner = createWaitBridgeOwner(() => { const port = new Port(); ports.push(port); const service = createWaitDrainService(port, 'e'); port.emit('message', { type: 'ready', epoch: 'e' }); return ready(service) })
  const a = await owner.acquire('root'), b = await owner.acquire('root')
  const reservation = a.reserve()
  await expect(a.release()).rejects.toThrow(/unresolved/)
  expect(() => a.reserve()).toThrow()
  reservation.release()
  await a.release()
  expect(ports).toHaveLength(1)
  await expect(owner.get('root').then(s => s.close())).rejects.toThrow(/client/)
  const closing = b.release()
  await expect(owner.acquire('root')).rejects.toThrow(/closing/)
  await new Promise(resolve => setImmediate(resolve))
  expect(ports[0].messages.at(-1).type).toBe('shutdown')
  let done = false; void closing.then(() => { done = true })
  ports[0].emit('message', { type: 'shutdown', epoch: 'e' })
  await new Promise(resolve => setImmediate(resolve)); expect(done).toBe(false)
  ports[0].emit('exit', 0); await closing
  const c = await owner.acquire('root'); expect(ports).toHaveLength(2)
  const end = c.release(); await new Promise(resolve => setImmediate(resolve)); ports[1].emit('message', { type: 'shutdown', epoch: 'e' }); ports[1].emit('exit', 0); await end
})

it('retains unknown unregister debt and the original service', async () => {
  class Port extends EventEmitter { postMessage(_m: unknown) {} }
  const port = new Port(); let starts = 0
  const owner = createWaitBridgeOwner(() => { starts++; const service = createWaitDrainService(port, 'e'); port.emit('message', { type: 'ready', epoch: 'e' }); return ready(service) })
  const client = await owner.acquire('root'); const reservation = client.reserve()
  const pending = reservation.unregister(1n as NativePtr)
  await new Promise(resolve => setImmediate(resolve))
  port.emit('message', { type: 'unknown', epoch: 'e', id: '1' })
  await expect(pending).rejects.toMatchObject({ outcome: 'unknown' })
  expect(() => reservation.release()).toThrow(/unresolved/)
  await expect(client.release()).rejects.toThrow(/unresolved/)
  const second = await owner.acquire('root'); expect(starts).toBe(1)
  await second.release()
})

it('retains a falsey close failure and retries on the same lease', async () => {
  let attempts = 0, starts = 0
  const owner = createWaitBridgeOwner(() => { starts++; return ready({ ready: Promise.resolve(), reserve() { throw new Error('unused') }, close() { attempts++; return attempts === 1 ? Promise.reject(undefined) : Promise.resolve() } }) })
  const client = await owner.acquire('root')
  await expect(client.release()).rejects.toBeUndefined()
  await expect(owner.acquire('root')).rejects.toThrow(/closing/)
  await client.release(); expect(starts).toBe(1); expect(attempts).toBe(2)
})
it('retires proven no-Worker startup failure for all co-admitted callers and starts once on retry', async () => {
  const original = new Error('missing assets'); let starts = 0, cleanups = 0
  const owner = createWaitBridgeOwner(() => { starts++; return starts === 1 ? startup(Promise.reject(original), async () => { cleanups++ }) : ready(fakeService()) })
  const outcomes = await Promise.allSettled([owner.get('r'), owner.acquire('r'), owner.acquire('r')])
  expect(outcomes.map(outcome => outcome.status === 'rejected' ? outcome.reason : null)).toEqual([original, original, original])
  expect(starts).toBe(1); expect(cleanups).toBe(1)
  const [a,b] = await Promise.all([owner.acquire('r'),owner.acquire('r')]); expect(starts).toBe(2)
  await a.release(); await b.release()
})
it('holds failed-ready startup until its original cleanup joins exit then permits a fresh incarnation', async () => {
  const exit = deferred<void>(); let starts = 0, cleanups = 0
  const owner = createWaitBridgeOwner(() => ++starts === 1 ? startup(Promise.resolve({ ...fakeService(), ready: Promise.reject(0) }), () => { cleanups++; return exit.promise }) : ready(fakeService()))
  const outcomes = Promise.allSettled([owner.acquire('r'),owner.get('r')])
  await new Promise(resolve => setImmediate(resolve))
  await expect(owner.acquire('r')).rejects.toThrow(/closing/)
  expect(cleanups).toBe(1); expect(starts).toBe(1)
  exit.resolve(); const values = await outcomes
  expect(values.every(outcome => outcome.status === 'rejected' && outcome.reason === 0)).toBe(true)
  const client = await owner.acquire('r'); expect(starts).toBe(2); await client.release()
})
it('preserves falsey startup and cleanup failures, retries only original cleanup and ignores old recovery after replacement', async () => {
  const exit = deferred<void>(); let starts = 0, cleanups = 0
  const owner = createWaitBridgeOwner(() => ++starts === 1 ? startup(Promise.reject(undefined), () => ++cleanups === 1 ? Promise.reject(null) : exit.promise) : ready(fakeService()))
  const failure = await owner.acquire('r').catch(error => error)
  expect(failure.errors).toEqual([undefined,null]); expect(failure.cause).toBeUndefined()
  await expect(owner.acquire('r')).rejects.toThrow(/closing/)
  await expect(owner.get('other')).rejects.toThrow(/identity/)
  const a = failure.retryCleanup(), b = failure.retryCleanup(); expect(a).toBe(b); expect(starts).toBe(1)
  await new Promise(resolve => setImmediate(resolve)); expect(cleanups).toBe(2)
  exit.resolve(); await a
  const client = await owner.acquire('r'); expect(starts).toBe(2)
  await failure.retryCleanup(); await owner.get('r'); expect(starts).toBe(2)
  await client.release()
})
it('refuses wrong, forged and detached receivers before any client or reservation action', async () => {
  let reserves = 0, releases = 0, unregisters = 0, rejoins = 0, closes = 0
  const service: WaitDrainService = { ready: Promise.resolve(), close: async () => { closes++ }, reserve() { reserves++; return { unregister: async () => { unregisters++; return { status:0, acknowledge:async()=>{} } }, rejoin() { rejoins++ }, release() { releases++ } } } }
  const owner = createWaitBridgeOwner(() => ready(service)), a = await owner.acquire('r'), b = await owner.acquire('r')
  const reserve = a.reserve, release = a.release
  for (const receiver of [b,{},undefined]) { expect(() => reserve.call(receiver as any)).toThrow(/receiver/); expect(() => release.call(receiver as any)).toThrow(/receiver/) }
  expect(reserves).toBe(0); expect(closes).toBe(0)
  const x = a.reserve(), y = b.reserve()
  for (const receiver of [y,{},undefined]) {
    expect(() => x.unregister.call(receiver as any,1n as NativePtr)).toThrow(/receiver/)
    expect(() => x.rejoin.call(receiver as any)).toThrow(/receiver/)
    expect(() => x.release.call(receiver as any)).toThrow(/receiver/)
  }
  expect(unregisters+rejoins+releases).toBe(0)
  x.release(); x.release(); y.release(); await a.release(); await b.release(); expect(releases).toBe(2); expect(closes).toBe(1)
  const c = await owner.acquire('r'); await a.release(); expect(() => a.reserve()).toThrow(/released/); await expect(x.unregister(1n as NativePtr)).rejects.toThrow(/released/); x.rejoin(); x.release(); expect(unregisters+rejoins).toBe(0); expect(releases).toBe(2); await c.release(); expect(closes).toBe(2)
})
it('retains client debt through real in-flight result, held handoff and callback release refusal; concurrent last release joins exit', async () => {
  class Port extends EventEmitter { messages: any[]=[]; postMessage(m:any){this.messages.push(m)} }
  const port=new Port(); let starts=0
  const owner=createWaitBridgeOwner(()=>{ starts++; const service=createWaitDrainService(port,'m');port.emit('message',{type:'ready',epoch:'m'});return ready(service) })
  const client=await owner.acquire('r'), raw=await owner.get('r'), reservation=client.reserve()
  await expect(raw.close()).rejects.toThrow(/clients/)
  const stillAllowed=client.reserve();stillAllowed.release()
  let callbackAllowed=false
  const {createRegisteredWait}=await import('../src/native-wait.ts')
  const wait=createRegisteredWait({register:()=>1n as NativePtr,unregister:p=>reservation.unregister(p),rejoin:()=>reservation.rejoin(),release(){if(!callbackAllowed)throw new Error('callback release held');reservation.release()}})
  const retiring=wait.close();void retiring.catch(()=>{})
  await new Promise(resolve=>setImmediate(resolve));expect(port.messages.at(-1).type).toBe('drain')
  await expect(client.release()).rejects.toThrow(/unresolved/)
  port.emit('message',{type:'result',epoch:'m',id:'1',status:0})
  await new Promise(resolve=>setImmediate(resolve));expect(port.messages.at(-1).type).toBe('ack')
  await expect(client.release()).rejects.toThrow(/unresolved/)
  port.emit('message',{type:'acknowledged',epoch:'m',id:'1'})
  await expect(retiring).rejects.toThrow(/callback release held/)
  await expect(client.release()).rejects.toThrow(/unresolved/)
  callbackAllowed=true;await wait.close()
  expect(port.messages.filter(m=>m.type==='drain')).toHaveLength(1)
  const a=client.release(), b=client.release();expect(a).toBe(b)
  await expect(owner.acquire('r')).rejects.toThrow(/closing/)
  await new Promise(resolve=>setImmediate(resolve));expect(port.messages.filter(m=>m.type==='shutdown')).toHaveLength(1)
  port.emit('message',{type:'shutdown',epoch:'m'})
  let joined=false;void a.then(()=>{joined=true});await new Promise(resolve=>setImmediate(resolve));expect(joined).toBe(false)
  port.emit('exit',0);await a;expect(starts).toBe(1)
})
it('retains wrapper debt after original reservation release refusal and decrements once after acknowledgment', async () => {
  let releases=0, closes=0
  const service:WaitDrainService={ready:Promise.resolve(),close:async()=>{closes++},reserve(){return {unregister:async()=>({status:0,acknowledge:async()=>{}}),rejoin(){},release(){if(++releases===1)throw new Error('original ownership not settled')}}}}
  const owner=createWaitBridgeOwner(()=>ready(service)),client=await owner.acquire('r'),reservation=client.reserve()
  expect(()=>reservation.release()).toThrow(/not settled/)
  await expect(client.release()).rejects.toThrow(/unresolved/);expect(()=>client.reserve()).toThrow(/released/)
  reservation.release();reservation.release();expect(releases).toBe(2)
  await client.release();await client.release();expect(closes).toBe(1)
})
it('raw unleased debt prevents final client shutdown and same original close completes only after raw release', async () => {
  class Port extends EventEmitter {messages:any[]=[];postMessage(m:any){this.messages.push(m)}}
  const port=new Port();let starts=0
  const owner=createWaitBridgeOwner(()=>{starts++;const service=createWaitDrainService(port,'raw');port.emit('message',{type:'ready',epoch:'raw'});return ready(service)})
  const raw=await owner.get('r'),client=await owner.acquire('r'),reservation=raw.reserve()
  await expect(raw.close()).rejects.toThrow(/clients/);expect(port.messages).toHaveLength(0)
  await expect(client.release()).rejects.toThrow(/unresolved/)
  await expect(owner.acquire('r')).rejects.toThrow(/closing/)
  reservation.release()
  const end=client.release();await new Promise(resolve=>setImmediate(resolve));expect(port.messages.at(-1).type).toBe('shutdown')
  port.emit('message',{type:'shutdown',epoch:'raw'});port.emit('exit',0);await end;expect(starts).toBe(1)
})
it('does not infer clean startup from a generic throwing factory or its error text', async () => {
  const original=new Error('missing assets');let starts=0
  const owner=createWaitBridgeOwner(()=>{starts++;throw original})
  const failure=await owner.acquire('r').catch(error=>error)
  expect(failure.errors[0]).toBe(original)
  await expect(failure.retryCleanup()).rejects.toThrow(/unknown/)
  await expect(owner.acquire('r')).rejects.toThrow(/closing/)
  expect(starts).toBe(1)
})
it('old co-admitted startup rejection continuation cannot clear a newly admitted incarnation', async () => {
  const original=new Error('startup');let starts=0
  const owner=createWaitBridgeOwner(()=>++starts===1?startup(Promise.reject(original),async()=>{}):ready(fakeService()))
  const replacement=owner.acquire('r').catch(error=>{expect(error).toBe(original);return owner.acquire('r')})
  const old=owner.get('r').catch(error=>{expect(error).toBe(original)})
  const client=await replacement;await old;await owner.get('r');expect(starts).toBe(2)
  await client.release()
})
