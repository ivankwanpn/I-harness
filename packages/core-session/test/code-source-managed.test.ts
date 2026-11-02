import { expect, it } from 'vitest'
import { captureFactGroup } from '../src/managed/groups.ts'
import { createNondurableFactOwner } from '../src/managed/nondurable.ts'
import type { Session } from '../src/events/types.ts'

const source = {type:'agent/delivery-source',version:1,kind:'code',sourceNamespace:'code',recipientSessionId:'parent',generationId:'g',sourceId:'outer',callSeq:2,cellId:'cell',delivery:'tool'} as const
const end = {type:'code/end',version:1,sourceSeq:4,cellId:'cell',execution:{dispatch:'not-dispatched',outcome:'unknown'},reason:'launch-refused'} as const
const handoff = {type:'agent/delivery-handoff',version:1,kind:'code',sourceSeq:4} as const
it('accepts only closed Code source and terminal facts through managed groups',()=>{
 expect(captureFactGroup({kind:'code-delivery-source',event:source}).kind).toBe('captured')
 for(const event of [end,handoff]) expect(captureFactGroup({kind:'delivery',event}).kind).toBe('captured')
 for(const event of [{...source,seq:4},{...source,extra:true},{...source,kind:'exec'},{...source,delivery:'parent'}]) expect(captureFactGroup({kind:'code-delivery-source',event} as never).kind).toBe('not-issued')
 for(const event of [{...end,extra:true},{...handoff,kind:'foreign'}]) expect(captureFactGroup({kind:'delivery',event} as never).kind).toBe('not-issued')
})
it('refuses a Code source when its original action currentness is stale',async()=>{
 const session:Session={formatVersion:14,events:[]},owner=createNondurableFactOwner(session),action=owner.beginAction()
 const fact=action.captureCodeDeliverySource(source,()=>false)
 expect(()=>fact.admit()).toThrow(/FACT_PRECONDITION_STALE/)
 expect(session.events).toEqual([]);action.finish()
})
