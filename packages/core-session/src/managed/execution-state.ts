import { types } from 'node:util'
import { restoreManagedConversation,installRestoredManagedConversation } from './restored-view.ts'
import { createExecutionMemberOwner,isExecutionMemberOf,readAcknowledgedExecutionMembers } from './execution-members.ts'
import { captureWriterDependencies } from './writer-dependencies.ts'
import { factPrefixDigest } from '../serialization/fact-journal.ts'
import type { OriginalConversationRestorationSource } from '../conversation/restoration-input.ts'
import type { CapturedFactGroup } from './groups.ts'
import type { EncodedFactBatch,FactReceipt,FactOutcome,BatchKey } from './types.ts'
import type { ManagedExecutionIdentity,ManagedExecutionOwner,ManagedExecutionDomain,OriginalExecutionWriterBinding,OriginalWriterDependencyScope,OriginalExecutionCaptureHooks,ExecutionObservation,PreparedExecutionRequest } from './execution-types.ts'
import {freezeJsonData} from './capture.ts'
import {captureOriginalRestorationSource} from './restoration-source.ts'
import {originalDeliveryObservation} from './delivery-control.ts'

const owners=new WeakMap<ManagedExecutionIdentity,{owner:ManagedExecutionOwner;sessionId:string;current():void;newWork?():void}>()
const domains=new WeakMap<object,{identity:ManagedExecutionIdentity;owner:ManagedExecutionOwner;context:object;current():void}>()
const sources=new WeakMap<object,{identity:ManagedExecutionIdentity;current():void}>()
export function createManagedExecutionDomain(identity:ManagedExecutionIdentity,owner:ManagedExecutionOwner,context:object,sessionId?:string):ManagedExecutionDomain{
 const original=owners.get(identity);if(!original||original.owner!==owner||!original.newWork||!context||typeof context!=='object'||types.isProxy(context)||sessionId!==undefined&&sessionId!==original.sessionId)throw TypeError('Original managed execution domain required');original.newWork()
 const domain=Object.freeze({identity,owner,context,sessionId:original.sessionId,assertCurrent(){if(this!==domain)throw TypeError('Original domain receiver required');original.newWork!()}}) as ManagedExecutionDomain
 domains.set(domain,{identity,owner,context,current:original.current});return domain
}
export function isManagedExecutionDomain(domain:object,context?:object){const original=domains.get(domain);if(!original||context!==undefined&&original.context!==context)return false;try{original.current();return true}catch{return false}}
export function isManagedExecutionSource(domain:ManagedExecutionDomain,source:object){const original=domains.get(domain),registered=sources.get(source);if(!original||registered?.identity!==original.identity)return false;try{original.current();registered.current();return true}catch{return false}}
export function readManagedAcknowledgedMembers(domain:ManagedExecutionDomain,capture:object,outcome:FactOutcome){const original=domains.get(domain);if(!original||!isExecutionMemberOf(capture,original.identity))throw TypeError('Original same-domain capture required');original.current();return readAcknowledgedExecutionMembers(capture,outcome)}
export function isManagedExecutionOwner(identity:ManagedExecutionIdentity,owner:object):boolean{
  const original=owners.get(identity)
  if(!original||original.owner!==owner)return false
  try{original.current();return true}catch{return false}
}
/** The original managed constructor supplies a separate held writer binding.
 * A readonly restored candidate alone cannot construct or authenticate an owner. */
export async function restoreManagedExecutionState(input:OriginalConversationRestorationSource,binding:OriginalExecutionWriterBinding){
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
  const candidateOwner=Object.freeze({}),candidate=await restoreManagedConversation(originalSource,candidateOwner,token.sessionId)
  assertHeld()
  const original=installRestoredManagedConversation(candidate,candidateOwner),identity=Object.freeze({}) as ManagedExecutionIdentity,members=createExecutionMemberOwner(assertHeld,identity),debt=new Set<OriginalWriterDependencyScope>()
  let stopped=false,ownerBound=false,closed=false,pendingWrite:object|undefined
  let dependencyFailure:{cause:unknown}|undefined
  const settleDependencies=async()=>{const errors:unknown[]=[];for(const scope of debt)try{await scope.close();debt.delete(scope)}catch(error){errors.push(error)}if(errors.length)throw new AggregateError(errors,'Exact writer dependency cleanup unresolved');dependencyFailure=undefined}
  const assertNewWork=()=>{assertHeld();if(stopped||closed)throw Object.assign(new Error('FACT_CLOSED'),{code:'FACT_CLOSED'});if(pendingWrite)throw Object.assign(new Error('Original issued write needs reconciliation'),{code:'FACT_RECOVERY_REQUIRED'});if(debt.size)throw Object.assign(new Error('Original writer dependency cleanup unresolved',{cause:dependencyFailure?.cause}),{code:'FACT_RECOVERY_REQUIRED'})}
  const requestActions=new WeakMap<object,()=>void>()
  function observe():ExecutionObservation{
    assertNewWork();const bound=owners.get(identity);if(!bound)throw TypeError('Original execution owner unbound');bound.current()
    const expected=original.prefix,delivery=originalDeliveryObservation(original.delivery),fence=delivery.revision();
    const current=()=>{assertNewWork();bound.current();if(original.prefix!==expected||delivery.revision()!==fence)throw TypeError('Original execution observation expired')}
    const floor=(value:number)=>{if(!Number.isSafeInteger(value)||value<0||value>expected.eventCount)throw RangeError('Invalid original inbox floor')}
    const inbox:ExecutionObservation['inbox']=Object.freeze({pending(fromSeq=0){if(this!==inbox)throw TypeError('Original inbox receiver required');current();floor(fromSeq);return original.intake.pending(fromSeq)},isPending(inputId:string,fromSeq=0){if(this!==inbox)throw TypeError('Original inbox receiver required');current();floor(fromSeq);return original.intake.isPending(inputId)&&(original.intake.admission(inputId)??-1)>=fromSeq},everAdmitted(inputId:string){if(this!==inbox)throw TypeError('Original inbox receiver required');current();return original.intake.everAdmitted(inputId)},isExecutable(inputId:string){if(this!==inbox)throw TypeError('Original inbox receiver required');current();return delivery.isExecutable(inputId)}})
    const header=original.header===undefined?undefined:freezeJsonData(structuredClone(original.header))
    const observation:ExecutionObservation=Object.freeze({identity,eventCount:expected.eventCount,formatVersion:original.formatVersion,...header?{header}:{},prefix:Object.freeze({...expected}),projectionRevision:original.context.projectionRevision(),contextRevision:original.context.contextRevision(),scheduleRevision:original.context.scheduleRevision(),schedules:Object.freeze({kind:'unavailable' as const,reason:'original-schedule-adapter-not-connected' as const,revision:original.context.scheduleRevision()}),inbox,
      assertCurrent(){if(this!==observation)throw TypeError('Original observation receiver required');current()},
      plan(){if(this!==observation)throw TypeError('Original observation receiver required');current();return freezeJsonData(original.context.plan())},
      sandboxMode(fromSeq=0){if(this!==observation)throw TypeError('Original observation receiver required');current();return original.context.sandboxMode(fromSeq)},
      rewrite(){if(this!==observation)throw TypeError('Original observation receiver required');current();return freezeJsonData(original.context.rewrite())},
      budget(){if(this!==observation)throw TypeError('Original observation receiver required');current();return freezeJsonData(original.context.budget(token.sessionId))},
      recovery(binding?:Parameters<ExecutionObservation['recovery']>[0]){if(this!==observation)throw TypeError('Original observation receiver required');current();let captured:typeof binding;if(binding!==undefined){if(!binding||typeof binding!=='object'||types.isProxy(binding))throw TypeError('Original recovery binding scalars required');const model=Object.getOwnPropertyDescriptor(binding,'modelId'),protocol=Object.getOwnPropertyDescriptor(binding,'protocol'),provider=Object.getOwnPropertyDescriptor(binding,'providerId');if(!model||!('value'in model)||typeof model.value!=='string'||!protocol||!('value'in protocol)||typeof protocol.value!=='string'||provider&&(!('value'in provider)||provider.value!==undefined&&typeof provider.value!=='string'))throw TypeError('Original recovery binding scalars required');captured={modelId:model.value,protocol:protocol.value,...provider?.value!==undefined?{providerId:provider.value}:{}}}return freezeJsonData(original.context.recovery(token.sessionId,captured))},
      generations(){if(this!==observation)throw TypeError('Original observation receiver required');current();return freezeJsonData(original.generations())},
    });current();return observation
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
      compatibility=original.compatibility(captured,owner);liveEvents.clear();return compatibility
    },
    bindOwner(owner:ManagedExecutionOwner){
      assertNewWork();if(ownerBound||!owner||types.isProxy(owner))throw new TypeError('Original execution owner already bound or unavailable')
      const methods=['ownsAction','beginAction','registerReceivedInputSource','drain'] as const,fields=methods.map(key=>Object.getOwnPropertyDescriptor(owner,key))
      if(fields.some(field=>!field||!('value'in field)||typeof field.value!=='function'))throw new TypeError('Original execution owner methods required')
      const ready=Object.getOwnPropertyDescriptor(owner,'assertReady');if(ready&&(!('value'in ready)||typeof ready.value!=='function'||types.isProxy(ready.value)))throw TypeError('Original owner readiness required')
      const current=()=>{assertHeld();for(let index=0;index<methods.length;index++)if(Object.getOwnPropertyDescriptor(owner,methods[index]!)?.value!==fields[index]!.value)throw new TypeError('Original execution owner changed');if(ready&&Object.getOwnPropertyDescriptor(owner,'assertReady')?.value!==ready.value)throw TypeError('Original owner readiness changed')}
      ownerBound=true;owners.set(identity,{owner,sessionId:token.sessionId,current,...ready?{newWork(){current();assertNewWork();Reflect.apply(ready.value,owner,[])}}:{}})
    },
    assertNewWork,
    settleDependencies,
    stopNewWork(){stopped=true},
    prepare(){assertNewWork();return original.prepare()},
    observe,prepareRequest,
    async prepareWrite(groups:readonly CapturedFactGroup[],rejectInvalidGroups=false){
      // Only the original writer invokes this after its real authorization;
      // already-admitted/source-required work can drain after new-work Stop.
      assertHeld();if(closed)throw new TypeError('Original writer closed');if(pendingWrite)throw Object.assign(new Error('Original issued write needs reconciliation'),{code:'FACT_RECOVERY_REQUIRED'});if(debt.size)throw new TypeError('Writer dependency cleanup unresolved')
      const expected=original.prefix,scope=captureWriterDependencies(open(expected))
      debt.add(scope) // installed before the first asynchronous read/open
      const check=scope.assertCurrent.bind(scope),readOriginal=scope.readEvent.bind(scope),read=async(ordinal:number)=>{const event=await readOriginal(ordinal);return compatibility?.view.events[ordinal]??liveEvents.get(ordinal)?.deref()??event},close=scope.close.bind(scope)
      let reading=true,prepared:Awaited<ReturnType<typeof original.prepareWrite>>|undefined,primary:unknown,failed=false
      const current=()=>{assertHeld();if(reading){check();if(original.prefix!==expected)throw new TypeError('Writer prefix changed during preparation')}}
      try{current();prepared=await original.prepareWrite(groups,read,current,rejectInvalidGroups);current()}catch(error){failed=true;primary=error}
      try{await close();debt.delete(scope)}catch(cleanup){prepared?.discard();const cause=failed?new AggregateError([primary,cleanup],'Writer preparation and exact dependency cleanup failed'):cleanup;dependencyFailure={cause};throw cause}finally{reading=false}
      if(failed)throw primary
      try{assertHeld()}catch(error){prepared?.discard();throw error}
      const staged=prepared!,operation=Object.freeze({});let installed=false,started=false,discarded=false,absent=false,issuedBatch:EncodedFactBatch|undefined,originalBatch:EncodedFactBatch|undefined,originalReceipt:FactReceipt|undefined
      const assertIssuable=()=>{assertHeld();if(discarded||absent||pendingWrite||issuedBatch||started||original.prefix!==expected)throw new TypeError('Writer prefix changed or original issuance already started')}
      return {events:staged.events,members:staged.members,rejected:staged.rejected,assertIssuable,discardUnissued(){if(issuedBatch||started)throw new TypeError('Original issued write cannot be discarded');discarded=true;staged.discard()},beforeIssue(batch:EncodedFactBatch){
        assertIssuable()
        if(batch.key.firstSeq!==expected.eventCount||batch.key.count!==staged.events.length||batch.key.previousPrefixDigest!==expected.prefixDigest)throw new TypeError('Original writer batch scope required')
        issuedBatch=batch;pendingWrite=operation
      },settleAbsent(outcome:Extract<FactOutcome,{key:BatchKey}>&{readonly kind:'absent'}){
        assertHeld();if(started||absent||!issuedBatch||outcome.kind!=='absent'||outcome.key!==issuedBatch.key||pendingWrite!==operation)throw new TypeError('Original verified absence required')
        absent=true;staged.discard();pendingWrite=undefined
      },install(batch:EncodedFactBatch,receipt:FactReceipt){
        if(absent||!issuedBatch||issuedBatch!==batch)throw new TypeError('Original writer issuance required before installation')
        if(started&&(batch!==originalBatch||receipt!==originalReceipt))throw new TypeError('Original pending installation required')
        if(installed)return;assertHeld();if(!started&&original.prefix!==expected)throw new TypeError('Writer prefix changed before issuance')
        if(receipt.owner.sessionId!==token.sessionId||receipt.owner.incarnation!==token.incarnation||receipt.key!==batch.key||receipt.lastSeq!==batch.key.firstSeq+batch.key.count-1||receipt.prefixDigest!==factPrefixDigest(batch.key.previousPrefixDigest,batch.key.batchDigest))throw new TypeError('Original verified writer receipt required')
        started=true;originalBatch=batch;originalReceipt=receipt
        staged.install(batch,receipt)
        if(compatibility)compatibility.append(staged.events);else for(const event of staged.events)liveEvents.set(event.seq!,new WeakRef(event))
        for(const member of staged.members)members.installed(member.group,member.events,receipt)
        installed=true;pendingWrite=undefined
      }}
    },
    captureHooks(source:object,assertCaptureCurrent:()=>void):OriginalExecutionCaptureHooks{
      assertNewWork();assertCaptureCurrent()
      const bound=owners.get(identity);bound?.current();if(bound?.owner.ownsAction(source)){
        const field=Object.getOwnPropertyDescriptor(source,'assertOpen');if(!field||!('value'in field)||typeof field.value!=='function'||types.isProxy(field.value))throw TypeError('Original action currentness required');const assert=field.value.bind(source) as ()=>void;
        requestActions.set(source,()=>{bound.current();if(!bound.owner.ownsAction(source)||Object.getOwnPropertyDescriptor(source,'assertOpen')?.value!==field.value)throw TypeError('Original request action changed');assert()})
      }
      else if(bound){const field=Object.getOwnPropertyDescriptor(source,'assertHeld');if(field&&'value'in field&&typeof field.value==='function'&&!types.isProxy(field.value)){const assert=field.value.bind(source) as ()=>void;sources.set(source,{identity,current(){bound.current();if(Object.getOwnPropertyDescriptor(source,'assertHeld')?.value!==field.value)throw TypeError('Original source changed');assert()}})}}
      return Object.freeze({capture:<T extends import('./ports.ts').CapturedActionFact>(group:CapturedFactGroup,commands:T)=>members.capture(group,commands,source,assertCaptureCurrent),forward:members.forward})
    },
    acknowledge:members.acknowledge,
    releaseSource:members.releaseSource,
    async close(){
      stopped=true;if(closed)return
      if(pendingWrite)throw Object.assign(new Error('Original issued write needs reconciliation'),{code:'FACT_RECOVERY_REQUIRED'})
      await settleDependencies()
      members.assertReleased()
      await original.close();members.close();liveEvents.clear();closed=true;owners.delete(identity)
    }
  }
}
