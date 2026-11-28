import { afterEach, expect, it, vi } from "vitest"
import type { LLMRequest, LLMStreamEvent } from "@i-harness/llm-seam"
import { createOpenAIClient } from "../src/index.ts"

const request: LLMRequest = { systemPrompt:"Original instructions", messages:[{role:"user",content:"Read the file"}], tools:[] }
const completed = {type:"response.completed",response:{status:"completed",usage:{input_tokens:131,input_tokens_details:{cached_tokens:128},output_tokens:624,output_tokens_details:{reasoning_tokens:246},total_tokens:755}}}
const response = (...frames: unknown[]) => new Response(frames.map(frame => "data: " + JSON.stringify(frame) + "\n\n").join(""), {headers:{"content-type":"text/event-stream"}})
async function collect(client: ReturnType<typeof createOpenAIClient>, input: LLMRequest) {
  const events: LLMStreamEvent[] = []
  for await (const event of client.stream(input)) events.push(event)
  return events
}
afterEach(() => vi.unstubAllGlobals())

it.each([["https://api.x.ai/v1/", "xai-api"], ["https://us.api.x.ai", "xai-us-api"]])("replays a qualified id-less encrypted item on %s and fences the original region", async (baseUrl, origin) => {
  const item = {type:"reasoning",summary:[],encrypted_content:"opaque_fixture"}
  const tool = {type:"function_call",id:"item_1",call_id:"call_1",name:"read",arguments:"{}"}
  const fetch = vi.fn(async (_url: string, _options: RequestInit) => response(completed)).mockResolvedValueOnce(response(
    {type:"response.output_item.done",output_index:0,item},
    {type:"response.output_item.added",output_index:1,item:tool},
    {type:"response.output_item.done",output_index:1,item:tool}, completed,
  ))
  vi.stubGlobal("fetch", fetch)
  const config = { model:"grok-4.6", apiKey:"synthetic", providerId:"my-grok", baseUrl }
  const first = await collect(createOpenAIClient(config), {...request,reasoningEffort:"max"})
  expect(first).toContainEqual({type:"usage",usage:{inputTokens:131,inputTokenSemantics:"includes-cache",cacheReadTokens:128,outputTokens:624}})
  const end = first.at(-1) as Extract<LLMStreamEvent,{type:"end"}>
  expect(end.providerContinuation).toMatchObject({origin,reasoningItems:[item]})
  const next: LLMRequest = {...request,messages:[...request.messages,
    {role:"assistant",content:"",toolCalls:[{id:"call_1",name:"read",args:{}}],providerContinuation:JSON.parse(JSON.stringify(end.providerContinuation))},
    {role:"tool",toolCallId:"call_1",content:"File content"}]}
  const [url, init] = fetch.mock.calls[0]!
  expect(url).toBe(new URL("/v1/responses",baseUrl).href)
  expect(init.redirect).toBe("error")
  expect(JSON.parse(String(init.body))).toMatchObject({store:false,include:["reasoning.encrypted_content"],reasoning:{effort:"xhigh"}})
  await collect(createOpenAIClient(config), next)
  expect(JSON.parse(String(fetch.mock.calls.at(-1)![1].body)).input.slice(1)).toEqual([
    item,{type:"function_call",call_id:"call_1",name:"read",arguments:"{}"},{type:"function_call_output",call_id:"call_1",output:"File content"},
  ])
  for (const other of ["https://proxy.example", origin === "xai-api" ? "https://us.api.x.ai" : "https://api.x.ai"]) {
    await collect(createOpenAIClient({...config,baseUrl:other}), next)
    expect(JSON.stringify(JSON.parse(String(fetch.mock.calls.at(-1)![1].body)).input)).not.toContain("opaque_fixture")
  }
})

it("uses named Grok model limits without changing user storage, explicit includes, or unrelated routes", async () => {
  const fetch = vi.fn(async (_url: string, _options: RequestInit) => response(completed))
  vi.stubGlobal("fetch",fetch)
  const config={baseUrl:"https://api.x.ai",apiKey:"synthetic",providerId:"grok",model:"grok-4.7"}
  await expect(createOpenAIClient(config).prepare!({...request,reasoningEffort:"off"})).rejects.toMatchObject({code:"INVALID_ARGUMENT",message:expect.stringContaining("xhigh")})
  expect(fetch).not.toHaveBeenCalled()
  for(const [model, effort] of [["grok-4.3","medium"],["grok-4.5","high"],["grok-4.7","xhigh"]]) {
    await collect(createOpenAIClient({...config,model:model!,options:{store:true,include:["custom"]}}),{...request,reasoningEffort:"max"})
    expect(JSON.parse(String(fetch.mock.calls.at(-1)![1].body))).toMatchObject({store:true,include:["custom"],reasoning:{effort}})
  }
  await collect(createOpenAIClient({...config,baseUrl:"https://api.x.ai.example"}),{...request,reasoningEffort:"off"})
  const proxy=JSON.parse(String(fetch.mock.calls.at(-1)![1].body))
  expect(proxy.reasoning.effort).toBe("none")
  expect(proxy).not.toHaveProperty("include")
  expect(proxy).not.toHaveProperty("store")
})
