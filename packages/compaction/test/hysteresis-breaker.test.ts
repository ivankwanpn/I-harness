import {createAgentContext} from '../../core-agent/src/agent/context.ts'
import {softWorkFacts} from '../../core-agent/src/agent/context-reduction/automatic.ts'
import {resolveCompactSpec} from '../src/config.ts'
import { expect,it,vi } from 'vitest'
import { append, fromJSONL, toJSONL, createConversationValidationIndex, subscribe } from '@i-harness/core-session'
import { createCompactionHarness } from './fixtures/engine.ts'
import { history,spyModel,autoConfig,autoCap } from './fixtures/history.ts'
import { prepareTextFixture,checkpointOfLength } from './fixtures/checkpoint.ts'
it('each key permits one durable sequence and changed keys preserve three failures until atomic target-ready',async()=>{
 const warn=vi.spyOn(console,'warn').mockImplementation(()=>{});try{
 let calls=0,fail=true;const session=history(20,400),model={prepare:prepareTextFixture,async *stream(){calls++;if(fail)throw Error('controlled failure');yield{type:'text/chunk' as const,text:checkpointOfLength(600)};yield{type:'end' as const}}}
 const first=createCompactionHarness({model,config:autoConfig,maxOutputTokens:autoCap}),second=createCompactionHarness({model,config:autoConfig,maxOutputTokens:autoCap})
 const state=()=>createConversationValidationIndex(session.events,{formatVersion:session.formatVersion}).softReduction('compaction-harness')
 for(let key=0;key<3;key++){
  await first.maybeCompact(session);await second.maybeCompact(session)
  expect(calls).toBe(key+1)
  if(key<2)append(session,{type:'user/message',text:'new semantic content '+key})
 }
 expect(state().failures).toBe(3)
 const reopened=fromJSONL(toJSONL(session));await second.maybeCompact(reopened);expect(calls).toBe(3)
 append(session,{type:'session/title',title:'bookkeeping',messageSeqs:[],source:'fallback'});await first.maybeCompact(session);expect(calls).toBe(3)
 append(session,{type:'user/message',text:'new semantic content'});await second.maybeCompact(session);await first.maybeCompact(session);expect(calls).toBe(4);expect(state().failures).toBe(4)
 fail=false;append(session,{type:'user/message',text:'another eligible input'});expect((await first.maybeCompact(session)).compacted).toBe(true)
 expect(state().failures).toBe(0)
 expect(session.events.at(-1)).toMatchObject({type:'context/soft-reduction',op:'terminal',outcome:'target-ready',publication:'committed'})
 await second.maybeCompact(session);expect(calls).toBe(5)
 }finally{warn.mockRestore()}
})
it.each([0,3])('preserves configured %i completed-turn hysteresis while explicit compact remains available',async minimum=>{
 const session=history(20,400),f=spyModel(),engine=createCompactionHarness({model:f.model,config:{...autoConfig,minTurnsBeforeRecompact:minimum},maxOutputTokens:autoCap})
 expect((await engine.compact(session)).compacted).toBe(true)
 for(let turn=1;turn<=3;turn++){
  append(session,{type:'turn/start'});append(session,{type:'user/message',text:'new source '.repeat(800)});append(session,{type:'turn/end'})
  const result=await engine.maybeCompact(session)
  expect(result.compacted).toBe(minimum===0||turn===3)
 }
})
it('manual compaction remains available when the caller config disables automatic work',async()=>{
 const session=history(),f=spyModel(),engine=createCompactionHarness({model:f.model,config:{...autoConfig,auto:false}})
 expect(f.requests).toEqual([])
 expect((await engine.compact(session)).compacted).toBe(true)
})

it('binds the consumed after-key to its own installed rewrite while leaving observer-appended input eligible, live and cold', async()=>{
 const session=history(20,400),f=spyModel(),engine=createCompactionHarness({model:f.model,config:autoConfig,maxOutputTokens:autoCap})
 const context=createAgentContext({session,model:f.model,tools:{schemas:()=>[]} as never,systemPrompt:'',compact:autoConfig,maxOutputTokens:autoCap},'compaction-harness')
 const resolved=resolveCompactSpec(autoConfig),policy={retainTokens:resolved.retainTokens,thresholdRatio:resolved.thresholdRatio,targetRatio:resolved.targetRatio,cooldown:resolved.cooldown,reserveRatio:undefined,prune:resolved.prune}
 let ownKey:string|undefined,lateKey:string|undefined
 const unsubscribe=subscribe(session,event=>{if(event.type==='context/soft-reduction'&&event.op==='terminal'&&event.publication==='committed'){
  ownKey=softWorkFacts(context.captureCandidate().snapshot,policy).workKey
  append(session,{type:'user/message',text:'Late unrelated input must remain independently eligible.'})
  lateKey=softWorkFacts(context.captureCandidate().snapshot,policy).workKey
 }})
 try {
  expect((await engine.maybeCompact(session)).compacted).toBe(true)
  const terminal=session.events.findLast(event=>event.type==='context/soft-reduction'&&event.op==='terminal')!
  expect(terminal).toMatchObject({consumedAfterKey:ownKey});expect(ownKey).toBeDefined();expect(lateKey).not.toBe(ownKey)
  for(const view of [session,fromJSONL(toJSONL(session))]){const state=createConversationValidationIndex(view.events,{formatVersion:view.formatVersion}).softReduction('compaction-harness');expect(state.consumed.has(ownKey!)).toBe(true);expect(state.consumed.has(lateKey!)).toBe(false);expect(state.pending).toBe(false)}
 }finally{unsubscribe()}
})
