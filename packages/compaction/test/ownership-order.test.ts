import { expect,it } from 'vitest'
import { append, deriveMessages } from '@i-harness/core-session'
import { createCompactionHarness } from './fixtures/engine.ts'
import { history,spyModel,autoConfig } from './fixtures/history.ts'
import { prepareTextFixture,checkpointOfLength } from './fixtures/checkpoint.ts'
import type { ModelClient } from '@i-harness/llm-seam'
it('remeasures the current full before input when a compatible retained suffix grows beyond the original input',async()=>{
 const session=history(),entered=Promise.withResolvers<void>(),release=Promise.withResolvers<void>();let calls=0
 const model:ModelClient={prepare:prepareTextFixture,async *stream(){calls++;entered.resolve();await release.promise;yield{type:'text/chunk',text:checkpointOfLength(600)};yield{type:'end'}}}
 const pending=createCompactionHarness({model,config:autoConfig}).compact(session)
 await entered.promise;append(session,{type:'step/start'});append(session,{type:'assistant/message',text:'retained suffix '+ 'z'.repeat(20000)});append(session,{type:'step/end'});release.resolve()
 expect(await pending).toMatchObject({compacted:true,outcome:'ready'});expect(calls).toBe(1)
 expect(deriveMessages(session).at(-1)?.content).toBe('retained suffix '+ 'z'.repeat(20000))
})
it('retained suffix accepted during summary generation reuses the completed source checkpoint',async()=>{
 const session=history(),entered=Promise.withResolvers<void>(),release=Promise.withResolvers<void>();let calls=0
 const model:ModelClient={prepare:prepareTextFixture,async *stream(){calls++;entered.resolve();await release.promise;yield{type:'text/chunk',text:checkpointOfLength(600)};yield{type:'end'}}}
 const pending=createCompactionHarness({model,config:autoConfig}).compact(session)
 await entered.promise;append(session,{type:'user/message',text:'retained compatible suffix'});release.resolve()
 expect(await pending).toMatchObject({compacted:true,publication:'nondurable'});expect(calls).toBe(1)
 const rewrite=session.events.at(-1);expect(rewrite?.type).toBe('compaction/replacement')
 if(rewrite?.type==='compaction/replacement')expect(rewrite.coverage.flatMap(row=>row.sources.map(source=>source.seq))).not.toContain(8)
})
it('selected content mutation during the await regenerates under the same finite tracker',async()=>{
 const session=history(),entered=Promise.withResolvers<void>(),release=Promise.withResolvers<void>();let calls=0
 const model:ModelClient={prepare:prepareTextFixture,async *stream(){calls++;if(calls===1){entered.resolve();await release.promise};yield{type:'text/chunk',text:checkpointOfLength(600)};yield{type:'end'}}}
 const attempts={count:0,staleRebuilds:0},pending=createCompactionHarness({model,config:autoConfig}).compact(session,undefined,{attempts})
 await entered.promise;const selected=session.events[0];if(selected?.type==='user/message')selected.text+=' changed';release.resolve()
 expect((await pending).compacted).toBe(true);expect(calls).toBe(2);expect(attempts).toEqual({count:2,staleRebuilds:1})
})
it('diagnostic metadata during generation neither regenerates nor consumes stale budget',async()=>{
 const session=history(),entered=Promise.withResolvers<void>(),release=Promise.withResolvers<void>();let calls=0
 const model:ModelClient={prepare:prepareTextFixture,async *stream(){calls++;entered.resolve();await release.promise;yield{type:'text/chunk',text:checkpointOfLength(600)};yield{type:'end'}}}
 const attempts={count:0,staleRebuilds:0},pending=createCompactionHarness({model,config:autoConfig}).compact(session,undefined,{attempts})
 await entered.promise;append(session,{type:'session/title',title:'compatible diagnostic',messageSeqs:[],source:'user'});release.resolve()
 expect((await pending).compacted).toBe(true);expect(calls).toBe(1);expect(attempts.staleRebuilds).toBe(0)
})
it('preserves model method receiver across summary preparation and transport',async()=>{
 const f=spyModel(),original=f.model.stream
 f.model.stream=async function*(request){expect(this).toBe(f.model);yield* original.call(this,request)}
 expect((await createCompactionHarness({model:f.model,config:autoConfig}).compact(history())).compacted).toBe(true)
})
