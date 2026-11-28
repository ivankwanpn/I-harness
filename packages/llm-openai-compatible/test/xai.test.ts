import { expect, it, vi } from "vitest"
import { createOpenAICompatibleClient } from "../src/index.ts"

it("preserves the regional Chat endpoint and uses its actual Grok effort range", async () => {
  const fetch = vi.fn(async (_url: Parameters<typeof globalThis.fetch>[0], _init?: RequestInit) => new Response('data: {"choices":[{"finish_reason":"stop","delta":{}}]}\n\ndata: [DONE]\n\n'))
  const client=createOpenAICompatibleClient({apiKey:"synthetic",model:"grok-4.7",baseUrl:"https://us.api.x.ai/v1/",fetch})
  const request={messages:[],systemPrompt:"",tools:[]}
  await expect(client.prepare!({...request,reasoningEffort:"off"})).rejects.toMatchObject({code:"INVALID_ARGUMENT"})
  expect(fetch).not.toHaveBeenCalled()
  for await(const _ of client.stream({...request,reasoningEffort:"max"})) {}
  const [url, init] = fetch.mock.calls[0]!
  expect(url).toBe("https://us.api.x.ai/v1/chat/completions")
  expect(init?.redirect).toBe("error")
  expect(JSON.parse(String(init?.body)).reasoning_effort).toBe("xhigh")
})
