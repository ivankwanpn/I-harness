import koffi from "koffi"
import type { PinnedEditableFile } from "./review-edit-handle.ts"

type NativeHandle = bigint | number | null

/** Deny concurrent write/delete handles while comparing and saving on Windows. */
export function openWindowsEditableFile(path: string): PinnedEditableFile {
  const library = koffi.load("kernel32.dll")
  const pointer = koffi.pointer("void")
  const create = library.func("__stdcall", "CreateFileW", pointer, ["str16", "uint32", "uint32", pointer, "uint32", "uint32", pointer])
  const final = library.func("__stdcall", "GetFinalPathNameByHandleW", "uint32", [pointer, pointer, "uint32", "uint32"])
  const info = library.func("__stdcall", "GetFileInformationByHandle", "int", [pointer, pointer])
  const seek = library.func("__stdcall", "SetFilePointerEx", "int", [pointer, "int64", pointer, "uint32"])
  const read = library.func("__stdcall", "ReadFile", "int", [pointer, pointer, "uint32", pointer, pointer])
  const write = library.func("__stdcall", "WriteFile", "int", [pointer, pointer, "uint32", pointer, pointer])
  const truncate = library.func("__stdcall", "SetEndOfFile", "int", [pointer])
  const flush = library.func("__stdcall", "FlushFileBuffers", "int", [pointer])
  const close = library.func("__stdcall", "CloseHandle", "int", [pointer])
  const lastError = library.func("__stdcall", "GetLastError", "uint32", [])
  const handle = create(path, 0xc0000000, 1, null, 3, 0x80, null) as NativeHandle
  if (handle === null || BigInt(handle) === -1n || BigInt(handle) === 0xffffffffffffffffn) {
    const code = lastError() as number
    const error = new Error(`Cannot open file for save (${code})`) as NodeJS.ErrnoException
    if (code === 2 || code === 3) error.code = "ENOENT"
    throw error
  }
  try {
    const details = Buffer.alloc(52)
    if (info(handle, details) === 0 || (details.readUInt32LE(0) & 0x10) !== 0 || details.readUInt32LE(40) !== 1) {
      throw new Error("edit target must be a regular file with one link")
    }
    const output = Buffer.alloc(32768 * 2)
    const length = final(handle, output, 32768, 0) as number
    if (length === 0 || length >= 32768) throw new Error("cannot determine edit handle path")
    const nativePath = output.subarray(0, length * 2).toString("utf16le")
    const finalPath = nativePath.startsWith("\\\\?\\UNC\\") ? `\\\\${nativePath.slice(8)}`
      : nativePath.startsWith("\\\\?\\") ? nativePath.slice(4) : undefined
    if (finalPath === undefined) throw new Error("edit handle has no DOS volume")
    let closed = false
    const check = (result: unknown) => { if (result === 0) throw new Error(`File save failed (${lastError()})`) }
    return {
      finalPath,
      async read(maxBytes) {
        if (closed) throw new Error("edit handle closed")
        check(seek(handle, 0n, null, 0))
        const bytes = Buffer.alloc(maxBytes)
        const count = Buffer.alloc(4)
        check(read(handle, bytes, maxBytes, count, null))
        return { bytes: bytes.subarray(0, count.readUInt32LE(0)), count: count.readUInt32LE(0) }
      },
      async write(bytes) {
        if (closed) throw new Error("edit handle closed")
        check(seek(handle, 0n, null, 0))
        let offset = 0
        while (offset < bytes.length) {
          const count = Buffer.alloc(4)
          check(write(handle, bytes.subarray(offset), bytes.length - offset, count, null))
          const written = count.readUInt32LE(0)
          if (written === 0) throw new Error("file save made no progress")
          offset += written
        }
        check(truncate(handle))
        check(flush(handle))
      },
      async close() {
        if (closed) return
        closed = true
        check(close(handle))
      },
    }
  } catch (error) { close(handle); throw error }
}
