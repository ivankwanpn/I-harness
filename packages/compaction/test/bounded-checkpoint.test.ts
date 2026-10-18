import { expect,it,vi,afterEach } from 'vitest'
afterEach(()=>vi.unstubAllGlobals())
import { createCompactionHarness } from './fixtures/engine.ts'
import { history,spyModel,autoConfig } from './fixtures/history.ts'
import { checkpointOfLength,prepareTextFixture } from './fixtures/checkpoint.ts'
import { createAnthropicClient } from '../../llm-anthropic/src/index.ts'
import { createOpenAIClient } from '../../llm-openai/src/index.ts'
import type { ModelClient } from '@i-harness/llm-seam'
it('distinct summary binding has an independent preferred output ceiling even when its limits are unknown',async()=>{
 const main=spyModel(),summary=spyModel()
 expect((await createCompactionHarness({model:main.model,maxOutputTokens:384000,config:{...autoConfig,contextWindow:1000000,summarizationModel:summary.model}}).compact(history())).compacted).toBe(true)
 expect(main.requests).toEqual([]);expect(summary.requests[0]?.maxOutputTokens).toBe(4096)
})
it('preflights actual Responses fixed policy/directive with no transport',async()=>{
 let calls=0;const summary=createOpenAIClient({apiKey:'controlled',model:'fixture',options:{instructions:'fixed '.repeat(3000)},fetch:async()=>{calls++;return new Response('')}} as any)
 expect(await createCompactionHarness({model:spyModel().model,config:{...autoConfig,summarizationModel:summary,summaryMaxOutputTokens:16,summaryLimits:{contextWindow:1000}}}).compact(history())).toMatchObject({compacted:false,blockedReason:'fixed-input'})
 expect(calls).toBe(0)
})
it('flush refusal is causal and precedes all summary transport',async()=>{
 const f=spyModel(),failure=Error('controlled flush refused')
 await expect(createCompactionHarness({model:f.model,config:autoConfig,flush:async()=>{throw failure}}).compact(history())).rejects.toBe(failure)
 expect(f.requests).toEqual([])
})
it('Stop reaches the held summary and never publishes its completed text',async()=>{
 const entered=Promise.withResolvers<void>(),release=Promise.withResolvers<void>(),abort=new AbortController(),session=history()
 const model:ModelClient={prepare:prepareTextFixture,async *stream(request){expect(request.signal).toBe(abort.signal);entered.resolve();await release.promise;yield{type:'text/chunk',text:checkpointOfLength(600)};yield{type:'end'}}}
 const pending=createCompactionHarness({model,config:autoConfig}).compact(session,undefined,{signal:abort.signal})
 await entered.promise;abort.abort(Error('held Stop'));release.resolve()
 await expect(pending).rejects.toThrow('held Stop')
 expect(session.events.some(event=>event.type.startsWith('compaction/'))).toBe(false)
})
it.each(['refused','truncated','incomplete','tool'] as const)('never publishes %s output',async mode=>{
 const session=history(),model:ModelClient={prepare:prepareTextFixture,async *stream(){yield{type:'text/chunk',text:checkpointOfLength(600)};if(mode==='tool')yield{type:'tool_call',call:{id:'c',name:'read',args:{}}};if(mode!=='incomplete')yield{type:'end',...(mode==='refused'?{refused:true}:mode==='truncated'?{truncated:true}:{})}}}
 expect((await createCompactionHarness({model,config:autoConfig}).compact(session)).compacted).toBe(false)
 expect(session.events.some(event=>event.type.startsWith('compaction/'))).toBe(false)
})
it('actual Claude thinking floor adjusts the default but preserves explicit conflicts',async()=>{
 for(const explicit of [false,true]){
  vi.stubGlobal('fetch',async()=>{throw Error('Unexpected endpoint')})
  const bodies:any[]=[];vi.stubGlobal('fetch',async(url:unknown,init:RequestInit)=>{expect(String(url)).toBe('https://api.anthropic.com/v1/messages');bodies.push(JSON.parse(String(init.body)));return new Response('data: '+JSON.stringify({type:'content_block_delta',index:0,delta:{type:'text_delta',text:checkpointOfLength(600)}})+'\n\ndata: '+JSON.stringify({type:'message_stop'})+'\n\n')});const model=createAnthropicClient({apiKey:'controlled',model:'claude-sonnet-4-6',options:{thinking:{type:'enabled',budget_tokens:8192}}})
  const result=await createCompactionHarness({model,maxOutputTokens:384000,config:{...autoConfig,contextWindow:1000000,...explicit?{summaryMaxOutputTokens:4096}:{}}}).compact(history())
  expect(result.compacted).toBe(!explicit)
  if(explicit){expect(result.blockedReason).toBe('output-floor');expect(bodies).toEqual([])}
  else{expect(bodies).toHaveLength(1);expect(bodies[0]).toMatchObject({max_tokens:9216,thinking:{type:'enabled',budget_tokens:8192}})}
 }
})
