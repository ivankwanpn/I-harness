import { expect, it, vi } from "vitest"
import { commitModelSwitch, switchJsonlModel } from "../src/model-switch.ts"
import { createSessionManagementFence } from "../src/session-management-fence.ts"
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

it("preserves active resources and publishes a changed JSONL selection only after its durable write succeeds", async () => {
  let active = true, activeWorkflow = false
  const operations: string[] = []
  const fence = createSessionManagementFence()
  const service = {
    inspectActivity: () => ({ live: true, running: false, tasks: 1, queued: 0, active }),
    closeSession: async () => { operations.push("close") },
    rebindModel: () => { operations.push("bind"); return true },
  }
  const binding = {} as Parameters<typeof switchJsonlModel>[3]
  const apply = (fail = false) => switchJsonlModel(service, fence, "s", binding, {
    hasDocument: () => true, hasActiveWorkflow: () => activeWorkflow,
    async persist() {
      operations.push("persist")
      if (fail) throw new Error("disk failed")
    },
  })
  await expect(apply()).rejects.toThrow("busy")
  expect(operations).toEqual([])
  active = false
  activeWorkflow = true
  await expect(apply()).rejects.toThrow("busy")
  expect(operations).toEqual([])
  activeWorkflow = false
  await expect(apply(true)).rejects.toThrow("disk failed")
  expect(operations).toEqual(["close", "persist"])
  await apply()
  expect(operations).toEqual(["close", "persist", "close", "persist", "bind"])
})
