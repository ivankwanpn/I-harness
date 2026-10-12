import { afterEach, expect, it, vi } from "vitest"
import { createAnthropicClient } from "../src/index.ts"
import type { LLMRequest, LLMStreamEvent } from "@i-harness/llm-seam"
afterEach(() => vi.unstubAllGlobals())
it.each([false])("reports neutral activity without changing wire or events (subscription %s)", async subscription => {
 const bodies: unknown[] = [], activities: string[] = []
 const frames: Record<string, unknown>[] = [{"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"c","name":"read","input":{}}},{"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":""}},{"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{\"x\":1}"}},{"type":"content_block_stop","index":0},{"type":"message_stop"}]
 vi.stubGlobal("fetch", async (_url: unknown, init: RequestInit) => { bodies.push(JSON.parse(init.body as string)); return new Response(frames.map(event => 'event: '+(event.type ?? 'message')+'\ndata: '+JSON.stringify(event)+'\n\n').join("") + "data: [DONE]\n\n") })
 const client = createAnthropicClient({ apiKey: "fixture", model: "fixture", ...(subscription ? { codexSubscription: true, resolveCodexAuth: async () => ({ accessToken: "fixture", accountId: "fixture" }) } : { baseUrl: "https://fixture.invalid" }) })
 const request: LLMRequest = { messages: [{ role: "user", content: "hi" }], systemPrompt: "stable", tools: [] }
 const run = async (req: LLMRequest) => { const result: LLMStreamEvent[] = []; for await (const event of client.stream(req)) result.push(event); return result }
 const plain = await run(request)
 expect(await run({ ...request, onStreamActivity: kind => { activities.push(kind) } })).toEqual(plain)
 expect(bodies[1]).toEqual(bodies[0])
 expect(activities).toEqual(["response-start", "tool-arguments"])
 expect(await run({ ...request, onStreamActivity: () => { throw new Error("observer") } })).toEqual(plain)
})
