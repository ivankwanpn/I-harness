import { expect, it, vi } from "vitest"
import { createProviderProbes } from "../src/provider-probes.ts"
it("cancels only the matching attempt and drains probes on close", async () => {
  const probeModels = vi.fn((_id, options) => new Promise<never>((_resolve, reject) => {
    options.signal.addEventListener("abort", () => reject(new Error("cancelled")), { once: true })
  }))
  const probes = createProviderProbes({ probeModels })
  const first = probes.start("a", "first").catch((error: Error) => error.message)
  const second = probes.start("a", "second").catch((error: Error) => error.message)
  await Promise.resolve()
  expect(probes.cancel("first")).toEqual({ cancelled: true })
  expect(await first).toBe("cancelled")
  expect(probes.cancel("first")).toEqual({ cancelled: false })
  await probes.close()
  expect(await second).toBe("cancelled")
  await expect(probes.start("a", "new")).rejects.toThrow("unavailable")
})
