import { expect, it } from "vitest"
import { createSessionManagementFence } from "../src/session-management-fence.ts"
it("drains previously registered admissions and prevents new starts until management finishes", async () => {
  const fence = createSessionManagementFence()
  let release!: () => void
  const entered = Promise.withResolvers<void>()
  const old = fence.run("s", async () => { entered.resolve(); await new Promise<void>(resolve => { release = resolve }) })
  await entered.promise
  let managed = false
  const exclusive = fence.exclusive("s", async () => { managed = true; fence.retire("s") })
  expect(managed).toBe(false)
  let started = false
  await expect(fence.run("s", async () => { started = true })).rejects.toThrow(/management|deleted/)
  expect(started).toBe(false)
  await fence.run("sibling", async () => {})
  release(); await old; await exclusive
  expect(managed).toBe(true)
  await expect(fence.run("s", async () => {})).rejects.toThrow(/deleted/)
})
