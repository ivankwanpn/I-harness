import { expect, it } from 'vitest'
import { createWin32ArtifactPathOwnerWithApi, invalidateOriginalArtifactVerification, withOriginalArtifactVerificationScope } from '../src/win32-artifact-path.ts'
import type { Win32ArtifactApi } from '../src/win32-artifact-api.ts'

// Focused, injected native boundary: proves the operation-scoped reuse contract
// without weakening the per-assert native count assertions in
// win32-artifact-path.test.ts / artifact-path-batch.test.ts (which never open a
// verification scope and therefore keep one fresh native proof per assertion).
function fixture() {
  const directories = new Map([
    ['C:\\store', { id: 1, sensitive: false, final: '\\Device\\Volume\\store' }],
    ['C:\\store\\locks', { id: 2, sensitive: false, final: '\\Device\\Volume\\store\\locks' }],
  ])
  const handles = new Map<bigint, { id: number; sensitive: boolean; final: string }>()
  const counts = { open: 0, info: 0, final: 0, close: 0 }
  let next = 1n
  const api: Win32ArtifactApi = {
    createFileW(name) {
      counts.open++
      const directory = directories.get(name)
      if (!directory) return -1n
      const handle = next++
      handles.set(handle, { ...directory })
      return handle
    },
    getLastError: () => 3,
    getFileInformationByHandleEx(handle, kind, data) {
      counts.info++
      const directory = handles.get(handle)!
      if (kind === 18) { data.writeBigUInt64LE(0xf000000000000001n, 0); data.writeUInt32LE(directory.id, 8) }
      else if (kind === 23) data.writeUInt32LE(directory.sensitive ? 1 : 0)
      else data.writeUInt32LE(0x10)
      return 1
    },
    getFinalPathNameByHandleW(handle, data) {
      counts.final++
      const value = handles.get(handle)!.final
      data.write(value + '\0', 'utf16le')
      return value.length
    },
    lcMapStringEx(_locale, _flags, value, _count, output) {
      const folded = value.toUpperCase()
      if (output) output.write(folded, 'utf16le')
      return folded.length
    },
    closeHandle(handle) {
      counts.close++
      if (!handles.delete(handle)) throw Error('unexpected original handle')
      return 1
    },
  }
  return { directories, handles, counts, api, owner: createWin32ArtifactPathOwnerWithApi('C:\\store', api) }
}

it('reuses one verified original identity for repeated accessors inside one guarded operation', () => {
  const f = fixture(), capture = f.owner.capture('C:\\store\\source.jsonl')
  try {
    withOriginalArtifactVerificationScope('session-a', () => {
      capture.assertCurrent()
      const first = { ...f.counts }
      capture.assertCurrent()
      capture.assertCurrent()
      expect({ ...f.counts }).toEqual(first)
    })
    // The scope itself never outlives the operation: a later assertion re-proves.
    const before = { ...f.counts }
    capture.assertCurrent()
    expect(f.counts.open).toBeGreaterThan(before.open)
  } finally { f.owner.settleResources() }
})

it('records the capture proof for the operation that created it', () => {
  const f = fixture()
  try {
    withOriginalArtifactVerificationScope('session-a', () => {
      const before = { ...f.counts }
      const capture = f.owner.capture('C:\\store\\source.jsonl')
      const captured = { ...f.counts }
      capture.assertCurrent()
      capture.assertCurrent()
      expect(captured.open).toBeGreaterThan(before.open)
      expect({ ...f.counts }).toEqual(captured)
    })
  } finally { f.owner.settleResources() }
})

it('re-proves after an explicit invalidation and after the operation ends', () => {
  const f = fixture(), capture = f.owner.capture('C:\\store\\source.jsonl')
  try {
    withOriginalArtifactVerificationScope('session-a', () => {
      capture.assertCurrent()
      const first = { ...f.counts }
      invalidateOriginalArtifactVerification()
      capture.assertCurrent()
      expect(f.counts.open).toBeGreaterThan(first.open)
    })
  } finally { f.owner.settleResources() }
})

it('rejects a replaced original directory in a later operation', () => {
  const f = fixture()
  try {
    withOriginalArtifactVerificationScope('session-a', () => {
      f.owner.capture('C:\\store\\source.jsonl').assertCurrent()
    })
    f.directories.get('C:\\store')!.id = 9
    let refused = false
    try { withOriginalArtifactVerificationScope('session-a', () => f.owner.capture('C:\\store\\source.jsonl').assertCurrent()) }
    catch { refused = true }
    expect(refused).toBe(true)
  } finally { f.owner.settleResources() }
})

it('never shares one owner proof with another owner of the same target', () => {
  const f = fixture(), second = createWin32ArtifactPathOwnerWithApi('C:\\store', f.api)
  try {
    const first = f.owner.capture('C:\\store\\source.jsonl'), other = second.capture('C:\\store\\source.jsonl')
    withOriginalArtifactVerificationScope('session-a', () => {
      first.assertCurrent()
      const proven = { ...f.counts }
      other.assertCurrent()
      // Proofs are per original owner; the second owner samples on its own.
      expect(f.counts.open).toBeGreaterThan(proven.open)
    })
  } finally { f.owner.settleResources(); second.settleResources() }
})

