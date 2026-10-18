import { expect,it } from 'vitest'
import { append,createSession,deriveMessages } from '@i-harness/core-session'
import { captureContextSnapshot,selectReductionRuns,replacementProposal } from '../../context-engine/src/index.ts'
import { createCompactionHarness } from './fixtures/engine.ts'
import { closedExchange,spyModel,autoConfig } from './fixtures/history.ts'
function capture(session:ReturnType<typeof createSession>){const value=captureContextSnapshot(session,{ownerSessionId:'owner',surface:{systemPrompt:'',tools:[]}});if(value.kind!=='captured')throw Error('capture');return value.snapshot}
it('only summaries in the selected contiguous run participate, with derived authority',async()=>{
 const session=createSession(),f=spyModel()
 append(session,{type:'turn/start'});append(session,{type:'user/message',text:'H'})
 closedExchange(session,'E1',4000);closedExchange(session,'E2',4000)
 append(session,{type:'user/message',text:'protected steer'})
 append(session,{type:'compaction/summary',text:'UNRELATED-CHECKPOINT',shadowedSeqs:[]});closedExchange(session,'E3',3000);closedExchange(session,'tail',1)
 expect((await createCompactionHarness({model:f.model,config:autoConfig}).compact(session)).compacted).toBe(true)
 expect(JSON.stringify(f.requests)).not.toContain('UNRELATED-CHECKPOINT')
 expect(JSON.stringify(deriveMessages(session))).toContain('UNRELATED-CHECKPOINT')
})
it('replacement coverage comes from exact selected sources and never from shadowedSeqs compatibility',()=>{
 const session=createSession();closedExchange(session,'A',2000,true);closedExchange(session,'tail',2)
 const runs=selectReductionRuns(capture(session),{}),draft=replacementProposal(runs[0]!,'S','r')
 expect(draft.coverage).toEqual([{item:{kind:'exchange',at:{seq:1,part:'call'}},sources:[{seq:0,part:'step'},{seq:1,part:'call'},{seq:2,part:'message'},{seq:3,part:'result'}]}])
 expect(draft.insertBefore).toEqual({kind:'exchange',at:{seq:1,part:'call'}})
})
it('unknown effects and open physical units remain indivisible and unselected',()=>{
 const session=createSession();closedExchange(session,'known',3000,true)
 append(session,{type:'step/start'});append(session,{type:'tool/call',callId:'uncertain',name:'read',args:{}})
 append(session,{type:'tool/result',callId:'uncertain',name:'read',output:{code:'TOOL_OUTCOME_UNKNOWN',replay:false},isError:true});append(session,{type:'step/end'})
 closedExchange(session,'tail',1)
 const selected=selectReductionRuns(capture(session),{}).flatMap(run=>run.groups.flatMap(group=>group.items))
 expect(selected.some(item=>item.exchange?.calls.some(call=>call.callId==='uncertain'))).toBe(false)
 expect(selected.some(item=>item.exchange?.calls.some(call=>call.callId==='known'))).toBe(true)
})
