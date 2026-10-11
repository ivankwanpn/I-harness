import { chmod, lstat, mkdir } from "node:fs/promises"

/** A dedicated credential directory: reject links and fail closed if protection fails. */
export async function protectChatGptDirectory(directory: string): Promise<void> {
  await mkdir(directory, { recursive: true, mode: 0o700 })
  const stat = await lstat(directory)
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("Credential directory must be a real directory")
  if (process.platform !== "win32") { await chmod(directory, 0o700); return }
  await restrictWindowsPath(directory)
}

/** Existing files may carry explicit ACL entries that a parent DACL cannot remove. */
export async function protectChatGptFile(path: string): Promise<void> {
  if (process.platform !== "win32") { await chmod(path, 0o600); return }
  await restrictWindowsPath(path)
}

async function restrictWindowsPath(path: string): Promise<void> {
  const { default: koffi } = await import("koffi")
  const kernel = koffi.load("kernel32.dll")
  const advapi = koffi.load("advapi32.dll")
  const ptr = koffi.pointer("void")
  const current = kernel.func("__stdcall", "GetCurrentProcess", ptr, [])
  const close = kernel.func("__stdcall", "CloseHandle", "int", [ptr])
  const free = kernel.func("__stdcall", "LocalFree", ptr, [ptr])
  const open = advapi.func("__stdcall", "OpenProcessToken", "int", [ptr, "uint32", koffi.out(koffi.pointer(ptr))])
  const info = advapi.func("__stdcall", "GetTokenInformation", "int", [ptr, "int", ptr, "uint32", koffi.out(koffi.pointer("uint32"))])
  const sidString = advapi.func("__stdcall", "ConvertSidToStringSidW", "int", [ptr, koffi.out(koffi.pointer(ptr))])
  const descriptor = advapi.func("__stdcall", "ConvertStringSecurityDescriptorToSecurityDescriptorW", "int", ["str16", "uint32", koffi.out(koffi.pointer(ptr)), ptr])
  const setSecurity = advapi.func("__stdcall", "SetFileSecurityW", "int", ["str16", "uint32", ptr])
  const token: unknown[] = [null], sid: unknown[] = [null], sd: unknown[] = [null]
  try {
    if (!open(current(), 0x0008, token)) throw new Error("Cannot protect credential directory")
    const size = [0]
    info(token[0], 1, null, 0, size)
    const data = Buffer.alloc(size[0]!)
    if (!info(token[0], 1, data, data.length, size)) throw new Error("Cannot protect credential directory")
    const userSid = koffi.decode(data, ptr)
    if (!sidString(userSid, sid)) throw new Error("Cannot protect credential directory")
    const user = koffi.decode(sid[0], "char16", -1) as string
    // Protected DACL, exactly the current user; OI/CI propagate to temporary files.
    if (!descriptor(`D:P(A;OICI;FA;;;${user})`, 1, sd, null)) throw new Error("Cannot protect credential directory")
    if (!setSecurity(path, 0x80000004, sd[0])) throw new Error("Cannot protect credential directory")
  } finally {
    if (sd[0]) free(sd[0])
    if (sid[0]) free(sid[0])
    if (token[0]) close(token[0])
  }
}
