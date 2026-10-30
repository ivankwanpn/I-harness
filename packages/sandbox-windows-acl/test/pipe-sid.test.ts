import { expect, it } from 'vitest'
import koffi from 'koffi'
import { NativeInitOwner } from '../src/init-owner.ts'
import { logonSidText } from '../src/pipe-sid.ts'
import type { NativePtr, Win32Bindings } from '../src/ffi.ts'

it('retains the converted text and frees the original LocalAlloc output', () => {
  const text = koffi.alloc('uint16_t', 16); koffi.encode(text, 'str16', 'S-1-5-5-1-2')
  let freed: unknown
  const api = { convertSidToStringSidW(_sid: NativePtr, slot: NativePtr) { koffi.encode(slot, 'void *', text); return 1 }, localFree(p: NativePtr) { freed = p; return null }, getLastError() { return 5 } } as unknown as Win32Bindings
  const owner = new NativeInitOwner(api)
  expect(logonSidText(owner, 1n as NativePtr)).toBe('S-1-5-5-1-2')
  expect(freed).toBe(text); owner.cleanup(); koffi.free(text)
})

it('keeps the LocalAlloc output on the original owner when free fails', () => {
  const text = koffi.alloc('uint16_t', 16); koffi.encode(text, 'str16', 'S-1-5-5-1-2')
  let attempts = 0
  const api = { convertSidToStringSidW(_sid: NativePtr, slot: NativePtr) { koffi.encode(slot, 'void *', text); return 1 }, localFree(p: NativePtr) { attempts++; return attempts === 1 ? p : null }, getLastError() { return 5 } } as unknown as Win32Bindings
  const owner = new NativeInitOwner(api)
  expect(() => logonSidText(owner, 1n as NativePtr)).toThrow()
  owner.cleanup(); expect(attempts).toBe(2); koffi.free(text)
})
