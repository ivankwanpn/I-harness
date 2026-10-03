import koffi from "koffi"
import type { PinnedProjectDirectory } from "./project-directory-handle.ts"

/** Lock the directory name against replacement while opendir consumes it. Each
 * ancestor is pinned by the caller, including the canonical workspace root. */
export function openWindowsProjectDirectory(path: string): PinnedProjectDirectory {
  const library = koffi.load("kernel32.dll"), pointer = koffi.pointer("void")
  const create = library.func("__stdcall", "CreateFileW", pointer, ["str16", "uint32", "uint32", pointer, "uint32", "uint32", pointer])
  const final = library.func("__stdcall", "GetFinalPathNameByHandleW", "uint32", [pointer, pointer, "uint32", "uint32"])
  const info = library.func("__stdcall", "GetFileInformationByHandle", "int", [pointer, pointer])
  const close = library.func("__stdcall", "CloseHandle", "int", [pointer])
  const lastError = library.func("__stdcall", "GetLastError", "uint32", [])
  const handle = create(path, 1, 1 | 2, null, 3, 0x02000000 | 0x00200000, null) as bigint | number | null
  if (handle === null || BigInt(handle) === -1n || BigInt(handle) === 0xffffffffffffffffn) throw new Error(`Cannot pin project directory (${lastError()})`)
  try {
    const details = Buffer.alloc(52)
    if (info(handle, details) === 0 || (details.readUInt32LE(0) & 0x10) === 0 || (details.readUInt32LE(0) & 0x400) !== 0) throw new Error("Project directory is not a real directory")
    const output = Buffer.alloc(32768 * 2), length = final(handle, output, 32768, 0) as number
    if (length === 0 || length >= 32768) throw new Error("Cannot determine project directory handle path")
    const nativePath = output.subarray(0, length * 2).toString("utf16le")
    const finalPath = nativePath.startsWith("\\\\?\\UNC\\") ? `\\\\${nativePath.slice(8)}` : nativePath.startsWith("\\\\?\\") ? nativePath.slice(4) : undefined
    if (!finalPath) throw new Error("Project directory handle has no DOS volume")
    let closed = false
    return { finalPath, scanPath: finalPath, async close() { if (!closed) { closed = true; if (close(handle) === 0) throw new Error("Cannot release project directory handle") } } }
  } catch (error) { close(handle); throw error }
}
