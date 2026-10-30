import { createRequire } from 'node:module'

export interface Win32ArtifactApi {
  createFileW(name: string, access: number, share: number, attributes: null, disposition: number, flags: number, template: null): bigint | null
  getFileInformationByHandleEx(handle: bigint, kind: number, data: Buffer, size: number): number
  getFinalPathNameByHandleW(handle: bigint, data: Buffer, units: number, flags: number): number
  lcMapStringEx(locale: string, flags: number, value: string, count: number, output: Buffer | null, capacity: number, version: null, reserved: null, param: bigint): number
  closeHandle(handle: bigint): number
  getLastError(): number
}
let cached: Win32ArtifactApi | undefined
/** Synchronous metadata operations only; loading stays lazy and platform-local. */
export function win32ArtifactApi(): Win32ArtifactApi {
  if (process.platform !== 'win32') throw new Error('Windows artifact identity unavailable')
  if (cached) return cached
  const koffi: typeof import('koffi') = createRequire(import.meta.url)('koffi')
  const kernel = koffi.load('kernel32.dll')
  cached = Object.freeze({
    createFileW: kernel.func('void * __stdcall CreateFileW(str16, uint32_t, uint32_t, void *, uint32_t, uint32_t, void *)'),
    getFileInformationByHandleEx: kernel.func('int __stdcall GetFileInformationByHandleEx(void *, int, void *, uint32_t)'),
    getFinalPathNameByHandleW: kernel.func('uint32_t __stdcall GetFinalPathNameByHandleW(void *, void *, uint32_t, uint32_t)'),
    lcMapStringEx: kernel.func('int __stdcall LCMapStringEx(str16, uint32_t, str16, int, void *, int, void *, void *, intptr_t)'),
    closeHandle: kernel.func('int __stdcall CloseHandle(void *)'),
    getLastError: kernel.func('uint32_t __stdcall GetLastError()'),
  }) as Win32ArtifactApi
  return cached
}
