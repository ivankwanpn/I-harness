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

it('shares only immutable named snapshots from the same projection revision',()=>{
 const fold=createOwnedMetadataFold({sessionId:'s',seedLength:0,formatVersion:14})
 const first={eventCount:3,bodyBytes:30,prefixDigest:'first'}
 fold.appendValidated([
  {type:'user/message',text:'first'},
  {type:'todo/write',version:1,items:[{content:'original',status:'pending'}]},
  {type:'goal/change',version:1,operation:'create',goal:{id:'g',revision:1,objective:'work',phase:'active'}},
 ],0)
 fold.finishRestore(first)
 const title=fold.views.title.snapshot(first),todo=fold.views.todo.snapshot(first),goal=fold.views.goal.snapshot(first)
 if(!title.candidate||todo.kind!=='present'||goal.kind!=='present')throw Error('Expected named snapshots')
 expect([title,title.candidate,title.candidate.messageSeqs,todo,todo.items,todo.items[0],goal,goal.value].every(Object.isFrozen)).toBe(true)
 expect(Reflect.set(title.candidate.messageSeqs,0,99)).toBe(false)
 expect(Reflect.set(todo.items[0]!,'content','changed')).toBe(false)
 expect(Reflect.set(goal.value,'objective','changed')).toBe(false)
 expect(fold.views.title.validateSnapshot(title)).toBe(true)
 expect(fold.views.todo.validateSnapshot(todo)).toBe(true)
 expect(fold.views.goal.validateSnapshot(goal)).toBe(true)

 const unrelated={eventCount:4,bodyBytes:40,prefixDigest:'internal'}
 fold.appendValidated([{type:'user/message',text:'hidden',internal:true}],3)
 expect(()=>fold.views.title.snapshot(first)).toThrow(/prefix mismatch/)
 fold.finishRestore(unrelated)
 expect(()=>fold.views.todo.snapshot({...unrelated,prefixDigest:'other'})).toThrow(/prefix mismatch/)
 expect(fold.views.title.snapshot(unrelated)).toBe(title)
 expect(fold.views.todo.snapshot(unrelated)).toBe(todo)
 expect(fold.views.goal.snapshot(unrelated)).toBe(goal)

 const nextTitle={eventCount:5,bodyBytes:50,prefixDigest:'title'}
 fold.appendValidated([{type:'user/message',text:'second'}],4)
 fold.finishRestore(nextTitle)
 const updatedTitle=fold.views.title.snapshot(nextTitle)
 expect(updatedTitle).not.toBe(title)
 expect(updatedTitle.candidate?.messageSeqs).toEqual([0,4])
 expect(title.candidate.messageSeqs).toEqual([0])
 expect(fold.views.todo.snapshot(nextTitle)).toBe(todo)
 expect(fold.views.goal.snapshot(nextTitle)).toBe(goal)

 const nextWork={eventCount:7,bodyBytes:70,prefixDigest:'work'}
 fold.appendValidated([
  {type:'todo/write',version:1,items:[]},
  {type:'goal/change',version:1,operation:'clear',cleared:{id:'g',revision:1}},
 ],5)
 fold.finishRestore(nextWork)
 expect(fold.views.title.snapshot(nextWork)).toBe(updatedTitle)
 expect(fold.views.todo.snapshot(nextWork)).toEqual({kind:'present',items:[]})
 expect(fold.views.goal.snapshot(nextWork)).toEqual({kind:'absent'})
 expect(todo.items[0]!.content).toBe('original')
 expect(goal.value.objective).toBe('work')
})

it('captures only physical eligible title inputs and latest title',()=>{
 const fold=createOwnedMetadataFold({sessionId:'s',seedLength:0,formatVersion:14})
 fold.appendValidated([{type:'user/message',text:'first'}, {type:'user/message',text:'hidden',internal:true}, {type:'user/message',text:'second'}, {type:'session/title',title:'',messageSeqs:[],source:'user'}] as any,0)
 const prefix={eventCount:4,bodyBytes:4,prefixDigest:'title'};fold.finishRestore(prefix)
 expect(fold.views.title.snapshot(prefix)).toEqual({revision:3,title:{title:'',messageSeqs:[],source:'user',eventSeq:3},candidate:{firstSeq:0,messageSeqs:[0,2],promptText:'first\n\nsecond',fallback:'first'}})
})

it('bounds prompt with exact separators, keeps all input sequences, and ignores sourced messages',()=>{
 const fold=createOwnedMetadataFold({sessionId:'s',seedLength:0,formatVersion:14})
 const text='x'.repeat(3999)
 fold.appendValidated([{type:'user/message',text}, {type:'user/message',text:''}, {type:'user/message',text:'source',source:'plugin'}, {type:'user/message',text:'tail'}] as any,0)
 const prefix={eventCount:4,bodyBytes:4,prefixDigest:'bounded'};fold.finishRestore(prefix)
 expect(fold.views.title.snapshot(prefix)).toEqual({revision:3,title:null,candidate:{firstSeq:0,messageSeqs:[0,1,3],promptText:text+'\n',fallback:'x'.repeat(120)+'...'}})
})

it('retains no candidate for an empty title source and validates a closed snapshot',()=>{
 const fold=createOwnedMetadataFold({sessionId:'s',seedLength:0,formatVersion:14})
 const prefix={eventCount:0,bodyBytes:0,prefixDigest:'empty'};fold.finishRestore(prefix)
 expect(fold.views.title.snapshot(prefix)).toEqual({revision:0,title:null,candidate:null})
 expect(fold.views.title.validateSnapshot({revision:0,title:null,candidate:null,extra:true})).toBe(false)
})
