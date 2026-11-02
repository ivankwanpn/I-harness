import {expect,it} from 'vitest'
import {createOwnedMetadataFold} from '../src/lifecycle/owned-metadata-fold.ts'
import {createScheduleFoldSink,createAfterScheduleRecord} from '@i-harness/schedule'

it('projects Schedule, Todo and Goal from one validated stream and prefix',()=>{
 const fold=createOwnedMetadataFold({sessionId:'s',seedLength:0,formatVersion:14})
 const prefix={eventCount:3,bodyBytes:10,prefixDigest:'digest'}
 fold.appendValidated([
  {type:'todo/write',version:1,items:[]},
  {type:'goal/change',version:1,operation:'create',goal:{id:'g',revision:1,objective:'work',phase:'active'}},
  {type:'goal/change',version:1,operation:'pause'},
 ],0)
 expect(()=>fold.views.todo.snapshot(prefix)).toThrow()
 fold.finishRestore(prefix)
 expect(fold.snapshot(prefix)).toEqual({active:[],seenIds:[],inactive:[]})
 expect(fold.validateSnapshot(fold.snapshot(prefix))).toBe(true)
 expect(fold.views.todo.snapshot(prefix)).toEqual({kind:'present',items:[]})
 expect(fold.views.goal.snapshot(prefix)).toEqual({kind:'present',value:{id:'g',revision:1,objective:'work',phase:'active'}})
 expect(fold.views.todo.validateSnapshot({kind:'absent'})).toBe(true)
 expect(fold.views.todo.validateSnapshot({kind:'present',items:[]})).toBe(true)
 expect(fold.views.todo.validateSnapshot({kind:'present',items:[],extra:true})).toBe(false)
 expect(fold.views.goal.validateSnapshot({kind:'present',value:{id:'g',revision:0,objective:'work',phase:'active'}})).toBe(false)
})

it('preserves absent and cleared views across successive acknowledged prefixes',()=>{
 const fold=createOwnedMetadataFold({sessionId:'s',seedLength:0,formatVersion:14})
 const first={eventCount:0,bodyBytes:0,prefixDigest:'a'}
 fold.finishRestore(first)
 expect(fold.views.todo.snapshot(first)).toEqual({kind:'absent'})
 expect(fold.views.goal.snapshot(first)).toEqual({kind:'absent'})
 fold.appendValidated([{type:'todo/write',version:1,items:[{content:'first',status:'pending'}]},{type:'goal/change',version:1,operation:'create',goal:{id:'g',revision:1,objective:'work',phase:'active'}}],0)
 const second={eventCount:2,bodyBytes:10,prefixDigest:'b'}
 fold.finishRestore(second)
 expect(fold.views.goal.snapshot(second)).toMatchObject({kind:'present',value:{revision:1}})
 fold.appendValidated([{type:'todo/write',version:1,items:[]},{type:'goal/change',version:1,operation:'clear',cleared:{id:'g',revision:1}}],2)
 const third={eventCount:4,bodyBytes:20,prefixDigest:'c'}
 fold.finishRestore(third)
 expect(fold.views.todo.snapshot(third)).toEqual({kind:'present',items:[]})
 expect(fold.views.goal.snapshot(third)).toEqual({kind:'absent'})
})

it('poisons the composite after a failed append rather than exposing Schedule alone',()=>{
 const fold=createOwnedMetadataFold({sessionId:'s',seedLength:0,formatVersion:14})
 const prefix={eventCount:0,bodyBytes:0,prefixDigest:'a'}
 fold.finishRestore(prefix)
 expect(()=>fold.appendValidated([],1)).toThrow()
 expect(()=>fold.snapshot(prefix)).toThrow(/poisoned/)
 expect(()=>fold.views.todo.snapshot(prefix)).toThrow(/poisoned/)
 expect(()=>fold.views.goal.snapshot(prefix)).toThrow(/poisoned/)
})

it('retains the exact original Schedule root and seed behavior alongside metadata',()=>{
 const source={sessionId:'s',seedLength:1,formatVersion:14}
 const combined=createOwnedMetadataFold(source),original=createScheduleFoldSink(source)
 const schedule=createAfterScheduleRecord('reminder','remember',60,Date.parse('2026-08-31T10:00:00Z'))
 const events=[{type:'user/message',text:'seed'},{type:'schedule/change',version:1,operation:'create',schedule},{type:'todo/write',version:1,items:[]}] as const
 const prefix={eventCount:3,bodyBytes:42,prefixDigest:'same'}
 combined.appendValidated(events,0);original.appendValidated(events,0)
 combined.finishRestore(prefix);original.finishRestore(prefix)
 expect(combined.snapshot(prefix)).toEqual(original.snapshot(prefix))
 expect(combined.validateSnapshot(combined.snapshot(prefix))).toBe(original.validateSnapshot(original.snapshot(prefix)))
 expect(combined.views.todo.snapshot(prefix)).toEqual({kind:'present',items:[]})
})

it('retains the validated Todo snapshot independently of the input object',()=>{
 const fold=createOwnedMetadataFold({sessionId:'s',seedLength:0,formatVersion:14})
 const items=[{content:'original',status:'pending' as const}]
 fold.appendValidated([{type:'todo/write',version:1,items}],0)
 items[0]!.content='changed after append'
 const prefix={eventCount:1,bodyBytes:1,prefixDigest:'a'};fold.finishRestore(prefix)
 expect(fold.views.todo.snapshot(prefix)).toEqual({kind:'present',items:[{content:'original',status:'pending'}]})
})
