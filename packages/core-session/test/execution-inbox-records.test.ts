import {expect,it,vi} from 'vitest'
import {restoreManagedExecutionState,createManagedExecutionDomain,assertManagedExecDeliveryCurrent,assertManagedCodeDeliveryCurrent,subscribeManagedExecutionReadiness,getManagedExecutionAdmissionWait} from '../src/managed/execution-state.ts'
import {createOwnerDeliveryControl} from '../src/managed/delivery-control.ts'
import type {SessionEventView} from '../src/managed/types.ts'
import {createNondurableFactOwner} from '../src/managed/nondurable.ts'
import {createSession} from '../src/events/append.ts'

async function fixture(controls:{read?():Promise<void>;close?():Promise<void>;fold?:import('../src/managed/execution-types.ts').OriginalExecutionFoldFactory;events?:SessionEventView[]}={}){
 const events:SessionEventView[]=controls.events??[
  {type:'agent/input/admitted',version:1,inputId:'done',text:'original completed body',delivery:'queue',intent:'user',provenance:{kind:'human',authority:'request',scope:'turn',producer:'fixture',originSessionId:'inbox'},seq:0},
  {type:'agent/input/cancelled',version:1,inputId:'done',reason:'cancelled',seq:1},
  {type:'agent/input/admitted',version:1,inputId:'done:retry:1',text:'retry body',delivery:'queue',intent:'user',seq:2},
 ]
 const prefix=Object.freeze({eventCount:events.length,bodyBytes:0,prefixDigest:'a'.repeat(64)})
 let held=true,epoch=0,opened=0,closed=0,reads:number[]=[],lastScope:any
 const source={formatVersion:14,prefix,assertCurrent(){if(!held)throw Error('lost native owner')},async consume(accept:any){for(const event of events)await accept([Object.freeze(event)])},async readEvent(ordinal:number){return events[ordinal]!},async settle(){},async close(){},appendCommitted(){throw Error('No observation writes')}}
 const binding={token:Object.freeze({sessionId:'inbox',incarnation:'original'}),assertHeld:source.assertCurrent,openDependencies(expected:typeof prefix){opened++;const captured=epoch;let disposed=false;lastScope={assertCurrent(){if(disposed||captured!==epoch||expected!==prefix)throw Error('changed original prefix');binding.assertHeld()},async readEvent(ordinal:number){reads.push(ordinal);await controls.read?.();return events[ordinal]!},async close(){await controls.close?.();disposed=true;closed++}};return lastScope}}
 const state=await restoreManagedExecutionState(source,binding,controls.fold)
 const deliveryControl=createOwnerDeliveryControl(state.delivery,()=>state.eventCount)
 const action={signal:new AbortController().signal,assertOpen(){}},owner={ownsAction(value:object){return value===action},beginAction(){throw Error('No observation action')},registerReceivedInputSource(){throw Error('No observation source')},async drain(){},assertReady(){}}
 state.bindOwner(owner);state.captureHooks(action,()=>{})
 return {state,owner,action:action as unknown as import('../src/managed/ports.ts').ManagedAction<import('../src/managed/types.ts').FactOutcome>,deliveryControl,events,reads,get opened(){return opened},get closed(){return closed},get lastScope(){return lastScope},change(){epoch++},lose(){held=false}}
}

it('hydrates the indexed actual matching dispatch and no missing or mismatched dispatch',async()=>{
 const events:SessionEventView[]=[{type:'tool/call',callId:'one',name:'shell',args:{command:'x'},seq:0},{type:'tool/dispatch',callId:'other',eventSeq:0,seq:1},{type:'tool/dispatch',callId:'one',eventSeq:0,seq:2},{type:'tool/call',callId:'two',name:'shell',args:{command:'y'},seq:3}]
 const f=await fixture({events}),observed=f.state.observe()
 expect(await observed.delivery.dispatchedCall(0)).toEqual({call:events[0],dispatch:events[2]})
 expect(await observed.delivery.dispatchedCall(3)).toBeUndefined()
 expect(f.reads).toEqual([0,2]);await f.state.close()
})

it('selects the latest own human rather than inherited, synthetic or non-human admissions',async()=>{
 const human={kind:'human' as const,authority:'request' as const,scope:'turn' as const,producer:'fixture'}
 const events:SessionEventView[]=[
  {type:'agent/input/admitted',version:1,inputId:'own',text:'own',delivery:'queue',intent:'user',provenance:human,seq:0},
  {type:'agent/input/admitted',version:1,inputId:'inherited',text:'other',delivery:'queue',intent:'user',provenance:{...human,originSessionId:'other'},seq:1},
  {type:'agent/input/admitted',version:1,inputId:'system',text:'system',delivery:'queue',intent:'system',seq:2},
 ]
 const f=await fixture({events}),observation=f.state.observe()
 expect(await observation.delivery.ownHuman()).toEqual(events[0]);expect(f.reads).toEqual([0]);await f.state.close()
})

it('publishes named original fold views without changing the schedule snapshot',async()=>{
 const f=await fixture({fold:()=>({appendValidated(){},finishRestore(){},snapshot(){return {schedule:'original'}},validateSnapshot(v){return !!v},views:{todo:{snapshot(){return {kind:'present',items:[]}},validateSnapshot(v){return !!v}}}})})
 const observation=f.state.observe()
 expect(observation.schedules).toMatchObject({kind:'available',snapshot:{schedule:'original'}})
 expect(observation.metadata.todo).toMatchObject({kind:'available',revision:3,snapshot:{kind:'present',items:[]}})
 expect(observation.metadata.goal).toMatchObject({kind:'unavailable',revision:3})
 await f.state.close()
})

for(const mode of ['changed','async','throw','falsey'] as const)it(`poisons the shared original fold when a named view is ${mode}`,async()=>{
 let failure=false
 const view={snapshot:()=>{if(failure&&mode==='throw')throw Error('original view failure');if(failure&&mode==='falsey')throw undefined;if(failure&&mode==='async')return Promise.resolve({kind:'absent'});return {kind:'absent'}},validateSnapshot:(_value:unknown)=>true}
 const f=await fixture({fold:()=>({appendValidated(){},finishRestore(){},snapshot(){return {schedule:'original'}},validateSnapshot(){return true},views:{todo:view}})})
 const old=f.state.observe()
 if(mode==='changed')view.validateSnapshot=()=>true
 else failure=true
 let error:unknown;try{f.state.observe()}catch(cause){error=cause}expect(error).toBeInstanceOf(TypeError)
 if(mode==='falsey')expect(Object.hasOwn(error as object,'cause')).toBe(true)
 expect(()=>f.state.observe()).toThrow()
 expect(()=>old.assertCurrent()).toThrow()
 expect(()=>old.delivery.activeGeneration()).toThrow()
 await f.state.close()
})

it('reports the original fold poison as terminal readiness failure',async()=>{
 let failure=false;const view={snapshot(){if(failure)throw false;return {kind:'absent'}},validateSnapshot(){return true}}
 const f=await fixture({fold:()=>({appendValidated(){},finishRestore(){},snapshot(){return {}},validateSnapshot(){return true},views:{todo:view}})})
 const domain=createManagedExecutionDomain(f.state.identity,f.owner,{}),errors:unknown[]=[],terminal:boolean[]=[]
 const off=subscribeManagedExecutionReadiness(domain,()=>{},(error,isTerminal)=>{errors.push(error);terminal.push(isTerminal)})
 failure=true;expect(()=>f.state.observe()).toThrow();await new Promise<void>(done=>setImmediate(done));await new Promise<void>(done=>setImmediate(done))
 expect(terminal).toEqual([true]);expect(errors[0]).toBeInstanceOf(TypeError);expect((errors[0] as Error).cause).toBe(false)
 off();await f.state.close()
})

it('hydrates the original own human admission through the revision-bound delivery observer',async()=>{
 const f=await fixture(),observation=f.state.observe()
 expect(await observation.delivery.ownHuman()).toEqual(f.events[0])
 expect(f.reads).toEqual([0]);expect(f.closed).toBe(1)
 expect(observation.delivery.activeGeneration()).toBeUndefined()
 await expect(observation.delivery.ownHuman.call({...observation.delivery})).rejects.toThrow('receiver')
 await f.state.close()
})

it('withholds the original delivery record until its exact cleanup succeeds',async()=>{
 let failing=true
 const f=await fixture({async close(){if(failing)throw Error('held delivery close')}}),observation=f.state.observe()
 await expect(observation.delivery.ownHuman()).rejects.toThrow('held delivery close')
 expect(f.reads).toEqual([0]);expect(()=>f.state.observe()).toThrow('cleanup unresolved')
 failing=false;await f.state.settleDependencies();expect(f.closed).toBe(1);await f.state.close()
})

it('refuses original delivery record publication after owner drift during hydration',async()=>{
 let enter!:()=>void,resume!:()=>void;const entered=new Promise<void>(r=>enter=r),held=new Promise<void>(r=>resume=r)
 const f=await fixture({async read(){enter();await held}}),observation=f.state.observe(),reading=observation.delivery.ownHuman()
 await entered;f.change();resume();await expect(reading).rejects.toThrow();expect(f.closed).toBe(1)
 await f.state.close()
})

it('invalidates a delivery observation on the original fence without a journal append',async()=>{
 const f=await fixture(),old=f.state.observe(),release=f.deliveryControl.port.revoke()
 expect(()=>old.delivery.activeGeneration()).toThrow('expired')
 expect(()=>old.assertCurrent()).toThrow('expired')
 const newer=f.state.observe();expect(newer.delivery.revision).not.toBe(old.delivery.revision)
 release();expect(()=>newer.assertCurrent()).toThrow('expired');await f.state.close()
})

it('checks the original live delivery fence even when a fresh observation still shows its generation',async()=>{
 const events:SessionEventView[]=[{type:'agent/input/admitted',version:1,inputId:'human',text:'x',delivery:'queue',intent:'user',provenance:{kind:'human',authority:'request',scope:'turn',producer:'fixture'},seq:0},{type:'agent/delivery-generation',version:1,op:'open',recipientSessionId:'inbox',generationId:'g',originInputSeq:0,seq:1}]
 const f=await fixture({events}),domain=createManagedExecutionDomain(f.state.identity,f.owner,{}),binding={recipientSessionId:'inbox',generationId:'g',sourceId:'exec',callSeq:0,delivery:'tool' as const}
 assertManagedExecDeliveryCurrent(domain,binding)
 expect(()=>assertManagedExecDeliveryCurrent(domain,{...binding,generationId:'foreign'})).toThrow()
 expect(()=>assertManagedExecDeliveryCurrent(domain,{...binding,recipientSessionId:'foreign'})).toThrow()
 let invoked=false;const forged=Object.defineProperty({...binding},'sourceId',{get(){invoked=true;return 'exec'}})
 expect(()=>assertManagedExecDeliveryCurrent(domain,forged)).toThrow();expect(invoked).toBe(false)
 const release=f.deliveryControl.port.revoke();expect(f.state.observe().delivery.activeGeneration()?.generationId).toBe('g')
 expect(()=>assertManagedExecDeliveryCurrent(domain,binding)).toThrow();expect(()=>assertManagedExecDeliveryCurrent({...domain},binding)).toThrow()
 release();expect(()=>assertManagedExecDeliveryCurrent(domain,binding)).toThrow();f.state.stopNewWork();expect(()=>assertManagedExecDeliveryCurrent(domain,binding)).toThrow()
 await f.state.close()
})

it('checks the same original live fence for a closed Code binding',async()=>{
 const events:SessionEventView[]=[{type:'agent/input/admitted',version:1,inputId:'human',text:'x',delivery:'queue',intent:'user',provenance:{kind:'human',authority:'request',scope:'turn',producer:'fixture'},seq:0},{type:'agent/delivery-generation',version:1,op:'open',recipientSessionId:'inbox',generationId:'g',originInputSeq:0,seq:1}]
 const f=await fixture({events}),domain=createManagedExecutionDomain(f.state.identity,f.owner,{}),binding={recipientSessionId:'inbox',generationId:'g',sourceId:'source',callSeq:0,cellId:'cell',delivery:'tool' as const}
 assertManagedCodeDeliveryCurrent(domain,binding);expect(()=>assertManagedCodeDeliveryCurrent({...domain},binding)).toThrow();expect(()=>assertManagedCodeDeliveryCurrent(domain,{...binding,recipientSessionId:'foreign'})).toThrow()
 const release=f.deliveryControl.port.revoke();expect(f.state.observe().delivery.activeGeneration()?.generationId).toBe('g');expect(()=>assertManagedCodeDeliveryCurrent(domain,binding)).toThrow();release();expect(()=>assertManagedCodeDeliveryCurrent(domain,binding)).toThrow();await f.state.close()
})

it('keeps nondurable guarded metadata captures single-use across their own mutation',async()=>{
 const session=createSession(),owner=createNondurableFactOwner(session),action=owner.beginAction();let current=true
 const stale=action.captureMetadata!({type:'goal/change',version:1,operation:'create',goal:{id:'g',revision:1,phase:'active',objective:'x'}},()=>current)
 current=false;expect(await stale.admit()).toMatchObject({kind:'not-issued',code:'FACT_PRECONDITION_STALE'});expect(session.events).toHaveLength(0)
 current=true;const fresh=action.captureMetadata!({type:'goal/change',version:1,operation:'create',goal:{id:'g',revision:1,phase:'active',objective:'x'}},()=>current)
 const result=await fresh.admit();expect(result.kind).toBe('memory-committed');current=false;expect(await fresh.reconcile()).toEqual(result);expect(session.events).toHaveLength(1);action.finish()
})

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

for(const end of ['ready','abort','Stop','falsey-close','unknown'] as const)it(`finite admission joins original active scope and rejects ${end} honestly`,async()=>{
 let release!:()=>void,entered!:()=>void;const held=new Promise<void>(r=>release=r),started=new Promise<void>(r=>entered=r);let fail=false
 const f=await fixture({async read(){entered();await held},async close(){if(fail)throw undefined}}),domain=createManagedExecutionDomain(f.state.identity,f.owner,{}),controller=new AbortController()
 expect(getManagedExecutionAdmissionWait(domain,f.action,controller.signal)).toBeUndefined()
 const reading=f.state.observe().inbox.admitted('done');await started
 const add=vi.spyOn(controller.signal,'addEventListener'),remove=vi.spyOn(controller.signal,'removeEventListener');const wait=getManagedExecutionAdmissionWait(domain,f.action,controller.signal);expect(wait).toBeInstanceOf(Promise);let advanced=false;const result=wait!.then(()=>{advanced=true;return {ok:true}},error=>({ok:false,error}))
 await Promise.resolve();expect(advanced).toBe(false)
 if(end==='abort')controller.abort('cancelled');if(end==='Stop')f.state.stopNewWork();if(end==='falsey-close')fail=true;if(end==='unknown')f.state.readinessChanged(true)
 release();const readResult=await reading.then(()=>true,()=>false);expect(readResult).toBe(end!=='Stop'&&end!=='falsey-close')
 expect((await result).ok).toBe(end==='ready');expect(advanced).toBe(end==='ready');expect(add).toHaveBeenCalledTimes(1);expect(remove).toHaveBeenCalledTimes(1)
 if(end==='ready')expect(getManagedExecutionAdmissionWait(domain,f.action,controller.signal)).toBeUndefined()
 if(end==='falsey-close'){expect(()=>getManagedExecutionAdmissionWait(domain,f.action,controller.signal)).toThrow();fail=false;await f.state.settleDependencies()}
 await f.state.close()
})

it('rechecks a second genuine busy epoch started by an earlier readiness listener',async()=>{
 let release1!:()=>void,release2!:()=>void,enter2!:()=>void,count=0
 const one=new Promise<void>(r=>release1=r),two=new Promise<void>(r=>release2=r),secondEntered=new Promise<void>(r=>enter2=r)
 const f=await fixture({async read(){if(++count===1)await one;else{enter2();await two}}}),domain=createManagedExecutionDomain(f.state.identity,f.owner,{}),observation=f.state.observe()
 let second:Promise<unknown>|undefined;const off=subscribeManagedExecutionReadiness(domain,()=>{if(!second)second=f.state.observe().inbox.admitted('done')})
 const first=observation.inbox.admitted('done'),wait=getManagedExecutionAdmissionWait(domain,f.action,f.action.signal)!;let ready=false;const done=wait.then(()=>{ready=true})
 release1();await first;await secondEntered;expect(ready).toBe(false);expect(()=>domain.assertCurrent()).toThrow('cleanup unresolved')
 release2();await second;await done;expect(ready).toBe(true);expect(count).toBe(2);off();await f.state.close()
})
it('subscribes while completion is already queued without losing the original wake',async()=>{
 let release!:()=>void;const held=new Promise<void>(r=>release=r),f=await fixture({async read(){await held}}),domain=createManagedExecutionDomain(f.state.identity,f.owner,{}),reading=f.state.observe().inbox.admitted('done')
 release();const wait=getManagedExecutionAdmissionWait(domain,f.action,f.action.signal);expect(wait).toBeInstanceOf(Promise);await reading;await wait;expect(getManagedExecutionAdmissionWait(domain,f.action,f.action.signal)).toBeUndefined();await f.state.close()
})
