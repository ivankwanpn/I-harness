import { expect, it, vi } from "vitest"
import { commitModelSwitch } from "../src/model-switch.ts"
it("evicts a transient binding if durable selection persistence fails", async () => {
  const service = { rebindModel: vi.fn(), closeSession: vi.fn().mockResolvedValue(undefined) }
  const binding = {} as Parameters<typeof commitModelSwitch>[2]
  await expect(commitModelSwitch(service, "s", binding, async () => { throw new Error("disk failed") })).rejects.toThrow("disk failed")
  expect(service.rebindModel).toHaveBeenCalledWith("s", binding)
  expect(service.closeSession).toHaveBeenCalledWith("s")
})
it("does not persist when the service refuses a busy live rebind", async () => {
  const persist = vi.fn()
  const service = { rebindModel: vi.fn(() => { throw new Error("busy") }), closeSession: vi.fn() }
  await expect(commitModelSwitch(service, "s", {} as Parameters<typeof commitModelSwitch>[2], persist)).rejects.toThrow("busy")
  expect(persist).not.toHaveBeenCalled()
  expect(service.closeSession).not.toHaveBeenCalled()
})
