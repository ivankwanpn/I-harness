import { describe, expect, it } from "vitest"
import { AclWriteGrant } from "../src/grant.ts"
import type { Win32Bindings } from "../src/ffi.ts"
import koffi from "koffi"

describe("AclWriteGrant", () => {
  it("create parses the SID string (win32-only)", () => {
    if (process.platform !== "win32") return
    const grant = AclWriteGrant.create("S-1-4-1-2")
    expect(grant.writeSid).toBe("S-1-4-1-2")
    grant.dispose()
  })
  it("retains the SID for a failed LocalFree and retries cleanup", () => {
    let frees = 0
    const sid = koffi.alloc('uint8', 1)
    const api = {
      convertStringSidToSidW: (_sid: string, slot: unknown) => { koffi.encode(slot, 'void *', sid); return 1 },
      localFree: () => { frees++; return frees === 1 ? sid : null },
      getLastError: () => 5,
      formatMessageW: () => 0,
    } as unknown as Win32Bindings
    const grant = AclWriteGrant.create("S-1-4-1-2", api)
    expect(() => grant.dispose()).toThrow(/cleanup failure/)
    expect(() => grant.dispose()).not.toThrow()
    expect(frees).toBe(2)
  })
})
