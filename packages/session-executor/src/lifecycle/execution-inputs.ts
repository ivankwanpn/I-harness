import { createHash } from 'node:crypto'
import { randomUUID } from 'node:crypto'
import { canonicalJsonData, committedFactSeqs, deliveryInputId,FactRecoveryRequiredError, isStrictFactData, SYSTEM_INPUT_PLUGIN,
  type AdmittedInput, type PendingInput, type SessionEvent, type InputFacts, type ProducerFactOutcome, type CapturedSettlementFact } from '@i-harness/core-session'
import { isManagedExecutionOwner,isManagedExecutionDomain,assertManagedExecDeliveryCurrent,type ManagedExecutionDomain } from '@i-harness/core-session/internal/execution'
import type { ManagedExecutionAttachment } from '../../../session-persistence/src/execution-internal.ts'
import { copyConversationData } from '../../../core-session/src/conversation/render.ts'
type InputEvent = Extract<SessionEvent, { type: 'agent/input/admitted' | 'agent/input/cancelled' }>
const owners = new WeakMap<object, ReturnType<typeof createExecutionInputs>>()
const privateRecipients=new WeakMap<object,{execution:ManagedExecutionAttachment;domain:ManagedExecutionDomain}>()
export interface PrivateExecRecipient {
 prepareExecLaunch(input:{sessionId:string;callId:string;callSeq:number;sourceId:string}):Promise<PrivateExecPreparation>
 reconcileExecCandidates():Promise<void>
 requestClose(reason:'user-stop'|'rewind'):{fenceId:string;settled:Promise<readonly number[]>}
 settle():Promise<void>
 revoke():void
}
type PrivateExecPreparation=Extract<import('@i-harness/core-session').DeliveryLaunchPreparation,{kind:'unavailable'}>|(Extract<import('@i-harness/core-session').DeliveryLaunchPreparation,{kind:'bound'}>&{isCurrent():boolean})
export function isOriginalPrivateExecRecipient(value:object,execution:ManagedExecutionAttachment,domain:ManagedExecutionDomain){const original=privateRecipients.get(value);return !!original&&original.execution===execution&&original.domain===domain}
export function receivedExecutionInputsFor(execution: ManagedExecutionAttachment) {
  if (!isManagedExecutionOwner(execution.identity, execution.owner)) throw new TypeError('Original execution owner required')
  let inputs = owners.get(execution.owner)
  if (!inputs) { inputs = createExecutionInputs(execution); owners.set(execution.owner, inputs) }
  return inputs
}
function createExecutionInputs(execution: ManagedExecutionAttachment) {
  let delivery:ReturnType<typeof createExecDelivery>|undefined,deliveryDomain:ManagedExecutionDomain|undefined
  const pending = new Map<string | symbol, { fingerprint?: string; capture: CapturedSettlementFact<ProducerFactOutcome>; invoked: boolean }>()
  const settle = async (key: string | symbol, record: typeof pending extends Map<unknown, infer V> ? V : never) => {
    let outcome = record.invoked ? await record.capture.observe() : await record.capture.admit()
    record.invoked = true
    if (outcome.kind === 'unknown' || outcome.kind === 'recovery-required' || outcome.kind === 'not-issued' && outcome.code === 'FACT_RECOVERY_REQUIRED') outcome = await record.capture.reconcile()
    if (outcome.kind === 'committed' || outcome.kind === 'memory-committed') pending.delete(key)
    return outcome
  }
  const source = execution.owner.registerReceivedInputSource(async () => {
    const failures: unknown[] = []
    try { await delivery?.settle() } catch(cause) { failures.push(cause) }
    for (const [key, record] of pending) try { committedFactSeqs(await settle(key, record)) } catch (cause) { failures.push(cause) }
    if (failures.length) throw Object.assign(new FactRecoveryRequiredError(),{cause:new AggregateError(failures)})
  })
  function createExecDelivery(domain:ManagedExecutionDomain){
    if(!isManagedExecutionDomain(domain)||domain.identity!==execution.identity||domain.owner!==execution.owner)throw TypeError('Original recipient domain required')
    let retired=false,opening:CapturedSettlementFact<ProducerFactOutcome>|undefined
    const closes=new Map<string,CapturedSettlementFact<ProducerFactOutcome>>()
    const admissions=new Map<string,CapturedSettlementFact<ProducerFactOutcome>>()
    const attempts=new WeakSet<object>(),everIssued=new WeakSet<object>()
    const flights=new WeakMap<object,Promise<readonly number[]|undefined>>()
    const settleCapture=(fact:CapturedSettlementFact<ProducerFactOutcome>)=>{
      const prior=flights.get(fact);if(prior)return prior
      const flight=(async()=>{let outcome=attempts.has(fact)?await fact.observe():await fact.admit();attempts.add(fact);if(outcome.kind!=='not-issued')everIssued.add(fact)
        if(outcome.kind==='unknown'||outcome.kind==='recovery-required'||outcome.kind==='not-issued'&&outcome.code==='FACT_RECOVERY_REQUIRED')outcome=await fact.reconcile()
        if(outcome.kind!=='not-issued')everIssued.add(fact)
        if(!everIssued.has(fact)&&outcome.kind==='not-issued'&&outcome.code==='FACT_PRECONDITION_STALE')return undefined
        return committedFactSeqs(outcome)})()
      flights.set(fact,flight);void flight.then(()=>flights.delete(fact),()=>flights.delete(fact));return flight
    }
    const current=()=>{domain.assertCurrent();if(retired)throw Error('Original recipient retired')}
    const adapter={
      async prepareExecLaunch(input:{sessionId:string;callId:string;callSeq:number;sourceId:string}):Promise<PrivateExecPreparation>{
        current();if(input.sessionId!==domain.sessionId)throw TypeError('Original recipient identity required')
        if(opening){const pending=opening;if(!await settleCapture(pending))throw new FactRecoveryRequiredError();if(opening===pending)opening=undefined;current()}
        let observed=execution.observe(),member=await observed.delivery.dispatchedCall(input.callSeq)
        if(!member||!['shell','bash','pwsh'].includes(member.call.name)||member.call.callId!==input.callId)return {kind:'unavailable' as const,reason:'uncertified-call' as const}
        observed=execution.observe();if(observed.delivery.source('exec',input.sourceId))throw Error('Original Exec source already exists')
        let generation=observed.delivery.activeGeneration()
        if(!generation){const human=await observed.delivery.ownHuman();observed.assertCurrent();if(!human){if((observed.delivery.lastFenceSeq()??-1)>=0)throw new FactRecoveryRequiredError();return {kind:'unavailable' as const,reason:'no-own-human-origin' as const}}
          if(opening){const pending=opening;if(!await settleCapture(pending))throw new FactRecoveryRequiredError();if(opening===pending)opening=undefined;return adapter.prepareExecLaunch(input)}
          const generationId=randomUUID(),capturedObservation=observed
          opening=source.captureDeliveryOpen({type:'agent/delivery-generation',version:1,op:'open',recipientSessionId:domain.sessionId,generationId,originInputSeq:human.seq!},()=>{try{current();capturedObservation.assertCurrent();return true}catch{return false}})
          if(!await settleCapture(opening))throw new FactRecoveryRequiredError();opening=undefined;current();generation=execution.observe().delivery.activeGeneration()
        }
        if(!generation)throw new FactRecoveryRequiredError()
        const binding={recipientSessionId:domain.sessionId,generationId:generation.generationId,sourceNamespace:'exec' as const,sourceId:input.sourceId,callSeq:input.callSeq}
        const isCurrent=()=>{try{current();assertManagedExecDeliveryCurrent(domain,{recipientSessionId:binding.recipientSessionId,generationId:binding.generationId,sourceId:binding.sourceId,callSeq:binding.callSeq,delivery:'tool'});return true}catch{return false}}
        if(!isCurrent())throw new FactRecoveryRequiredError()
        return {kind:'bound' as const,binding,isCurrent}
      },
      requestClose(reason:'user-stop'|'rewind'){
        current();const fenceId=randomUUID(),fact=source.captureDeliveryClose({type:'agent/delivery-generation',version:1,op:'close',recipientSessionId:domain.sessionId,fenceId,reason});closes.set(fenceId,fact)
        const settled=settleCapture(fact).then(seqs=>{if(!seqs)throw new FactRecoveryRequiredError();return seqs});void settled.catch(()=>{});return {fenceId,settled}
      },
      async reconcileExecCandidates(){
        await adapter.settle();current();const candidates=execution.observe().delivery.execPending(),failures:unknown[]=[]
        for(const candidate of candidates)try{
          const binding=candidate.source,terminal=candidate.terminal
          if(binding.recipientSessionId!==domain.sessionId||!('dependency'in terminal)||terminal.dependency.retention.kind!=='artifact')throw new FactRecoveryRequiredError()
          const key={kind:'exec' as const,recipientSessionId:domain.sessionId,sourceNamespace:'exec' as const,sourceId:binding.sourceId,resultRevision:terminal.dependency.retention.ref.revision},inputId=deliveryInputId(key)
          if(execution.observe().delivery.receipt(key))continue
          let fact=admissions.get(inputId)
          if(!fact){const metadata={instanceId:terminal.instanceId,execution:terminal.execution,exitCode:terminal.exitCode,timedOut:terminal.timedOut,frames:terminal.dependency},text=`<exec_result>\n${JSON.stringify(metadata)}\nRetained frame reference only. Read through the current authorized result-read tools; reads may be unavailable.\n</exec_result>`
            const eligible=()=>{try{current();assertManagedExecDeliveryCurrent(domain,{recipientSessionId:domain.sessionId,generationId:binding.generationId,sourceId:binding.sourceId,callSeq:binding.callSeq,delivery:binding.delivery});return execution.observe().delivery.execPending().some(value=>value.source.seq===binding.seq&&value.terminal.seq===terminal.seq)}catch{return false}}
            fact=source.captureDeliveryAdmission({type:'agent/delivery-received',version:1,key,sourceSeq:binding.seq!,terminalSeq:terminal.seq!,inputId},{type:'agent/input/admitted',version:1,inputId,text,delivery:'steer',intent:'system',provenance:{kind:'child-report',authority:'observation',scope:'turn',producer:'session.delivery.exec'},synthetic:{description:`Exec ${binding.sourceId} ${terminal.execution.outcome}`,scope:'turn',display:{kind:'task',title:`Exec ${terminal.execution.outcome}`,body:text}}},eligible);admissions.set(inputId,fact)
          }
          if(!await settleCapture(fact))throw new FactRecoveryRequiredError();admissions.delete(inputId)
        }catch(cause){failures.push(cause)}
        if(failures.length)throw Object.assign(new FactRecoveryRequiredError(),{cause:new AggregateError(failures,'Original Exec recipient requires recovery')})
      },
      async settle(){if(opening){await settleCapture(opening);opening=undefined}for(const [key,fact] of closes){await settleCapture(fact);closes.delete(key)}for(const [key,fact] of admissions){await settleCapture(fact);admissions.delete(key)}},
      revoke(){retired=true},
    }
    const original=Object.freeze(adapter);privateRecipients.set(original,{execution,domain});return original
  }
  const receive = async (event: InputEvent, admitted: boolean) => {
    let strict = false
    try { strict = isStrictFactData(event) } catch { /* Original capture owns refusal. */ }
    const key = strict ? `${admitted ? 'admit' : 'cancel'}:${event.inputId}` : Symbol('invalid')
    const fingerprint = strict ? createHash('sha256').update(canonicalJsonData(event)).digest('hex') : undefined
    let record = pending.get(key)
    if (record && record.fingerprint !== fingerprint) return { kind: 'not-issued', code: 'FACT_INVALID_GROUP' } as const
    if (!record) {
      if (strict && admitted && execution.observe().inbox.everAdmitted(event.inputId)) return { kind: 'not-issued', code: 'FACT_INVALID_GROUP' } as const
      record = { fingerprint, invoked: false, capture: admitted ? source.captureAdmitted(event as Extract<InputEvent, {type:'agent/input/admitted'}>) : source.captureCancellation(event as Extract<InputEvent,{type:'agent/input/cancelled'}>) }
      pending.set(key, record)
    }
    return settle(key, record)
  }
  const facts = (signal?: AbortSignal): InputFacts<ProducerFactOutcome> => {
    const optional = async (invoke: (input: InputFacts<ProducerFactOutcome>) => Promise<ProducerFactOutcome>) => {
      const action = execution.owner.beginAction(signal)
      try { return await invoke(action.facts.inputs) } finally { action.finish() }
    }
    return { admit: e => receive(e,true), cancel: e => receive(e,false), start: (...args) => optional(f=>f.start(...args)), claim: (...args) => optional(f=>f.claim(...args)), scheduled: (...args) => optional(f=>f.scheduled(...args)) }
  }
  const inbox = {
    everAdmitted(id: string) { return execution.observe().inbox.everAdmitted(id) },
    pending(): PendingInput[] { const observation=execution.observe(); return copyConversationData(observation.inbox.pending().filter(input=>observation.inbox.isExecutable(input.inputId))) },
    isPending(id: string) { const observation=execution.observe(); return observation.inbox.isPending(id) && observation.inbox.isExecutable(id) },
    async admit(input: AdmittedInput, signal?: AbortSignal) { signal?.throwIfAborted(); const [seq]=committedFactSeqs(await facts(signal).admit({type:'agent/input/admitted',version:1,...input})); return seq! },
    async cancel(inputId: string, reason?: string) {
      if (!execution.observe().inbox.isPending(inputId)) return false
      const result=await facts().cancel({type:'agent/input/cancelled',version:1,inputId,...(reason===undefined?{}:{reason})})
      if(result.kind==='not-issued'&&result.code==='FACT_INVALID_GROUP'&&!execution.observe().inbox.isPending(inputId))return false
      committedFactSeqs(result);return true
    },
    async claimAtStepBoundary(inputFacts?: InputFacts<ProducerFactOutcome>, prepare?: (input: PendingInput)=>Promise<import('@i-harness/core-session').PreparedInputResult|undefined>, claim?: InputFacts<ProducerFactOutcome>['claim']) {
      for(const input of inbox.pending().filter(input=>input.delivery==='steer')) {
        const prepared=await prepare?.(input)
        committedFactSeqs(await (claim??(inputFacts??facts()).claim)({type:'agent/input/promoted',version:1,inputId:input.inputId},{type:'user/message',text:input.text,...(input.provenance?{provenance:input.provenance}:{}),input:{inputId:input.inputId,intent:input.intent,...(input.provenance?{provenance:input.provenance}:{}),...(input.synthetic?{synthetic:input.synthetic}:{})},...(input.images?.length?{imageInputId:input.inputId}:{}),...(input.intent==='system'?{source:{kind:'plugin',plugin:SYSTEM_INPUT_PLUGIN} as const}:{})},prepared))
      }
    },
  }
  return Object.freeze({ inbox:Object.freeze(inbox), facts, execDelivery(domain:ManagedExecutionDomain){if(delivery){if(domain!==deliveryDomain)throw TypeError('Original recipient already bound');return delivery}delivery=createExecDelivery(domain);deliveryDomain=domain;return delivery}, close: ()=>source.close() })
}
