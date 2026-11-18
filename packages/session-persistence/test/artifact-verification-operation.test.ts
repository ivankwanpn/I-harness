import { beforeEach, expect, it, vi } from 'vitest'
import { win32 as path } from 'node:path'
import type { Win32ArtifactApi } from '../../fs-lock/src/win32-artifact-api.ts'

// Focused coordinator-level contract for the guarded-operation verification
// scope: one serialized session operation may reuse an already proven original
// identity, and every operation boundary, opaque callback, invalidation and
// observed change re-proves it. Per-assert native counts outside a scope remain
// covered by canonical-query-count.test.ts and ownership-native-count.test.ts.
const state = vi.hoisted(() => ({ directories: new Map<string, { id: number; sensitive: boolean; final: string }>(), handles: new Map<bigint, { id: number; sensitive: boolean; final: string }>(), counts: { open: 0, info: 0, final: 0, close: 0 }, next: 1n }))

vi.mock('@i-harness/fs-lock/internal/artifact-path', async original => {
  const module = await original<typeof import('@i-harness/fs-lock/internal/artifact-path')>()
  const { createWin32ArtifactPathOwnerWithApi } = await import('../../fs-lock/src/win32-artifact-path.ts')
  const api: Win32ArtifactApi = {
    createFileW(name) {
      state.counts.open++
      const directory = state.directories.get(name)
      if (!directory) return -1n
      const handle = state.next++
      state.handles.set(handle, { ...directory })
      return handle
    },
    getLastError: () => 3,
    getFileInformationByHandleEx(handle, kind, data) {
      state.counts.info++
      const directory = state.handles.get(handle)!
      if (kind === 18) { data.writeBigUInt64LE(0xf000000000000001n, 0); data.writeUInt32LE(directory.id, 8) }
      else if (kind === 23) data.writeUInt32LE(directory.sensitive ? 1 : 0)
      else data.writeUInt32LE(0x10)
      return 1
    },
    getFinalPathNameByHandleW(handle, data) {
      state.counts.final++
      const value = state.handles.get(handle)!.final
      data.write(value + '\0', 'utf16le')
      return value.length
    },
    lcMapStringEx(_locale, _flags, value, _count, output) {
      const folded = value.toUpperCase()
      if (output) output.write(folded, 'utf16le')
      return folded.length
    },
    closeHandle(handle) {
      state.counts.close++
      if (!state.handles.delete(handle)) throw Error('unexpected original handle')
      return 1
    },
  }
  return { ...module, createArtifactPathOwner(root: string) { for (const directory of [root, path.join(root, '.i-harness-locks')]) if (!state.directories.has(directory)) state.directories.set(directory, { id: state.directories.size + 1, sensitive: false, final: '\\Device\\TestVolume' + directory.slice(2) }); return createWin32ArtifactPathOwnerWithApi(root, api) } }
})

vi.mock('@i-harness/fs-lock', async () => {
  const { createHash } = await import('node:crypto'), { heldLock } = await import('../../fs-lock/src/win32.ts')
  return { lockPathFor: (root: string, id: string) => path.join(root, '.i-harness-locks', createHash('sha256').update(id).digest('hex').slice(0, 24) + '.lock'), async acquireSessionLock({ lockPath }: { lockPath: string }) { return heldLock({ createFileW() { throw Error('Unexpected native acquisition') }, lockFileEx() { throw Error('Unexpected native acquisition') }, unlockFileEx: () => 1, closeHandle: () => 1, getLastError: () => 0 }, 1n, lockPath, 2n) } }
})

import { createOwnership } from '../src/coordinator/ownership.ts'
import { associateArtifactPaths, invalidateArtifactCurrentnessVerification, withArtifactCurrentnessOperation, withImmediateArtifactCurrentChecks } from '../src/coordinator/artifact-path-association.ts'
import { createOriginalJsonlPathResolution } from '../src/coordinator/canonical-path-resolution.ts'
import type { PersistenceBackend } from '../src/coordinator/types.ts'

function fixture() {
  state.directories = new Map([['C:\\store', { id: 1, sensitive: false, final: '\\Device\\Volume\\store' }]])
  state.handles = new Map(); state.counts = { open: 0, info: 0, final: 0, close: 0 }; state.next = 1n
  const backend = { lockRoot: 'C:\\store' } as PersistenceBackend
  associateArtifactPaths(backend, createOriginalJsonlPathResolution('C:\\store').bindBackend(backend, { async prepareRoot() {}, async prepareDocumentParents() {} }))
  const owner = createOwnership(backend, { lock: { enabled: true } })
  const snapshot = () => ({ ...state.counts })
  const delta = (before: ReturnType<typeof snapshot>) => Object.fromEntries(Object.keys(state.counts).map(key => [key, state.counts[key as keyof typeof state.counts] - before[key as keyof typeof before]]))
  return { owner, snapshot, delta }
}

beforeEach(() => { vi.restoreAllMocks() })

it('reuses one operation proof across repeated accessors and re-proves in the next operation', async () => {
  const f = fixture(), first = await f.owner.pinOwnership('source'), claim = await f.owner.pinOwnership('source')
  try {
    const cold = f.snapshot()
    claim.assertHeld()
    const outside = f.delta(cold)
    expect(outside.open).toBeGreaterThan(0)

    const opened = f.snapshot()
    withArtifactCurrentnessOperation('source-operation', () => { claim.assertHeld(); claim.assertHeld(); claim.assertHeld() })
    const inside = f.delta(opened)
    // The first accessor proves every capture; the repeated ones are free.
    expect(inside).toEqual(outside)

    await Promise.resolve()
    const next = f.snapshot()
    withArtifactCurrentnessOperation('next-operation', () => claim.assertHeld())
    expect(f.delta(next).open).toBeGreaterThan(0)
  } finally { await claim.release(); await first.release(); await Promise.all(f.owner.releaseHeldLocks()) }
})

it('rejects a native identity replacement between two operations', async () => {
  const f = fixture(), first = await f.owner.pinOwnership('source'), claim = await f.owner.pinOwnership('source')
  try {
    withArtifactCurrentnessOperation('operation-one', () => claim.assertHeld())
    await Promise.resolve()
    state.directories.get('C:\\store')!.id = 9
    expect(() => withArtifactCurrentnessOperation('operation-two', () => claim.assertHeld())).toThrow(/changed|unavailable/i)
  } finally { await claim.release().catch(() => {}); await first.release().catch(() => {}); await Promise.allSettled(f.owner.releaseHeldLocks()) }
})

it('re-proves after an explicit invalidation and after an opaque callback boundary', async () => {
  const f = fixture(), first = await f.owner.pinOwnership('source'), claim = await f.owner.pinOwnership('source')
  try {
    withArtifactCurrentnessOperation('operation-one', () => {
      claim.assertHeld()
      const proven = f.snapshot()
      invalidateArtifactCurrentnessVerification()
      claim.assertHeld()
      expect(f.delta(proven).open).toBeGreaterThan(0)
    })
    expect(() => withArtifactCurrentnessOperation('operation-two', () => {
      claim.assertHeld()
      withImmediateArtifactCurrentChecks(() => { state.directories.get('C:\\store')!.id = 9 })
      claim.assertHeld()
    })).toThrow(/changed|unavailable/i)
  } finally { await claim.release().catch(() => {}); await first.release().catch(() => {}); await Promise.allSettled(f.owner.releaseHeldLocks()) }
})
