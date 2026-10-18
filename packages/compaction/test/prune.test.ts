import { expect,it } from 'vitest'
import { createSession,deriveMessages } from '@i-harness/core-session'
import { createCompactionHarness } from './fixtures/engine.ts'
import { closedExchange,spyModel,autoConfig,autoCap } from './fixtures/history.ts'
import { prepareTextFixture } from './fixtures/checkpoint.ts'
const config={...autoConfig,prune:{thresholdChars:1000,headChars:100,tailChars:100}}
function source(assistantChars=0){const session=createSession();closedExchange(session,'old',assistantChars,true);const result=session.events.find(event=>event.type==='tool/result')!;if(result.type==='tool/result')result.output='HEAD '+ 'raw-selected-output '.repeat(1000)+' EXACT-END';closedExchange(session,'tail',20);return session}
it('publishes prune-only only after actual main target readiness and strict progress',async()=>{
  const session=source(),before=session.events.slice(),f=spyModel()
  const result=await createCompactionHarness({model:f.model,config,maxOutputTokens:autoCap}).maybeCompact(session)
  expect(result).toMatchObject({compacted:true,pruned:true,outcome:'ready',publication:'nondurable',shadowedSeqs:[]})
  expect(f.requests).toEqual([]);expect(session.events.slice(0,before.length)).toEqual(before)
  expect(session.events.at(-1)?.type).toBe('compaction/prune')
  expect(JSON.stringify(deriveMessages(session))).toContain('pruned')
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
