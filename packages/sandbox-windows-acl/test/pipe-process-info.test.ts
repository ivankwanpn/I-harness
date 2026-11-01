import { beforeEach, expect, it, vi } from 'vitest'
const native = vi.hoisted(() => ({ next:100n, buffers:new Map<bigint,ArrayBuffer>(), frees:[] as bigint[], views:0, reads:[] as number[], allocFailure:false, viewFailure:false, freeFailure:false, viewHook:undefined as (()=>void)|undefined, readFailures:new Map<number,unknown>() }))
vi.mock('koffi', async original => {
  const actual = await original<any>()
  return { ...actual, default:{ ...actual.default,
    alloc: (_type:unknown,size:number) => { if(native.allocFailure) throw Error('allocation refused'); const p=native.next++; const b=new ArrayBuffer(size); new Uint8Array(b).fill(0xa5); native.buffers.set(p,b); return p },
    free:(p:bigint)=>{ native.frees.push(p); if(!native.buffers.delete(p)) throw Error('double free'); if(native.freeFailure) throw undefined },
    view:(p:bigint,size:number)=>{ native.views++; expect(size).toBe(24); if(native.viewFailure) throw Error('view refused'); const b=native.buffers.get(p); if(!b) throw Error('freed view'); native.viewHook?.(); return b },
  } }
})
import { createProcessInfoSlot, createProcessInfoState } from '../src/pipe-process-info.ts'
import { NativeInitOwner } from '../src/init-owner.ts'
import { Win32Error } from '../src/errors.ts'
import type { Win32Bindings } from '../src/ffi.ts'
const raw64=DataView.prototype.getBigUint64, raw32=DataView.prototype.getUint32
beforeEach(()=>{
  vi.restoreAllMocks(); native.next=100n; native.buffers.clear(); native.frees=[]; native.views=0; native.reads=[]; native.allocFailure=false; native.viewFailure=false; native.freeFailure=false; native.viewHook=undefined; native.readFailures.clear()
  vi.spyOn(DataView.prototype,'getBigUint64').mockImplementation(function(this:DataView,offset:number,little?:boolean){ native.reads.push(offset); if(native.readFailures.has(offset)){const e=native.readFailures.get(offset);native.readFailures.delete(offset);throw e} return raw64.call(this,offset,little) })
  vi.spyOn(DataView.prototype,'getUint32').mockImplementation(function(this:DataView,offset:number,little?:boolean){ native.reads.push(offset); if(native.readFailures.has(offset)){const e=native.readFailures.get(offset);native.readFailures.delete(offset);throw e} return raw32.call(this,offset,little) })
})
function fixture(){
  const api={ getLastError(){expect(this).toBe(api);return 0xfedcba98} } as Win32Bindings
  return {api,owner:new NativeInitOwner(api)}
}
function write(p:bigint,process=11n,thread=22n,pid=33){ const v=new DataView(native.buffers.get(p)!);v.setBigUint64(0,process,true);v.setBigUint64(8,thread,true);v.setUint32(16,pid,true) }
const capture=(call:()=>unknown)=>{try{call();throw Error('expected exception')}catch(e){return e}}
const handoff=(slot:ReturnType<typeof createProcessInfoSlot>)=>slot.acknowledgeOutputHandoff()

it('records creation before independent decode and never reissues', () => {
  let calls = 0, fail = true
  const source = { issue() { expect(this).toBe(source); calls++; return 1 }, lastError() { expect(this).toBe(source); return 5 }, readProcess() { expect(this).toBe(source); if (fail) throw Error('decode'); return 10n }, readThread() { expect(this).toBe(source); return 20n }, readPid() { expect(this).toBe(source); return 42 } }
  const owner = createProcessInfoState(source)
  owner.issue(); expect(owner.phase()).toBe('created')
  expect(() => owner.process()).toThrow('decode')
  expect(owner.thread()).toBe(20n); expect(owner.pid()).toBe(42)
  fail = false; expect(owner.process()).toBe(10n)
  expect(() => owner.issue()).toThrow(); expect(calls).toBe(1)
})
it('pins unknown issue and distinguishes a known failure', () => {
  const make = (issue: () => number) => createProcessInfoState({ issue, lastError: () => 7, readProcess: () => 1n, readThread: () => 2n, readPid: () => 3 })
  const unknown = make(() => { throw undefined }); expect(() => unknown.issue()).toThrow(); expect(unknown.phase()).toBe('unknown')
  const failed = make(() => 0); expect(() => failed.issue()).toThrow(); expect(failed.phase()).toBe('failed')
})
it('zeros the exact original native slot and hands off decoded output before freeing',()=>{
  const {owner}=fixture();let calls=0
  const s=createProcessInfoSlot(owner,p=>{calls++;expect(p).toBe(100n);expect([...new Uint8Array(native.buffers.get(p)!)]).toEqual(Array(24).fill(0));write(p);return 1})
  expect(native.buffers.get(s.slot)?.byteLength).toBe(24);s.issue();expect(s.phase()).toBe('created')
  expect(s.process()).toBe(11n);expect(s.thread()).toBe(22n);expect(s.pid()).toBe(33)
  expect(native.reads).toEqual([0,8,16]);expect(()=>s.issue()).toThrow();expect(calls).toBe(1)
  handoff(s);owner.cleanup();owner.cleanup();expect(native.frees).toEqual([100n]);expect(()=>s.slot).toThrow()
  expect(s.process()).toBe(11n);expect(s.thread()).toBe(22n);expect(s.pid()).toBe(33);expect(native.reads).toEqual([0,8,16])
})
it.each([false,true])('invalidates slot issue after original retirement, failed free=%s',fail=>{
  const {owner}=fixture();let calls=0;const s=createProcessInfoSlot(owner,()=>{calls++;return 1});native.freeFailure=fail
  if(fail)expect(()=>owner.cleanup()).toThrow();else owner.cleanup()
  expect(()=>s.slot).toThrow();expect(()=>s.issue()).toThrow();expect(calls).toBe(0);expect(native.reads).toEqual([])
  if(fail)expect(()=>owner.cleanup()).toThrow();else owner.cleanup();expect(native.frees).toEqual([100n])
})
it('pins created but unresolved storage and expires uncached reads even after failed retirement',()=>{
  const {owner}=fixture(),s=createProcessInfoSlot(owner,p=>{write(p);return 1});s.issue();expect(s.thread()).toBe(22n)
  expect(()=>owner.cleanup()).toThrow();expect(native.buffers.has(100n)).toBe(true);expect(native.frees).toEqual([])
  expect(()=>s.process()).toThrow();expect(()=>s.pid()).toThrow();expect(()=>s.slot).toThrow();expect(s.thread()).toBe(22n);expect(native.reads).toEqual([8]);expect(()=>handoff(s)).toThrow();expect(()=>owner.cleanup()).toThrow()
})
it('requires explicit output handoff even if all fields are cached and permits handoff after retirement refusal',()=>{
  const {owner}=fixture(),s=createProcessInfoSlot(owner,p=>{write(p);return 1});s.issue();s.process();s.thread();s.pid()
  expect(()=>owner.cleanup()).toThrow();expect(native.frees).toEqual([]);handoff(s);handoff(s);owner.cleanup();expect(native.frees).toEqual([100n]);expect(s.process()).toBe(11n)
})
it.each([undefined,null,false,0,''])('pins falsey unknown issue and never launches again (%j)',cause=>{
  const {owner}=fixture();let calls=0;const s=createProcessInfoSlot(owner,()=>{calls++;throw cause});const error=capture(()=>s.issue())
  expect(error).toMatchObject({cause});expect(s.phase()).toBe('unknown');expect(()=>s.issue()).toThrow();expect(()=>owner.cleanup()).toThrow();expect(()=>owner.cleanup()).toThrow();expect(calls).toBe(1);expect(native.frees).toEqual([])
})
it('allows only explicit recovery handoff of original unknown outputs without asserting launch success',()=>{
  const {owner}=fixture(),s=createProcessInfoSlot(owner,p=>{write(p);throw null});expect(()=>s.issue()).toThrow();expect(s.phase()).toBe('unknown')
  expect(s.process()).toBe(11n);expect(s.thread()).toBe(22n);expect(s.pid()).toBe(33);handoff(s);owner.cleanup();expect(native.frees).toEqual([100n]);expect(s.phase()).toBe('unknown');expect(()=>s.issue()).toThrow()
})
it.each([NaN,undefined,null,true,0x80000000,1.5])('pins malformed BOOL %j without another issue',result=>{
  const {owner}=fixture();let calls=0;const s=createProcessInfoSlot(owner,()=>{calls++;return result as number});expect(()=>s.issue()).toThrow();expect(s.phase()).toBe('unknown');expect(()=>s.issue()).toThrow();expect(()=>owner.cleanup()).toThrow();expect(calls).toBe(1);expect(native.frees).toEqual([])
})
it('retains exact unsigned native API/code on BOOL zero and frees failed output storage',()=>{
  const {owner}=fixture();let calls=0;const s=createProcessInfoSlot(owner,()=>{calls++;return 0});const e=capture(()=>s.issue())
  expect(e).toBeInstanceOf(Win32Error);expect(e).toMatchObject({api:'CreateProcessAsUserW',win32Code:0xfedcba98});expect(s.phase()).toBe('failed');expect(()=>s.issue()).toThrow();expect(calls).toBe(1);owner.cleanup();expect(native.frees).toEqual([100n])
})
it('retains known failed phase when error retrieval throws falsey and blocks reentrant issue',()=>{
  const {api,owner}=fixture();let calls=0;let s:ReturnType<typeof createProcessInfoSlot>
  api.getLastError=function(){expect(this).toBe(api);expect(s.phase()).toBe('failed');expect(()=>s.issue()).toThrow();throw undefined}
  s=createProcessInfoSlot(owner,()=>{calls++;expect(s.phase()).toBe('issuing');expect(()=>s.issue()).toThrow();return 0})
  expect(capture(()=>s.issue())).toBeUndefined();expect(s.phase()).toBe('failed');expect(()=>s.issue()).toThrow();owner.cleanup();expect(calls).toBe(1);expect(native.frees).toEqual([100n])
})
it.each([0,8,16])('recovers a throwing original field %s independently and caches primitive values',offset=>{
  const {owner}=fixture(),s=createProcessInfoSlot(owner,p=>{write(p);return 1});s.issue();const readers=[()=>s.process(),()=>s.thread(),()=>s.pid()];const index=offset===0?0:offset===8?1:2
  native.readFailures.set(offset,undefined);expect(()=>readers[index]!()).toThrow();for(let i=0;i<3;i++)if(i!==index)expect(readers[i]!()).toBe([11n,22n,33][i]);expect(readers[index]!()).toBe([11n,22n,33][index])
  const count=native.reads.length;write(100n,99n,98n,97);expect(s.process()).toBe(11n);expect(s.thread()).toBe(22n);expect(s.pid()).toBe(33);expect(native.reads.length).toBe(count);handoff(s);owner.cleanup()
})
it.each([{offset:0,value:0n},{offset:0,value:0xffffffffffffffffn},{offset:8,value:0n},{offset:8,value:0xffffffffffffffffn},{offset:16,value:0}])('keeps invalid field $offset retryable without erasing other decodes',({offset,value})=>{
  const {owner}=fixture(),s=createProcessInfoSlot(owner,p=>{write(p);const v=new DataView(native.buffers.get(p)!);if(offset===16)v.setUint32(offset,value as number,true);else v.setBigUint64(offset,value as bigint,true);return 1});s.issue()
  const read=()=>offset===0?s.process():offset===8?s.thread():s.pid();expect(read).toThrow();if(offset!==0)expect(s.process()).toBe(11n);if(offset!==8)expect(s.thread()).toBe(22n);if(offset!==16)expect(s.pid()).toBe(33)
  expect(()=>handoff(s)).toThrow();write(100n);expect(read()).toBe(offset===0?11n:offset===8?22n:33);handoff(s);owner.cleanup()
})
it('pins outputs when reentrant retirement occurs inside the synchronous issuer',()=>{
  const {owner}=fixture();let s:ReturnType<typeof createProcessInfoSlot>;let calls=0
  s=createProcessInfoSlot(owner,p=>{calls++;expect(()=>owner.cleanup()).toThrow();expect(native.frees).toEqual([]);write(p);return 1});s.issue();expect(s.phase()).toBe('created');expect(()=>s.process()).toThrow();expect(()=>s.issue()).toThrow();expect(calls).toBe(1);expect(native.reads).toEqual([])
})
it('checks currentness after fallible native view preparation before touching returned storage',()=>{
  const {owner}=fixture();native.viewHook=()=>owner.cleanup();let zeroes=0;const original=Uint8Array.prototype.fill
  vi.spyOn(Uint8Array.prototype,'fill').mockImplementation(function(this:Uint8Array,value:number,start?:number,end?:number){if(value===0)zeroes++;return original.call(this,value,start,end)})
  expect(()=>createProcessInfoSlot(owner,()=>1)).toThrow();expect(zeroes).toBe(0);expect(native.frees).toEqual([100n])
})
it.each(['allocation','view','zeroing'] as const)('retains partial %s setup on the original owner',step=>{
  const {owner}=fixture();if(step==='allocation')native.allocFailure=true;if(step==='view')native.viewFailure=true
  if(step==='zeroing'){const original=Uint8Array.prototype.fill;vi.spyOn(Uint8Array.prototype,'fill').mockImplementation(function(this:Uint8Array,value:number,start?:number,end?:number){if(value===0)throw null;return original.call(this,value,start,end)})}
  expect(()=>createProcessInfoSlot(owner,()=>1)).toThrow();expect(native.buffers.size).toBe(step==='allocation'?0:1);owner.cleanup();owner.cleanup();expect(native.frees).toEqual(step==='allocation'?[]:[100n])
})
it('pins unknown free on the same owner without consuming a reused native address',()=>{
  const {owner}=fixture();native.viewFailure=true;expect(()=>createProcessInfoSlot(owner,()=>1)).toThrow();native.freeFailure=true;expect(()=>owner.cleanup()).toThrow();native.buffers.set(100n,new ArrayBuffer(24));expect(()=>owner.cleanup()).toThrow();expect(()=>owner.transfer(100n as any)).toThrow();expect(native.frees).toEqual([100n]);expect(native.buffers.has(100n)).toBe(true)
})

it('refuses pre-issue reads and handoff without touching the native view',()=>{
  const {owner}=fixture(),s=createProcessInfoSlot(owner,()=>1)
  expect(()=>s.process()).toThrow();expect(()=>s.thread()).toThrow();expect(()=>s.pid()).toThrow();expect(()=>handoff(s)).toThrow();expect(native.reads).toEqual([]);owner.cleanup();expect(native.frees).toEqual([100n])
})
it('refuses transfer of unresolved unknown output storage on the original owner',()=>{
  const {owner}=fixture(),s=createProcessInfoSlot(owner,()=>{throw undefined});const pointer=s.slot
  expect(()=>s.issue()).toThrow();expect(()=>owner.transfer(pointer)).toThrow();expect(native.buffers.has(pointer)).toBe(true);expect(native.frees).toEqual([]);expect(()=>s.slot).toThrow();expect(()=>owner.cleanup()).toThrow()
})
it('refuses direct heap retirement of original unresolved output storage',()=>{
  const {owner}=fixture(),s=createProcessInfoSlot(owner,()=>{throw null});const pointer=s.slot
  expect(()=>s.issue()).toThrow();expect(()=>owner.release(pointer,'heap')).toThrow();expect(native.buffers.has(pointer)).toBe(true);expect(native.frees).toEqual([]);expect(()=>s.slot).toThrow();expect(()=>owner.cleanup()).toThrow()
})
