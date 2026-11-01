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
