import { types } from 'node:util'
import { restoreManagedConversation,installRestoredManagedConversation } from './restored-view.ts'
import { createExecutionMemberOwner } from './execution-members.ts'
import { captureWriterDependencies } from './writer-dependencies.ts'
import { factPrefixDigest } from '../serialization/fact-journal.ts'
import type { OriginalConversationRestorationSource } from '../conversation/restoration-input.ts'
import type { CapturedFactGroup } from './groups.ts'
import type { EncodedFactBatch,FactReceipt,FactOutcome,BatchKey } from './types.ts'
import type { ManagedExecutionIdentity,ManagedExecutionOwner,OriginalExecutionWriterBinding,OriginalWriterDependencyScope,OriginalExecutionCaptureHooks } from './execution-types.ts'

const owners=new WeakMap<ManagedExecutionIdentity,{owner:ManagedExecutionOwner;current():void}>()
export function isManagedExecutionOwner(identity:ManagedExecutionIdentity,owner:object):boolean{
  const original=owners.get(identity)
  if(!original||original.owner!==owner)return false
  try{original.current();return true}catch{return false}
}
/** The original managed constructor supplies a separate held writer binding.
 * A readonly restored candidate alone cannot construct or authenticate an owner. */
export async function restoreManagedExecutionState(source:OriginalConversationRestorationSource,binding:OriginalExecutionWriterBinding){
  if(!binding||types.isProxy(binding))throw new TypeError('Original held writer binding required')
  const tokenField=Object.getOwnPropertyDescriptor(binding,'token'),heldField=Object.getOwnPropertyDescriptor(binding,'assertHeld'),openField=Object.getOwnPropertyDescriptor(binding,'openDependencies')
  if(!tokenField||!('value'in tokenField)||!Object.isFrozen(tokenField.value)||!heldField||!('value'in heldField)||typeof heldField.value!=='function'||!openField||!('value'in openField)||typeof openField.value!=='function')throw new TypeError('Original held writer binding required')
  const token=tokenField.value as OriginalExecutionWriterBinding['token'],held=heldField.value.bind(binding) as ()=>void,open=openField.value.bind(binding) as OriginalExecutionWriterBinding['openDependencies']
  const assertHeld=()=>{if(Object.getOwnPropertyDescriptor(binding,'token')?.value!==token||Object.getOwnPropertyDescriptor(binding,'assertHeld')?.value!==heldField.value||Object.getOwnPropertyDescriptor(binding,'openDependencies')?.value!==openField.value)throw new TypeError('Held writer binding changed');held()}
  assertHeld()
  if(!token.sessionId||!token.incarnation)throw new TypeError('Original writer incarnation required')
  const candidateOwner=Object.freeze({}),candidate=await restoreManagedConversation(source,candidateOwner,token.sessionId)
  assertHeld()
  const original=installRestoredManagedConversation(candidate,candidateOwner),identity=Object.freeze({}) as ManagedExecutionIdentity,members=createExecutionMemberOwner(assertHeld),debt=new Set<OriginalWriterDependencyScope>()
  let stopped=false,ownerBound=false,closed=false,pendingWrite:object|undefined
  const assertNewWork=()=>{assertHeld();if(stopped||closed)throw Object.assign(new Error('FACT_CLOSED'),{code:'FACT_CLOSED'});if(pendingWrite)throw Object.assign(new Error('Original issued write needs reconciliation'),{code:'FACT_RECOVERY_REQUIRED'})}
  return {
    identity,
    get eventCount(){return original.eventCount},
    get prefix(){return original.prefix},
    get formatVersion(){return original.formatVersion},
    get header(){return original.header},
    bindOwner(owner:ManagedExecutionOwner){
      assertNewWork();if(ownerBound||!owner||types.isProxy(owner))throw new TypeError('Original execution owner already bound or unavailable')
      const methods=['ownsAction','beginAction','registerReceivedInputSource','drain'] as const,fields=methods.map(key=>Object.getOwnPropertyDescriptor(owner,key))
      if(fields.some(field=>!field||!('value'in field)||typeof field.value!=='function'))throw new TypeError('Original execution owner methods required')
      const current=()=>{assertHeld();for(let index=0;index<methods.length;index++)if(Object.getOwnPropertyDescriptor(owner,methods[index]!)?.value!==fields[index]!.value)throw new TypeError('Original execution owner changed')}
      ownerBound=true;owners.set(identity,{owner,current})
    },
    assertNewWork,
    stopNewWork(){stopped=true},
    prepare(){assertNewWork();return original.prepare()},
    async prepareWrite(groups:readonly CapturedFactGroup[]){
      // Only the original writer invokes this after its real authorization;
      // already-admitted/source-required work can drain after new-work Stop.
      assertHeld();if(closed)throw new TypeError('Original writer closed');if(pendingWrite)throw Object.assign(new Error('Original issued write needs reconciliation'),{code:'FACT_RECOVERY_REQUIRED'});if(debt.size)throw new TypeError('Writer dependency cleanup unresolved')
      const expected=original.prefix,scope=captureWriterDependencies(open(expected))
      debt.add(scope) // installed before the first asynchronous read/open
      const check=scope.assertCurrent.bind(scope),read=scope.readEvent.bind(scope),close=scope.close.bind(scope)
      let reading=true,prepared:Awaited<ReturnType<typeof original.prepareWrite>>|undefined,primary:unknown,failed=false
      const current=()=>{assertHeld();if(reading){check();if(original.prefix!==expected)throw new TypeError('Writer prefix changed during preparation')}}
      try{current();prepared=await original.prepareWrite(groups,read,current);current()}catch(error){failed=true;primary=error}
      try{await close();debt.delete(scope)}catch(cleanup){prepared?.discard();if(failed)throw new AggregateError([primary,cleanup],'Writer preparation and exact dependency cleanup failed');throw cleanup}finally{reading=false}
      if(failed)throw primary
      const staged=prepared!,operation=Object.freeze({});let installed=false,started=false,discarded=false,absent=false,issuedBatch:EncodedFactBatch|undefined,originalBatch:EncodedFactBatch|undefined,originalReceipt:FactReceipt|undefined
      const assertIssuable=()=>{assertHeld();if(discarded||absent||pendingWrite||issuedBatch||started||original.prefix!==expected)throw new TypeError('Writer prefix changed or original issuance already started')}
      return {events:staged.events,members:staged.members,assertIssuable,discardUnissued(){if(issuedBatch||started)throw new TypeError('Original issued write cannot be discarded');discarded=true;staged.discard()},beforeIssue(batch:EncodedFactBatch){
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
        for(const member of staged.members)members.installed(member.group,member.events,receipt)
        installed=true;pendingWrite=undefined
      }}
    },
    captureHooks(source:object,assertCaptureCurrent:()=>void):OriginalExecutionCaptureHooks{
      assertNewWork();assertCaptureCurrent()
      return Object.freeze({capture:<T extends import('./ports.ts').CapturedActionFact>(group:CapturedFactGroup,commands:T)=>members.capture(group,commands,source,assertCaptureCurrent),forward:members.forward})
    },
    acknowledge:members.acknowledge,
    releaseSource:members.releaseSource,
    async close(){
      stopped=true;if(closed)return
      if(pendingWrite)throw Object.assign(new Error('Original issued write needs reconciliation'),{code:'FACT_RECOVERY_REQUIRED'})
      const errors:unknown[]=[]
      for(const scope of debt)try{await scope.close();debt.delete(scope)}catch(error){errors.push(error)}
      if(errors.length)throw new AggregateError(errors,'Exact writer dependency cleanup unresolved')
      members.assertReleased()
      await original.close();members.close();closed=true;owners.delete(identity)
    }
  }
}
