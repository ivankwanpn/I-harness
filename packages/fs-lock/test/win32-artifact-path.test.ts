import { expect, it } from 'vitest'
import { win32 as path } from 'node:path'

type Dir = { id: number; sensitive: boolean; final: string }
function fixture() {
  const directories = new Map<string, Dir>([
    ['C:\\store', { id: 1, sensitive: false, final: '\\Device\\Volume\\store' }],
    ['C:\\store\\Mixed', { id: 2, sensitive: true, final: '\\Device\\Volume\\store\\Mixed' }],
    ['C:\\store\\short', { id: 3, sensitive: false, final: '\\Device\\Volume\\store\\Long Directory' }],
    ['C:\\store\\Long Directory', { id: 3, sensitive: false, final: '\\Device\\Volume\\store\\Long Directory' }],
  ])
  const handles = new Map<bigint, Dir>(), calls: string[] = []
  let next = 1n, error = 0, closeFailure = false, foldCalls = 0
  const api = {
    createFileW(name: string, access: number, share: number, attributes: null, disposition: number, flags: number, template: null) {
      expect([access, share, attributes, disposition, flags, template]).toEqual([0x80, 7, null, 3, 0x02200000, null])
      calls.push(name)
      const dir = directories.get(name)
      if (!dir) { error = 3; return -1n }
      const handle = next++; handles.set(handle, { ...dir }); return handle
    },
    getLastError() { return error },
    getFileInformationByHandleEx(handle: bigint, kind: number, data: Buffer, size: number) {
      const dir = handles.get(handle)!
      if (kind === 18) { expect(size).toBe(24); data.writeBigUInt64LE(0xf000000000000001n, 0); data.writeUInt32LE(dir.id, 8) }
      else if (kind === 23) { expect(size).toBe(4); data.writeUInt32LE(dir.sensitive ? 1 : 0) }
      else { expect([kind, size]).toEqual([9, 8]); data.writeUInt32LE(0x10) }
      return 1
    },
    getFinalPathNameByHandleW(handle: bigint, data: Buffer, units: number, flags: number) {
      expect(flags).toBe(2)
      const value = handles.get(handle)!.final
      if (units <= value.length) return value.length + 1
      data.write(value + '\0', 'utf16le'); return value.length
    },
    lcMapStringEx(locale: string, flags: number, value: string, count: number, output: Buffer | null, capacity: number, version: null, reserved: null, param: bigint) {
      expect([locale, flags, count, version, reserved, param]).toEqual(['', 0x200, value.length, null, null, 0n])
      foldCalls++
      const mapped = value.replace(/[a-z]/g, char => String.fromCharCode(char.charCodeAt(0) - 32))
      if (!output) { expect(capacity).toBe(0); return mapped.length }
      expect(capacity).toBe(mapped.length); output.write(mapped, 'utf16le'); return mapped.length
    },
    closeHandle(handle: bigint) {
      if (closeFailure) { closeFailure = false; error = 5; return 0 }
      expect(handles.delete(handle)).toBe(true); return 1
    },
  }
  return { directories, handles, calls, api, failClose() { closeFailure = true }, folds: () => foldCalls }
}

async function implementation() {
  const module = await import('../src/win32-artifact-path.ts').catch(() => undefined)
  expect(module?.createWin32ArtifactPathOwnerWithApi).toBeTypeOf('function')
  return module!.createWin32ArtifactPathOwnerWithApi
}

it('uses actual directory ID, policy and exact UTF16 leaf rather than a globally folded path', async () => {
  const create = await implementation(), f = fixture(), owner = create('C:\\store', f.api)
  const lower = owner.capture('C:\\store\\name.doc.jsonl'), upper = owner.capture('C:\\store\\NAME.doc.jsonl')
  expect(lower.kind).toBe('ready'); expect(upper.kind === 'ready' && upper.key).toBe(lower.kind === 'ready' && lower.key)
  const before = f.folds()
  const sensitive = owner.capture('C:\\store\\Mixed\\name.doc.jsonl'), other = owner.capture('C:\\store\\Mixed\\NAME.doc.jsonl')
  expect(sensitive.kind === 'ready' && sensitive.key).not.toBe(other.kind === 'ready' && other.key)
  expect(f.folds()).toBe(before)
  const long = owner.capture('C:\\store\\Long Directory\\name.doc.jsonl')
  expect(long.kind).toBe('ready')
  expect(owner.capture('C:\\store\\short\\name.doc.jsonl')).toMatchObject({ key: long.kind === 'ready' ? long.key : undefined })
  expect(f.handles.size).toBe(0)
  expect(lower.kind === 'ready' && lower.key).toContain('01000000000000f0')
})

it('returns no final key before actual parents exist and recaptures their actual policy', async () => {
  const create = await implementation(), f = fixture(), owner = create('C:\\store', f.api)
  const pending = owner.capture('C:\\store\\missing\\name.doc.jsonl')
  expect(pending.kind).toBe('needs-parents'); expect('key' in pending).toBe(false)
  f.directories.set('C:\\store\\missing', { id: 4, sensitive: true, final: '\\Device\\Volume\\store\\missing' })
  const next = owner.capture('C:\\store\\missing\\name.doc.jsonl')
  expect(next.kind).toBe('ready')
  expect(next.kind === 'ready' && next.key).toContain(':S:')
  expect(f.handles.size).toBe(0)
})

it('invalidates replaced roots and changed directory policy without retargeting a capture', async () => {
  const create = await implementation(), f = fixture(), owner = create('C:\\store', f.api)
  const capture = owner.capture('C:\\store\\Mixed\\name.doc.jsonl')
  capture.assertCurrent()
  f.directories.get('C:\\store\\Mixed')!.sensitive = false
  expect(() => capture.assertCurrent()).toThrow()
  f.directories.get('C:\\store')!.id = 9
  expect(() => owner.capture('C:\\store\\name.doc.jsonl')).toThrow()
  expect(f.handles.size).toBe(0)
})

it('retains failed original cleanup and refuses capture success until explicit settlement', async () => {
  const create = await implementation(), f = fixture(), owner = create('C:\\store', f.api)
  f.failClose()
  expect(() => owner.capture('C:\\store\\name.doc.jsonl')).toThrow()
  expect(f.handles.size).toBe(1)
  const before = f.calls.length
  expect(() => owner.capture('C:\\store\\name.doc.jsonl')).toThrow()
  expect(f.calls.length).toBe(before)
  owner.settleResources()
  expect(f.handles.size).toBe(0)
  expect(owner.capture(path.join('C:\\store', 'name.doc.jsonl')).kind).toBe('ready')
})

it('never treats a missing bound root or unproved root spelling as directory-creation permission', async () => {
  const create = await implementation(), f = fixture(), owner = create('C:\\store', f.api)
  const value = owner.capture('C:\\store\\name.doc.jsonl')
  expect(() => owner.capture('C:\\STORE\\name.doc.jsonl')).toThrow()
  f.directories.delete('C:\\store')
  expect(() => owner.capture('C:\\store\\name.doc.jsonl')).toThrow()
  expect(() => value.assertCurrent()).toThrow()
  f.directories.set('C:\\store', { id: 1, sensitive: false, final: '\\Device\\Volume\\store' })
  expect(() => value.assertCurrent()).toThrow()
  expect(f.handles.size).toBe(0)
})

it('rejects borrowed owner and capture methods before native work', async () => {
  const create = await implementation(), f = fixture(), owner = create('C:\\store', f.api)
  const value = owner.capture('C:\\store\\name.doc.jsonl'), before = f.calls.length
  expect(() => owner.capture.call({} as typeof owner, 'C:\\store\\name.doc.jsonl')).toThrow()
  expect(() => owner.settleResources.call({} as typeof owner)).toThrow()
  expect(() => value.assertCurrent.call({} as typeof value)).toThrow()
  expect(f.calls.length).toBe(before)
  value.assertCurrent()
})

it('retains a consuming close acknowledgment before fallible ledger bookkeeping', async () => {
  const create = await implementation(), f = fixture(), owner = create('C:\\store', f.api)
  const original = Set.prototype.delete
  let failed = false
  Set.prototype.delete = function (value: unknown) {
    if (!failed && value && typeof value === 'object' && 'closed' in value && value.closed === true) {
      failed = true
      throw new Error('ledger bookkeeping failure')
    }
    return Reflect.apply(original, this, [value])
  }
  try { expect(() => owner.capture('C:\\store\\name.doc.jsonl')).toThrow('ledger bookkeeping failure') }
  finally { Set.prototype.delete = original }
  expect(f.handles.size).toBe(0)
  owner.settleResources()
  expect(owner.capture('C:\\store\\name.doc.jsonl').kind).toBe('ready')
})
