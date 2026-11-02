import { expect, it } from 'vitest'
import { createScheduleFoldSink, createAfterScheduleRecord, foldScheduleEvents } from '../src/index.ts'

it('tracks inherited and unrelated ordinals and binds snapshots to the exact prefix', () => {
  const record = createAfterScheduleRecord('s', 'prompt', 60, Date.parse('2026-08-31T10:00:00Z'))
  const events = [{type:'user/message',text:'inherited'}, {type:'schedule/change',version:1,operation:'create',schedule:record}, {type:'user/message',text:'tail'}] as any[]
  const sink = createScheduleFoldSink({seedLength:1})
  sink.appendValidated(events.slice(0,2),0)
  sink.appendValidated(events.slice(2),2)
  const prefix = {eventCount:3,bodyBytes:5,prefixDigest:'a'}
  sink.finishRestore(prefix)
  expect(sink.snapshot(prefix)).toEqual(foldScheduleEvents(events,1))
  expect(() => sink.snapshot({...prefix,prefixDigest:'b'})).toThrow()
  expect(() => sink.appendValidated(events,0)).toThrow()
})
import { createOwnerDeliveryControl } from '../../core-session/src/managed/delivery-control.ts'
import { restoreManagedExecutionState } from '../../core-session/src/execution-internal.ts'
import { captureFactGroup, encodeFactBatch, factPrefixDigest } from '../../core-session/src/index.ts'

it('connects the real fold to restored observation and an acknowledged live suffix once', async () => {
  const token = Object.freeze({sessionId:'owned',incarnation:'original'})
  const record = createAfterScheduleRecord('restored', 'prompt', 60, Date.parse('2026-08-31T10:00:00Z'))
  const events:any[] = [{type:'schedule/change',version:1,operation:'create',schedule:record,seq:0}]
  let prefix = {eventCount:1,bodyBytes:0,prefixDigest:'a'.repeat(64)}
  const source = {formatVersion:14,get prefix(){return prefix},assertCurrent(){},async consume(accept:any){await accept(events)},async readEvent(i:number){return events[i]},async settle(){},async close(){},appendCommitted(batch:any,receipt:any){prefix={eventCount:prefix.eventCount+batch.key.count,bodyBytes:prefix.bodyBytes+batch.bytes.length,prefixDigest:receipt.prefixDigest}}}
  const binding = {token,assertHeld(){},openDependencies(){return {assertCurrent(){},async readEvent(i:number){return events[i]},async close(){}}}}
  const state = await restoreManagedExecutionState(source,binding,createScheduleFoldSink)
  createOwnerDeliveryControl(state.delivery, () => state.eventCount)
  state.bindOwner({ownsAction:()=>false,beginAction(){throw Error('unused')},registerReceivedInputSource(){throw Error('unused')},async drain(){}} as any)
  const observed = state.observe()
  expect(observed.schedules).toMatchObject({kind:'available',snapshot:{active:[record],seenIds:['restored']}})
  const captured = captureFactGroup({kind:'metadata',event:{type:'plan/mode',mode:'on'}} as any)
  if (captured.kind !== 'captured') throw Error('capture failed')
  const staged = await state.prepareWrite([captured.group])
  const batch = encodeFactBatch('bridge',prefix.prefixDigest,staged.events)
  const receipt = Object.freeze({owner:token,key:batch.key,lastSeq:batch.key.firstSeq+batch.key.count-1,prefixDigest:factPrefixDigest(batch.key.previousPrefixDigest,batch.key.batchDigest)})
  staged.beforeIssue(batch); staged.install(batch,receipt); staged.install(batch,receipt)
  expect(() => observed.assertCurrent()).toThrow()
  expect(state.observe().schedules).toMatchObject({kind:'available',snapshot:{active:[record],seenIds:['restored']}})
  const live = createAfterScheduleRecord('live', 'live', 60, Date.parse('2026-08-31T10:00:00Z'))
  const change = captureFactGroup({kind:'metadata',event:{type:'schedule/change',version:1,operation:'create',schedule:live}} as any)
  if (change.kind !== 'captured') throw Error('capture failed')
  const next = await state.prepareWrite([change.group])
  const nextBatch = encodeFactBatch('live-schedule',prefix.prefixDigest,next.events)
  const nextReceipt = Object.freeze({owner:token,key:nextBatch.key,lastSeq:nextBatch.key.firstSeq+nextBatch.key.count-1,prefixDigest:factPrefixDigest(nextBatch.key.previousPrefixDigest,nextBatch.key.batchDigest)})
  next.beforeIssue(nextBatch); next.install(nextBatch,nextReceipt); next.install(nextBatch,nextReceipt)
  expect(state.observe().schedules).toMatchObject({kind:'available',snapshot:{active:[record,live],seenIds:['restored','live']}})
})

it('poisons the accumulator after an invalid event rather than retrying it', () => {
  const sink = createScheduleFoldSink({seedLength:0})
  expect(() => sink.appendValidated([{type:'schedule/change',version:1,operation:'delete',id:'missing'}] as any,0)).toThrow()
  expect(() => sink.appendValidated([],0)).toThrow(/poisoned/)
  expect(() => sink.snapshot({eventCount:0,bodyBytes:0,prefixDigest:'x'})).toThrow(/poisoned/)
})




it('a throwing live fold stays blocked and is never replayed after an uncertain mutation', async () => {
  const token = Object.freeze({sessionId:'owned',incarnation:'original'})
  let prefix = {eventCount:0,bodyBytes:0,prefixDigest:'a'.repeat(64)}, calls = 0
  const source = {formatVersion:14,get prefix(){return prefix},assertCurrent(){},async consume(_accept:any){},async readEvent(_i:number){throw Error('unexpected')},async settle(){},async close(){},appendCommitted(batch:any,receipt:any){prefix={eventCount:prefix.eventCount+batch.key.count,bodyBytes:prefix.bodyBytes+batch.bytes.length,prefixDigest:receipt.prefixDigest}}}
  const binding = {token,assertHeld(){},openDependencies(){return {assertCurrent(){},async readEvent(_i:number){throw Error('unexpected')},async close(){}}}}
  const state = await restoreManagedExecutionState(source,binding, info => {
    const sink = createScheduleFoldSink(info)
    return {...sink,appendValidated(unit,ordinal){calls++;sink.appendValidated(unit,ordinal);throw Error('uncertain')}}
  })
  createOwnerDeliveryControl(state.delivery, () => state.eventCount)
  state.bindOwner({ownsAction:()=>false,beginAction(){throw Error('unused')},registerReceivedInputSource(){throw Error('unused')},async drain(){}} as any)
  const captured = captureFactGroup({kind:'metadata',event:{type:'plan/mode',mode:'on'}} as any)
  if (captured.kind !== 'captured') throw Error('capture failed')
  const staged = await state.prepareWrite([captured.group]), batch = encodeFactBatch('poison',prefix.prefixDigest,staged.events)
  const receipt = Object.freeze({owner:token,key:batch.key,lastSeq:batch.key.firstSeq+batch.key.count-1,prefixDigest:factPrefixDigest(batch.key.previousPrefixDigest,batch.key.batchDigest)})
  expect(calls).toBe(0)
  staged.beforeIssue(batch)
  expect(calls).toBe(0)
  expect(() => staged.install(batch,receipt)).toThrow('uncertain')
  expect(() => state.observe()).toThrow()
  expect(() => staged.install(batch,receipt)).toThrow(/RECOVERY_REQUIRED/)
  expect(calls).toBe(1)
})
