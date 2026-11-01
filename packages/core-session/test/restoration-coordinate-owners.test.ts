import { describe, it, expect } from 'vitest'
import { archiveConversationSources, createConversationSourceCoordinates } from '../src/conversation/sources.ts'
import { createPruneDependencyIndex, preparePruneSubstitutes } from '../src/projection/pruning.ts'
import type { SessionEventView } from '../src/managed/types.ts'
const event = (value: unknown) => value as SessionEventView

describe('original restoration coordinate owners', () => {
  it('preserves duplicate, gap, missing and candidate coordinates without archive scans', () => {
    const events = [event({type:'user/message',seq:4}), event({type:'conversation/semantics',seq:9}),event({type:'user/message',seq:4}),event({type:'user/message'})]
    const owner = createConversationSourceCoordinates()
    owner.stage(events.slice(0,2)).commit()
    const coordinates = owner.stage(events.slice(2)).commit()
    const diagnostics: any[] = [], expected: any[] = []
    const archive = {length:events.length,get:(index:number)=>events[index]!}
    const full = archiveConversationSources(archive, 'owner', expected)
    const restored = archiveConversationSources({length:events.length,get:()=>{throw Error('unprepared')}}, 'owner', diagnostics,{coordinates})
    expect(diagnostics).toEqual(expected)
    for(let i=0;i<events.length;i++) expect(restored.ref(i,'event')).toEqual(full.ref(i,'event'))
    expect(restored.indexOfSeq(9)).toBe(1)
    expect(()=>archiveConversationSources(archive,'owner',[],{coordinates:{...coordinates}})).toThrow()
    owner.stage([]).commit()
    expect(()=>restored.ref(0,'event')).toThrow()
  })
  it('stages atomically and hydrates only selected latest prune payloads',async()=>{
    const owner=createPruneDependencyIndex()
    const events=[event({type:'compaction/prune',seq:2,pruned:[{callId:'a',head:'old',tail:'',removedBytes:1}]}),event({type:'compaction/prune',seq:5,pruned:[{callId:'a',head:'new',tail:'end',removedBytes:2},{callId:'b',head:'other',tail:'',removedBytes:3}]})]
    const first=owner.stage(events.slice(0,1)), competing=owner.stage([])
    first.commit();expect(()=>competing.commit()).toThrow()
    const view=owner.stage(events.slice(1)).commit(), reads:number[]=[]
    const records=await preparePruneSubstitutes(view,['a'],async index=>{reads.push(index);return events[index]!})
    expect(reads).toEqual([1]);expect([...records.keys()]).toEqual(['a']);expect(records.get('a')?.head).toBe('new')
    await expect(preparePruneSubstitutes({...view},['a'],async()=>events[1]!)).rejects.toThrow()
    await expect(preparePruneSubstitutes(view,['missing'],async()=>events[1]!)).rejects.toThrow()
    await expect(preparePruneSubstitutes(view,['a'],async()=>event({...events[1],seq:6}))).rejects.toThrow()
    await expect(preparePruneSubstitutes(view,['a'],async()=>{owner.stage([]).commit();return events[1]!})).rejects.toThrow()
  })
})

it('refuses all stale source operations before payload access', () => {
  const owner = createConversationSourceCoordinates(), view = owner.stage([event({type:'user/message',seq:0,text:'hi'})]).commit()
  let reads=0
  const reader=archiveConversationSources({length:1,get:()=>{reads++; return event({type:'user/message',seq:0,text:'hi'})}},'s',[],{coordinates:view})
  reader.ref(0,'text')
  owner.stage([]).commit()
  expect(()=>reader.indexOfSeq(0)).toThrow('Stale')
  expect(()=>reader.ref(0,'text')).toThrow('Stale')
  expect(()=>reader.provenance(0,'text')).toThrow('Stale')
  expect(reads).toBe(0)
})

it('matches full provenance across semantics fence, actual text, inheritance and candidates', () => {
  const admitted=(seq:number,inputId:string,text:string)=>event({type:'agent/input/admitted',seq,inputId,text,intent:'user'})
  const message=(seq:number,inputId:string,text:string)=>event({type:'user/message',seq,text,input:{inputId,intent:'user'}})
  const events=[admitted(3,'before','same'),message(7,'before','same'),event({type:'conversation/semantics',seq:11}),admitted(14,'after','same'),message(18,'after','same'),message(22,'before','different'),message(25,'before','same')]
  const owner=createConversationSourceCoordinates(), competing=owner.stage([])
  const coordinates=owner.stage(events).commit()
  expect(()=>competing.commit()).toThrow()
  const archive={length:events.length,get:(index:number)=>events[index]!}
  for(const inherited of [false,true]) for(const prospective of [false,true]) {
    const options={...(inherited?{header:{parentSession:'parent',seedLength:2} as any}:{}),...(prospective?{candidate:{id:'pending',baseCount:6}}:{})}
    const fullDiagnostics:any[]=[],restoredDiagnostics:any[]=[]
    const full=archiveConversationSources(archive,'s',fullDiagnostics,options)
    const restored=archiveConversationSources(archive,'s',restoredDiagnostics,{...options,coordinates})
    for(const [index,admission] of [[1,0],[4,3],[5,0],[6,0]]) expect(restored.provenance(index!,'text',admission)).toEqual(full.provenance(index!,'text',admission))
    expect(restoredDiagnostics).toEqual(fullDiagnostics)
    expect(restored.ref(6,'text')).toEqual(full.ref(6,'text'))
    if(!inherited&&!prospective){
      expect(restored.provenance(1,'text',0).authority).toBe('request')
      expect(restored.provenance(4,'text',3).authority).toBe('unknown')
      expect(restored.provenance(5,'text',0).authority).toBe('unknown')
    }
  }
})
