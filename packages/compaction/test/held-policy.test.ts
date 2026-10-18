import {softWorkFacts} from '../../core-agent/src/agent/context-reduction/automatic.ts'
import {reductionPolicyFacts} from '../../core-agent/src/agent/context-reduction/summary-policy.ts'
import {resolveCompactSpec} from '../src/config.ts'
import {projectionFingerprint} from '@i-harness/token-meter'
import {afterEach,expect,it,vi} from 'vitest'
import {append,createSession,createNondurableFactOwner,createConversationValidationIndex,fromJSONL,toJSONL,type SessionView} from '@i-harness/core-session'
import {createAgentContext} from '../../core-agent/src/agent/context.ts'
import {createSummaryPort} from '../src/summary/port.ts'
import {prepareTextFixture,checkpointOfLength} from './fixtures/checkpoint.ts'
import {prepareModelRequest,type ModelClient,type LLMRequest} from '@i-harness/llm-seam'
import {buildContextRequest} from '../../core-agent/src/agent/request-input.ts'
const owner='held-policy-owner',digest='a'.repeat(64)
afterEach(()=>vi.unstubAllGlobals())
function fixture(hold:'summary'|'prepare'|'issuance'|'none'|'forged'){
 vi.stubGlobal('fetch',()=>{throw Error('controlled fixture forbids network')})
 const session=createSession();for(let i=0;i<20;i++)append(session,{type:'user/message',text:`segment-${i} ${'x'.repeat(400)}`})
 append(session,{type:'context/soft-reduction',version:1,op:'start',ownerSessionId:owner,sequenceId:'prior',workKey:digest,sourceKey:digest,protectionKey:digest,policyKey:digest,acceptedExchanges:0,humanTurns:0})
 append(session,{type:'context/soft-reduction',version:1,op:'terminal',ownerSessionId:owner,sequenceId:'prior',startSeq:20,workKey:digest,sourceKey:digest,outcome:'failed',publication:'none',consumedBeforeKey:digest})
 const config={contextWindow:20000,thresholdRatio:.8,targetRatio:.7,minTurnsBeforeRecompact:0,prune:false as const},budget={contextWindow:20000,reserveRatio:.9}
 const entered=Promise.withResolvers<void>(),release=Promise.withResolvers<void>();let calls=0,held=false,captures=0,issued=0,stales=0
 const model:ModelClient={async prepare(request:LLMRequest){
  const messages=JSON.stringify(request.messages),summary=messages.includes('You are now acting as a compaction engine')
  if(hold==='prepare'&&!held&&!summary&&messages.includes('<compacted-summary>')){held=true;entered.resolve();await release.promise}
  return prepareTextFixture.call(this,request)
 },async *stream(){calls++;if(hold==='summary'&&!held){held=true;entered.resolve();await release.promise};yield{type:'text/chunk',text:checkpointOfLength(600)};yield{type:'end'}}}
 const action=createNondurableFactOwner(session).beginAction()
 const context=createAgentContext({session,model,tools:{schemas:()=>[]} as never,systemPrompt:'',compact:config,budget,maxOutputTokens:15500,summaryFactory:createSummaryPort,
  captureContextReduction:(draft,current)=>{captures++;const captured=action.captureContextReduction!(draft,current);return{...captured,async admit(){if(hold==='forged')throw Object.assign(new Error('untrusted hint'),{code:'FACT_PRECONDITION_STALE'});if(hold==='issuance'&&!held){held=true;entered.resolve();await release.promise}const outcome=await captured.admit();if(outcome.kind==='memory-committed')issued++;if(outcome.kind==='not-issued'&&outcome.code==='FACT_PRECONDITION_STALE')stales++;return outcome}}},captureSoftReduction:action.captureSoftReduction.bind(action),facts:action.facts,assertFactOpen:action.assertOpen,registerFactSource:drain=>action.registerSettlementSource(drain)},owner)
 return{session,config,budget,context,model,action,entered,release,calls:()=>calls,captures:()=>captures,issued:()=>issued,stales:()=>stales}
}
function folded(session:SessionView){return createConversationValidationIndex(session.events,{formatVersion:session.formatVersion}).softReduction(owner)}
it.each(['summary','prepare','issuance'] as const)('rejects the old target while actual %s is held, and never publishes a stale ready/reset',async hold=>{
 const f=fixture(hold);try{
  const running=f.context.compactor!.maybeCompact(f.session);await f.entered.promise;f.config.targetRatio=.01;f.release.resolve();const result=await running
  const evidence=f.context.captureCandidate(),prepared=await prepareModelRequest(f.model,buildContextRequest(evidence.snapshot,{})),final=f.context.ownedBudget.probe(prepared,evidence,false,f.budget.reserveRatio,f.context.pressurePolicy)
  expect(final.decision.pressure).toMatchObject({kind:'known',input:225,inputBudget:2500,target:25,targetReady:false});expect(result.outcome).toBe('reduced-over-target')
  expect(f.session.events.some(e=>e.type==='context/soft-reduction'&&e.op==='terminal'&&e.outcome==='target-ready')).toBe(false)
  const current=softWorkFacts(evidence.snapshot,reductionPolicyFacts(resolveCompactSpec(f.config),evidence.snapshot.surface,f.model,f.budget.reserveRatio))
  expect(folded(f.session).lastTerminal).toMatchObject({outcome:'reduced-over-target',publication:'committed',consumedAfterKey:current.workKey})
  expect(folded(f.session).lastStart!.policyKey).not.toBe(current.policyKey);expect(folded(f.session).consumed.has(current.workKey)).toBe(true)
  for(const view of[f.session,fromJSONL(toJSONL(f.session))]){expect(folded(view).failures).toBe(1);expect(folded(view).pending).toBe(false)}
  expect(f.session.events.filter(e=>e.type==='context/soft-reduction'&&e.op==='start')).toHaveLength(2)
  expect(f.calls()).toBe(2);expect(f.captures()).toBe(hold==='issuance'?2:1);expect(f.issued()).toBe(1);expect(f.stales()).toBe(hold==='issuance'?1:0)
 }finally{f.release.resolve();f.action.finish()}
})
it('unchanged policy still publishes a genuinely ready candidate and cold-folds its reset',async()=>{
 const f=fixture('summary');try{const running=f.context.compactor!.maybeCompact(f.session);await f.entered.promise;f.release.resolve();expect((await running).outcome).toBe('ready');expect(f.calls()).toBe(1)
 for(const view of[f.session,fromJSONL(toJSONL(f.session))])expect(folded(view)).toMatchObject({failures:0,pending:false})
 }finally{f.release.resolve();f.action.finish()}
})

it.each(['threshold','target','cooldown','retain','prune','reserve'] as const)('captures the actual resolved %s member without mutable aliases',member=>{
 const f=fixture('none');try{const surface=f.context.captureCandidate().snapshot.surface,prior=reductionPolicyFacts(resolveCompactSpec(f.config),surface,f.model,f.budget.reserveRatio),before=projectionFingerprint(prior)
 const next={...f.config,...member==='threshold'?{thresholdRatio:.9}:member==='target'?{targetRatio:.01}:member==='cooldown'?{minTurnsBeforeRecompact:1}:member==='retain'?{retainTokens:100}:member==='prune'?{prune:{thresholdChars:10000}}:{}}
 const after=reductionPolicyFacts(resolveCompactSpec(next),surface,f.model,member==='reserve'?.8:f.budget.reserveRatio)
 expect(projectionFingerprint(after)).not.toBe(before);expect(projectionFingerprint(prior)).toBe(before)
 expect(prior).toMatchObject({thresholdRatio:.8,targetRatio:.7,cooldown:{mode:'human-turns',minimum:0},retainTokens:0,reserveRatio:.9,prune:{enabled:false}})
 }finally{f.action.finish()}
})
it('a held reserve change is reassessed using the current allowance without renewing the sequence',async()=>{
 const f=fixture('prepare');try{const running=f.context.compactor!.maybeCompact(f.session);await f.entered.promise;f.budget.reserveRatio=.8;f.release.resolve();expect((await running).outcome).toBe('ready')
 const evidence=f.context.captureCandidate(),prepared=await prepareModelRequest(f.model,buildContextRequest(evidence.snapshot,{})),final=f.context.ownedBudget.probe(prepared,evidence,false,.8,f.context.pressurePolicy)
 expect(final.decision.pressure).toMatchObject({input:225,inputBudget:500,target:350,targetReady:true});expect(f.calls()).toBe(2);expect(f.issued()).toBe(1)
 expect(f.session.events.filter(e=>e.type==='context/soft-reduction'&&e.op==='start')).toHaveLength(2)
 }finally{f.release.resolve();f.action.finish()}
})

it('a thrown stale-code hint is not trusted proof of non-issuance or permission to rebuild',async()=>{
 const f=fixture('forged');try{expect(await f.context.compactor!.maybeCompact(f.session)).toMatchObject({publication:'recovery-required'});expect(f.calls()).toBe(1);expect(f.captures()).toBe(1);expect(f.issued()).toBe(0)
 expect(folded(f.session)).toMatchObject({failures:1,pending:true});expect(f.session.events.some(e=>e.type==='compaction/replacement')).toBe(false)
 await f.context.compactor!.maybeCompact(f.session);expect(f.calls()).toBe(1);expect(f.captures()).toBe(1)
 }finally{f.action.stop();f.action.finish()}
})
