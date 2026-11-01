import { expect, it } from 'vitest'
import { drainPipe } from '../src/spawn.ts'
import type { NativePtr, Win32Bindings } from '../src/ffi.ts'

it('closes the read handle and preserves the original unexpected peek error', async () => {
  const closed: unknown[] = []
  let lastError = 123
  const api = {
    peekNamedPipe: () => 0,
    getLastError: () => lastError,
    closeHandle: (handle: unknown) => { closed.push(handle); lastError = 6; return 1 },
    formatMessageW: () => 0,
  } as unknown as Win32Bindings
  await expect(drainPipe(api, 42n as NativePtr)).rejects.toMatchObject({ api: 'PeekNamedPipe', win32Code: 123 })
  expect(closed).toEqual([42n])
})
