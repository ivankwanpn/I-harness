import { expect,it,vi } from 'vitest'
import { append } from '@i-harness/core-session'
import { createCompactionHarness } from './fixtures/engine.ts'
import { history,spyModel,autoConfig,autoCap } from './fixtures/history.ts'
import { prepareTextFixture,checkpointOfLength } from './fixtures/checkpoint.ts'
it('three failed auto transactions pause the same semantic source until new content or manual success',async()=>{
 const warn=vi.spyOn(console,'warn').mockImplementation(()=>{});try{
 let calls=0,fail=true;const session=history(20,400),model={prepare:prepareTextFixture,async *stream(){calls++;if(fail)throw Error('controlled failure');yield{type:'text/chunk' as const,text:checkpointOfLength(600)};yield{type:'end' as const}}}
 const first=createCompactionHarness({model,config:autoConfig,maxOutputTokens:autoCap}),second=createCompactionHarness({model,config:autoConfig,maxOutputTokens:autoCap})
 await first.maybeCompact(session);await second.maybeCompact(session);await first.maybeCompact(session)
 expect((await second.maybeCompact(session)).outcome).toBe('unchanged');expect(calls).toBe(3)
 append(session,{type:'user/message',text:'new semantic content'});await second.maybeCompact(session);await first.maybeCompact(session);expect(calls).toBe(4)
 fail=false;expect((await first.compact(session)).compacted).toBe(true)
 append(session,{type:'user/message',text:'fresh large source '.repeat(400)});fail=true;await second.maybeCompact(session);await first.maybeCompact(session);expect(calls).toBe(7)
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
