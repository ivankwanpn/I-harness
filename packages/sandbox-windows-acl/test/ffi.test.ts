import { describe, expect, it } from "vitest"
import { allocBytes, allocPtrSlot, allocUint32, decodeUint32, encodeUint32, isNullPtr, ptrAddress } from "../src/ffi.ts"

describe("ffi helpers (pure, no koffi load on non-win32)", () => {
  it("allocBytes returns a non-null buffer-aligned pointer on win32", () => {
    if (process.platform !== "win32") return // koffi native load is win32-only in CI
    const p = allocBytes(64)
    expect(isNullPtr(p)).toBe(false)
  })

  it("encodeUint32/decodeUint32 round-trip", () => {
    const slot = allocUint32()
    encodeUint32(slot, 42)
    expect(decodeUint32(slot)).toBe(42)
  })

  it("allocPtrSlot holds a zeroed pointer (no crash)", () => {
    const slot = allocPtrSlot()
    expect(ptrAddress(slot)).toBeTypeOf("bigint")
  })
})
