import { expect, it, vi } from "vitest"
import { createSessionService } from "../src/index.ts"
it("takes fresh extension inputs per assembly and cleans mounts on disposal", async () => {
  const dispose = vi.fn()
  const mount = vi.fn(async () => dispose)
  const extensionsFor = vi.fn(async () => ({ options: {}, mount }))
  const service = createSessionService({ workspace: process.cwd(), modelPolicy: "test-mock", extensionsFor })
  try {
    const first = await service.assemblyFor("a")
    expect(await service.assemblyFor("a")).toBe(first)
    await service.assemblyFor("b")
    expect(extensionsFor).toHaveBeenCalledTimes(2)
    expect(mount).toHaveBeenCalledTimes(2)
    await service.closeSession("a")
    expect(dispose).toHaveBeenCalledTimes(1)
  } finally { await service.close() }
  expect(dispose).toHaveBeenCalledTimes(2)
})
