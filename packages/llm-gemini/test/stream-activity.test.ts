import { afterEach, expect, it, vi } from "vitest"
import { createGeminiClient } from "../src/index.ts"
import type { LLMRequest, LLMStreamEvent } from "@i-harness/llm-seam"
afterEach(() => vi.unstubAllGlobals())
it.each([false])("reports neutral activity without changing wire or events (subscription %s)", async subscription => {
 const bodies: unknown[] = [], activities: string[] = []
 const frames: Record<string, unknown>[] = [{"candidates":[{"content":{"parts":[{"functionCall":{"name":"read","args":{"x":1}}},{"functionCall":{"args":{}}}]},"finishReason":"STOP"}]}]
 vi.stubGlobal("fetch", async (_url: unknown, init: RequestInit) => { bodies.push(JSON.parse(init.body as string)); return new Response(frames.map(event => 'event: '+(event.type ?? 'message')+'\ndata: '+JSON.stringify(event)+'\n\n').join("") + "data: [DONE]\n\n") })
 const client = createGeminiClient({ apiKey: "fixture", model: "fixture", ...(subscription ? { codexSubscription: true, resolveCodexAuth: async () => ({ accessToken: "fixture", accountId: "fixture" }) } : { baseUrl: "https://fixture.invalid" }) })
 const request: LLMRequest = { messages: [{ role: "user", content: "hi" }], systemPrompt: "stable", tools: [] }
 const run = async (req: LLMRequest) => { const result: LLMStreamEvent[] = []; for await (const event of client.stream(req)) result.push(event); return result }
 const plain = await run(request)
 expect(await run({ ...request, onStreamActivity: kind => { activities.push(kind) } })).toEqual(plain)
 expect(bodies[1]).toEqual(bodies[0])
 expect(activities).toEqual(["response-start", "tool-arguments"])
 expect(await run({ ...request, onStreamActivity: () => { throw new Error("observer") } })).toEqual(plain)
})
