import { expect, it } from 'vitest'
import { createWin32OutputPipe, type Win32PipeApi } from '../src/win32-overlapped-read.ts'
import type { NativePtr } from '../src/ffi.ts'

function fixture() {
  let next = 10n
  let error = 535
  const live = new Set<NativePtr>()
  const memory = new Map<NativePtr, number | NativePtr | Buffer>()
  const trace: string[] = []
  const alloc = () => { const p = next++ as NativePtr; live.add(p); return p }
  let failFree = false
  let failPeer = false
  let readCalls = 0
  let signal!: () => void
  let ackFail = false
  const api: Win32PipeApi = {
    alloc: () => alloc(), free: p => { trace.push(`free:${p}`); if (failFree) { failFree = false; throw new Error('free debt') } expect(live.delete(p)).toBe(true) },
    zero: () => {}, pointer: (p, _offset, value) => { memory.set(p, value) },
    uint32: p => Number(memory.get(p) ?? 0), decodePointer: p => memory.get(p) as NativePtr,
    bytes: (_p, length) => Buffer.from('tail').subarray(0, length),
    securityAttributes: () => {},
    convertSecurity: (sddl, slot) => { trace.push(sddl); memory.set(slot, alloc()); return 1 },
    localFree: p => { expect(live.delete(p)).toBe(true); return null },
    createEvent: () => alloc(),
    createNamedPipe: (_name, flags, mode, instances) => { trace.push(`server:${flags}:${mode}:${instances}`); return alloc() },
    openClient: (_name, access) => { trace.push(`client:${access}`); return alloc() },
    clientPid: (_handle, slot) => { memory.set(slot, failPeer ? process.pid + 1 : process.pid); return 1 },
    connect: () => 0,
    read: (_handle, _buffer, _capacity, count) => { if (++readCalls === 1) { memory.set(count, 4); return 1 } error = 109; return 0 },
    result: (_handle, _overlapped, count) => { trace.push('result'); memory.set(count, 4); return 1 },
    cancel: () => { trace.push('cancel'); error = 1168; return 0 },
    reset: () => 1, close: p => { trace.push(`close:${p}`); expect(live.delete(p)).toBe(true); return 1 },
    lastError: () => error,
    observe: () => ({ signalled: new Promise<void>(r => { signal = r }), close: async () => { trace.push('ack'); if (ackFail) { ackFail = false; throw new Error('ack debt') } } }),
  }
  return { api, live, trace, error: (code: number) => { error = code }, setFreeFailure: () => { failFree = true }, setPeerFailure: () => { failPeer = true }, pendingConnect: () => { api.connect = () => { error = 997; return 0 } }, signal: () => signal(), failAck: () => { ackFail = true } }
}

it('owns a private preopened pipe and native storage before read, including connected race', async () => {
  const f = fixture()
  const owner = createWin32OutputPipe('S-1-5-5-1-2', f.api)
  await owner.initialize()
  expect(owner.writer()).toBeDefined()
  expect((await owner.readAll()).toString()).toBe('tail')
  // Writer is retained for the launch owner until it explicitly closes its host copy.
  expect(f.live.size).toBe(1)
  await owner.closeWriter()
  expect(f.live.size).toBe(0)
  expect(f.trace).toContain('D:P(A;;0x0012019f;;;S-1-5-5-1-2)')
  expect(f.trace).toContain(`server:${0x40080001}:${8}:1`)
  expect(f.trace).toContain(`client:${0x100002}`)
})

it.each([1, 2, 3, 4, 5, 6])('retains the complete ledger when native allocation %i fails', async stage => {
  const f = fixture()
  const allocate = f.api.alloc
  let calls = 0
  const original = new Error(`allocation ${stage}`)
  f.api.alloc = size => { if (++calls === stage) throw original; return allocate(size) }
  const owner = createWin32OutputPipe('S-1-5-5-1-2', f.api)
  await expect(owner.initialize()).rejects.toBe(original)
  await owner.cleanup()
  expect(f.live.size).toBe(0)
})

it.each(['convertSecurity', 'createEvent', 'createNamedPipe', 'openClient', 'clientPid', 'connect'] as const)('cleans partial acquisition after %s failure and preserves Win32 status', async stage => {
  const f = fixture()
  f.error(5)
  if (stage === 'convertSecurity' || stage === 'clientPid' || stage === 'connect') f.api[stage] = () => 0
  else f.api[stage] = () => -1n as NativePtr
  const owner = createWin32OutputPipe('S-1-5-5-1-2', f.api)
  await expect(owner.initialize()).rejects.toMatchObject({ win32Code: 5 })
  await owner.cleanup()
  expect(f.live.size).toBe(0)
})

it('keeps all read storage until cancellation result and native callback ACK; retries close independently', async () => {
  const f = fixture()
  const owner = createWin32OutputPipe('S-1-5-5-1-2', f.api)
  await owner.initialize()
  await owner.closeWriter()
  f.api.read = () => { f.error(997); return 0 }
  f.api.result = () => { f.trace.push('aborted-result'); f.error(995); return 0 }
  const reading = owner.readAll().catch(error => error)
  await Promise.resolve()
  const closing = owner.cancel()
  await Promise.resolve(); await Promise.resolve()
  const liveBeforeSignal = f.live.size
  expect(f.trace).toContain('cancel') // ERROR_NOT_FOUND is not completion ACK.
  expect(f.trace).not.toContain('aborted-result')
  f.signal()
  await Promise.all([reading, closing])
  expect(liveBeforeSignal).toBeGreaterThan(0)
  expect(f.live.size).toBe(0)
  expect(f.trace.indexOf('ack')).toBeGreaterThan(f.trace.indexOf('aborted-result'))
})

it('preserves a terminal native error and retires the acknowledged read without resubmission', async () => {
  const f = fixture()
  const owner = createWin32OutputPipe('S-1-5-5-1-2', f.api)
  await owner.initialize(); await owner.closeWriter()
  let submitted = 0
  f.api.read = () => { submitted++; f.error(997); return 0 }
  f.api.result = () => { f.error(5); return 0 }
  const reading = owner.readAll()
  await Promise.resolve(); f.signal()
  await expect(reading).rejects.toMatchObject({ api: 'GetOverlappedResult', win32Code: 5 })
  await owner.cleanup()
  expect(submitted).toBe(1)
  expect(f.live.size).toBe(0)
})

it('retries one failed native close without freeing dependent storage prematurely', async () => {
  const f = fixture()
  const owner = createWin32OutputPipe('S-1-5-5-1-2', f.api)
  await owner.initialize(); await owner.closeWriter()
  const close = f.api.close
  let fail = true
  f.api.close = p => { if (fail) { fail = false; f.error(6); return 0 } return close(p) }
  await expect(owner.readAll()).rejects.toMatchObject({ api: 'CloseHandle(CreateNamedPipeW)', win32Code: 6 })
  expect(f.live.size).toBeGreaterThan(0)
  await owner.cleanup()
  expect(f.live.size).toBe(0)
})

it('retains partial acquisition on peer failure and retries individual frees without double free', async () => {
  const f = fixture(); f.setPeerFailure()
  const owner = createWin32OutputPipe('S-1-5-5-1-2', f.api)
  await expect(owner.initialize()).rejects.toThrow(/peer/)
  expect(f.live.size).toBeGreaterThan(0)
  f.setFreeFailure()
  await expect(owner.cleanup()).rejects.toThrow('free debt')
  await owner.cleanup()
  expect(f.live.size).toBe(0)
})

it('acknowledges pending connect and callback drain before reuse; failed ACK is retryable', async () => {
  const f = fixture(); f.pendingConnect(); f.failAck()
  const owner = createWin32OutputPipe('S-1-5-5-1-2', f.api)
  const started = owner.initialize()
  expect(f.live.size).toBeGreaterThan(0)
  f.signal()
  await expect(started).rejects.toThrow('ack debt')
  expect(f.trace.filter(x => x === 'result')).toHaveLength(1)
  await owner.cleanup()
  expect(f.trace.filter(x => x === 'result')).toHaveLength(1)
  expect(f.live.size).toBe(0)
})

it('replaces an owned failed connect observer during cleanup without losing original connect I/O', async () => {
  const f = fixture(); f.pendingConnect()
  let observations = 0
  f.api.observe = () => ({ signalled: ++observations === 1 ? Promise.reject(new Error('registration failed')) : Promise.resolve(), close: async () => { f.trace.push('ack') } })
  const owner = createWin32OutputPipe('S-1-5-5-1-2', f.api)
  await expect(owner.initialize()).rejects.toThrow('registration failed')
  expect(f.live.size).toBeGreaterThan(0)
  await owner.cleanup()
  expect(observations).toBe(2)
  expect(f.live.size).toBe(0)
})
