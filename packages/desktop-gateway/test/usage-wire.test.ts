import { expect, it, vi } from "vitest"
import { usageRequest } from "../src/usage-wire.ts"

const query = { start: 0, end: 86400000, timeZone: "Asia/Hong_Kong" }
const fixture = () => ({ query: vi.fn(async () => ({ totalRecords: 0 })), setPricing: vi.fn(async () => {}) })

it("validates usage query and pricing before sending to their owner", async () => {
  const store = fixture()
  expect(await usageRequest(store as any, "desktop/usage/query", { query })).toEqual({ totalRecords: 0 })
  expect(store.query).toHaveBeenCalledWith(expect.objectContaining(query))
  const price = { providerId: "p", modelId: "m", inputPerMillion: 2, outputPerMillion: 4, source: "Contract", updatedAt: 1 }
  expect(await usageRequest(store as any, "desktop/usage/pricing", { price })).toEqual({ saved: true })
  expect(store.setPricing).toHaveBeenCalledWith(price)
})

it.each([
  ["desktop/usage/query", { query: { ...query, timeZone: "INVALID/ZONE" } }],
  ["desktop/usage/query", { query: { ...query, end: 0 } }],
  ["desktop/usage/query", { query: { ...query, pageSize: 100000 } }],
  ["desktop/usage/query", { query: { ...query, start: NaN } }],
  ["desktop/usage/query", { query, directory: "C:/sensitive" }],
  ["desktop/usage/pricing", { price: { providerId: "p", modelId: "m", inputPerMillion: -1 } }],
  ["desktop/usage/remove", {}],
])("rejects malformed usage requests without IO (%s)", async (method, params) => {
  const store = fixture()
  await expect(usageRequest(store as any, method as string, params)).rejects.toThrow()
  expect(store.query).not.toHaveBeenCalled()
  expect(store.setPricing).not.toHaveBeenCalled()
})
