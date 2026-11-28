import { once } from 'node:events'
import { createServer } from 'node:http'
import { expect, it } from 'vitest'
import { createRetryingClient, modelFailureFacts, resolveRetryPolicy, retryErrorCode, type LLMStreamEvent } from '@i-harness/llm-seam'
import { createGeminiClient } from '../src/index.ts'

const request = { systemPrompt:'',tools:[],messages:[] }
const data = (value:unknown,named=false) => (named?'event: error\r\n':'')+'data: '+JSON.stringify(value)+'\r\n\r\n'
const chunk = (parts:unknown[],finishReason?:string) => data({candidates:[{index:0,content:{parts},finishReason}]})
const ok = chunk([{text:'retry succeeded'}],'STOP')
const secret = 'fixture-private-prompt-4711'
const diagnostic = {code:503,status:'UNAVAILABLE',message:secret,details:[{private:secret}]}
const partial = chunk([{text:'visible partial'},{functionCall:{id:'pending',name:'effect',args:{}}}],'STOP')

async function withLocal<T>(wires:string[],run:(client:ReturnType<typeof createGeminiClient>)=>Promise<T>) {
  let posts=0
  const server=createServer(async(req,res)=>{
    for await(const _ of req) { /* consume actual HTTP request */ }
    if(req.method!=='POST'||req.url!=='/v1beta/models/fixture:streamGenerateContent?alt=sse'){res.writeHead(404).end();return}
    res.writeHead(200,{'content-type':'text/event-stream'})
    res.end(wires[posts++] ?? data({error:{code:400,status:'INVALID_ARGUMENT'}}))
  })
  server.listen(0,'127.0.0.1');await once(server,'listening')
  const address=server.address()
  if(!address||typeof address==='string')throw Error('Missing loopback port')
  try {
    const result=await run(createGeminiClient({apiKey:'fixture-only',model:'fixture',baseUrl:'http://127.0.0.1:'+address.port}))
    return {result,posts}
  } finally { server.closeAllConnections(); await new Promise<void>(resolve=>server.close(()=>resolve())) }
}
async function collect(stream:AsyncIterable<LLMStreamEvent>) {const result:LLMStreamEvent[]=[];for await(const event of stream)result.push(event);return result}

it.each(['data','named','raw'] as const)('terminates a successful HTTP stream on a Gemini %s error and discards pending calls',async carrier=>{
  const usageMetadata={promptTokenCount:15,candidatesTokenCount:3,cachedContentTokenCount:2}
  const rejectedCandidate={index:0,content:{parts:[{text:'forbidden'}]},finishReason:'STOP'}
  const payload={error:diagnostic,candidates:[rejectedCandidate],usageMetadata}
  const errorBlock=carrier==='data'?data(payload):carrier==='named'?data({...diagnostic,usageMetadata},true):JSON.stringify(payload)
  const wire=partial+errorBlock+(carrier==='raw'?'':ok)
  const {result,posts}=await withLocal([wire],client=>collect(client.stream(request)))
  expect(posts).toBe(1)
  expect(result.map(e=>e.type)).toEqual(['text/chunk','usage','error'])
  expect(result[0]).toEqual({type:'text/chunk',text:'visible partial'})
  expect(result[1]).toEqual({type:'usage',usage:{inputTokens:15,inputTokenSemantics:'includes-cache',outputTokens:3,cacheReadTokens:2}})
  const failure=(result[2] as Extract<LLMStreamEvent,{type:'error'}>).error
  expect(retryErrorCode(failure)).toBe('SERVER')
  expect(modelFailureFacts(failure)).toMatchObject({code:'SERVER',providerCode:'UNAVAILABLE'})
  expect(modelFailureFacts(failure)).not.toHaveProperty('httpStatus')
  expect(failure).not.toHaveProperty('httpStatus')
  expect(failure).not.toHaveProperty('cause')
  expect(failure.message+JSON.stringify(failure)).not.toContain(secret)
})

it.each([
  [{code:429,status:'RESOURCE_EXHAUSTED'},'RATE_LIMIT'],
  [{code:401,status:'UNAUTHENTICATED'},'AUTH'],
  [{code:403,status:'PERMISSION_DENIED',message:'The input token count (10000) exceeds the maximum number of tokens allowed (5000).'},'AUTH'],
  [{code:400,status:'INVALID_ARGUMENT',message:'The input token count (10000) exceeds the maximum number of tokens allowed (5000).'},'CONTEXT_WINDOW_EXCEEDED'],
  [{code:400,status:'INVALID_ARGUMENT',message:'Invalid schema: includes context_length_exceeded'},'INVALID_ARGUMENT'],
  [{code:504,status:'DEADLINE_EXCEEDED'},'TIMEOUT'],
  [{code:500},'SERVER'],
  [{code:499,status:'CANCELLED'},'ABORTED'],
  [{status:'UNKNOWN_STATUS',message:secret},'UNKNOWN'],
  [{},'MALFORMED_RESPONSE'],
] as const)('bounds Gemini diagnostics for %j', async(diagnostic,expected)=>{
  const {result}=await withLocal([data({error:diagnostic})],client=>collect(client.stream(request)))
  expect(result.map(e=>e.type)).toEqual(['error'])
  const failure=(result[0] as Extract<LLMStreamEvent,{type:'error'}>).error
  expect(retryErrorCode(failure)).toBe(expected)
  expect(modelFailureFacts(failure)).not.toHaveProperty('httpStatus')
  expect(JSON.stringify(failure)+failure.message).not.toContain(secret)
})

it.each([true,false])('retries a temporary Gemini stream error only before visible output (partial=%s)',async visible=>{
  const first=(visible?partial:'')+data({error:diagnostic})
  const {result,posts}=await withLocal([first,ok],client=>collect(createRetryingClient(client,
    resolveRetryPolicy({mode:'normal',maxRetries:1,backoff:{initialDelayMs:1,maxDelayMs:1,jitterRatio:0}})).stream(request)))
  expect(posts).toBe(visible?1:2)
  expect(result.some(e=>e.type==='retry')).toBe(!visible)
  expect(result.at(-1)?.type).toBe(visible?'error':'end')
  expect(result.some(e=>e.type==='tool_call')).toBe(false)
})

it.each(['null','[DONE]','{}','not json '+secret])('fails an explicit named error with no usable diagnostic (%s)',async raw=>{
  const {result}=await withLocal([partial+'event: error\ndata: '+raw+'\n\n'+ok],client=>collect(client.stream(request)))
  expect(result.map(e=>e.type)).toEqual(['text/chunk','error'])
  const failure=(result[1] as Extract<LLMStreamEvent,{type:'error'}>).error
  expect(retryErrorCode(failure)).toBe('MALFORMED_RESPONSE')
  expect(JSON.stringify(failure)+failure.message).not.toContain(secret)
})

it('ends a still-open stream on its error frame and retains only previously observed usage',async()=>{
  const closed=Promise.withResolvers<void>()
  const early=data({usageMetadata:{promptTokenCount:7}})
  const wire=Buffer.from(data({error:{...diagnostic,message:'私密'+secret},usageMetadata:{candidatesTokenCount:2}}))
  const split=wire.indexOf(Buffer.from('私'))+1
  const server=createServer((req,res)=>{
    req.resume()
    res.on('close',()=>closed.resolve())
    res.writeHead(200,{'content-type':'text/event-stream'})
    res.write(early);res.write(wire.subarray(0,split))
    setImmediate(()=>res.write(wire.subarray(split)))
  })
  server.listen(0,'127.0.0.1');await once(server,'listening')
  const address=server.address()
  if(!address||typeof address==='string')throw Error('Missing loopback port')
  try {
    const client=createGeminiClient({model:'fixture',apiKey:'fixture-only',baseUrl:'http://127.0.0.1:'+address.port})
    const result=await collect(client.stream({...request,signal:AbortSignal.timeout(3000)}))
    expect(result.map(e=>e.type)).toEqual(['usage','usage','error'])
    expect(result.slice(0,2)).toEqual([{type:'usage',usage:{inputTokens:7,inputTokenSemantics:'includes-cache'}},{type:'usage',usage:{outputTokens:2}}])
    expect(result.at(-1)).toMatchObject({error:{code:'SERVER'}})
    await closed.promise
  } finally {server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()))}
})
