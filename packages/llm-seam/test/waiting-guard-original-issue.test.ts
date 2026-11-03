import {afterEach,expect,it,vi} from 'vitest'
import {createWaitingGuard,prepareModelRequest,createRetryingClient,resolveRetryPolicy} from '../src/index.ts'
import {openOwnedPreparedStream,readDrainedOwnedExecutionConfirmation} from '../src/prepared/stream-lifetime.ts'
import type {ExecutionConfirmation} from '../src/prepared/execution.ts'
import {createOpenAICompatibleClient} from '../../llm-openai-compatible/src/index.ts'
afterEach(()=>vi.unstubAllGlobals())
it.each([false,true])('original waiting guard preserves one actual handoff callback and nominal drained proof (listener throws=%s)',async throws=>{
 let issued=0,requests=0,confirmation:ExecutionConfirmation|undefined
 vi.stubGlobal('fetch',async()=>{requests++;return new Response('data: {"choices":[{"delta":{"content":"controlled"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',{headers:{'content-type':'text/event-stream'}})})
 const client=createWaitingGuard(createOpenAICompatibleClient({apiKey:'fixture',model:'m',baseUrl:'http://127.0.0.1:1'}),{firstResponseMs:1000,progressMs:1000})
 const prepared=await prepareModelRequest(client,{systemPrompt:'',messages:[],tools:[]})
 const invocation=openOwnedPreparedStream(prepared,{confirmExecution(value){confirmation=value},onTransportIssue(){issued++;if(throws)throw Error('passive listener failure')}})
 for await(const _ of invocation.stream){}await invocation.drain()
 expect(requests).toBe(1);expect(issued).toBe(1);expect(confirmation).toBeDefined();expect(readDrainedOwnedExecutionConfirmation(invocation,confirmation!,prepared)).toBeDefined()
})
it.each([false,true])('original guarded retry reports each physical handoff once and settles its timer lifecycle (listener throws=%s)',async throws=>{
 let fetches=0,issued=0,confirmed=0
 vi.stubGlobal('fetch',async()=>{fetches++;return fetches===1?new Response('controlled retry',{status:503}):new Response('data: {"choices":[{"delta":{"content":"controlled"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',{headers:{'content-type':'text/event-stream'}})})
 const base=createWaitingGuard(createOpenAICompatibleClient({apiKey:'fixture',model:'m',baseUrl:'http://127.0.0.1:1'}),{firstResponseMs:1000,progressMs:1000})
 const client=createRetryingClient(base,resolveRetryPolicy({mode:'normal',maxRetries:1,backoff:{initialDelayMs:1,maxDelayMs:1,jitterRatio:0}}))
 const phases:string[]=[];for await(const event of client.stream({systemPrompt:'',messages:[],tools:[],onTransportIssue(){issued++;if(throws)throw Error('Non-refusing captured listener')},confirmExecution(){confirmed++}}))if(event.type==='retry')phases.push(event.retry.phase)
 expect([fetches,issued,confirmed]).toEqual([2,2,2]);expect(phases).toEqual(['waiting','attempting','recovered'])
})
it.each(['confirm','validate'] as const)('guarded original %s refusal preserves exact error and zero physical fetch',async site=>{
 const refusal=Error('Original admission refusal');let fetches=0,issued=0
 vi.stubGlobal('fetch',async()=>{fetches++;return new Response('')})
 const client=createWaitingGuard(createOpenAICompatibleClient({apiKey:'fixture',model:'m',baseUrl:'http://127.0.0.1:1'}),{firstResponseMs:1000,progressMs:1000})
 const prepared=await prepareModelRequest(client,{systemPrompt:'',messages:[],tools:[]})
 const consume=async()=>{for await(const _ of prepared.stream({confirmExecution(){if(site==='confirm')throw refusal},validateBeforeTransport(){if(site==='validate')throw refusal},onTransportIssue(){issued++}})){} }
 await expect(consume()).rejects.toBe(refusal);expect(fetches).toBe(0);expect(issued).toBe(0)
})
