import { afterEach, expect, it, vi } from "vitest"
const { routed } = vi.hoisted(() => ({ routed: vi.fn() }))
vi.mock("@i-harness/http-transport", () => ({ systemFetch: routed }))
import { createOpenAIClient } from "../src/index.ts"

afterEach(() => { vi.unstubAllGlobals(); routed.mockReset() })
it("routes Codex subscription Responses through the shared system transport with account headers", async () => {
  const fetcher = vi.fn(async () => new Response('data: {"type":"response.completed","response":{"status":"completed","output":[]}}\n\n'))
  vi.stubGlobal("fetch", fetcher)
  routed.mockImplementation(async (input: string, init: RequestInit, beforeTransport?: () => Promise<() => void>) => { const issue = await beforeTransport?.(); issue?.(); return globalThis.fetch(input, init) })
  const client = createOpenAIClient({ model: "model", apiKey: "", codexSubscription: true, resolveCodexAuth: async () => ({ accessToken: "synthetic", accountId: "workspace-a" }) })
  for await (const _ of client.stream({ messages: [{ role: "user", content: "fixture" }], tools: [], systemPrompt: "fixture" })) {}
  expect(routed).toHaveBeenCalledOnce()
  expect(routed).toHaveBeenCalledWith("https://chatgpt.com/backend-api/codex/responses", expect.objectContaining({ redirect: "error", headers: expect.objectContaining({ "ChatGPT-Account-Id": "workspace-a", Authorization: "Bearer synthetic" }) }), expect.any(Function))
})
