import {expect,it} from 'vitest'
import {restoreManagedExecutionState} from '../src/managed/execution-state.ts'
import {createOwnerDeliveryControl} from '../src/managed/delivery-control.ts'
import type {SessionEventView} from '../src/managed/types.ts'

async function fixture(controls:{read?():Promise<void>;close?():Promise<void>}={}){
 const events:SessionEventView[]=[
  {type:'agent/input/admitted',version:1,inputId:'done',text:'original completed body',delivery:'queue',intent:'user',seq:0},
  {type:'agent/input/cancelled',version:1,inputId:'done',reason:'cancelled',seq:1},
  {type:'agent/input/admitted',version:1,inputId:'done:retry:1',text:'retry body',delivery:'queue',intent:'user',seq:2},
 ]
 const prefix=Object.freeze({eventCount:events.length,bodyBytes:0,prefixDigest:'a'.repeat(64)})
 let held=true,epoch=0,opened=0,closed=0,reads:number[]=[],lastScope:any
 const source={formatVersion:14,prefix,assertCurrent(){if(!held)throw Error('lost native owner')},async consume(accept:any){for(const event of events)await accept([Object.freeze(event)])},async readEvent(ordinal:number){return events[ordinal]!},async settle(){},async close(){},appendCommitted(){throw Error('No observation writes')}}
 const binding={token:Object.freeze({sessionId:'inbox',incarnation:'original'}),assertHeld:source.assertCurrent,openDependencies(expected:typeof prefix){opened++;const captured=epoch;let disposed=false;lastScope={assertCurrent(){if(disposed||captured!==epoch||expected!==prefix)throw Error('changed original prefix');binding.assertHeld()},async readEvent(ordinal:number){reads.push(ordinal);await controls.read?.();return events[ordinal]!},async close(){await controls.close?.();disposed=true;closed++}};return lastScope}}
 const state=await restoreManagedExecutionState(source,binding)
 createOwnerDeliveryControl(state.delivery,()=>state.eventCount)
 state.bindOwner({ownsAction(){return false},beginAction(){throw Error('No observation action')},registerReceivedInputSource(){throw Error('No observation source')},async drain(){}})
 return {state,events,reads,get opened(){return opened},get closed(){return closed},get lastScope(){return lastScope},change(){epoch++},lose(){held=false}}
}

it('hydrates only the original completed admission and keeps exact cancellation retry lineage',async()=>{
 const f=await fixture(),observed=f.state.observe()
 expect(observed.inbox.pending().map(input=>input.inputId)).toEqual(['done:retry:1'])
 expect(observed.inbox.lastCancellationSeq('done')).toBe(1)
 expect(observed.inbox.lastCancellationSeq('done:retry:1')).toBeUndefined()
 const admitted=await observed.inbox.admitted('done');observed.assertCurrent()
 expect(admitted).toEqual(f.events[0]);expect(Object.isFrozen(admitted)).toBe(true)
 expect(f.reads).toEqual([0]);expect(f.opened).toBe(1);expect(f.closed).toBe(1)
 expect(await observed.inbox.admitted('missing')).toBeUndefined();expect(f.opened).toBe(1)
 await expect(observed.inbox.admitted.call({...observed.inbox},'done')).rejects.toThrow('receiver')
 await f.state.close()
})

for(const drift of ['prefix','native','Stop'] as const)it(`refuses ${drift} drift across the original admission read before publishing data`,async()=>{
 let enter!:()=>void,resume!:()=>void;const entered=new Promise<void>(r=>enter=r),held=new Promise<void>(r=>resume=r)
 const f=await fixture({async read(){enter();await held}}),observed=f.state.observe(),reading=observed.inbox.admitted('done')
 await entered
 if(drift==='prefix')f.change();else if(drift==='native')f.lose();else f.state.stopNewWork()
 resume();await expect(reading).rejects.toThrow();expect(f.closed).toBe(1)
})

it('retains falsey primary and cleanup failures with the exact original cleanup method',async()=>{
 let failing=true,replacement=0
 const f=await fixture({async read(){throw null},async close(){if(failing)throw 0}}),observed=f.state.observe()
 const failure=await observed.inbox.admitted('done').catch(error=>error)
 expect(failure).toBeInstanceOf(AggregateError);expect(failure.errors).toEqual([null,0])
 expect(()=>f.state.observe()).toThrow('cleanup unresolved');expect(f.opened).toBe(1)
 f.lastScope.close=async()=>{replacement++};failing=false;await f.state.close()
 expect(f.closed).toBe(1);expect(replacement).toBe(0)
})

it('withholds a valid admission until its original cleanup ACK and retries cleanup without reading again',async()=>{
 let failing=true
 const f=await fixture({async close(){if(failing)throw undefined}}),observed=f.state.observe()
 await expect(observed.inbox.admitted('done')).rejects.toBeUndefined()
 expect(f.reads).toEqual([0]);expect(()=>observed.assertCurrent()).toThrow('cleanup unresolved')
 failing=false;await f.state.settleDependencies();observed.assertCurrent()
 expect(f.reads).toEqual([0]);expect(f.closed).toBe(1);await f.state.close()
})
