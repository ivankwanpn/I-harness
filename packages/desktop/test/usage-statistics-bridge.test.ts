import { expect, it, vi } from "vitest"
import { createGlobalProviderSettings } from "../src/main/global-provider-settings.ts"

it("queries global usage without an active workspace or opening a browser", async () => {
  const query = { start: 0, end: 86400000, timeZone: "Asia/Hong_Kong", page: 1 }
  const snapshot = { summary: { requests: 0 } }
  const request = vi.fn(async () => snapshot)
  const openExternal = vi.fn()
  const service = createGlobalProviderSettings(async () => ({ request }), { openExternal })
  expect(await service.request({ kind: "desktop/usage/query", query })).toEqual(snapshot)
  expect(request).toHaveBeenCalledWith("desktop/usage/query", { query })
  expect(openExternal).not.toHaveBeenCalled()
  await service.close()
})

it("sends explicit pricing configuration to the usage owner", async () => {
  const price = { providerId: "api", modelId: "m", inputPerMillion: 2, outputPerMillion: 8, source: "My contract", updatedAt: 1 }
  const request = vi.fn(async () => ({ saved: true }))
  const service = createGlobalProviderSettings(async () => ({ request }))
  await expect(service.request({ kind: "desktop/usage/pricing", price })).resolves.toEqual({ saved: true })
  expect(request).toHaveBeenCalledWith("desktop/usage/pricing", { price })
  await service.close()
})

it.each([
  { kind: "desktop/usage/query", query: null },
  { kind: "desktop/usage/query", query: [] },
  { kind: "desktop/usage/pricing", price: "bad" },
  { kind: "desktop/usage/reset" },
])("rejects malformed usage envelopes without dispatch", async input => {
  const request = vi.fn()
  const service = createGlobalProviderSettings(async () => ({ request }))
  await expect(service.request(input)).rejects.toThrow()
  expect(request).not.toHaveBeenCalled()
  await service.close()
})
