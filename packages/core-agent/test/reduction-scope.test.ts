import { expect,it,vi } from 'vitest'
import { createContext } from '@i-harness/core-plugin'
import { createSession,append } from '@i-harness/core-session'
import { createToolRegistry } from '@i-harness/core-tools'
import { createOpenAIClient } from '../../llm-openai/src/index.ts'
import { systemFetch } from '../../http-transport/src/index.ts'
import { createAgentWithSummary } from './fixtures/agent.ts'
import { checkpointOfLength } from '../../compaction/test/fixtures/checkpoint.ts'
import type { LLMRequest,ModelClient } from '@i-harness/llm-seam'
vi.mock('../../http-transport/src/index.ts',()=>({systemFetch:vi.fn()}))
it.each(['auto','recovery'] as const)('private %s preparation preserves actual subscription turn affinity without authenticating probes',async mode=>{
 const ctx=createContext(),session=createSession(),records:{summary:boolean;scope:LLMRequest['requestScope'];shape:string}[]=[];let auths=0,sends=0,summaries=0
 for(let i=0;i<2;i++)append(session,{type:'user/message',text:'old '+ 'x'.repeat(4000)})
 vi.mocked(systemFetch).mockImplementation(async(url,init)=>{
  expect(String(url)).toBe('https://chatgpt.com/backend-api/codex/responses');sends++
  const body=JSON.parse(String(init?.body)),summary=JSON.stringify(body).includes('You are now acting as a compaction engine');if(summary)summaries++
  if(mode==='recovery'&&sends===1&&!summary)return new Response(JSON.stringify({error:{code:'context_length_exceeded',message:'Maximum context length exceeded',type:'invalid_request_error'}}),{status:400})
  return new Response('data: '+JSON.stringify({type:'response.output_text.delta',delta:summary?checkpointOfLength(600):'done'})+'\n\ndata: '+JSON.stringify({type:'response.completed',response:{status:'completed'}})+'\n\n')
 })
 const actual=createOpenAIClient({apiKey:'',model:'fixture',codexSubscription:true,resolveCodexAuth:async()=>{auths++;return{accessToken:'controlled',accountId:'fixture'}}})
 const model:ModelClient={stream:request=>actual.stream(request),async prepare(request){const prepared=await actual.prepare!(request);records.push({summary:JSON.stringify(request.messages.at(-1)).includes('You are now acting as a compaction engine'),scope:request.requestScope,shape:prepared.measurement.input.shapeFingerprint});return prepared}}
 const agent=createAgentWithSummary(ctx,{session,tools:createToolRegistry(ctx),model,systemPrompt:'actual system',maxOutputTokens:6000,compact:{contextWindow:10000,minTurnsBeforeRecompact:0,auto:mode==='auto',prune:false}})
 expect((await agent.run('continue')).finalText).toBe('done')
 const main=records.filter(record=>!record.summary)
 expect(main.length).toBeGreaterThan(2)
 expect(main[0]?.scope?.sessionId).toBeTypeOf('string')
 expect(main.every(record=>record.scope===main[0]!.scope&&record.shape===main[0]!.shape)).toBe(true)
 expect(summaries).toBe(1);expect(sends).toBe(mode==='auto'?2:3);expect(auths).toBe(sends)
 const before=records.length
 append(session,{type:'user/message',text:'new idle completed evidence '+ 'y'.repeat(8000)})
 expect((await agent.compact!()).compacted).toBe(true)
 expect(records.slice(before).filter(record=>!record.summary).every(record=>record.scope===undefined)).toBe(true)
})
