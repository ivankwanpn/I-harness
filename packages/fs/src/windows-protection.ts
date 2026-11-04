/**
 * Windows DACL protection for a credential file or directory.
 *
 * One implementation for every caller: the ChatGPT OAuth token store and the
 * provider API-key store both need "exactly the current user, protected DACL,
 * inheritable to the files inside". They used to carry their own copies — the
 * key store had none at all, so on Windows its secrets inherited the directory
 * ACL (`chmod 0600` is a no-op there).
 *
 * koffi is imported dynamically so a POSIX host never loads it.
 */
export async function protectWindowsPath(path: string): Promise<void> {
  if (process.platform !== "win32") throw new Error("Windows path protection is win32-only")
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
    if (!open(current(), 0x0008, token)) throw new Error("Cannot protect path")
    const size = [0]
    info(token[0], 1, null, 0, size)
    const data = Buffer.alloc(size[0]!)
    if (!info(token[0], 1, data, data.length, size)) throw new Error("Cannot protect path")
    const userSid = koffi.decode(data, ptr)
    if (!sidString(userSid, sid)) throw new Error("Cannot protect path")
    const user = koffi.decode(sid[0], "char16", -1) as string
    // Protected DACL, exactly the current user; OI/CI propagate to temporary files.
    if (!descriptor(`D:P(A;OICI;FA;;;${user})`, 1, sd, null)) throw new Error("Cannot protect path")
    if (!setSecurity(path, 0x80000004, sd[0])) throw new Error("Cannot protect path")
  } finally {
    if (sd[0]) free(sd[0])
    if (sid[0]) free(sid[0])
    if (token[0]) close(token[0])
  }
}
