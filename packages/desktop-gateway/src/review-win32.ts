import koffi from "koffi"
import type { PinnedReviewFile } from "./review-handle.ts"

const GENERIC_READ = 0x80000000
const FILE_SHARE_READ_WRITE_DELETE = 1 | 2 | 4
const OPEN_EXISTING = 3
const FILE_ATTRIBUTE_NORMAL = 0x80
const INVALID_HANDLE_VALUE = 0xffffffffffffffffn

type NativeHandle = bigint | number | null

interface Win32Bindings {
  createFileW(path: string, access: number, share: number, security: null, creation: number, flags: number, template: null): NativeHandle
  getFinalPath(handle: NativeHandle, output: Buffer, chars: number, flags: number): number
  readFile(handle: NativeHandle, output: Buffer, length: number, count: unknown, overlapped: null): number
  closeHandle(handle: NativeHandle): number
  getLastError(): number
}

let bindings: Win32Bindings | undefined

function win32() {
  if (bindings !== undefined) return bindings
  const library = koffi.load("kernel32.dll")
  const PVOID = koffi.pointer("void")
  bindings = {
    createFileW: library.func("__stdcall", "CreateFileW", PVOID, ["str16", "uint32", "uint32", PVOID, "uint32", "uint32", PVOID]),
    getFinalPath: library.func("__stdcall", "GetFinalPathNameByHandleW", "uint32", [PVOID, PVOID, "uint32", "uint32"]),
    readFile: library.func("__stdcall", "ReadFile", "int", [PVOID, PVOID, "uint32", koffi.pointer("uint32"), PVOID]),
    closeHandle: library.func("__stdcall", "CloseHandle", "int", [PVOID]),
    getLastError: library.func("__stdcall", "GetLastError", "uint32", []),
  } as unknown as Win32Bindings
  return bindings!
}

function isInvalid(handle: NativeHandle): boolean {
  return handle === null || handle === undefined || BigInt(handle) === INVALID_HANDLE_VALUE || BigInt(handle) === -1n
}

function normalizeFinalPath(path: string): string {
  if (path.startsWith("\\\\?\\UNC\\")) return `\\\\${path.slice(8)}`
  if (path.startsWith("\\\\?\\")) return path.slice(4)
  throw new Error("Windows returned a final path without a DOS volume")
}

/** Windows' GetFinalPathNameByHandleW binds the containment decision to the
 * handle opened by CreateFileW; ReadFile later consumes that same handle. */
export function openWindowsReviewFile(path: string): PinnedReviewFile {
  const api = win32()
  const handle = api.createFileW(path, GENERIC_READ, FILE_SHARE_READ_WRITE_DELETE, null, OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, null)
  if (isInvalid(handle)) {
    const code = api.getLastError()
    const error = new Error(`CreateFileW failed (${code})`) as NodeJS.ErrnoException
    if (code === 2 || code === 3) error.code = "ENOENT"
    throw error
  }
  try {
    const output = Buffer.alloc(32768 * 2)
    const length = api.getFinalPath(handle, output, 32768, 0)
    if (length === 0 || length >= 32768) throw new Error(`GetFinalPathNameByHandleW failed (${api.getLastError()})`)
    const finalPath = normalizeFinalPath(output.subarray(0, length * 2).toString("utf16le"))
    let closed = false
    return {
      finalPath,
      async read(maxBytes) {
        if (closed) throw new Error("review handle closed")
        const bytes = Buffer.alloc(maxBytes)
        const countPtr = koffi.alloc("uint32", 1)
        const result = api.readFile(handle, bytes, maxBytes, countPtr, null)
        if (result === 0) throw new Error(`ReadFile failed (${api.getLastError()})`)
        const count = koffi.decode(countPtr, "uint32") as number
        return { bytes: bytes.subarray(0, count), count }
      },
      async close() {
        if (closed) return
        closed = true
        if (api.closeHandle(handle) === 0) throw new Error(`CloseHandle failed (${api.getLastError()})`)
      },
    }
  } catch (error) {
    api.closeHandle(handle)
    throw error
  }
}
