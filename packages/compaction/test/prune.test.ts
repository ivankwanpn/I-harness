import { expect,it,vi,afterEach } from 'vitest'
import { createOpenAICompatibleClient } from '../../llm-openai-compatible/src/index.ts'
afterEach(()=>vi.unstubAllGlobals())
import { createSession,deriveMessages } from '@i-harness/core-session'
import { createCompactionHarness } from './fixtures/engine.ts'
import { closedExchange,spyModel,autoConfig,autoCap } from './fixtures/history.ts'
import { prepareTextFixture } from './fixtures/checkpoint.ts'
import type { TelemetryEvent } from '@i-harness/telemetry'
const config={...autoConfig,prune:{thresholdChars:1000,headChars:100,tailChars:100}}
function source(assistantChars=0){const session=createSession();closedExchange(session,'old',assistantChars,true);const result=session.events.find(event=>event.type==='tool/result')!;if(result.type==='tool/result')result.output='HEAD '+ 'raw-selected-output '.repeat(1000)+' EXACT-END';closedExchange(session,'tail',20);return session}
it('a token target cannot certify ready when the final candidate still exceeds its independent HTTP body limit',async()=>{
 let sends=0;vi.stubGlobal('fetch',()=>{sends++;throw Error('network denied')})
 const session=source(),before=session.events.slice(),model=createOpenAICompatibleClient({apiKey:'synthetic',model:'fixture',baseUrl:'https://body.fixture.invalid'})
 const result=await createCompactionHarness({model,config:{...config,contextWindow:100000},maxOutputTokens:1000,requestShape:()=>({systemPrompt:'fixed policy '.repeat(200),tools:[]}),
  budgetBinding:{version:1,metadata:{version:1,modelId:'fixture',protocol:'openai-compatible',identityCoverage:'partial'},limits:{bodyBytes:{value:100,origin:'explicit-route',sourceId:'fixture-body-limit'}},generation:{origin:'configured'},capability:{version:1,route:'openai-compatible',evidenceId:'fixture',outputParameter:'optional',packetKind:'http-json-body'}}}).compact(session)
 expect(result.compacted).toBe(false);expect(result.outcome).toBe('blocked');expect(result.publication).toBe('none')
 expect(session.events).toEqual(before);expect(sends).toBe(0)
})
it('publishes prune-only only after actual main target readiness and strict progress',async()=>{
  const session=source(),before=session.events.slice(),f=spyModel(),events:TelemetryEvent[]=[]
  const result=await createCompactionHarness({model:f.model,config,maxOutputTokens:autoCap,telemetry:{emit(event){events.push(event)},close(){}}}).maybeCompact(session)
  expect(result).toMatchObject({compacted:true,pruned:true,outcome:'ready',publication:'nondurable',shadowedSeqs:[]})
  expect(f.requests).toEqual([]);expect(session.events.slice(0,before.length)).toEqual(before)
  expect(session.events.at(-1)).toMatchObject({type:'context/soft-reduction',op:'terminal',outcome:'target-ready'})
  expect(JSON.stringify(deriveMessages(session))).toContain('pruned')
  expect(events.filter(event=>event.type==='compaction/attempt')).toMatchObject([{data:{outcome:'prune-only',outcomeState:'ready',publication:'nondurable',pruned:1,attempts:0}}])
})
it('when prune alone remains over-target a failed summary publishes neither proposal',async()=>{
  const session=source(8000),before=JSON.stringify(session),requests:unknown[]=[]
  const result=await createCompactionHarness({model:{prepare:prepareTextFixture,async *stream(request){requests.push(request);throw Error('controlled summary failed')}},config,maxOutputTokens:autoCap}).compact(session)
  expect(result).toMatchObject({compacted:false,outcome:'blocked',publication:'none',reason:'summarizer-failed'})
  expect(JSON.stringify(session)).toBe(before);expect(requests).toHaveLength(1)
  expect(JSON.stringify(requests)).toContain('raw-selected-output')
  expect(JSON.stringify(requests)).toContain('EXACT-END')
  expect(JSON.stringify(requests)).not.toContain('…(pruned')
})
it('successful combined prune and replacement install as one group after complete full-output summarization',async()=>{
  const session=source(8000),f=spyModel()
  expect(await createCompactionHarness({model:f.model,config,maxOutputTokens:autoCap}).compact(session)).toMatchObject({compacted:true,pruned:true,publication:'nondurable'})
  expect(session.events.slice(-2).map(event=>event.type)).toEqual(['compaction/prune','compaction/replacement'])
  expect(JSON.stringify(f.requests)).toContain('EXACT-END')
})
it.each([true,false])('whole-group protection and prune=false keep raw results intact (protected=%s)',async protectedGroup=>{
  const session=source(4000),f=spyModel(),call=session.events.find(event=>event.type==='tool/call')!
  const result=await createCompactionHarness({model:f.model,config:protectedGroup?config:{...config,prune:false}}).compact(session,undefined,protectedGroup?{protectedSeqs:[call.seq!]}:undefined)
  expect(result.pruned).toBeUndefined()
  if(protectedGroup){expect(JSON.stringify(f.requests)).not.toContain('raw-selected-output');expect(JSON.stringify(deriveMessages(session))).toContain('raw-selected-output')}
  else expect(JSON.stringify(f.requests)).toContain('raw-selected-output')
  expect(session.events.some(event=>event.type==='compaction/prune')).toBe(false)
})
