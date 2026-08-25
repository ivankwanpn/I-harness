import { describe, expect, it } from "vitest"
import { buildExplicitAccess } from "../src/acl.ts"
import * as abi from "../src/win32-abi.ts"
import { allocBytes, ptrAddress } from "../src/ffi.ts"

describe("buildExplicitAccess (pure buffer packing)", () => {
  it("packs a GRANT_ACCESS entry (48 bytes) with OI|CI and TRUSTEE_IS_SID", () => {
    const sid = allocBytes(68)
    const entry = buildExplicitAccess(sid, abi.GRANT_ACCESS, abi.GRANT_MASK)
    expect(entry.length).toBe(48)
    expect(entry.readUInt32LE(0)).toBe(abi.GRANT_MASK)
    expect(entry.readUInt32LE(4)).toBe(abi.GRANT_ACCESS)
    expect(entry.readUInt32LE(8)).toBe(abi.SUB_CONTAINERS_AND_OBJECTS_INHERIT)
    expect(entry.readUInt32LE(24)).toBe(abi.NO_MULTIPLE_TRUSTEE)
    expect(entry.readUInt32LE(28)).toBe(abi.TRUSTEE_IS_SID)
    expect(entry.readUInt32LE(32)).toBe(abi.TRUSTEE_IS_UNKNOWN)
    expect(entry.readBigUInt64LE(40)).toBe(ptrAddress(sid))
  })
})
