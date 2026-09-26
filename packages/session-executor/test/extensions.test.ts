import { expect, it, vi } from "vitest"
import { createSessionService } from "../src/index.ts"
it("disposes an extension first enabled after the assembly was created", async () => {
  let enabled = false
  const dispose = vi.fn()
  const service = createSessionService({ workspace: process.cwd(), modelPolicy: "test-mock", extensionsFor: async () => enabled ? { options: {}, mount: async () => dispose } : { options: {} } })
  try {
    await service.assemblyFor("s")
    enabled = true
    await service.refreshExtensions()
    await service.closeSession("s")
    expect(dispose).toHaveBeenCalledOnce()
  } finally { await service.close() }
})
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
