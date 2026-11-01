import {expect,it,vi} from 'vitest'
import {createScheduleFoldSink,createAfterScheduleRecord,foldScheduleEvents} from '../src/index.ts'
import {restoreManagedExecutionState} from '../../core-session/src/execution-internal.ts'
import {createOwnerDeliveryControl} from '../../core-session/src/managed/delivery-control.ts'
import {captureFactGroup,encodeFactBatch,factPrefixDigest} from '../../core-session/src/index.ts'
import * as contextModule from '../../core-session/src/projection/context.ts'
import * as validationModule from '../../core-session/src/conversation/validation.ts'

function fixture(units:any[][]=[], options:{seedLength?:number;prefixCount?:number;settleFailure?:boolean}={}) {
  const events=units.flat(),token=Object.freeze({sessionId:'owned',incarnation:'original'})
  let prefix={eventCount:options.prefixCount??events.length,bodyBytes:0,prefixDigest:'a'.repeat(64)},current=true
  const source={formatVersion:14,...options.seedLength===undefined?{}:{header:{sessionId:'owned',seedLength:options.seedLength}},
    get prefix(){return prefix},assertCurrent(){if(!current)throw Error('source stale')},
    async consume(accept:any){for(const unit of units)await accept(unit)},async readEvent(i:number){return events[i]},
    async settle(){if(options.settleFailure)throw Error('settle failed')},async close(){},
    appendCommitted(batch:any,receipt:any){prefix={eventCount:prefix.eventCount+batch.key.count,bodyBytes:prefix.bodyBytes+batch.bytes.length,prefixDigest:receipt.prefixDigest}}}
  const binding={token,assertHeld(){},openDependencies(){return {assertCurrent(){},async readEvent(i:number){return events[i]},async close(){}}}}
  async function restore(factory:any=createScheduleFoldSink){
    const state=await restoreManagedExecutionState(source as any,binding,factory)
    createOwnerDeliveryControl(state.delivery,()=>state.eventCount)
    state.bindOwner({ownsAction:()=>false,beginAction(){throw Error('unused')},registerReceivedInputSource(){throw Error('unused')},async drain(){}} as any)
    return state
  }
  return {restore,stale(){current=false},token,prefix:()=>prefix}
}
async function write(f:ReturnType<typeof fixture>,state:Awaited<ReturnType<ReturnType<typeof fixture>['restore']>>) {
  const capture=captureFactGroup({kind:'metadata',event:{type:'plan/mode',mode:'on'}} as any)
  if(capture.kind!=='captured')throw Error('capture failed')
  const stage=await state.prepareWrite([capture.group]),batch=encodeFactBatch('live',f.prefix().prefixDigest,stage.events)
  const receipt=Object.freeze({owner:f.token,key:batch.key,lastSeq:batch.key.firstSeq+batch.key.count-1,prefixDigest:factPrefixDigest(batch.key.previousPrefixDigest,batch.key.batchDigest)})
  return {stage,batch,receipt,install(){stage.install(batch,receipt)}}
}

for(const operation of ['appendValidated','finishRestore'] as const) {
  it(`refuses asynchronous restore ${operation} acknowledgment`,async()=>{
    const f=fixture([[{type:'plan/mode',mode:'on',seq:0}]])
    let late=0
    await expect(f.restore((info:any)=>{
      const sink=createScheduleFoldSink(info)
      return {...sink,[operation]:async(...args:any[])=>{await Promise.resolve();late++;(sink[operation] as Function)(...args);throw Error('late rejection')}}
    })).rejects.toThrow(/synchronous/i)
    await Promise.resolve();expect(late).toBe(1)
  })
  it(`blocks asynchronous live ${operation} forever without replay`,async()=>{
    const f=fixture();let live=false,calls=0,late=0
    const state=await f.restore((info:any)=>{
      const sink=createScheduleFoldSink(info)
      return {...sink,[operation]:(...args:any[])=>{
        if(!live)return (sink[operation] as Function)(...args)
        calls++;return Promise.resolve().then(()=>{late++;(sink[operation] as Function)(...args);throw Error('late rejection')})
      }}
    })
    const pending=await write(f,state);live=true;pending.stage.beforeIssue(pending.batch)
    expect(pending.install).toThrow(/synchronous/i)
    await Promise.resolve();await Promise.resolve()
    expect(()=>state.observe()).toThrow();expect(pending.install).toThrow(/RECOVERY_REQUIRED/)
    expect({calls,late}).toEqual({calls:1,late:1})
  })
}

it('skips a successfully acknowledged fold when a later original context commit fails and retries',async()=>{
  const original=contextModule.createContextStateIndex
  let fail=false,failed=false,feeds=0
  const spy=vi.spyOn(contextModule,'createContextStateIndex').mockImplementation((...args:Parameters<typeof original>)=>{
    const index=original(...args),stage=index.stage.bind(index)
    return {...index,stage(events){const staged=stage(events);return {...staged,commit(){if(fail&&!failed){failed=true;throw Error('context commit failure')}return staged.commit()}}}}
  })
  try {
    const f=fixture(),state=await f.restore((info:any)=>{const sink=createScheduleFoldSink(info);return {...sink,appendValidated(unit:any,ordinal:number){feeds++;sink.appendValidated(unit,ordinal)}}})
    const pending=await write(f,state);fail=true;pending.stage.beforeIssue(pending.batch)
    expect(pending.install).toThrow('context commit failure');expect(()=>state.observe()).toThrow()
    expect(()=>pending.stage.install(pending.batch,{...pending.receipt})).toThrow('Original pending installation required')
    pending.install();pending.install();expect(feeds).toBe(1)
    expect(state.observe().schedules).toMatchObject({kind:'available',snapshot:{active:[]}})
  } finally {spy.mockRestore()}
})

for(const failure of ['invalid','prefix','settle'] as const)it(`does not publish a failed ${failure} restoration or reuse its sink`,async()=>{
  let factories=0,finishes=0
  const factory=(info:any)=>{factories++;const sink=createScheduleFoldSink(info);return {...sink,finishRestore(prefix:any){finishes++;sink.finishRestore(prefix)}}}
  const units=failure==='invalid'?[[{type:'plan/mode',mode:'on',seq:0}],[{type:'schedule/change',version:1,operation:'delete',id:'missing',seq:1}]]:[]
  await expect(fixture(units,{prefixCount:failure==='prefix'?1:units.flat().length,settleFailure:failure==='settle'}).restore(factory)).rejects.toThrow()
  expect(finishes).toBe(0)
  const recovered=await fixture().restore(factory)
  expect(recovered.observe().schedules).toMatchObject({kind:'available',snapshot:{active:[]}})
  expect(factories).toBe(2);expect(finishes).toBe(1)
})

it('excludes genuine inherited schedule ownership across original consume units',async()=>{
  const record=createAfterScheduleRecord('inherited','inherited',60,Date.parse('2026-08-31T10:00:00Z'))
  const own=createAfterScheduleRecord('own','own',60,Date.parse('2026-08-31T10:00:00Z'))
  const events=[{type:'schedule/change',version:1,operation:'create',schedule:record,seq:0},{type:'schedule/change',version:1,operation:'create',schedule:own,seq:1},{type:'plan/mode',mode:'on',seq:2}]
  const state=await fixture([events.slice(0,1),events.slice(1)],{seedLength:1}).restore()
  expect(state.observe().schedules).toMatchObject({kind:'available',snapshot:foldScheduleEvents(events as any,1)})
})

it('rejects snapshot reentry changing original source currency',async()=>{
  const f=fixture(),state=await f.restore((info:any)=>{const sink=createScheduleFoldSink(info);return {...sink,snapshot(prefix:any){const result=sink.snapshot(prefix);f.stale();return result}}})
  expect(()=>state.observe()).toThrow('source stale')
})

it('rejects an async snapshot without publishing an available observation',async()=>{
  const f=fixture(),state=await f.restore((info:any)=>{const sink=createScheduleFoldSink(info);return {...sink,async snapshot(prefix:any){await Promise.resolve();return sink.snapshot(prefix)}}})
  expect(()=>state.observe()).toThrow(/Synchronous/)
})

it('does not publish when the original final scan throws after consuming valid units',async()=>{
  const original=validationModule.createConversationValidationScan
  let finishes=0,feeds=0
  const spy=vi.spyOn(validationModule,'createConversationValidationScan').mockImplementation((...args:Parameters<typeof original>)=>{
    const scan=original(...args)
    return {...scan,finish(){scan.finish();throw Error('final validation failure')}}
  })
  try {
    await expect(fixture([[{type:'plan/mode',mode:'on',seq:0}]]).restore((info:any)=>{
      const sink=createScheduleFoldSink(info)
      return {...sink,appendValidated(unit:any,ordinal:number){feeds++;sink.appendValidated(unit,ordinal)},finishRestore(prefix:any){finishes++;sink.finishRestore(prefix)}}
    })).rejects.toThrow('final validation failure')
    expect({feeds,finishes}).toEqual({feeds:1,finishes:0})
  } finally {spy.mockRestore()}
  expect((await fixture().restore()).observe().schedules.kind).toBe('available')
})

for(const after of [false,true])it(`retains falsey live fold failure ${after?'after':'before'} apply without replay`,async()=>{
  const f=fixture();let calls=0
  const state=await f.restore((info:any)=>{const sink=createScheduleFoldSink(info);return {...sink,appendValidated(unit:any,ordinal:number){calls++;if(after)sink.appendValidated(unit,ordinal);throw undefined}}})
  const pending=await write(f,state);pending.stage.beforeIssue(pending.batch)
  let failed=false;try{pending.install()}catch(error){failed=true;expect(error).toBeUndefined()}
  expect(failed).toBe(true);expect(()=>state.observe()).toThrow();expect(pending.install).toThrow(/RECOVERY_REQUIRED/);expect(calls).toBe(1)
})

for(const [name,invalid] of Object.entries({null:null,undefined:undefined,primitive:1,array:[],wrong:{other:[]},badRecord:{active:[{id:'bad'}],seenIds:['bad']},unseen:{active:[createAfterScheduleRecord('unseen','prompt',60,Date.parse('2026-08-31T10:00:00Z'))],seenIds:[]}})) {
  it(`permanently refuses ${name} snapshot even when the next callback would be valid`,async()=>{
    let calls=0
    const state=await fixture().restore((info:any)=>{const sink=createScheduleFoldSink(info);return {...sink,snapshot(prefix:any){calls++;return calls===1?invalid:sink.snapshot(prefix)}}})
    expect(()=>state.observe()).toThrow();expect(()=>state.observe()).toThrow();expect(calls).toBe(1)
  })
}

for(const mode of ['throw','async','changed'] as const)it(`permanently refuses ${mode} validator without snapshot revival`,async()=>{
  let snapshots=0,validations=0
  const state=await fixture().restore((info:any)=>{
    const sink=createScheduleFoldSink(info)
    const supplied={...sink,snapshot(prefix:any){snapshots++;if(mode==='changed')supplied.validateSnapshot=()=>true;return sink.snapshot(prefix)},validateSnapshot(value:unknown):any{
      validations++
      if(validations>1)return true
      if(mode==='throw')throw undefined
      if(mode==='async')return Promise.reject(Error('late validator rejection'))
      return sink.validateSnapshot(value)
    }}
    return supplied
  })
  expect(()=>state.observe()).toThrow();await Promise.resolve();await Promise.resolve()
  expect(()=>state.observe()).toThrow();expect(snapshots).toBe(1)
})
