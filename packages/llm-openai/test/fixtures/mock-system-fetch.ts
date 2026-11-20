import { beforeEach, vi } from "vitest"

// Subscription calls reach systemFetch, while direct API calls reach fetch.
// Route both through the same per-test response fixtures, after issuance.
vi.mock("@i-harness/http-transport", async importOriginal => {
  const original = await importOriginal<typeof import("@i-harness/http-transport")>()
  const systemFetch: typeof original.systemFetch = async (input, init, beforeTransport) => {
    const issue = await beforeTransport?.()
    issue?.()
    return globalThis.fetch(input, init)
  }
  return { ...original, systemFetch }
})

beforeEach(() => {
  vi.stubGlobal("fetch", async () => { throw new Error("Expected a test response fixture") })
})
