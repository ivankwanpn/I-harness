import { describe, expect, it, vi } from "vitest"

describe("session assembly module loading", () => {
  it("does not initialize Windows ACL native types when the assembly is only imported", async () => {
    await import("../src/assembly.ts")
    vi.resetModules()

    await expect(import("../src/assembly.ts")).resolves.toMatchObject({
      createSessionAssembly: expect.any(Function),
    })
  })
})
