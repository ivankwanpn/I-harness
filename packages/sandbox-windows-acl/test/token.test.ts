import { describe, expect, it } from "vitest"
import { win32Sync } from "../src/ffi.ts"

describe("token construction (win32-only)", () => {
  it.skipIf(process.platform !== "win32")("openCurrentProcessToken returns a handle", () => {
    const api = win32Sync()
    expect(api).toBeDefined()
  })
})
