import { beforeEach, expect, it, vi } from 'vitest'
const state = vi.hoisted(() => ({ next: 100n, live: new Map<bigint, string>(), memory: new Map<bigint, bigint | number>(), failAlloc: false, failClose: 0n, decodeFailures: 0, freeFailures: 0, revokeFails: false, api: {} as any }))
vi.mock('koffi', async original => { const actual = await original<any>(); return { ...actual, default: { ...actual.default, free: (p: bigint) => { if (state.freeFailures-- > 0) throw new Error('free failed'); if (state.live.get(p) !== 'heap') throw new Error('allocator mismatch'); state.live.delete(p) }, encode: (p: bigint, _type: unknown, value: bigint | number) => { state.memory.set(p, value) } } } })
vi.mock('../src/ffi.ts', async original => { const actual = await original<any>(); const alloc = () => { if (state.failAlloc) { state.failAlloc = false; throw new Error('allocation failed') } const p = state.next++; state.live.set(p, 'heap'); return p }; return { ...actual, getTempPath: () => process.cwd(), allocOverlapped: alloc, allocBytes: alloc, allocUint32: alloc, allocPtrSlot: alloc, decodePtr: (p: bigint) => { if (state.decodeFailures-- > 0) throw new Error('decode failed'); return state.memory.get(p) ?? null }, decodeUint32: (p: bigint) => Number(state.memory.get(p)), encodeUint32: (p: bigint, n: number) => { state.memory.set(p, n) }, decodePtrAt: () => 99n, decodeUint16At: () => 0, ptrAddress: (p: bigint) => p, win32: async () => state.api } })
import type { NativePtr } from '../src/ffi.ts'
const ptr = (n: bigint) => n as NativePtr
beforeEach(() => {
  state.live.clear(); state.memory.clear(); state.next = 100n; state.failAlloc = false; state.failClose = 0n; state.decodeFailures = 0; state.freeFailures = 0; state.revokeFails = false
  const resource = (kind: string) => { const p = state.next++; state.live.set(p, kind); return p }
  state.api = {
    openProcess: () => resource('handle'), closeHandle: (p: bigint) => { if (p === state.failClose) return 0; expect(state.live.get(p)).toBe('handle'); state.live.delete(p); return 1 },
    openProcessToken: (_h: bigint, _r: number, slot: bigint) => { state.memory.set(slot, resource('handle')); return 1 },
    createRestrictedToken: (...args: any[]) => { state.memory.set(args.at(-1), resource('handle')); return 1 },
    getLastError: () => 5, formatMessageW: () => 0,
    getTokenInformation: (_t: bigint, cls: number, buffer: Buffer | null, _n: number, size: bigint) => { state.memory.set(size, 24); if (!buffer) return 0; buffer.writeUInt32LE(cls === 2 ? 1 : 0, 0); if (cls === 2) buffer.writeUInt32LE(0xc0000000, 16); return 1 },
    getLengthSid: () => 12, copySid: () => 0, createWellKnownSid: () => 0, isValidSid: () => 1,
    setEntriesInAclW: (_n: number, _access: unknown, _acl: bigint, slot: bigint) => { state.memory.set(slot, resource('local')); return 0 }, setTokenInformation: () => 0,
    localFree: (p: bigint) => { expect(state.live.get(p)).toBe('local'); state.live.delete(p); return null },
  }
})


vi.mock('node:fs', async original => ({ ...await original<any>(), mkdirSync: () => {} }))
import { grantWrite, revokeWrite, withPathLock } from '../src/acl.ts'
import { NativeInitOwner } from '../src/init-owner.ts'
import { AclSandbox } from '../src/index.ts'
beforeEach(() => {
  const resource = (kind: string) => { const p = state.next++; state.live.set(p, kind); return p }
  state.api.createFileW = () => resource('handle')
  state.api.lockFileEx = () => 1
  state.api.unlockFileEx = () => 1
  state.api.getNamedSecurityInfoW = (...args: any[]) => { state.memory.set(args.at(-1), resource('local')); state.memory.set(args[5], 99n); return 0 }
  state.api.setNamedSecurityInfoW = () => 0
})
it('balances lock, OVERLAPPED, descriptor/merged ACL and all five outslots on success', () => {
  grantWrite(state.api, process.cwd(), ptr(2n))
  expect(state.live.size).toBe(0)
})
it('retains descriptor after successful get followed by failed decode', async () => {
  state.decodeFailures = 2
  let failure: any
  try { grantWrite(state.api, process.cwd(), ptr(2n)) } catch (error) { failure = error }
  expect(failure.disposeAsync).toBeTypeOf('function')
  await failure.disposeAsync()
  expect(state.live.size).toBe(0)
})
it('keeps failed post-apply LocalFree in the original parent scope without reapplying', () => {
  const owner = new NativeInitOwner(state.api)
  let applies = 0
  state.api.setNamedSecurityInfoW = () => { applies++; return 0 }
  const free = state.api.localFree
  let frees = 0
  state.api.localFree = (p: bigint) => ++frees === 2 ? p : free(p)
  let failure: any
  try { revokeWrite(state.api, process.cwd(), ptr(2n), owner) } catch (error) { failure = error }
  expect(failure.operationCompleted).toBe(true)
  owner.cleanupScopes(); owner.cleanup()
  expect(applies).toBe(1)
  expect(state.live.size).toBe(0)
})
it('preserves original apply error alongside unlock debt and retries cleanup only', async () => {
  const owner = new NativeInitOwner(state.api)
  let applies = 0
  state.api.setNamedSecurityInfoW = () => { applies++; return 5 }
  state.api.unlockFileEx = () => 0
  let failure: any
  try { grantWrite(state.api, process.cwd(), ptr(2n), owner) } catch (error) { failure = error }
  expect(failure.errors[0]).toMatchObject({ api: 'SetNamedSecurityInfoW', win32Code: 5 })
  expect(state.live.size).toBeGreaterThan(0)
  state.api.unlockFileEx = () => 1
  owner.cleanupScopes(); owner.cleanup()
  expect(applies).toBe(1)
  expect(state.live.size).toBe(0)
})

it('original init owner retains lower ACL debt and does not repeat an acknowledged revoke', async () => {
  state.api.convertStringSidToSidW = (_sid: string, slot: bigint) => { const p = state.next++; state.live.set(p, 'local'); state.memory.set(slot, p); return 1 }
  let applies = 0, frees = 0
  state.api.setNamedSecurityInfoW = () => { applies++; return 0 }
  const free = state.api.localFree
  state.api.localFree = (p: bigint) => ++frees === 4 ? p : free(p)
  const sandbox = new AclSandbox({ mode: 'workspace-write', writableDirs: [], writeSid: 'S-1-4-1-2', tempDir: process.cwd(), tempWriteSid: 'S-1-4-1-3' })
  const failure = await sandbox.init().catch(error => error)
  expect(failure.owner).toBe(sandbox)
  expect(Object.keys(failure)).not.toContain('owner')
  expect(failure.errors[0]).toMatchObject({ api: 'CopySid', win32Code: 5 })
  expect(applies).toBe(2)
  expect([...state.live.values()].filter(kind => kind === 'local')).toHaveLength(3)
  await failure.disposeAsync()
  expect(applies).toBe(2)
  expect(state.live.size).toBe(0)
})

it('pins an effect-then-throw unlock without repeating it or releasing OVERLAPPED/lock handle', () => {
  const owner = new NativeInitOwner(state.api)
  let unlocks = 0
  state.api.unlockFileEx = () => { unlocks++; throw new Error('unlock return lost') }
  expect(() => withPathLock(state.api, process.cwd(), () => 1, owner)).toThrow()
  const retained = state.live.size
  expect(() => owner.cleanupScopes()).toThrow(/unknown/)
  expect(() => owner.cleanup()).toThrow(/unknown/)
  expect(unlocks).toBe(1)
  expect(state.live.size).toBe(retained)
  expect([...state.live.values()]).toContain('handle')
  expect([...state.live.values()]).toContain('heap')
})
