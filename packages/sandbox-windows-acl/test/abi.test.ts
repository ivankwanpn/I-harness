import { describe, expect, it } from "vitest"
import * as abi from "../src/win32-abi.ts"
import { Win32Error } from "../src/errors.ts"

describe("win32-abi constants (spot-check against winnt.h)", () => {
  it("token rights are exact", () => {
    expect(abi.TOKEN_ASSIGN_PRIMARY).toBe(0x0001)
    expect(abi.TOKEN_DUPLICATE).toBe(0x0002)
    expect(abi.TOKEN_QUERY).toBe(0x0008)
    expect(abi.TOKEN_ADJUST_DEFAULT).toBe(0x0080)
  })

  it("restricted-token flags are exact", () => {
    expect(abi.WRITE_RESTRICTED).toBe(0x8)
    expect(abi.LUA_TOKEN).toBe(0x4)
    expect(abi.DISABLE_MAX_PRIVILEGE).toBe(0x1)
  })

  it("GRANT_MASK is the write+delete mask", () => {
    expect(abi.GRANT_MASK).toBe(0x00110156)
  })

  it("SE_GROUP_LOGON_ID has bit 31 set", () => {
    expect(abi.SE_GROUP_LOGON_ID >>> 0).toBe(0xC0000000)
  })

  it("struct sizes present for the ABI asserts", () => {
    expect(abi.SID_AND_ATTRIBUTES_SIZE).toBeGreaterThan(0)
    expect(abi.EXPLICIT_ACCESS_W_SIZE).toBe(48)
  })
})

describe("Win32Error", () => {
  it("carries api + win32Code and formats the message", () => {
    const err = new Win32Error("CreateRestrictedToken", 5, "Access is denied.")
    expect(err.win32Code).toBe(5)
    expect(err.api).toBe("CreateRestrictedToken")
    expect(err.message).toContain("CreateRestrictedToken")
    expect(err.message).toContain("5")
    expect(err.message).toContain("Access is denied.")
    expect(err).toBeInstanceOf(Error)
    expect(err.name).toBe("Win32Error")
  })

  it("omits the detail part when absent", () => {
    const err = new Win32Error("CloseHandle", 6)
    expect(err.message).toBe("CloseHandle failed (Win32 6)")
  })
})
