import { beforeEach, expect, it, vi } from 'vitest'
const state = vi.hoisted(() => ({ next: 100n, live: new Map<bigint, string>(), memory: new Map<bigint, bigint | number>(), failAlloc: false, failClose: 0n, decodeFailures: 0, freeFailures: 0, freeCalls: 0, revokeFails: false, api: {} as any }))
vi.mock('koffi', async original => { const actual = await original<any>(); return { ...actual, default: { ...actual.default, decode: (p: bigint, type: unknown, length: unknown) => type === 'char16' ? 'S-1-5-5-1-2' : actual.default.decode(p, type, length), free: (p: bigint) => { state.freeCalls++; if (state.freeFailures-- > 0) throw new Error('free failed'); if (state.live.get(p) !== 'heap') throw new Error('allocator mismatch'); state.live.delete(p) }, encode: (p: bigint, _type: unknown, value: bigint | number) => { state.memory.set(p, value) } } } })
vi.mock('../src/ffi.ts', async original => { const actual = await original<any>(); const alloc = () => { if (state.failAlloc) { state.failAlloc = false; throw new Error('allocation failed') } const p = state.next++; state.live.set(p, 'heap'); return p }; return { ...actual, allocBytes: alloc, allocUint32: alloc, allocPtrSlot: alloc, decodePtr: (p: bigint) => { if (state.decodeFailures-- > 0) throw new Error('decode failed'); return state.memory.get(p) ?? null }, decodeUint32: (p: bigint) => Number(state.memory.get(p)), encodeUint32: (p: bigint, n: number) => { state.memory.set(p, n) }, decodePtrAt: () => 99n, ptrAddress: (p: bigint) => p, win32: async () => state.api } })
vi.mock('../src/acl.ts', async original => { const actual = await original<any>(); return { ...actual, grantWrite: () => {}, revokeWrite: () => { if (state.revokeFails) throw new Error('revoke failed'); return true } } })
import { openCurrentProcessToken, findLogonSid, makeWellKnownSid, createRestrictedToken, setTokenDefaultDaclGrant } from '../src/token.ts'
import type { NativePtr } from '../src/ffi.ts'
import { AclSandbox, AclWriteGrant } from '../src/index.ts'
import { NativeInitOwner } from '../src/init-owner.ts'
const ptr = (n: bigint) => n as NativePtr
beforeEach(() => {
  state.live.clear(); state.memory.clear(); state.next = 100n; state.failAlloc = false; state.failClose = 0n; state.decodeFailures = 0; state.freeFailures = 0; state.freeCalls = 0; state.revokeFails = false
  const resource = (kind: string) => { const p = state.next++; state.live.set(p, kind); return p }
  state.api = {
    openProcess: () => resource('handle'), closeHandle: (p: bigint) => { if (p === state.failClose) return 0; expect(state.live.get(p)).toBe('handle'); state.live.delete(p); return 1 },
    openProcessToken: (_h: bigint, _r: number, slot: bigint) => { state.memory.set(slot, resource('handle')); return 1 },
    createRestrictedToken: (...args: any[]) => { state.memory.set(args.at(-1), resource('handle')); return 1 },
    getLastError: () => 5, formatMessageW: () => 0,
    getTokenInformation: (_t: bigint, cls: number, buffer: Buffer | null, _n: number, size: bigint) => { state.memory.set(size, 24); if (!buffer) return 0; buffer.writeUInt32LE(cls === 2 ? 1 : 0, 0); if (cls === 2) buffer.writeUInt32LE(0xc0000000, 16); return 1 },
    getLengthSid: () => 12, copySid: () => 0, createWellKnownSid: () => 0, isValidSid: () => 1,
    setEntriesInAclW: (_n: number, _access: unknown, _acl: bigint, slot: bigint) => { state.memory.set(slot, resource('local')); return 0 }, setTokenInformation: () => 0,
    convertSidToStringSidW: (_sid: bigint, slot: bigint) => { state.memory.set(slot, resource('local')); return 1 },
    localFree: (p: bigint) => { expect(state.live.get(p)).toBe('local'); state.live.delete(p); return null },
  }
})

it('failed init exposes its original sandbox cleanup and never admits spawn', async () => {
  const sandbox = new AclSandbox({ mode: 'read-only', writableDirs: [] })
  state.api.copySid = () => { state.failClose = [...state.live].find(([, kind]) => kind === 'handle')![0]; return 0 }
  const failure = await sandbox.init().catch(error => error)
  expect(failure.owner).toBe(sandbox)
  expect(failure.errors[0]).toMatchObject({ api: 'CopySid', win32Code: 5 })
  expect(() => sandbox.spawn({ command: 'must-not-launch' })).toThrow(/not initialized/)
  state.failClose = 0n
  const first = failure.disposeAsync(), second = sandbox.disposeAsync()
  expect(first).toBe(second)
  await first
  expect(state.live.size).toBe(0)
})

it('successful init frees heap SIDs with koffi.free and retries only failed finalization', async () => {
  state.api.copySid = () => 1; state.api.createWellKnownSid = () => 1; state.api.setTokenInformation = () => 1
  const sandbox = new AclSandbox({ mode: 'read-only', writableDirs: [] })
  await sandbox.init()
  expect([...state.live.values()].filter(kind => kind === 'handle')).toHaveLength(1)
  state.failClose = [...state.live].find(([, kind]) => kind === 'handle')![0]
  expect(() => sandbox.dispose()).toThrow('CloseHandle')
  state.failClose = 0n
  await sandbox.disposeAsync()
  expect(state.live.size).toBe(0)
})

it('grant factory retains successful parse out-slot debt before decode and exposes original grant cleanup', async () => {
  state.api.convertStringSidToSidW = (_sid: string, slot: bigint) => { const pointer = state.next++; state.live.set(pointer, 'local'); state.memory.set(slot, pointer); return 1 }
  state.decodeFailures = 2
  let failure: any
  try { AclWriteGrant.create('S-1-4-1-2', state.api) } catch (error) { failure = error }
  expect(failure.owner).toBeInstanceOf(AclWriteGrant)
  await failure.disposeAsync()
  expect(state.live.size).toBe(0)
})

it('failed revocation retains parsed SIDs and init cleanup debt until the same owner retries', async () => {
  state.api.convertStringSidToSidW = (_sid: string, slot: bigint) => { const pointer = state.next++; state.live.set(pointer, 'local'); state.memory.set(slot, pointer); return 1 }
  state.revokeFails = true
  const sandbox = new AclSandbox({ mode: 'workspace-write', writableDirs: [], writeSid: 'S-1-4-1-2', tempDir: process.cwd(), tempWriteSid: 'S-1-4-1-3' })
  const failure = await sandbox.init().catch(error => error)
  expect(failure.owner).toBe(sandbox)
  expect([...state.live.values()].filter(kind => kind === 'local')).toHaveLength(2)
  await expect(sandbox.disposeAsync()).rejects.toThrow(/grant cleanup incomplete/)
  expect([...state.live.values()].filter(kind => kind === 'local')).toHaveLength(2)
  state.revokeFails = false
  await failure.disposeAsync()
  expect(state.live.size).toBe(0)
})

it('synchronous dispose refuses admitted init before mutation; async dispose fences and joins it', async () => {
  const sandbox = new AclSandbox({ mode: 'read-only', writableDirs: [] })
  const initializing = sandbox.init()
  expect(() => sandbox.dispose()).toThrow(/disposeAsync/)
  const closing = sandbox.disposeAsync()
  await expect(initializing).rejects.toThrow(/closed during initialization/)
  await closing
  expect(state.live.size).toBe(0)
})

it('retains default-DACL output decode debt and retries LocalFree before slot release', async () => {
  state.decodeFailures = 2
  let failure: any
  try { setTokenDefaultDaclGrant(state.api, ptr(1n), ptr(2n)) } catch (error) { failure = error }
  expect(failure.disposeAsync).toBeTypeOf('function')
  await failure.disposeAsync()
  expect(state.live.size).toBe(0)
})

it('preserves original SetTokenInformation failure alongside retained LocalFree failure', async () => {
  const localFree = state.api.localFree
  let attempts = 0
  state.api.localFree = (p: bigint) => ++attempts === 1 ? p : localFree(p)
  let failure: any
  try { setTokenDefaultDaclGrant(state.api, ptr(1n), ptr(2n)) } catch (error) { failure = error }
  expect(failure.errors[0]).toMatchObject({ api: 'SetTokenInformation', win32Code: 5 })
  expect(failure.errors[1]).toMatchObject({ api: 'LocalFree', win32Code: 5 })
  await failure.disposeAsync()
  expect(attempts).toBe(2)
  expect(state.live.size).toBe(0)
})
it('closes acquired process if output-slot allocation fails', () => {
  state.failAlloc = true
  expect(() => openCurrentProcessToken(state.api)).toThrow('allocation failed')
  expect(state.live.size).toBe(0)
})
it('keeps a successfully acquired token reachable when process close fails', async () => {
  state.failClose = 100n
  let failure: any
  try { openCurrentProcessToken(state.api) } catch (error) { failure = error }
  expect(failure.disposeAsync).toBeTypeOf('function')
  state.failClose = 0n
  await failure.disposeAsync()
  expect(state.live.size).toBe(0)
})
it.each(['copy', 'well-known'])('balances native copied SID and slots on %s failure', kind => {
  expect(() => kind === 'copy' ? findLogonSid(state.api, ptr(1n)) : makeWellKnownSid(state.api, 1)).toThrow()
  expect(state.live.size).toBe(0)
})
it('retains successful restricted token output until decode and cleanup are acknowledged', async () => {
  state.decodeFailures = 2
  let failure: any
  try { createRestrictedToken(state.api, ptr(1n), ptr(2n), [], { world: ptr(3n) }, 'read-only') } catch (error) { failure = error }
  expect(failure.disposeAsync).toBeTypeOf('function')
  await failure.disposeAsync()
  expect(state.live.size).toBe(0)
})
it('frees merged LocalAlloc DACL and all native slots on SetTokenInformation failure', () => {
  expect(() => setTokenDefaultDaclGrant(state.api, ptr(1n), ptr(2n))).toThrow()
  expect(state.live.size).toBe(0)
})

it('pins effect-then-throw CloseHandle and does not consume a reused numeric process handle', async () => {
  let consumes = 0
  const close = state.api.closeHandle
  state.api.closeHandle = (p: bigint) => {
    if (p === 100n) { consumes++; state.live.delete(p); state.live.set(p, 'unrelated-handle'); throw new Error('return lost after close') }
    return close(p)
  }
  let failure: any
  try { openCurrentProcessToken(state.api) } catch (error) { failure = error }
  expect(consumes).toBe(1)
  expect(failure.disposeAsync).toBeTypeOf('function')
  await expect(failure.disposeAsync()).rejects.toThrow(/unknown/)
  await expect(failure.disposeAsync()).rejects.toThrow(/unknown/)
  expect(consumes).toBe(1)
  expect(state.live.get(100n)).toBe('unrelated-handle')
  expect([...state.live.values()]).toEqual(['unrelated-handle']) // Independent token/slot cleanup still acknowledged.
})

it('pins effect-then-throw LocalFree and keeps its slot and reused unrelated allocation', () => {
  let address = 0n, consumes = 0
  state.api.convertStringSidToSidW = (_sid: string, slot: bigint) => { address = state.next++; state.live.set(address, 'local'); state.memory.set(slot, address); return 1 }
  const grant = AclWriteGrant.create('S-1-4-1-2', state.api)
  state.api.localFree = (p: bigint) => { consumes++; state.live.delete(p); state.live.set(p, 'unrelated-local'); throw new Error('return lost after free') }
  expect(() => grant.dispose()).toThrow()
  const retained = state.live.size
  expect(() => grant.dispose()).toThrow(/cleanup/)
  expect(consumes).toBe(1)
  expect(state.live.size).toBe(retained)
  expect(state.live.get(address)).toBe('unrelated-local')
  expect(retained).toBe(2) // The original pointer slot cannot be freed past unknown consumption.
  expect(() => grant.add(process.cwd())).toThrow(/disposed/)
})

it('original sandbox pins a consumed/reused restricted-token handle and all dependent entries', async () => {
  state.api.copySid = () => 1; state.api.createWellKnownSid = () => 1; state.api.setTokenInformation = () => 1
  const sandbox = new AclSandbox({ mode: 'read-only', writableDirs: [] })
  await sandbox.init()
  const handle = [...state.live].find(([, kind]) => kind === 'handle')![0]
  let consumes = 0
  state.api.closeHandle = (p: bigint) => { expect(p).toBe(handle); consumes++; state.live.delete(p); state.live.set(p, 'unrelated-handle'); throw new Error('return lost') }
  expect(() => sandbox.dispose()).toThrow(/unknown/)
  const retained = state.live.size
  await expect(sandbox.disposeAsync()).rejects.toThrow(/unknown/)
  expect(consumes).toBe(1)
  expect(state.live.size).toBe(retained)
  expect(state.live.get(handle)).toBe('unrelated-handle')
})

it('does not classify arbitrary heap-free throws as known not-issued or transfer their debt', () => {
  const owner = new NativeInitOwner(state.api)
  const value = owner.bytes(12)
  state.freeFailures = 1
  expect(() => owner.release(value, 'heap')).toThrow(/unknown/)
  expect(() => owner.transfer(value)).toThrow(/unknown/)
  expect(() => owner.cleanup()).toThrow(/unknown/)
  expect(state.freeCalls).toBe(1)
  expect(state.live.get(value)).toBe('heap')
})

it('retains a returned BOOL failure as retryable even when error reporting throws', () => {
  let attempts = 0
  const close = state.api.closeHandle
  state.api.closeHandle = (p: bigint) => p === 100n && ++attempts === 1 ? 0 : close(p)
  state.api.getLastError = () => { throw new Error('reporting failed') }
  expect(() => openCurrentProcessToken(state.api)).toThrow('reporting failed')
  expect(attempts).toBe(2)
  expect(state.live.size).toBe(0)
})

it('records returned success before fallible deferred bookkeeping', () => {
  const owner = new NativeInitOwner(state.api)
  let calls = 0
  const release = owner.deferBool('controlled release', () => { calls++; return 1 }, () => { throw new Error('bookkeeping failed') })
  expect(release).toThrow('bookkeeping failed')
  owner.cleanup(); release()
  expect(calls).toBe(1)
})
