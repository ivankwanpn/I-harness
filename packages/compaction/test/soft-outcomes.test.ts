import {afterEach,expect,it,vi} from 'vitest'
import {append,fromJSONL,toJSONL,createConversationValidationIndex,createNondurableFactOwner} from '@i-harness/core-session'
import {createAnthropicClient} from '../../llm-anthropic/src/index.ts'
import {generationError} from '@i-harness/llm-seam'
import {createAgentContext} from '../../core-agent/src/agent/context.ts'
import {createSummaryPort} from '../src/summary/port.ts'
import {createCompactionHarness} from './fixtures/engine.ts'
import {history,autoConfig,autoCap} from './fixtures/history.ts'
import {prepareTextFixture,checkpointOfLength} from './fixtures/checkpoint.ts'
const owner='compaction-harness'
afterEach(()=>{vi.unstubAllGlobals();vi.restoreAllMocks()})
function state(session:ReturnType<typeof history>){return createConversationValidationIndex(session.events,{formatVersion:session.formatVersion}).softReduction(owner)}
async function priorFailure(){
 vi.spyOn(console,'warn').mockImplementation(()=>{})
 const session=history(20,400),model={prepare:prepareTextFixture,async *stream(){throw Error('actual synthetic provider failure')}}
 await createCompactionHarness({model,config:autoConfig,maxOutputTokens:autoCap}).maybeCompact(session)
 expect(state(session).failures).toBe(1);append(session,{type:'user/message',text:'new eligible input'})
 return {session,model}
}
function verify(session:ReturnType<typeof history>,outcome:string,failures:number){
 const terminal=session.events.findLast(e=>e.type==='context/soft-reduction'&&e.op==='terminal')!
 expect(terminal).toMatchObject({outcome,publication:'none'})
 for(const cold of [session,fromJSONL(toJSONL(session))]){
  const folded=state(cold);expect(folded.failures).toBe(failures);expect(folded.pending).toBe(false)
  if(terminal.type!=='context/soft-reduction')throw Error('terminal required')
  expect(folded.consumed.has(terminal.workKey)).toBe(true)
 }
}
it.each(['output-floor','retention-policy','binding','call-policy'] as const)('actual local %s block preserves prior failures and consumes the key without sending',async reason=>{
 const {session,model}=await priorFailure(),network=vi.fn(()=>{throw Error('network forbidden')});vi.stubGlobal('fetch',network)
 const claude=createAnthropicClient({apiKey:'synthetic-only',model:'claude-sonnet-4-6',options:{thinking:{type:'enabled',budget_tokens:8192}}})
 const config={...autoConfig,...reason==='output-floor'?{summaryMaxOutputTokens:4096}:reason==='retention-policy'?{maxTokens:100,minSummaryChars:500}:reason==='binding'?{summarizationModel:claude,summaryMetadata:{version:1 as const,modelId:'foreign',protocol:'anthropic-messages',identityCoverage:'partial' as const}}:{}}
 const engine=createCompactionHarness({model:reason==='output-floor'?claude:model,config,maxOutputTokens:autoCap})
 const options=reason==='call-policy'?{maxSummaryCalls:NaN}:undefined
 const result=await engine.maybeCompact(session,options)
 expect(result).toMatchObject({outcome:'blocked',publication:'none',blockedReason:reason});expect(result.reason).toBeUndefined()
 verify(session,'blocked',1);const count=session.events.length
 await engine.maybeCompact(session,options);expect(session.events).toHaveLength(count);expect(network).not.toHaveBeenCalled()
})
it.each(['checkpoint-format','retention-output','truncated'] as const)('actual generated %s failure increments once for the whole sequence',async reason=>{
 const {session}=await priorFailure();let calls=0
 const model={prepare:prepareTextFixture,async *stream(){calls++;yield{type:'text/chunk' as const,text:reason==='retention-output'?'short':'x'.repeat(600)};yield{type:'end' as const,...reason==='truncated'?{truncated:true as const}:{}}}}
 const engine=createCompactionHarness({model,config:autoConfig,maxOutputTokens:autoCap})
 expect(await engine.maybeCompact(session)).toMatchObject({outcome:'blocked',reason:'summarizer-failed'})
 expect(calls).toBe(reason==='truncated'?1:2);verify(session,'failed',2)
 const count=session.events.length;await engine.maybeCompact(session);expect(session.events).toHaveLength(count);expect(calls).toBe(reason==='truncated'?1:2)
})
it('a branded generation allowance refusal remains propagated but is not a failed summary sequence',async()=>{
 const {session}=await priorFailure(),action=createNondurableFactOwner(session).beginAction();let sends=0
 const selected={prepare:prepareTextFixture,async *stream(){sends++;throw Error('must not send')}}
 const context=createAgentContext({session,model:selected,tools:{schemas:()=>[]} as never,systemPrompt:'',compact:autoConfig,maxOutputTokens:autoCap,
  summaryFactory:input=>createSummaryPort({...input,bindGeneration:async()=>{throw generationError('GENERATION_EXHAUSTED')}}),
  captureContextReduction:action.captureContextReduction!.bind(action),captureSoftReduction:action.captureSoftReduction.bind(action),facts:action.facts,assertFactOpen:action.assertOpen,registerFactSource:drain=>action.registerSettlementSource(drain)},owner)
 try{await expect(context.compactor!.maybeCompact(session)).rejects.toMatchObject({code:'GENERATION_EXHAUSTED'});verify(session,'blocked',1);expect(sends).toBe(0)}finally{action.finish()}
})

it('changing only the selected summary cap permits one new sequence for unchanged conversation',async()=>{
 const {session}=await priorFailure(),model=createAnthropicClient({apiKey:'synthetic-only',model:'claude-sonnet-4-6',options:{thinking:{type:'enabled',budget_tokens:8192}}})
 let calls=0;vi.stubGlobal('fetch',async(url:unknown)=>{expect(String(url)).toBe('https://api.anthropic.com/v1/messages');calls++;return new Response('data: '+JSON.stringify({type:'content_block_delta',index:0,delta:{type:'text_delta',text:checkpointOfLength(600)}})+'\n\ndata: '+JSON.stringify({type:'message_stop'})+'\n\n')})
 const config={...autoConfig,summaryMaxOutputTokens:4096},engine=createCompactionHarness({model,config,maxOutputTokens:autoCap})
 expect((await engine.maybeCompact(session)).blockedReason).toBe('output-floor');expect(calls).toBe(0)
 const before=session.events.filter(e=>e.type==='context/soft-reduction'&&e.op==='start').at(-1)!
 config.summaryMaxOutputTokens=9216
 expect((await engine.maybeCompact(session)).compacted).toBe(true);expect(calls).toBe(1)
 const after=session.events.filter(e=>e.type==='context/soft-reduction'&&e.op==='start').at(-1)!
 if(before.type!=='context/soft-reduction'||after.type!=='context/soft-reduction')throw Error('starts required')
 expect(after.workKey).not.toBe(before.workKey);expect(state(session).failures).toBe(0)
 const count=session.events.length;await engine.maybeCompact(session);expect(session.events).toHaveLength(count);expect(calls).toBe(1)
})

it('a selected summary binding-only change survives cold reopen and permits exactly one new attempt',async()=>{
 const {session,model}=await priorFailure(),claude=createAnthropicClient({apiKey:'synthetic-only',model:'claude-sonnet-4-6',options:{thinking:{type:'enabled',budget_tokens:8192}}})
 let calls=0;vi.stubGlobal('fetch',async(url:unknown)=>{expect(String(url)).toBe('https://api.anthropic.com/v1/messages');calls++;return new Response('data: '+JSON.stringify({type:'content_block_delta',index:0,delta:{type:'text_delta',text:checkpointOfLength(600)}})+'\n\ndata: '+JSON.stringify({type:'message_stop'})+'\n\n')})
 const binding:import('@i-harness/llm-seam').ModelBudgetBinding={version:1,metadata:{version:1,modelId:'claude-sonnet-4-6',protocol:'anthropic-messages',identityCoverage:'partial'},generation:{origin:'unspecified'},limits:{contextTokens:{value:20000,origin:'explicit-route',sourceId:'fixture-window'},outputTokens:{value:4096,origin:'explicit-route',sourceId:'fixture-output'}},capability:{version:1,route:'anthropic-messages',evidenceId:'fixture',outputParameter:'required',packetKind:'http-json-body'}}
 const config={...autoConfig,summaryMaxOutputTokens:9216,summarizationModel:claude,summaryBudgetBinding:binding},engine=createCompactionHarness({model,config,maxOutputTokens:autoCap})
 expect((await engine.maybeCompact(session)).blockedReason).toBe('opaque');verify(session,'blocked',1)
 const cold=fromJSONL(toJSONL(session)),count=cold.events.length
 const freshClient=createAnthropicClient({apiKey:'synthetic-only',model:'claude-sonnet-4-6',options:{thinking:{type:'enabled',budget_tokens:8192}}})
 const reopenedConfig={...config,summarizationModel:freshClient,summaryBudgetBinding:structuredClone(binding)},reopened=createCompactionHarness({model,config:reopenedConfig,maxOutputTokens:autoCap})
 await reopened.maybeCompact(cold);expect(cold.events).toHaveLength(count);expect(calls).toBe(0)
 reopenedConfig.summaryBudgetBinding={...binding,limits:{...binding.limits,outputTokens:{value:12288,origin:'explicit-route',sourceId:'fixture-output'}}}
 expect((await reopened.maybeCompact(cold)).compacted).toBe(true);expect(calls).toBe(1);expect(state(cold).failures).toBe(0)
 const after=cold.events.length;await reopened.maybeCompact(cold);expect(cold.events).toHaveLength(after);expect(calls).toBe(1)
})

it('an actual locally invalid selected summary request is blocked before transport',async()=>{
 const {session,model}=await priorFailure(),network=vi.fn(()=>{throw Error('network forbidden')});vi.stubGlobal('fetch',network)
 const invalid=createAnthropicClient({apiKey:'synthetic-only',model:'claude-sonnet-4-6',options:{thinking:{type:'enabled',budget_tokens:0}}})
 const result=await createCompactionHarness({model,config:{...autoConfig,summarizationModel:invalid},maxOutputTokens:autoCap}).maybeCompact(session)
 expect(result).toMatchObject({outcome:'blocked',blockedReason:'source-unrepresentable'});expect(result.reason).toBeUndefined()
 verify(session,'blocked',1);expect(network).not.toHaveBeenCalled()
})
