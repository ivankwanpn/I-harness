import { beforeEach, expect, it, vi } from 'vitest'
const state = vi.hoisted(() => ({
  registered: 1, decodeFails: 0, releaseFails: 0, frees: 0, releases: 0,
  callback: undefined as (() => void) | undefined,
  nativeArguments: [] as unknown[],
  prototypeArguments: [] as unknown[],
}))
vi.mock('koffi', () => ({ default: {
  proto: (...args: unknown[]) => { state.prototypeArguments = args; return 'callback' },
  pointer: (type: unknown) => ({ type }),
  alloc: () => 10n,
  decode: () => { if (state.decodeFails-- > 0) throw new Error('decode failed'); return 77n },
  free: () => { state.frees++ },
  register: (callback: () => void) => { state.callback = callback; return 20n },
  unregister: () => { state.releases++; if (state.releaseFails-- > 0) throw new Error('callback release failed') },
  load: () => ({ func: (_abi: string, name: string) => name === 'GetLastError' ? () => 5 : (...args: unknown[]) => { state.nativeArguments = args; return state.registered } }),
} }))
import { registerWin32Wait } from '../src/win32-wait.ts'
import type { NativePtr } from '../src/ffi.ts'
beforeEach(() => { state.registered = 1; state.decodeFails = 0; state.releaseFails = 0; state.frees = 0; state.releases = 0 })

it('uses BOOLEAN callback ABI and one-shot infinite wait, retaining native slot until ACK', async () => {
  let ack!: (code: number) => void
  const unregister = vi.fn(() => new Promise<number>(r => { ack = r }))
  const wait = registerWin32Wait(42n as NativePtr, unregister)
  expect(state.prototypeArguments).toEqual(['__stdcall', 'void', ['void *', 'uint8']])
  expect(state.nativeArguments).toEqual([10n, 42n, 20n, null, 0xffffffff, 8])
  state.callback!()
  await wait.signalled
  const closing = wait.close()
  expect(state.frees).toBe(0); expect(state.releases).toBe(0)
  ack(0); await closing
  expect(unregister).toHaveBeenCalledWith(77n)
  expect(state.frees).toBe(1); expect(state.releases).toBe(1)
})

it('returns an owned failed observer for native registration failure', async () => {
  state.registered = 0
  const unregister = vi.fn(async () => 0)
  const wait = registerWin32Wait(42n as NativePtr, unregister)
  await expect(wait.signalled).rejects.toMatchObject({ api: 'RegisterWaitForSingleObject', win32Code: 5 })
  expect(state.frees).toBe(0)
  await wait.close()
  expect(unregister).not.toHaveBeenCalled()
  expect(state.frees).toBe(1)
})

it('retains a successful native registration even if decoding its out-slot throws', async () => {
  state.decodeFails = 1
  const unregister = vi.fn(async () => 0)
  const wait = registerWin32Wait(42n as NativePtr, unregister)
  await expect(wait.signalled).rejects.toThrow('decode failed')
  await wait.close()
  expect(unregister).toHaveBeenCalledWith(77n)
  expect(state.frees).toBe(1)
})

it('retries failed trampoline release without resubmitting native unregister', async () => {
  state.releaseFails = 1
  const unregister = vi.fn(async () => 0)
  const wait = registerWin32Wait(42n as NativePtr, unregister)
  await expect(wait.close()).rejects.toThrow('callback release failed')
  expect(state.frees).toBe(0)
  await wait.close()
  expect(unregister).toHaveBeenCalledTimes(1)
  expect(state.frees).toBe(1)
})
