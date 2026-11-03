import { beforeEach, describe, expect, it, vi } from 'vitest'
const state = vi.hoisted(() => ({ next: 100n, buffers: new Map<bigint, ArrayBuffer>(), values: new Map<bigint, unknown>(), calls: [] as Array<{name:string; result:unknown; args:unknown[]}> }))
vi.mock('koffi', async original => {
  const actual = await original<any>()
  return { ...actual, default: { ...actual.default,
    alloc: (_type: unknown, length: number) => { const pointer = state.next++; state.buffers.set(pointer, new ArrayBuffer(length)); return pointer },
    free: (pointer: bigint) => { if (!state.buffers.delete(pointer)) throw Error('double free'); state.values.delete(pointer) },
    view: (pointer: bigint) => { const buffer = state.buffers.get(pointer); if (!buffer) throw Error('freed view'); return buffer },
    encode: (pointer: bigint, _type: unknown, value: unknown) => { if (!state.buffers.has(pointer)) throw Error('freed encode'); state.values.set(pointer, value) },
    decode: (pointer: bigint) => { if (!state.buffers.has(pointer)) throw Error('freed decode'); return state.values.get(pointer) },
    load: () => ({ func: (_abi: unknown, name: string, result: unknown, args: unknown[]) => { state.calls.push({ name, result, args }); return () => 1 } }),
  } }
})
import koffi from 'koffi'
import * as ffi from '../src/ffi.ts'
import { NativeInitOwner } from '../src/init-owner.ts'
import * as startup from '../src/startup-attributes.ts'

beforeEach(() => { state.next=100n; state.buffers.clear(); state.values.clear(); state.calls.length=0 })
const api = () => ({ getLastError: () => 5, formatMessageW: () => 0 } as unknown as ffi.Win32Bindings)

describe('extended startup ABI and consuming void control', () => {
  it('defines the real nested x64 startup layout and preserves the legacy pointee', async () => {
    const extended = (ffi as any).STARTUPINFOEXW
    expect(extended?.size).toBe(112)
    expect(koffi.offsetof(extended, 'StartupInfo')).toBe(0)
    expect(koffi.offsetof(extended, 'lpAttributeList')).toBe(104)
    const bindings = await ffi.win32()
    expect((bindings as any).createProcessAsUserExW).toBeTypeOf('function')
    const creates = state.calls.filter(call => call.name === 'CreateProcessAsUserW')
    expect(creates).toHaveLength(2)
    expect(creates.map(call => (koffi.type(call.args[9] as any) as any).ref.size).sort()).toEqual([104,112])
    expect(state.calls.find(call => call.name === 'DeleteProcThreadAttributeList')?.result).toBe('void')
  })
  it('owns initialized void control before dependent buffers and deletes once', () => {
    const owner = new NativeInitOwner(api()), pointer = owner.bytes(32)
    let deletes=0
    expect((owner as any).voidControl).toBeTypeOf('function')
    const release = (owner as any).voidControl('initialize', () => 1, 'delete', () => { expect(state.buffers.has(pointer)).toBe(true); deletes++ })
    const current = (owner as any).captureCurrent()
    current(); release(); expect(() => current()).toThrow(); owner.cleanup(); owner.cleanup()
    expect(deletes).toBe(1); expect(state.buffers.size).toBe(0)
  })
  it('pins unknown initialize and delete outcomes without a second consuming call', () => {
    for (const phase of ['initialize','delete']) {
      const owner = new NativeInitOwner(api()), pointer = owner.bytes(32)
      let initializes=0,deletes=0
      expect((owner as any).voidControl).toBeTypeOf('function')
      try { (owner as any).voidControl('initialize', () => { initializes++; if (phase==='initialize') throw undefined; return 1 }, 'delete', () => { deletes++; throw false }) } catch {}
      expect(() => owner.cleanup()).toThrow()
      expect(() => owner.cleanup()).toThrow()
      expect(initializes).toBe(1); expect(deletes).toBe(phase==='delete'?1:0)
      expect(state.buffers.has(pointer)).toBe(true)
    }
  })
  it('does not delete a control whose initialize returned a known failure', () => {
    const owner = new NativeInitOwner(api()); owner.bytes(16)
    let deletes=0
    expect((owner as any).voidControl).toBeTypeOf('function')
    expect(() => (owner as any).voidControl('initialize', () => 0, 'delete', () => { deletes++ })).toThrow()
    owner.cleanup(); expect(deletes).toBe(0); expect(state.buffers.size).toBe(0)
  })
})

function attributeApi(failure?: 'initialize' | 'update' | 'delete' | 'unknown-initialize') {
  const record = { init:0, update:0, deleted:0, list:0n, values:0n, error:122, live: false }
  const bindings = {
    ...api(), getLastError: () => record.error,
    initializeProcThreadAttributeList(list: bigint | null, count: number, flags: number, size: bigint) {
      expect(count).toBe(1); expect(flags).toBe(0)
      if (list === null) { state.values.set(size,160); record.error=122; return 0 }
      record.init++; record.list=list
      expect(state.buffers.get(list)?.byteLength).toBe(160)
      if (failure==='initialize') { record.error=5; return 0 }
      record.live=true
      if (failure==='unknown-initialize') throw Error('initialize return lost')
      return 1
    },
    updateProcThreadAttribute(list: bigint, flags: number, attribute: number, values: bigint, bytes: number, previous: null, returned: null) {
      expect(record.live).toBe(true); expect(list).toBe(record.list); expect(flags).toBe(0)
      expect(attribute).toBe(0x20002); expect(bytes).toBe(24); expect(previous).toBeNull(); expect(returned).toBeNull()
      expect(state.values.get(values)).toEqual([11n,12n,13n]); record.values=values; record.update++
      if (failure==='update') { record.error=5; return 0 }
      return 1
    },
    deleteProcThreadAttributeList(list: bigint) {
      expect(list).toBe(record.list); expect(record.live).toBe(true)
      expect(state.buffers.has(list)).toBe(true)
      if (record.values) expect(state.buffers.has(record.values)).toBe(true)
      record.deleted++; record.live=false
      if (failure==='delete') throw Error('delete return lost')
    },
  } as ffi.Win32Bindings
  return { bindings, record }
}
const handles = [11n,12n,13n] as unknown as startup.ChildStdioHandles
describe('original extended startup resource owner', () => {
  it('builds the exact whitelist and retains its values until attribute deletion', () => {
    const { bindings,record } = attributeApi(), parent = new NativeInitOwner(bindings)
    expect((startup as any).prepareChildStartup).toBeTypeOf('function')
    const prepared = (startup as any).prepareChildStartup(parent, handles)
    expect(state.values.get(prepared.startupInfo)).toMatchObject({ StartupInfo: { cb:112,dwFlags:0x100,hStdInput:11n,hStdOutput:12n,hStdError:13n }, lpAttributeList:record.list })
    expect(prepared.creationFlags).toBe(0x80000); prepared.assertCurrent()
    prepared.close(); prepared.close(); parent.cleanup()
    expect(record).toMatchObject({init:1,update:1,deleted:1}); expect(state.buffers.size).toBe(0)
    expect(() => prepared.assertCurrent()).toThrow()
  })
  it.each(['initialize','update'] as const)('retains initialized-state cleanup after a known %s failure', failure => {
    const {bindings,record}=attributeApi(failure), parent=new NativeInitOwner(bindings)
    expect((startup as any).prepareChildStartup).toBeTypeOf('function')
    expect(() => (startup as any).prepareChildStartup(parent,handles)).toThrow()
    parent.cleanup(); expect(record.deleted).toBe(failure==='update'?1:0); expect(state.buffers.size).toBe(0)
  })
  it.each(['unknown-initialize','delete'] as const)('pins backing storage after %s without reissuing control', failure => {
    const {bindings,record}=attributeApi(failure), parent=new NativeInitOwner(bindings)
    expect((startup as any).prepareChildStartup).toBeTypeOf('function')
    if (failure==='delete') { const prepared=(startup as any).prepareChildStartup(parent,handles); expect(()=>prepared.close()).toThrow(); expect(()=>prepared.assertCurrent()).toThrow() }
    else expect(() => (startup as any).prepareChildStartup(parent,handles)).toThrow()
    expect(()=>parent.cleanup()).toThrow(); expect(()=>parent.cleanup()).toThrow()
    expect(record.deleted).toBe(failure==='delete'?1:0); expect(record.init).toBe(1); expect(state.buffers.size).toBeGreaterThan(0)
  })
  it('rejects invalid whitelists before allocation and expires after parent cleanup', () => {
    const {bindings,record}=attributeApi(),parent=new NativeInitOwner(bindings)
    expect((startup as any).prepareChildStartup).toBeTypeOf('function')
    for (const input of [[11n,11n,13n],[0n,12n,13n],[-1n,12n,13n],[11n,12n]]) expect(()=>(startup as any).prepareChildStartup(parent,input)).toThrow()
    expect(record.init).toBe(0); expect(state.buffers.size).toBe(0)
    const prepared=(startup as any).prepareChildStartup(parent,handles); parent.cleanup()
    expect(()=>prepared.assertCurrent()).toThrow(); expect(record.deleted).toBe(1)
  })
})
