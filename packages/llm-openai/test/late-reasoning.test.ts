import { afterEach, expect, it, vi } from "vitest"
import { createServer, type Server } from "node:http"
import { createSession, append, deriveMessages, fromJSONL, toJSONL } from "../../core-session/src/index.ts"
import { createOpenAIClient } from "../src/index.ts"
import type { LLMRequest, LLMStreamEvent } from "@i-harness/llm-seam"

const config = { apiKey: "fixture", model: "gpt-5-mini", providerId: "azure", baseUrl: "https://resource.openai.azure.com/openai", options: { store: false } }
const start: LLMRequest = { systemPrompt: "", tools: [], messages: [{ role: "user", content: "read the file" }] }
const raw = { type: "reasoning", id: "rs_1", summary: [{ type: "summary_text", text: "a summary" }] }
const cipher = "late-cipher-only", completed = { ...raw, encrypted_content: cipher }
const tool = { type: "function_call", id: "fc1", call_id: "call_read", name: "read", arguments: '{"path":"a.txt"}', status: "completed" }
const done = (item:unknown, output_index:number) => ({type:"response.output_item.done",output_index,item})
const final = (output:unknown[]) => ({type:"response.completed",response:{status:"completed",output}})
async function observe(frames:unknown[], route = config) {
  const wire = vi.fn(async (_url: string, _init: RequestInit) => new Response(frames.map(event=>"data: "+JSON.stringify(event)+"\n\n").join("")))
  vi.stubGlobal("fetch",wire)
  const events: LLMStreamEvent[] = []
  for await (const e of createOpenAIClient(route).stream(start)) events.push(e)
  return events
}
afterEach(()=>vi.unstubAllGlobals())

it.each([true,false])("preserves terminal encrypted reasoning through a real journal reopen (intermediate reasoning=%s)",async intermediate=>{
  const events=await observe([...(intermediate?[done(raw,0),{type:"response.output_item.added",output_index:1,item:tool},done(tool,1)]:[]),final([completed,tool])])
  const session=createSession()
  append(session,{type:"user/message",text:"read the file"});append(session,{type:"step/start"})
  for(const event of events){
    if(event.type==="error")throw event.error
    if(event.type==="tool_call")append(session,{type:"tool/call",callId:event.call.id!,name:event.call.name,args:event.call.args})
    if(event.type==="end")append(session,{type:"assistant/message",text:"",providerContinuation:event.providerContinuation})
  }
  expect(events.filter(event=>event.type==="tool_call")).toHaveLength(1)
  append(session,{type:"tool/result",name:"read",callId:tool.call_id,output:"file contents"});append(session,{type:"step/end"})
  const messages=deriveMessages(fromJSONL(toJSONL(session)))
  const wire=vi.fn(async (_url:string,_init:RequestInit)=>new Response('data: {"type":"response.completed"}\n\n'))
  vi.stubGlobal("fetch",wire)
  for(const target of [config,{...config,baseUrl:"https://resource.openai.azure.com/other"},{...config,providerId:"other"},{...config,model:"another"}]){
    for await(const event of createOpenAIClient(target).stream({...start,messages}))if(event.type==="error")throw event.error
    const [,init]=wire.mock.calls.at(-1)!
    const input=JSON.parse(String(init.body)).input
    if(target===config){expect(input.slice(1)).toEqual([completed,{type:"function_call",call_id:tool.call_id,name:tool.name,arguments:tool.arguments},{type:"function_call_output",call_id:tool.call_id,output:JSON.stringify("file contents")}]);expect(init.redirect).toBe("error")}
    else {expect(JSON.stringify(input)).not.toContain(cipher);expect(input).toContainEqual({type:"function_call_output",call_id:tool.call_id,output:JSON.stringify("file contents")})}
  }
})

it.each([
  ["changed-content", [done(raw,0)], [{...completed,summary:[{type:"summary_text",text:"changed"}]}]],
  ["changed-id", [done(raw,0)], [{...completed,id:"rs_other"}]],
  ["changed-position", [done(raw,1)], [completed]],
  ["repeated-final-id", [done(raw,0)], [completed,completed]],
  ["competing-source-id", [done(raw,0),done({...raw,id:"other"},0)], [completed]],
  ["competing-source-content", [done(raw,0),done({...raw,summary:[]},0)], [completed]],
  ["unidentified", [], [{...completed,id:undefined}]],
  ["unfinished", [], [{...completed,status:"in_progress"}]],
  ["malformed-summary", [], [{...completed,summary:"invalid"}]],
] as const)("does not attach ambiguous terminal data (%s)",async (_why,early,output)=>{
  const events=await observe([...early,final([...output])])
  expect(JSON.stringify(events)).not.toContain(cipher)
})
it("keeps the original nonempty ciphertext when a terminal record differs",async()=>{
  const original={...raw,encrypted_content:"original-cipher"}
  const events=await observe([done(original,0),final([completed])])
  expect(events.at(-1)).toMatchObject({type:"end",providerContinuation:{reasoningItems:[original]}})
  expect(JSON.stringify(events)).not.toContain(cipher)
})

it("recognizes a repeated identical item.done without changing assistant order", async () => {
  const events = await observe([done(raw, 0), done(structuredClone(raw), 0), final([completed, tool])])
  expect(events.filter(e => e.type === "tool_call")).toHaveLength(1)
  expect(events.at(-1)).toMatchObject({ type: "end", providerContinuation: {
    reasoningItems: [completed], outputOrder: [{ kind: "reasoning", index: 0 }, { kind: "tool", index: 0 }],
  } })
})

it.each(["https://user:secret@service.invalid/base", "https://service.invalid/base?api-key=secret", "https://service.invalid/base#secret"])(
  "keeps URL-sensitive provenance unqualified without retaining its credentials: %s", async baseUrl => {
    const route = { ...config, baseUrl }
    const events = await observe([done(completed, 0), final([completed])], route)
    const end = events.find(event => event.type === "end")
    expect(end?.providerContinuation).toMatchObject({ replayEndpointFingerprint: null, reasoningItems: [completed] })
    expect(JSON.stringify(end?.providerContinuation)).not.toContain("secret")
    const send = vi.fn(async (_url: string, _init: RequestInit) => new Response('data: {"type":"response.completed"}\n\n'))
    vi.stubGlobal("fetch", send)
    const messages: LLMRequest["messages"] = [{ role: "assistant", content: "", providerContinuation: end?.providerContinuation }, { role: "user", content: "next" }]
    for await (const event of createOpenAIClient(route).stream({ ...start, messages })) if (event.type === "error") throw event.error
    expect(JSON.stringify(JSON.parse(String(send.mock.calls[0]![1].body)).input)).not.toContain(cipher)
    const ambiguous = await observe([final([completed, tool])], route)
    expect(ambiguous.map(event => event.type)).toEqual(["error"])
  },
)

it.each([true, false])("binds a redirected response to its actual endpoint and prevents forwarding private reasoning (encrypted=%s)", async encrypted => {
  const reason = encrypted ? completed : { ...raw, content: [{ type: "reasoning_text", text: cipher }] }
  const bodies = { requested: [] as string[], actual: [] as string[], sink: [] as string[] }
  let redirectReplay = false, actualOrigin: string, requestedOrigin: string
  async function listen(server: Server) {
    await new Promise<void>(ready => server.listen(0, "127.0.0.1", ready))
    const address = server.address()
    if (!address || typeof address === "string") throw new Error("Missing fixture port")
    return "http://127.0.0.1:" + address.port
  }
  const requested = createServer(async (req, res) => {
    let body = ""; for await (const chunk of req) body += chunk
    if (req.url === "/sink") { bodies.sink.push(body); res.end(); return }
    bodies.requested.push(body)
    res.writeHead(307, { location: actualOrigin + "/v1/responses" }).end()
  })
  const actual = createServer(async (req, res) => {
    let body = ""; for await (const chunk of req) body += chunk
    bodies.actual.push(body)
    if (redirectReplay) { res.writeHead(307, { location: requestedOrigin + "/sink" }).end(); return }
    const frames = bodies.actual.length === 1 ? [final([reason])] : [final([])]
    res.writeHead(200, { "content-type": "text/event-stream" }).end(frames.map(f => "data: " + JSON.stringify(f) + "\n\n").join(""))
  })
  try {
    actualOrigin = await listen(actual)
    requestedOrigin = await listen(requested)
    const source = createOpenAIClient({ ...config, baseUrl: requestedOrigin })
    const first: LLMStreamEvent[] = []
    for await (const event of source.stream(start)) first.push(event)
    const end = first.find(event => event.type === "end")
    expect(end?.providerContinuation).toMatchObject({ reasoningItems: [reason] })
    const next: LLMRequest = { ...start, messages: [{ role: "assistant", content: "", providerContinuation: end?.providerContinuation }, { role: "user", content: "continue" }] }
    for await (const event of source.stream(next)) if (event.type === "error") throw event.error
    expect(bodies.requested).toHaveLength(2)
    expect(bodies.requested[1]).not.toContain(cipher)
    expect(bodies.actual[1]).not.toContain(cipher)
    redirectReplay = true
    const replay: LLMStreamEvent[] = []
    for await (const event of createOpenAIClient({ ...config, baseUrl: actualOrigin }).stream(next)) replay.push(event)
    expect(bodies.actual.at(-1)).toContain(cipher)
    expect(replay.at(-1)?.type).toBe("error")
    expect(bodies.sink).toEqual([])
  } finally {
    for (const server of [requested, actual]) {
      server.closeAllConnections()
      if (server.listening) await new Promise<void>(done => server.close(() => done()))
    }
  }
})
