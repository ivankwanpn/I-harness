import { afterEach, expect, it, vi } from "vitest"
import { createOpenAIClient } from "../src/index.ts"
import type { LLMRequest, LLMStreamEvent } from "@i-harness/llm-seam"
afterEach(() => vi.unstubAllGlobals())
it.each([false, true])("reports neutral activity without changing wire or events (subscription %s)", async subscription => {
 const bodies: unknown[] = [], activities: string[] = []
 const frames: Record<string, unknown>[] = [{"type":"response.output_item.added","item":{"type":"function_call","id":"fc","call_id":"c","name":"read","arguments":""}},{"type":"response.function_call_arguments.delta","item_id":"fc","delta":""},{"type":"response.function_call_arguments.delta","item_id":"fc","delta":"{\"x\":1}"},{"type":"response.function_call_arguments.done","item_id":"fc"},{"type":"response.completed","response":{"status":"completed"}}]
 vi.stubGlobal("fetch", async (_url: unknown, init: RequestInit) => { bodies.push(JSON.parse(init.body as string)); return new Response(frames.map(event => 'event: '+(event.type ?? 'message')+'\ndata: '+JSON.stringify(event)+'\n\n').join("") + "data: [DONE]\n\n") })
 const client = createOpenAIClient({ apiKey: "fixture", model: "fixture", ...(subscription ? { codexSubscription: true, resolveCodexAuth: async () => ({ accessToken: "fixture", accountId: "fixture" }) } : { baseUrl: "https://fixture.invalid" }) })
 const request: LLMRequest = { messages: [{ role: "user", content: "hi" }], systemPrompt: "stable", tools: [] }
 const run = async (req: LLMRequest) => { const result: LLMStreamEvent[] = []; for await (const event of client.stream(req)) result.push(event); return result }
 const plain = await run(request)
 expect(await run({ ...request, onStreamActivity: kind => { activities.push(kind) } })).toEqual(plain)
 expect(bodies[1]).toEqual(bodies[0])
 expect(activities).toEqual(["response-start", "tool-arguments"])
 expect(await run({ ...request, onStreamActivity: () => { throw new Error("observer") } })).toEqual(plain)
})
