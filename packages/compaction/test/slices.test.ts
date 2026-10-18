import { expect, it } from 'vitest'
import { summarizeFixture, summarySource } from './fixtures/summary.ts'
import { generateSelectedSummary } from '../src/summary/generate.ts'
import { spyModel } from './fixtures/history.ts'
import { prepareTextFixture, checkpointOfLength } from './fixtures/checkpoint.ts'
import type { LLMRequest, LLMMessage, ModelClient } from '@i-harness/llm-seam'
const messages = (): LLMMessage[] => Array.from({ length: 8 }, (_, index) => ({ role: 'user', content: `GROUP-${index} ${'x'.repeat(3000)}` }))
it('preflight partitions exactly between whole groups and preserves literal 0..7 coverage in rolling merge', async () => {
  const f = spyModel(), source = summarySource(messages())
  const result = await generateSelectedSummary(f.model, source, { maxTokens: 1024, minSummaryChars: 500, inherited: true }, { contextWindow: 9000 })
  expect(f.requests).toHaveLength(2); expect(source.attempts.count).toBe(2)
  expect(result.groupIds).toEqual(['literal-0','literal-1','literal-2','literal-3','literal-4','literal-5','literal-6','literal-7'])
  expect(f.requests[0]!.messages.slice(0,-1).map(m => String(m.content).slice(0,7))).toEqual(['GROUP-0','GROUP-1','GROUP-2','GROUP-3'])
  expect(f.requests[1]!.messages.slice(0,-1).map(m => String(m.content).slice(0,7))).toEqual(['GROUP-4','GROUP-5','GROUP-6','GROUP-7'])
  expect(String(f.requests[1]!.messages.at(-1)?.content)).toContain(checkpointOfLength(600))
})
it('one indivisible huge source blocks without character/message slicing or transport', async () => {
  const f=spyModel()
  await expect(summarizeFixture(f.model,'huge'.repeat(10000),1024,undefined,undefined,500,undefined,undefined,{ contextWindow: 9000 })).rejects.toMatchObject({kind:'fixed-input'})
  expect(f.requests).toEqual([])
})
it.each([false,true])('only an explicit confirmed overflow may partition at group boundaries (confirmed=%s)',async confirmed=>{
  const requests: LLMRequest[]=[]
  const model:ModelClient={prepare:prepareTextFixture,async *stream(request){requests.push(request);if(requests.length===1)throw confirmed?Object.assign(Error('full'),{code:'CONTEXT_WINDOW_EXCEEDED'}):Error('context window exceeded');yield{type:'text/chunk',text:checkpointOfLength(600)};yield{type:'end'}}}
  const promise=summarizeFixture(model,'unused',1024,undefined,undefined,500,undefined,{systemPrompt:'',tools:[],messages:messages()},{contextWindow:100000})
  if(confirmed){await promise;expect(requests).toHaveLength(3)}
  else{await expect(promise).rejects.toThrow('context window exceeded');expect(requests).toHaveLength(1)}
})
it('shares quality retries and pieces under one eight-invocation allowance',async()=>{
  let calls=0
  const model:ModelClient={prepare:prepareTextFixture,async *stream(){calls++;if(calls%3===1)throw Object.assign(Error('full'),{code:'CONTEXT_WINDOW_EXCEEDED'});yield{type:'text/chunk',text:calls%3===2?'short':checkpointOfLength(600)};yield{type:'end'}}}
  const source=summarySource(messages())
  await expect(generateSelectedSummary(model,source,{maxTokens:1024,minSummaryChars:500,inherited:true},{contextWindow:100000})).rejects.toMatchObject({kind:'call-limit'})
  expect(calls).toBe(8);expect(source.attempts.count).toBe(8)
})
it('an autonomous parallel call/result round stays whole when other groups are split',async()=>{
  const f=spyModel(), bundle:LLMMessage[]=[{role:'assistant',content:'recorded round',toolCalls:[{id:'a',name:'read',args:{path:'a'}},{id:'b',name:'read',args:{path:'b'}}]},{role:'tool',toolCallId:'b',content:'B'.repeat(3000)},{role:'tool',toolCallId:'a',content:'A'.repeat(3000)}]
  await summarizeFixture(f.model,'',1024,undefined,undefined,500,undefined,{systemPrompt:'',tools:[],messages:[...messages(),...bundle]},{contextWindow:11000})
  const carriers=f.requests.filter(request=>request.messages.some(message=>message.role==='tool'))
  expect(carriers).toHaveLength(1)
  expect(carriers[0]!.messages.filter(message=>message.role==='tool').map(message=>message.toolCallId)).toEqual(['b','a'])
  expect(carriers[0]!.messages.some(message=>message.role==='assistant'&&message.toolCalls?.length===2)).toBe(true)
})
