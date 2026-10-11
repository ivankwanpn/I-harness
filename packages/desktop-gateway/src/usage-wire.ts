import { validateUsagePrice, validateUsageQuery } from "@i-harness/usage-stats"
import type { DesktopHandlers } from "./types.ts"

/** The renderer supplies filters and prices, never storage locations. */
export async function usageRequest(store: NonNullable<DesktopHandlers["usageStats"]>, method: string, params: unknown): Promise<unknown> {
  if (!params || typeof params !== "object" || Array.isArray(params)) throw new Error("Invalid usage request")
  const input = params as Record<string, unknown>
  if (method === "desktop/usage/query" && Object.keys(input).every(key => key === "query")) {
    return store.query(validateUsageQuery(input.query))
  }
  if (method === "desktop/usage/pricing" && Object.keys(input).every(key => key === "price")) {
    await store.setPricing(validateUsagePrice(input.price))
    return { saved: true }
  }
  throw new Error("Invalid usage operation")
}
