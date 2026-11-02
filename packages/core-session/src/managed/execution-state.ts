import { types } from 'node:util'
import { restoreManagedConversation,installRestoredManagedConversation } from './restored-view.ts'
import { createExecutionMemberOwner,isExecutionMemberOf,isExecutionCaptureSource,readAcknowledgedExecutionMembers } from './execution-members.ts'
import { captureWriterDependencies } from './writer-dependencies.ts'
import { factPrefixDigest } from '../serialization/fact-journal.ts'
import type { OriginalConversationRestorationSource } from '../conversation/restoration-input.ts'
import type { CapturedFactGroup } from './groups.ts'
import type { EncodedFactBatch,FactReceipt,FactOutcome,BatchKey } from './types.ts'
import type { ManagedExecutionIdentity,ManagedExecutionOwner,ManagedExecutionDomain,OriginalExecutionWriterBinding,OriginalWriterDependencyScope,OriginalExecutionCaptureHooks,ExecutionObservation,PreparedExecutionRequest } from './execution-types.ts'
import {freezeJsonData,isStrictFactData} from './capture.ts'
import {captureOriginalRestorationSource} from './restoration-source.ts'
import {originalDeliveryObservation} from './delivery-control.ts'
import {subscribers} from '../events/state.ts'

const owners=new WeakMap<ManagedExecutionIdentity,{owner:ManagedExecutionOwner;sessionId:string;current():void;generations():readonly import('../conversation/generation.ts').GenerationActionState[];execSource(id:string):ReturnType<import('../conversation/delivery.ts').DeliveryState['source']>;assertExecIssue(event:import('../events/exec-delivery.ts').ExecDeliverySourceEvent):void;newWork?():void}>()
const readinessOwners=new WeakMap<object,{subscribe(listener:(epoch:number)=>void,onUnavailable?:(error:unknown,terminal:boolean)=>void):()=>void}>()
const observations=new WeakSet<object>()
export function isOriginalExecutionObservation(value:object):value is ExecutionObservation{return observations.has(value)}
const domains=new WeakMap<object,{identity:ManagedExecutionIdentity;owner:ManagedExecutionOwner;context:object;current():void}>()
/** Original subscriptions use the same store as explicit compatibility views.
 * A private execution key is never a Session or a durable admission port. */
export function publishManagedExecutionTransient(domain:ManagedExecutionDomain,source:object,event:Extract<import('../events/types.ts').SessionEvent,{type:'assistant/chunk'|'reasoning/chunk'|'model/activity'}>){if(!isManagedExecutionSource(domain,source))throw TypeError('Original transient source required');const {seq:_seq,...live}=event;subscribers.get(domain.identity)?.forEach(listener=>listener(live))}
/** Signals only original owner observability; this grants no observation or write. */
export function subscribeManagedExecutionReadiness(domain:ManagedExecutionDomain,listener:(epoch:number)=>void,onUnavailable?:(error:unknown,terminal:boolean)=>void):()=>void {
 const registered=domains.get(domain),owner=registered&&owners.get(registered.identity),readiness=registered&&readinessOwners.get(registered.identity)
 if(!registered||!owner||owner.owner!==registered.owner||!readiness||typeof listener!=='function'||types.isProxy(listener)||onUnavailable!==undefined&&(typeof onUnavailable!=='function'||types.isProxy(onUnavailable)))throw TypeError('Original readiness domain required')
 owner.current()
 return readiness.subscribe(listener,onUnavailable)
}
export function subscribeManagedExecution(domain:ManagedExecutionDomain,listener:(event:import('../events/types.ts').SessionEvent)=>void){domain.assertCurrent();if(!isManagedExecutionDomain(domain))throw TypeError('Original execution domain required');let set=subscribers.get(domain.identity);if(!set){set=new Set();subscribers.set(domain.identity,set)}set.add(listener);return()=>{set.delete(listener)}}
const sources=new WeakMap<object,{identity:ManagedExecutionIdentity;current():void}>()
/** Existing source lifetime only. Reading its original fold does not reopen
 * observation admission or authorize a fresh capture after retirement. */
export function readManagedSourceGenerations(identity:ManagedExecutionIdentity,source:import('./ports.ts').SettlementFacts<FactOutcome>){
 const original=owners.get(identity),registered=sources.get(source)
 if(!original||registered?.identity!==identity)throw TypeError('Original same-execution held source required')
 original.current();registered.current()
 const snapshot=freezeJsonData(original.generations())
 registered.current();original.current()
 return snapshot
}
/** A held settlement source may inspect only its execution's committed Exec binding after admission retires. */
export function readManagedSourceExecDelivery(identity:ManagedExecutionIdentity,source:import('./ports.ts').SettlementFacts<import('./ports.ts').ProducerFactOutcome>,sourceId:string){
 const original=owners.get(identity),registered=sources.get(source)
 if(!original||registered?.identity!==identity||typeof sourceId!=='string'||!sourceId)throw TypeError('Original same-execution held source required')
 original.current();registered.current();const result=freezeJsonData(structuredClone(original.execSource(sourceId)));registered.current();original.current();return result
}
const actions=new WeakMap<object,{identity:ManagedExecutionIdentity;current():void}>()
export function assertManagedActionCurrent(domain:ManagedExecutionDomain,action:object){const original=domains.get(domain),registered=actions.get(action);if(!original||registered?.identity!==original.identity)throw TypeError('Original same-domain action required');domain.assertCurrent();registered.current()}
/** Consult the original live fence; this check issues no fact or model permission. */
export function assertManagedExecDeliveryCurrent(domain:ManagedExecutionDomain,binding:Readonly<{recipientSessionId:string;generationId:string;sourceId:string;callSeq:number;delivery:'tool'|'parent'}>){
 const registered=domains.get(domain),owner=registered&&owners.get(registered.identity)
 if(!registered||!owner||owner.owner!==registered.owner||!binding||typeof binding!=='object'||types.isProxy(binding))throw TypeError('Original managed Exec delivery domain required')
 const keys=['recipientSessionId','generationId','sourceId','callSeq','delivery'] as const,fields=Object.getOwnPropertyDescriptors(binding)
 if(Reflect.ownKeys(fields).length!==keys.length||keys.some(key=>!fields[key]||!('value'in fields[key]!)))throw TypeError('Closed original Exec binding required')
 const recipient:unknown=fields.recipientSessionId!.value,generation:unknown=fields.generationId!.value,source:unknown=fields.sourceId!.value,call:unknown=fields.callSeq!.value,delivery:unknown=fields.delivery!.value
 if(recipient!==owner.sessionId||typeof generation!=='string'||!generation||typeof source!=='string'||!source||typeof call!=='number'||!Number.isSafeInteger(call)||call<0||delivery!=='tool'&&delivery!=='parent')throw TypeError('Closed original Exec binding required')
 domain.assertCurrent();owner.assertExecIssue({type:'agent/delivery-source',version:1,kind:'exec',sourceNamespace:'exec',recipientSessionId:recipient,generationId:generation,sourceId:source,callSeq:call,delivery});domain.assertCurrent()
}
export function createManagedExecutionDomain(identity:ManagedExecutionIdentity,owner:ManagedExecutionOwner,context:object,sessionId?:string):ManagedExecutionDomain{
 const original=owners.get(identity);if(!original||original.owner!==owner||!original.newWork||!context||typeof context!=='object'||types.isProxy(context)||sessionId!==undefined&&sessionId!==original.sessionId)throw TypeError('Original managed execution domain required');original.newWork()
 const domain=Object.freeze({identity,owner,context,sessionId:original.sessionId,assertCurrent(){if(this!==domain)throw TypeError('Original domain receiver required');original.newWork!()}}) as ManagedExecutionDomain
 domains.set(domain,{identity,owner,context,current:original.current});return domain
}
export function isManagedExecutionDomain(domain:object,context?:object){const original=domains.get(domain);if(!original||context!==undefined&&original.context!==context)return false;try{original.current();return true}catch{return false}}
export function isManagedExecutionSource(domain:ManagedExecutionDomain,source:object){const original=domains.get(domain),registered=sources.get(source);if(!original||registered?.identity!==original.identity)return false;try{original.current();registered.current();return true}catch{return false}}
export function readManagedAcknowledgedMembers(domain:ManagedExecutionDomain,capture:object,outcome:FactOutcome){const original=domains.get(domain);if(!original||!isExecutionMemberOf(capture,original.identity))throw TypeError('Original same-domain capture required');original.current();return readAcknowledgedExecutionMembers(capture,outcome)}
export function readManagedActionMembers(domain:ManagedExecutionDomain,action:object,capture:object,outcome:FactOutcome){const original=domains.get(domain);if(!original||!original.owner.ownsAction(action)||!isExecutionCaptureSource(capture,action))throw TypeError('Original same-action capture required');return readManagedAcknowledgedMembers(domain,capture,outcome)}
export function isManagedExecutionOwner(identity:ManagedExecutionIdentity,owner:object):boolean{
  const original=owners.get(identity)
  if(!original||original.owner!==owner)return false
  try{original.current();return true}catch{return false}
}
/** The original managed constructor supplies a separate held writer binding.
 * A readonly restored candidate alone cannot construct or authenticate an owner. */
export async function restoreManagedExecutionState(input:OriginalConversationRestorationSource,binding:OriginalExecutionWriterBinding,foldFactory?:import('./execution-types.ts').OriginalExecutionFoldFactory){
  const source=captureOriginalRestorationSource(input)
  let compatibility:ReturnType<typeof import('./view.ts').createManagedIndexedView>|undefined
  const liveEvents=new Map<number,WeakRef<import('./types.ts').SessionEventView>>()
  const readSource=source.readEvent.bind(source)
  const originalSource:OriginalConversationRestorationSource={get formatVersion(){return source.formatVersion},get header(){return source.header},get prefix(){return source.prefix},assertCurrent:source.assertCurrent.bind(source),consume:source.consume.bind(source),async readEvent(ordinal){const event=await readSource(ordinal);return compatibility?.view.events[ordinal]??liveEvents.get(ordinal)?.deref()??event},settle:source.settle.bind(source),close:source.close.bind(source),appendCommitted:source.appendCommitted.bind(source)}
  if(!binding||types.isProxy(binding))throw new TypeError('Original held writer binding required')
  const tokenField=Object.getOwnPropertyDescriptor(binding,'token'),heldField=Object.getOwnPropertyDescriptor(binding,'assertHeld'),openField=Object.getOwnPropertyDescriptor(binding,'openDependencies')
  if(!tokenField||!('value'in tokenField)||!Object.isFrozen(tokenField.value)||!heldField||!('value'in heldField)||typeof heldField.value!=='function'||!openField||!('value'in openField)||typeof openField.value!=='function')throw new TypeError('Original held writer binding required')
  const token=tokenField.value as OriginalExecutionWriterBinding['token'],held=heldField.value.bind(binding) as ()=>void,open=openField.value.bind(binding) as OriginalExecutionWriterBinding['openDependencies']
  const assertHeld=()=>{if(Object.getOwnPropertyDescriptor(binding,'token')?.value!==token||Object.getOwnPropertyDescriptor(binding,'assertHeld')?.value!==heldField.value||Object.getOwnPropertyDescriptor(binding,'openDependencies')?.value!==openField.value)throw new TypeError('Held writer binding changed');held()}
  assertHeld()
  if(!token.sessionId||!token.incarnation)throw new TypeError('Original writer incarnation required')
  const candidateOwner=Object.freeze({}),candidate=await restoreManagedConversation(originalSource,candidateOwner,token.sessionId,foldFactory)
  assertHeld()
  const original=installRestoredManagedConversation(candidate,candidateOwner),identity=Object.freeze({}) as ManagedExecutionIdentity,members=createExecutionMemberOwner(assertHeld,identity),debt=new Set<OriginalWriterDependencyScope>()
  let stopped=false,ownerBound=false,closed=false,pendingWrite:object|undefined
  let readinessWasReady=false,readinessEpoch=0,readinessQueued=false,ownerRecoveryBlocked=false
  let readinessFailure:{error:unknown;terminal:boolean}|undefined
  const readinessListeners=new Set<{listener:(epoch:number)=>void;onUnavailable?:(error:unknown,terminal:boolean)=>void;delivered:number}>()
  const markBusy=()=>{readinessWasReady=false;readinessEpoch++}
  const readinessState=():{kind:'busy'}|{kind:'ready'}|{kind:'failed';error:unknown}=>{
    if(stopped||closed)return {kind:'busy'}
    try{const owner=owners.get(identity);if(!owner?.newWork)throw TypeError('Original readiness unavailable');owner.current();if(pendingWrite||debt.size||ownerRecoveryBlocked)return {kind:'busy'};owner.newWork();observe();return {kind:'ready'}}catch(error){return {kind:'failed',error}}
  }
  const sameHeldOwner=()=>{try{const owner=owners.get(identity);if(!owner)return false;owner.current();return true}catch{return false}}
  const signalUnavailable=(error:unknown,terminal=false)=>{readinessFailure={error,terminal};markBusy();const items=[...readinessListeners];queueMicrotask(()=>{for(const item of items){if(!readinessListeners.has(item))continue;try{item.onUnavailable?.(error,terminal)}catch{/* Original settlement is independent of listeners. */}if(terminal)readinessListeners.delete(item)}})}
  // Defer an established edge only to prevent listener reentrancy into the
  // original writer. A queued delivery always reads the latest epoch; it is
  // not itself a readiness barrier or a retry.
  const queueReadiness=()=>{if(readinessQueued)return;readinessQueued=true;queueMicrotask(()=>{
    readinessQueued=false;if(!readinessWasReady)return
    const state=readinessState();if(state.kind==='busy'){markBusy();return}if(state.kind==='failed'){signalUnavailable(state.error,true);return}
    const epoch=readinessEpoch
    for(const item of [...readinessListeners]){
      if(epoch!==readinessEpoch)break
      const current=readinessState();if(current.kind==='busy'){markBusy();break}if(current.kind==='failed'){signalUnavailable(current.error,true);break}
      if(!readinessListeners.has(item)||item.delivered===epoch)continue;item.delivered=epoch;try{item.listener(epoch)}catch{/* Listener failure cannot affect source settlement. */}
    }
    if(readinessWasReady&&epoch!==readinessEpoch)queueReadiness()
  })}
  const signalReady=()=>{if(!readinessListeners.size||readinessWasReady)return;const state=readinessState();if(state.kind==='failed'){signalUnavailable(state.error,true);return}if(state.kind==='busy')return;readinessFailure=undefined;readinessWasReady=true;readinessEpoch++;queueReadiness()}
  readinessOwners.set(identity,{subscribe(listener,onUnavailable){assertHeld();const owner=owners.get(identity);if(stopped||closed||!owner)throw TypeError('Original readiness owner retired');owner.current();const item={listener,onUnavailable,delivered:-1};readinessListeners.add(item);try{if(!pendingWrite&&!debt.size&&!ownerRecoveryBlocked){if(!owner.newWork)throw TypeError('Original readiness unavailable');owner.newWork();observe();readinessFailure=undefined;if(!readinessWasReady){readinessWasReady=true;readinessEpoch++}queueReadiness()}else if(readinessFailure){const failure=readinessFailure;queueMicrotask(()=>{if(!readinessListeners.has(item))return;try{item.onUnavailable?.(failure.error,failure.terminal)}catch{}if(failure.terminal)readinessListeners.delete(item)})}}catch(error){readinessListeners.delete(item);throw error}let active=true;return()=>{if(active){active=false;readinessListeners.delete(item)}}}})
  let dependencyFailure:{cause:unknown}|undefined
  const settleDependencies=async()=>{const errors:unknown[]=[];for(const scope of debt)try{await scope.close();debt.delete(scope)}catch(error){errors.push(error)}if(errors.length){const error=new AggregateError(errors,'Exact writer dependency cleanup unresolved');signalUnavailable(error,!sameHeldOwner());throw error};dependencyFailure=undefined;signalReady()}
  const assertFresh=(reading?:OriginalWriterDependencyScope)=>{assertHeld();if(stopped||closed)throw Object.assign(new Error('FACT_CLOSED'),{code:'FACT_CLOSED'});if(pendingWrite)throw Object.assign(new Error('Original issued write needs reconciliation'),{code:'FACT_RECOVERY_REQUIRED'});if(debt.size>(reading&&debt.has(reading)?1:0))throw Object.assign(new Error('Original writer dependency cleanup unresolved',{cause:dependencyFailure?.cause}),{code:'FACT_RECOVERY_REQUIRED'})}
  const assertNewWork=()=>assertFresh()
  const requestActions=new WeakMap<object,()=>void>()
  function observe():ExecutionObservation{
    assertNewWork();const bound=owners.get(identity);if(!bound)throw TypeError('Original execution owner unbound');bound.current()
    const expected=original.prefix,delivery=originalDeliveryObservation(original.delivery),fence=delivery.revision();
    const current=(reading?:OriginalWriterDependencyScope)=>{assertFresh(reading);bound.current();if(original.prefix!==expected||delivery.revision()!==fence)throw TypeError('Original execution observation expired')}
    const floor=(value:number)=>{if(!Number.isSafeInteger(value)||value<0||value>expected.eventCount)throw RangeError('Invalid original inbox floor')}
    const inbox:ExecutionObservation['inbox']=Object.freeze({pending(fromSeq=0){if(this!==inbox)throw TypeError('Original inbox receiver required');current();floor(fromSeq);return original.intake.pending(fromSeq)},isPending(inputId:string,fromSeq=0){if(this!==inbox)throw TypeError('Original inbox receiver required');current();floor(fromSeq);return original.intake.isPending(inputId)&&(original.intake.admission(inputId)??-1)>=fromSeq},everAdmitted(inputId:string){if(this!==inbox)throw TypeError('Original inbox receiver required');current();return original.intake.everAdmitted(inputId)},isExecutable(inputId:string){if(this!==inbox)throw TypeError('Original inbox receiver required');current();return delivery.isExecutable(inputId)},
      lastCancellationSeq(inputId:string){if(this!==inbox)throw TypeError('Original inbox receiver required');current();return original.intake.lastCancellationSeq(inputId)},
      async admitted(inputId:string){
        if(this!==inbox)throw TypeError('Original inbox receiver required');current()
        const ordinal=original.intake.admission(inputId);if(ordinal===undefined)return undefined
        const scope=captureWriterDependencies(open(expected));debt.add(scope);markBusy()
        // Only this synchronous invocation's original registered reader is
        // exempt from its own debt check. Every public admission remains fenced.
        let record:Extract<import('./types.ts').SessionEventView,{type:'agent/input/admitted'}>|undefined,failed=false,primary:unknown
        try{
          current(scope);scope.assertCurrent();const event=await scope.readEvent(ordinal);current(scope);scope.assertCurrent()
          if(event.type!=='agent/input/admitted'||event.seq!==ordinal||event.inputId!==inputId)throw TypeError('Original indexed admission record required')
          record=freezeJsonData(event)
        }catch(error){failed=true;primary=error}
        try{await scope.close();debt.delete(scope)}catch(cleanup){const cause=failed?new AggregateError([primary,cleanup],'Admission read and exact dependency cleanup failed'):cleanup;dependencyFailure={cause};signalUnavailable(cause,!sameHeldOwner());throw cause}
        if(failed)throw primary
        current();signalReady();return record
      }
    })
    const readRecords=async(ordinals:readonly number[])=>{
      current();const scope=captureWriterDependencies(open(expected));debt.add(scope);markBusy()
      let records:import('./types.ts').SessionEventView[]|undefined,failed=false,primary:unknown
      try{records=[];for(const ordinal of ordinals){current(scope);scope.assertCurrent();const record=await scope.readEvent(ordinal);current(scope);scope.assertCurrent();if(record.seq!==ordinal)throw TypeError('Original indexed record required');records.push(freezeJsonData(structuredClone(record)))}}
      catch(error){failed=true;primary=error}
      try{await scope.close();debt.delete(scope)}catch(cleanup){const cause=failed?new AggregateError([primary,cleanup],'Delivery read and exact dependency cleanup failed'):cleanup;dependencyFailure={cause};signalUnavailable(cause,!sameHeldOwner());throw cause}
      if(failed)throw primary;current();signalReady();return records!
    }
    const deliveryView:ExecutionObservation['delivery']=Object.freeze({
      revision:fence,
      activeGeneration(){if(this!==deliveryView)throw TypeError('Original delivery receiver required');current();return freezeJsonData(structuredClone(original.delivery().activeGeneration()))},
      lastFenceSeq(){if(this!==deliveryView)throw TypeError('Original delivery receiver required');current();return original.delivery().lastFenceSeq()},
      source(namespace:string,id:string){if(this!==deliveryView)throw TypeError('Original delivery receiver required');current();return freezeJsonData(structuredClone(original.delivery().source(namespace,id)))},
      receipt(key:import('../events/delivery.ts').DeliveryKey){if(this!==deliveryView)throw TypeError('Original delivery receiver required');current();return freezeJsonData(structuredClone(original.delivery().receipt(key)))},
      execPending(){if(this!==deliveryView)throw TypeError('Original delivery receiver required');current();return freezeJsonData(structuredClone(original.delivery().execPending()))},
      codePending(){if(this!==deliveryView)throw TypeError('Original delivery receiver required');current();return freezeJsonData(structuredClone(original.delivery().codePending()))},
      async ownHuman(){if(this!==deliveryView)throw TypeError('Original delivery receiver required');current();const index=original.delivery(),ordinal=index.ownHumanAdmissionSeq(token.sessionId,original.header?.seedLength??0,index.lastFenceSeq()??-1);if(ordinal===undefined)return undefined;const [event]=await readRecords([ordinal]);if(event?.type!=='agent/input/admitted'||event.intent!=='user'||event.synthetic||event.provenance?.kind!=='human'||event.provenance.authority!=='request'||event.provenance.originSessionId!==undefined&&event.provenance.originSessionId!==token.sessionId)throw TypeError('Original human admission required');return event},
      async dispatchedCall(callSeq:number){if(this!==deliveryView)throw TypeError('Original delivery receiver required');current();if(!Number.isSafeInteger(callSeq)||callSeq<0||callSeq>=expected.eventCount)throw RangeError('Invalid original call ordinal');const match=original.delivery().dispatchForCall(callSeq);if(!match)return undefined;const [call,dispatch]=await readRecords([callSeq,match.seq]);if(call?.type!=='tool/call'||dispatch?.type!=='tool/dispatch'||call.callId!==match.callId||dispatch.callId!==call.callId||dispatch.eventSeq!==callSeq||match.seq<=callSeq)throw TypeError('Original dispatched call required');return Object.freeze({call,dispatch})},
    })
    const header=original.header===undefined?undefined:freezeJsonData(structuredClone(original.header))
    current();const folded=original.hasFold?original.foldSnapshot(expected):undefined;current()
    if(original.hasFold && (!folded || !isStrictFactData(folded)))throw TypeError('Synchronous original fold data required')
    const schedules:ExecutionObservation['schedules']=original.hasFold?Object.freeze({kind:'available' as const,revision:original.context.scheduleRevision(),snapshot:freezeJsonData(structuredClone(folded))}):Object.freeze({kind:'unavailable' as const,reason:'original-schedule-adapter-not-connected' as const,revision:original.context.scheduleRevision()})
    const metadata=Object.freeze(Object.fromEntries((['todo','goal'] as const).map(name=>{current();if(!original.hasFoldView(name))return [name,Object.freeze({kind:'unavailable' as const,reason:'original-adapter-not-connected' as const,revision:expected.eventCount})];const value=original.foldView(name,expected);current();return [name,Object.freeze({kind:'available' as const,revision:expected.eventCount,snapshot:freezeJsonData(structuredClone(value))})]}))) as ExecutionObservation['metadata']
    const observation:ExecutionObservation=Object.freeze({identity,eventCount:expected.eventCount,formatVersion:original.formatVersion,...header?{header}:{},prefix:Object.freeze({...expected}),projectionRevision:original.context.projectionRevision(),contextRevision:original.context.contextRevision(),scheduleRevision:original.context.scheduleRevision(),schedules,metadata,inbox,delivery:deliveryView,
      assertCurrent(){if(this!==observation)throw TypeError('Original observation receiver required');current()},
      plan(){if(this!==observation)throw TypeError('Original observation receiver required');current();return freezeJsonData(original.context.plan())},
      sandboxMode(fromSeq=0){if(this!==observation)throw TypeError('Original observation receiver required');current();return original.context.sandboxMode(fromSeq)},
      rewrite(){if(this!==observation)throw TypeError('Original observation receiver required');current();return freezeJsonData(original.context.rewrite())},
      budget(){if(this!==observation)throw TypeError('Original observation receiver required');current();return freezeJsonData(original.context.budget(token.sessionId))},
      recovery(binding?:Parameters<ExecutionObservation['recovery']>[0]){if(this!==observation)throw TypeError('Original observation receiver required');current();let captured:typeof binding;if(binding!==undefined){if(!binding||typeof binding!=='object'||types.isProxy(binding))throw TypeError('Original recovery binding scalars required');const model=Object.getOwnPropertyDescriptor(binding,'modelId'),protocol=Object.getOwnPropertyDescriptor(binding,'protocol'),provider=Object.getOwnPropertyDescriptor(binding,'providerId');if(!model||!('value'in model)||typeof model.value!=='string'||!protocol||!('value'in protocol)||typeof protocol.value!=='string'||provider&&(!('value'in provider)||provider.value!==undefined&&typeof provider.value!=='string'))throw TypeError('Original recovery binding scalars required');captured={modelId:model.value,protocol:protocol.value,...provider?.value!==undefined?{providerId:provider.value}:{}}}return freezeJsonData(original.context.recovery(token.sessionId,captured))},
      generations(){if(this!==observation)throw TypeError('Original observation receiver required');current();return freezeJsonData(original.generations())},
      semanticsStartSeq(){if(this!==observation)throw TypeError('Original observation receiver required');current();return original.executionScalars().semanticsStartSeq},
      hasToolCallId(id:string){if(this!==observation)throw TypeError('Original observation receiver required');current();return original.executionScalars().hasToolCallId(id)},
      softReduction(){if(this!==observation)throw TypeError('Original observation receiver required');current();return original.softReduction()},
    });current();observations.add(observation);return observation
  }
  async function prepareRequest(action:import('./ports.ts').ManagedAction<FactOutcome>):Promise<PreparedExecutionRequest>{
    const actionCurrent=requestActions.get(action);if(!actionCurrent)throw TypeError('Original request action required')
    actionCurrent();const observation=observe(),archive=await original.prepare();let active=true,settled=false,settling:Promise<void>|undefined
    const current=()=>{if(!active)throw TypeError('Original request preparation expired');actionCurrent();observation.assertCurrent();archive.assertCurrent()}
    try{current()}catch(primary){try{await archive.settle()}catch(cleanup){throw new AggregateError([primary,cleanup],'Request preparation and original lease cleanup failed')}throw primary}
    const request:PreparedExecutionRequest=Object.freeze({archive,observation,assertCurrent(){if(this!==request)throw TypeError('Original request receiver required');current()},settle(){if(this!==request)return Promise.reject(TypeError('Original request receiver required'));active=false;if(settled)return Promise.resolve();if(settling)return settling;const flight=archive.settle().then(()=>{settled=true});settling=flight;void flight.finally(()=>{if(settling===flight)settling=undefined}).catch(()=>{});return flight}})
    return request
  }
  return {
    identity,
    get eventCount(){return original.eventCount},
    get prefix(){return original.prefix},
    get formatVersion(){return original.formatVersion},
    get header(){return original.header},
    delivery:original.delivery,
    intake:original.intake,
    materialize(events:readonly import('./types.ts').SessionEventView[],owner:ManagedExecutionOwner){
      assertNewWork();if(!isManagedExecutionOwner(identity,owner))throw TypeError('Original execution owner required');if(compatibility)return compatibility
      const captured=events.map((event,index)=>{if(event.seq!==index)throw TypeError('Complete compatibility history required');return liveEvents.get(index)?.deref()??freezeJsonData(event)})
      compatibility=original.compatibility(captured,owner);const listeners=subscribers.get(identity);if(listeners)subscribers.set(compatibility.view,listeners);else{const set=new Set<(event:import('../events/types.ts').SessionEvent)=>void>();subscribers.set(identity,set);subscribers.set(compatibility.view,set)}liveEvents.clear();return compatibility
    },
    bindOwner(owner:ManagedExecutionOwner){
      assertNewWork();if(ownerBound||!owner||types.isProxy(owner))throw new TypeError('Original execution owner already bound or unavailable')
      const methods=['ownsAction','beginAction','registerReceivedInputSource','drain'] as const,fields=methods.map(key=>Object.getOwnPropertyDescriptor(owner,key))
      if(fields.some(field=>!field||!('value'in field)||typeof field.value!=='function'))throw new TypeError('Original execution owner methods required')
      const ready=Object.getOwnPropertyDescriptor(owner,'assertReady');if(ready&&(!('value'in ready)||typeof ready.value!=='function'||types.isProxy(ready.value)))throw TypeError('Original owner readiness required')
      const current=()=>{assertHeld();for(let index=0;index<methods.length;index++)if(Object.getOwnPropertyDescriptor(owner,methods[index]!)?.value!==fields[index]!.value)throw new TypeError('Original execution owner changed');if(ready&&Object.getOwnPropertyDescriptor(owner,'assertReady')?.value!==ready.value)throw TypeError('Original owner readiness changed')}
      ownerBound=true;owners.set(identity,{owner,sessionId:token.sessionId,current,generations(){current();if(pendingWrite)throw Object.assign(Error('Original issued write needs reconciliation'),{code:'FACT_RECOVERY_REQUIRED'});return original.generations()},execSource(id){current();if(pendingWrite)throw Object.assign(Error('Original issued write needs reconciliation'),{code:'FACT_RECOVERY_REQUIRED'});return original.delivery().source('exec',id)},assertExecIssue(event){current();assertNewWork();const index=original.delivery();if(index.activeGeneration()?.generationId!==event.generationId)throw Object.assign(Error('Delivery precondition is stale'),{code:'FACT_PRECONDITION_STALE'});originalDeliveryObservation(original.delivery).assertIssue([event])},...ready?{newWork(){current();assertNewWork();Reflect.apply(ready.value,owner,[])}}:{}})
    },
    assertNewWork,
    readinessChanged(recoverableBlocked=false){ownerRecoveryBlocked=recoverableBlocked;if(!readinessListeners.size)return;const state=readinessState();if(state.kind==='failed')signalUnavailable(state.error,true);else if(state.kind==='busy')markBusy();else signalReady()},
    readinessUnavailable(error:unknown,terminal=false){signalUnavailable(error,terminal)},
    settleDependencies,
    stopNewWork(){if(!stopped){stopped=true;signalUnavailable(Object.assign(new Error('FACT_CLOSED'),{code:'FACT_CLOSED'}),true)}},
    prepare(){assertNewWork();return original.prepare()},
    observe,prepareRequest,
    async prepareWrite(groups:readonly CapturedFactGroup[],rejectInvalidGroups=false){
      // Only the original writer invokes this after its real authorization;
      // already-admitted/source-required work can drain after new-work Stop.
      assertHeld();if(closed)throw new TypeError('Original writer closed');if(pendingWrite)throw Object.assign(new Error('Original issued write needs reconciliation'),{code:'FACT_RECOVERY_REQUIRED'});if(debt.size)throw new TypeError('Writer dependency cleanup unresolved')
      const expected=original.prefix,scope=captureWriterDependencies(open(expected))
      debt.add(scope);markBusy() // installed before the first asynchronous read/open
      const check=scope.assertCurrent.bind(scope),readOriginal=scope.readEvent.bind(scope),read=async(ordinal:number)=>{const event=await readOriginal(ordinal);return compatibility?.view.events[ordinal]??liveEvents.get(ordinal)?.deref()??event},close=scope.close.bind(scope)
      let reading=true,prepared:Awaited<ReturnType<typeof original.prepareWrite>>|undefined,primary:unknown,failed=false
      const current=()=>{assertHeld();if(reading){check();if(original.prefix!==expected)throw new TypeError('Writer prefix changed during preparation')}}
      try{current();prepared=await original.prepareWrite(groups,read,current,rejectInvalidGroups);current()}catch(error){failed=true;primary=error}
      try{await close();debt.delete(scope)}catch(cleanup){prepared?.discard();const cause=failed?new AggregateError([primary,cleanup],'Writer preparation and exact dependency cleanup failed'):cleanup;dependencyFailure={cause};signalUnavailable(cause,!sameHeldOwner());throw cause}finally{reading=false}
      if(failed)throw primary
      try{assertHeld()}catch(error){prepared?.discard();throw error}
      signalReady()
      const staged=prepared!,operation=Object.freeze({});let installed=false,started=false,discarded=false,absent=false,published=0,issuedBatch:EncodedFactBatch|undefined,originalBatch:EncodedFactBatch|undefined,originalReceipt:FactReceipt|undefined
      const assertIssuable=()=>{assertHeld();if(discarded||absent||pendingWrite||issuedBatch||started||original.prefix!==expected)throw new TypeError('Writer prefix changed or original issuance already started')}
      return {events:staged.events,members:staged.members,rejected:staged.rejected,assertIssuable,discardUnissued(){if(issuedBatch||started)throw new TypeError('Original issued write cannot be discarded');discarded=true;staged.discard()},beforeIssue(batch:EncodedFactBatch){
        assertIssuable()
        if(batch.key.firstSeq!==expected.eventCount||batch.key.count!==staged.events.length||batch.key.previousPrefixDigest!==expected.prefixDigest)throw new TypeError('Original writer batch scope required')
        issuedBatch=batch;pendingWrite=operation;markBusy()
      },settleAbsent(outcome:Extract<FactOutcome,{key:BatchKey}>&{readonly kind:'absent'}){
        assertHeld();if(started||absent||!issuedBatch||outcome.kind!=='absent'||outcome.key!==issuedBatch.key||pendingWrite!==operation)throw new TypeError('Original verified absence required')
        absent=true;staged.discard();pendingWrite=undefined;signalReady()
      },install(batch:EncodedFactBatch,receipt:FactReceipt){
        if(absent||!issuedBatch||issuedBatch!==batch)throw new TypeError('Original writer issuance required before installation')
        if(started&&(batch!==originalBatch||receipt!==originalReceipt))throw new TypeError('Original pending installation required')
        if(installed)return;assertHeld();if(!started&&original.prefix!==expected)throw new TypeError('Writer prefix changed before issuance')
        if(receipt.owner.sessionId!==token.sessionId||receipt.owner.incarnation!==token.incarnation||receipt.key!==batch.key||receipt.lastSeq!==batch.key.firstSeq+batch.key.count-1||receipt.prefixDigest!==factPrefixDigest(batch.key.previousPrefixDigest,batch.key.batchDigest))throw new TypeError('Original verified writer receipt required')
        started=true;originalBatch=batch;originalReceipt=receipt
        staged.install(batch,receipt)
        if(compatibility)compatibility.append(staged.events);else{for(const event of staged.events)liveEvents.set(event.seq!,new WeakRef(event));while(published<staged.events.length){const event=staged.events[published++]!;subscribers.get(identity)?.forEach(listener=>listener(event as import('../events/types.ts').SessionEvent))}}
        for(const member of staged.members)members.installed(member.group,member.events,receipt)
        installed=true;pendingWrite=undefined;signalReady()
      }}
    },
    captureHooks(source:object,assertCaptureCurrent:()=>void):OriginalExecutionCaptureHooks{
      assertNewWork();assertCaptureCurrent()
      const bound=owners.get(identity);bound?.current();if(bound?.owner.ownsAction(source)){
        const field=Object.getOwnPropertyDescriptor(source,'assertOpen');if(!field||!('value'in field)||typeof field.value!=='function'||types.isProxy(field.value))throw TypeError('Original action currentness required');const assert=field.value.bind(source) as ()=>void;
        const fields=Object.getOwnPropertyDescriptors(source),facts=fields.facts?.value as object|undefined,groups=facts?Object.entries(Object.getOwnPropertyDescriptors(facts)).map(([key,value])=>({key,value:value.value,fields:value.value&&typeof value.value==='object'?Object.getOwnPropertyDescriptors(value.value):undefined})):[];
        const current=()=>{bound.current();if(!bound.owner.ownsAction(source))throw TypeError('Original request action changed');for(const key of Reflect.ownKeys(fields)){const expected=Object.getOwnPropertyDescriptor(fields,key)!.value as PropertyDescriptor,actual=Object.getOwnPropertyDescriptor(source,key);if(!actual||!('value'in actual)||actual.value!==expected.value)throw TypeError('Original request action changed')}for(const group of groups){if(Object.getOwnPropertyDescriptor(facts!,group.key)?.value!==group.value)throw TypeError('Original action fact ports changed');for(const [key,expected]of Object.entries(group.fields??{}))if(Object.getOwnPropertyDescriptor(group.value,key)?.value!==expected.value)throw TypeError('Original action fact method changed')}assert()};
        requestActions.set(source,current);actions.set(source,{identity,current})
      }
      else if(bound){const field=Object.getOwnPropertyDescriptor(source,'assertHeld');if(field&&'value'in field&&typeof field.value==='function'&&!types.isProxy(field.value)){const assert=field.value.bind(source) as ()=>void;sources.set(source,{identity,current(){bound.current();if(Object.getOwnPropertyDescriptor(source,'assertHeld')?.value!==field.value)throw TypeError('Original source changed');assert()}})}}
      return Object.freeze({capture:<T extends import('./ports.ts').CapturedActionFact>(group:CapturedFactGroup,commands:T)=>members.capture(group,commands,source,assertCaptureCurrent),forward:members.forward})
    },
    acknowledge:members.acknowledge,
    releaseSource:members.releaseSource,
    async close(){
      if(!stopped){stopped=true;signalUnavailable(Object.assign(new Error('FACT_CLOSED'),{code:'FACT_CLOSED'}),true)}if(closed)return
      if(pendingWrite)throw Object.assign(new Error('Original issued write needs reconciliation'),{code:'FACT_RECOVERY_REQUIRED'})
      await settleDependencies()
      members.assertReleased()
      await original.close();members.close();liveEvents.clear();closed=true;readinessOwners.delete(identity);owners.delete(identity)
    }
  }
}
