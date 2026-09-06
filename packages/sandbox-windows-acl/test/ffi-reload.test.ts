import { describe, expect, it, vi } from "vitest"

describe("Win32 FFI module loading", () => {
  it("can reload the FFI module without re-registering global native type names", async () => {
    await import("../src/ffi.ts")
    vi.resetModules()

    await expect(import("../src/ffi.ts")).resolves.toMatchObject({
      allocStartupInfo: expect.any(Function),
      allocProcessInfo: expect.any(Function),
    })
  })
})
