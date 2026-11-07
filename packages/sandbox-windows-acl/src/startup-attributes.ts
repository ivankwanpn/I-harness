import koffi from 'koffi'
import { STARTUPINFOEXW, throwWin32, throwLastError, type NativePtr } from './ffi.ts'
import { NativeInitOwner } from './init-owner.ts'
import { ERROR_INSUFFICIENT_BUFFER, EXTENDED_STARTUPINFO_PRESENT, PROC_THREAD_ATTRIBUTE_HANDLE_LIST, STARTF_USESTDHANDLES, STARTUPINFOEXW_SIZE } from './win32-abi.ts'

export type ChildStdioHandles = readonly [NativePtr, NativePtr, NativePtr]
const HANDLE_LIST = koffi.array(koffi.pointer('void'), 3)
const MAX_ATTRIBUTE_BYTES = 1024 * 1024

/** The caller owns the three inheritable child endpoints. This scope owns only
 * the extended startup storage and native list, until CreateProcess returns.
 * Failure leaves the same scope registered on parent for acknowledged cleanup. */
export function prepareChildStartup(parent: NativeInitOwner, handles: ChildStdioHandles, windowsHide = false) {
  if (!Array.isArray(handles) || handles.length !== 3 || handles.some(handle => typeof handle !== 'bigint' || handle <= 0n || handle >= 0xffffffffffffffffn)
      || new Set(handles).size !== 3) throw new TypeError('Exactly three distinct child stdio handles are required')
  const parentCurrent = parent.captureCurrent(), owner = parent.scope(), ownerCurrent = owner.captureCurrent(), api = parent.api
  const current = () => { parentCurrent(); ownerCurrent() }
  // koffi.alloc returns zeroed memory already; koffi.view crashes under the
  // packaged Electron runtime, so the redundant zeroing is skipped there.
  const bytes = (size: number) => { current(); const pointer = owner.bytes(size); current(); if (!process.versions.electron) new Uint8Array(koffi.view(pointer, size)).fill(0); return pointer }
  const sizeSlot = bytes(koffi.sizeof('size_t'))
  koffi.encode(sizeSlot, 'size_t', 0)
  const query = api.initializeProcThreadAttributeList(null, 1, 0, sizeSlot), queryError = api.getLastError()
  current()
  if (query !== 0 || queryError !== ERROR_INSUFFICIENT_BUFFER) throwWin32(api, 'InitializeProcThreadAttributeList(size)', queryError)
  const rawSize: unknown = koffi.decode(sizeSlot, 'size_t')
  const size = typeof rawSize === 'bigint' && rawSize <= BigInt(MAX_ATTRIBUTE_BYTES) ? Number(rawSize) : rawSize
  if (typeof size !== 'number' || !Number.isSafeInteger(size) || size <= 0 || size > MAX_ATTRIBUTE_BYTES) throw new Error('Invalid attribute-list allocation size')
  // Every backing allocation precedes the consuming control entry: reverse
  // cleanup deletes the list before freeing values it may still reference.
  const list = bytes(size), values = bytes(HANDLE_LIST.size), startupInfo = bytes(STARTUPINFOEXW_SIZE)
  koffi.encode(values, HANDLE_LIST, [...handles])
  owner.voidControl('InitializeProcThreadAttributeList', () => api.initializeProcThreadAttributeList(list, 1, 0, sizeSlot),
    'DeleteProcThreadAttributeList', () => api.deleteProcThreadAttributeList(list))
  current()
  const updated = api.updateProcThreadAttribute(list, 0, PROC_THREAD_ATTRIBUTE_HANDLE_LIST, values, HANDLE_LIST.size, null, null)
  if (updated === 0) throwLastError(api, 'UpdateProcThreadAttribute')
  current()
  if (!Number.isInteger(updated) || updated < -0x80000000 || updated > 0x7fffffff) throw new Error('UpdateProcThreadAttribute outcome unknown')
  koffi.encode(startupInfo, STARTUPINFOEXW, { StartupInfo: { cb: STARTUPINFOEXW_SIZE, dwFlags: STARTF_USESTDHANDLES | (windowsHide ? 1 : 0), ...(windowsHide ? { wShowWindow: 0 } : {}),
    hStdInput: handles[0], hStdOutput: handles[1], hStdError: handles[2] }, lpAttributeList: list })
  let closing = false, closed = false
  const assertCurrent = () => { if (closing) throw new Error('Extended startup is closed'); current() }
  assertCurrent()
  return Object.freeze({ get startupInfo() { assertCurrent(); return startupInfo }, creationFlags: EXTENDED_STARTUPINFO_PRESENT, assertCurrent,
    close() { closing = true; if (closed) return; owner.cleanup(); closed = true },
  })
}
