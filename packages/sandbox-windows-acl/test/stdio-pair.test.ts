import { expect, it } from 'vitest'
import koffi from 'koffi'
import { NativeInitOwner } from '../src/init-owner.ts'
import type { Win32Bindings } from '../src/ffi.ts'

it('owns both outputs of one issue before either is retired', () => {
  const closed: bigint[] = []; let calls = 0
  const api = { closeHandle(p: bigint) { closed.push(p); return 1 }, getLastError() { return 5 } } as unknown as Win32Bindings
  const owner = new NativeInitOwner(api), a = owner.slot(), b = owner.slot()
  const outputs = owner.outputHandlePair(a, b, 'CreatePipe', () => { calls++; koffi.encode(a, 'void *', 11n); koffi.encode(b, 'void *', 12n); return 1 })
  expect(outputs).toEqual([11n, 12n]); expect(calls).toBe(1)
  owner.cleanup(); expect(closed).toEqual([12n, 11n])
})
it('retains original outputs after an unknown issue without reissuing', () => {
  const closed: bigint[] = []; let calls = 0
  const api = { closeHandle(p: bigint) { closed.push(p); return 1 }, getLastError() { return 5 } } as unknown as Win32Bindings
  const owner = new NativeInitOwner(api), a = owner.slot(), b = owner.slot()
  expect(() => owner.outputHandlePair(a, b, 'CreatePipe', () => { calls++; koffi.encode(a, 'void *', 11n); koffi.encode(b, 'void *', 12n); throw Error('unknown') })).toThrow()
  expect(() => owner.cleanup()).toThrow(/unknown/); expect(closed).toEqual([]); expect(calls).toBe(1)
})



it('creates EOF stdin and duplicates exactly the three child endpoints', async () => {
  const { acquireChildStdio } = await import('../src/pipe-stdio.ts')
  const closed: bigint[] = [], sources: bigint[] = []; let issueCount = 0
  const api = { getCurrentProcess: () => 99n, createPipe(a: bigint, b: bigint) { issueCount++; koffi.encode(a, 'void *', 11n); koffi.encode(b, 'void *', 12n); return 1 }, duplicateHandle(_p: bigint, source: bigint, _q: bigint, slot: bigint, access: number, inherit: number, flags: number) { sources.push(source); expect([access, inherit, flags]).toEqual([0, 1, 2]); koffi.encode(slot, 'void *', BigInt(20 + sources.length)); return 1 }, closeHandle(p: bigint) { closed.push(p); return 1 }, getLastError: () => 5 } as unknown as Win32Bindings
  const owner = new NativeInitOwner(api)
  expect(acquireChildStdio(owner, 30n as never, 31n as never)).toEqual([21n, 22n, 23n])
  expect(issueCount).toBe(1); expect(sources).toEqual([11n, 30n, 31n]); expect(closed).toEqual([12n, 11n])
  owner.cleanup(); expect(closed).toEqual([12n, 11n, 23n, 22n, 21n])
})
