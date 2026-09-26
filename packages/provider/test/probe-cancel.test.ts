import { afterEach, expect, it, vi } from "vitest"
import { createProviderRegistry } from "../src/index.ts"
afterEach(() => vi.unstubAllGlobals())
it("forwards cancellation to HTTP and refuses a late successful response", async () => {
  let signal: AbortSignal | undefined
  let respond!: (value: Response) => void
  let entered!: () => void
  const started = new Promise<void>((resolve) => { entered = resolve })
  vi.stubGlobal("fetch", vi.fn((_url, options) => { signal = options.signal; entered(); return new Promise<Response>((resolve) => { respond = resolve }) }))
  const controller = new AbortController()
  const pending = createProviderRegistry().probeModels("custom", { baseURL: "https://example.invalid", signal: controller.signal }).then(() => "success", () => "cancelled")
  await started
  controller.abort()
  respond(new Response(JSON.stringify({ data: [{ id: "m" }] })))
  const result = await pending
  expect(signal?.aborted).toBe(true)
  expect(result).toBe("cancelled")
})
