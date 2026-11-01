import assert from 'node:assert/strict'
import { appendFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { verifyWaitAssets } from '../../src/native-wait-assets.mjs'
import { createWaitDrainBridge } from '../../src/native-wait-bridge.ts'
import type { NativePtr } from '../../src/ffi.ts'

const assetRoot = process.env.IH_ACL_NATIVE_ASSET_ROOT
const tracePath = process.env.IH_ACL_NATIVE_TRACE
if (process.env.IH_ACL_NATIVE_QUALIFICATION !== '1' || !assetRoot || !tracePath) throw new Error('explicit isolated native gate required')
if (process.platform !== 'win32' || process.arch !== 'x64') throw new Error('Windows x64 gate only')
assert.ok(process.argv[2] === 'preflight' || process.argv[2] === 'all', 'explicit assigned phase required')
const log = (event: string, detail: unknown = {}) => {
  const line = JSON.stringify({ event, detail }, (_key, value) => typeof value === 'bigint' ? `0x${value.toString(16)}` : value)
  appendFileSync(tracePath, line + '\n'); process.stdout.write(line + '\n')
}
const assets = verifyWaitAssets(assetRoot)
log('assets-verified', assets)
const { default: koffi } = await import('koffi')
assert.equal(koffi.version, '3.1.6')
const overlappedType = koffi.struct({ Internal: 'uintptr_t', InternalHigh: 'uintptr_t', Offset: 'uint32', OffsetHigh: 'uint32', hEvent: 'void *' })
const attributesType = koffi.struct({ nLength: 'uint32', lpSecurityDescriptor: 'void *', bInheritHandle: 'int' })
const abi = { pointer: koffi.sizeof('void *'), overlapped: koffi.sizeof(overlappedType), eventOffset: koffi.offsetof(overlappedType, 'hEvent'), securityAttributes: koffi.sizeof(attributesType), descriptorOffset: koffi.offsetof(attributesType, 'lpSecurityDescriptor'), inheritOffset: koffi.offsetof(attributesType, 'bInheritHandle') }
assert.deepEqual(abi, { pointer: 8, overlapped: 32, eventOffset: 24, securityAttributes: 24, descriptorOffset: 8, inheritOffset: 16 })
log('runtime-identity-and-layout', { node: process.version, executable: process.execPath, koffi: koffi.version, koffiEntry: createRequire(import.meta.url).resolve('koffi'), platform: process.platform, arch: process.arch, abi })
const service = await createWaitDrainBridge(assetRoot)
log('production-worker-ready')
if (process.argv[2] === 'preflight') {
  await service.close()
  log('production-worker-exit-joined')
} else {
  try {
  const { win32PipeApi, createWin32OutputPipe } = await import('../../src/win32-overlapped-read.ts')
  const { registerWin32Wait } = await import('../../src/win32-wait.ts')
  log('native-owner-modules-imported')
  const kernel = koffi.load('kernel32.dll'), advapi = koffi.load('advapi32.dll')
  const bind = (name: string, result: string, args: string[]) => kernel.func('__stdcall', name, result, args)
  const setEvent = bind('SetEvent', 'int', ['void *'])
  const write = bind('WriteFile', 'int', ['void *', 'void *', 'uint32', 'void *', 'void *'])
  const getCurrentProcess = bind('GetCurrentProcess', 'void *', [])
  const lastError = bind('GetLastError', 'uint32', [])
  const close = bind('CloseHandle', 'int', ['void *'])
  const localFree = bind('LocalFree', 'void *', ['void *'])
  const openToken = advapi.func('__stdcall', 'OpenProcessToken', 'int', ['void *', 'uint32', 'void *'])
  const tokenInformation = advapi.func('__stdcall', 'GetTokenInformation', 'int', ['void *', 'int', 'void *', 'uint32', 'void *'])
  const sidString = advapi.func('__stdcall', 'ConvertSidToStringSidW', 'int', ['void *', 'void *'])
  const turn = () => new Promise<void>(resolve => setImmediate(resolve))
  function check(ok: unknown, api: string) { if (!ok) throw Object.assign(new Error(`${api} failed`), { win32Code: lastError() }) }
  function hostLogonSid() {
    const cleanup: Array<() => void> = []
    const alloc = (size: number) => { const p = koffi.alloc('uint8', size) as NativePtr; cleanup.push(() => koffi.free(p)); return p }
    try {
      const tokenSlot = alloc(8), needed = alloc(4), textSlot = alloc(8)
      let token: NativePtr | undefined
      let text: NativePtr | undefined
      let opened = false, converted = false
      cleanup.push(() => { if (converted) { text ??= koffi.decode(textSlot, 'void *') as NativePtr; assert.ok(text); assert.equal(localFree(text), null) } })
      cleanup.push(() => { if (opened) { token ??= koffi.decode(tokenSlot, 'void *') as NativePtr; assert.ok(token); check(close(token), 'CloseHandle(host token)') } })
      check(openToken(getCurrentProcess(), 8, tokenSlot), 'OpenProcessToken'); opened = true
      log('host-token-opened')
      token = koffi.decode(tokenSlot, 'void *') as NativePtr
      const queried = tokenInformation(token, 2, null, 0, needed)
      const queryCode = lastError() as number
      assert.equal(queried, 0); assert.equal(queryCode, 122)
      const size = koffi.decode(needed, 'uint32') as number
      assert.ok(size >= 8 && size <= 65536)
      const groups = alloc(size)
      check(tokenInformation(token, 2, groups, size, needed), 'GetTokenInformation(TokenGroups)')
      log('host-token-groups-read')
      const count = koffi.decode(groups, 'uint32') as number
      assert.ok(count > 0 && count <= 256 && 8 + count * 16 <= size)
      for (let i = 0; i < count; i++) {
        const attributes = koffi.decode(groups, 8 + i * 16 + 8, 'uint32') as number
        if (((attributes & 0xc0000000) >>> 0) !== 0xc0000000) continue
        const sid = koffi.decode(groups, 8 + i * 16, 'void *') as NativePtr
        check(sidString(sid, textSlot), 'ConvertSidToStringSidW'); converted = true
        text = koffi.decode(textSlot, 'void *') as NativePtr
        log('host-logon-sid-string-converted')
        // text points to UTF-16 characters, not a memory slot containing a string pointer.
        const value = koffi.decode(text, 'char16', -1) as string
        assert.match(value, /^S-1-5-5-\d+-\d+$/)
        return value
      }
      throw new Error('host token has no logon SID')
    } finally { for (const release of cleanup.reverse()) release() }
  }
  function instrument(label: string) {
    const api = win32PipeApi(service)
    const memory = new Set<NativePtr>(), handles = new Set<NativePtr>(), descriptors = new Set<NativePtr>()
    const statuses: Array<{ operation: string; ok: number; code?: number }> = []
    let wake!: () => void
    const pending = new Promise<void>(resolve => { wake = resolve })
    const alloc = api.alloc, free = api.free, convert = api.convertSecurity, freeLocal = api.localFree, closeHandle = api.close
    api.alloc = size => { const pointer = alloc(size); assert.ok(!memory.has(pointer)); memory.add(pointer); return pointer }
    api.free = pointer => { assert.ok(memory.has(pointer)); free(pointer); memory.delete(pointer) }
    api.convertSecurity = (sddl, slot) => { const ok = convert(sddl, slot); if (ok) descriptors.add(api.decodePointer(slot)); return ok }
    api.localFree = pointer => { assert.ok(descriptors.has(pointer)); const result = freeLocal(pointer); if (result === null || result === 0n) descriptors.delete(pointer); return result }
    for (const name of ['createEvent', 'createNamedPipe', 'openClient'] as const) {
      const original = api[name] as (...args: any[]) => NativePtr
      ;(api[name] as (...args: any[]) => NativePtr) = (...args) => { const handle = original(...args); if (handle && handle !== -1n && handle !== 0xffffffffffffffffn) handles.add(handle); return handle }
    }
    api.close = handle => { assert.ok(handles.has(handle)); const ok = closeHandle(handle); if (ok) handles.delete(handle); return ok }
    for (const name of ['connect', 'read', 'result', 'cancel'] as const) {
      const original = api[name] as (...args: any[]) => number
      ;(api[name] as (...args: any[]) => number) = (...args) => {
        const ok = original(...args)
        const code = ok ? undefined : api.lastError()
        statuses.push({ operation: name, ok, code })
        log(`${label}:${name}`, { ok, code })
        if (name === 'read' && code === 997) wake()
        return ok
      }
    }
    const observe = api.observe
    api.observe = event => {
      const wait = observe(event)
      return { signalled: wait.signalled, async close() { log(`${label}:unregister-start`); await wait.close(); log(`${label}:unregister-ack`) } }
    }
    return { api, pending, statuses, assertReleased() {
      assert.equal(memory.size, 0); assert.equal(handles.size, 0); assert.equal(descriptors.size, 0)
      log(`${label}:ledger-empty`)
    } }
  }
  const sid = hostLogonSid()
  log('host-logon-sid-extracted', { shape: /^S-1-5-5-/.test(sid) })
  const binary = Buffer.from(Array.from({ length: 513 }, (_, i) => i % 256))
  function writeBytes(handle: NativePtr, bytes: Buffer) {
    const count = koffi.alloc('uint32', 1)
    try { check(write(handle, bytes, bytes.length, count, null), 'WriteFile(host writer)'); assert.equal(koffi.decode(count, 'uint32'), bytes.length) } finally { koffi.free(count) }
  }
  async function eventCase() {
    const api = win32PipeApi(service)
    const event = api.createEvent()
    assert.ok(event)
    let wait: ReturnType<typeof registerWin32Wait> | undefined
    try {
      wait = registerWin32Wait(event, service)
      log('manual-event:registered')
      let done = false
      void wait.signalled.then(() => { done = true })
      await turn(); assert.equal(done, false)
      check(setEvent(event), 'SetEvent')
      log('manual-event:set')
      await wait.signalled
      log('manual-event:callback-observed')
      await Promise.all([wait.close(), wait.close()])
      log('manual-event:signal-and-unregister-ack')
    } finally { if (wait) await wait.close(); check(api.close(event), 'CloseHandle(manual event)') }
  }
  async function pipeCase(mode: 'immediate' | 'pending' | 'empty' | 'cancel' | 'error') {
    const tracked = instrument(mode)
    const owner = createWin32OutputPipe(sid, tracked.api)
    try {
      await owner.initialize()
      if (mode === 'error') {
        const nativeRead = tracked.api.read, writer = owner.writer()
        tracked.api.read = (_handle, buffer, capacity, count, overlapped) => nativeRead(writer, buffer, capacity, count, overlapped)
        await assert.rejects(owner.readAll(), error => (error as { api?: string; win32Code?: number }).api === 'ReadFile' && (error as { win32Code?: number }).win32Code === 5)
      } else if (mode === 'cancel') {
        const reading = owner.readAll()
        const observed = reading.catch(error => error)
        await tracked.pending
        await owner.cancel()
        const error = await observed
        assert.equal(error.api, 'GetOverlappedResult'); assert.equal(error.win32Code, 995)
      } else {
        if (mode === 'immediate') writeBytes(owner.writer(), binary)
        if (mode !== 'pending') await owner.closeWriter()
        const reading = owner.readAll()
        if (mode === 'pending') {
          await tracked.pending
          const reads = tracked.statuses.filter(entry => entry.operation === 'read').length
          await turn(); assert.equal(tracked.statuses.filter(entry => entry.operation === 'read').length, reads)
          writeBytes(owner.writer(), binary)
          await owner.closeWriter()
        }
        assert.deepEqual(await reading, mode === 'empty' ? Buffer.alloc(0) : binary)
        if (mode === 'immediate') assert.ok(tracked.statuses.some(entry => entry.operation === 'read' && entry.ok === 1))
        if (mode === 'pending') assert.ok(tracked.statuses.some(entry => entry.operation === 'read' && entry.code === 997))
      }
    } finally { await owner.cleanup() }
    tracked.assertReleased()
    log(`${mode}:complete`, tracked.statuses)
  }
    await eventCase()
    for (const mode of ['immediate', 'pending', 'empty', 'cancel', 'error'] as const) await pipeCase(mode)
  } catch (error) {
    log('fixture-failure', { message: (error as Error).message, stack: (error as Error).stack, code: (error as { win32Code?: number }).win32Code })
    throw error
  } finally { await service.close(); log('production-worker-exit-joined') }
}
log('qualification-phase-complete', { phase: process.argv[2] ?? 'all' })
