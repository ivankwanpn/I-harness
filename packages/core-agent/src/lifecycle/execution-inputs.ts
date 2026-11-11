import { DeliverySuppressedError } from './delivery-errors.ts'
import { createHash } from 'node:crypto'
import { randomUUID } from 'node:crypto'
import { canonicalJsonData, committedFactSeqs, deliveryInputId,FactRecoveryRequiredError, isStrictFactData, SYSTEM_INPUT_PLUGIN,
  type AdmittedInput, type PendingInput, type SessionEvent, type InputFacts, type ProducerFactOutcome, type CapturedSettlementFact } from '@i-harness/core-session'
import { isManagedExecutionOwner,isManagedExecutionDomain,assertManagedExecDeliveryLifetimeCurrent,assertManagedCodeDeliveryLifetimeCurrent,assertManagedWorkflowDeliveryLifetimeCurrent,readManagedSourceCodeEvidence,readManagedSourceTaskEvidence,readManagedSourceTaskCandidate,type ManagedExecutionDomain } from '@i-harness/core-session/internal/execution'
import {isManagedExecutionAttachment,type ManagedExecutionAttachment} from '../../../session-persistence/src/execution-internal.ts'
import { copyConversationData } from '@i-harness/core-session'
import {eligibleCodeTerminal,codeTerminalRef} from '@i-harness/core-session/internal/execution'
type InputEvent = Extract<SessionEvent, { type: 'agent/input/admitted' | 'agent/input/cancelled' }>
const owners = new WeakMap<object, ReturnType<typeof createExecutionInputs>>()
const privateRecipients=new WeakMap<object,{execution:ManagedExecutionAttachment;domain:ManagedExecutionDomain}>()
export interface PrivateExecRecipient {
 prepareExecLaunch(input:{sessionId:string;callId:string;callSeq:number;sourceId:string}):Promise<PrivateExecPreparation>
 reconcileExecCandidates():Promise<void>
 requestClose(reason:'user-stop'|'rewind'):{fenceId:string;settled:Promise<readonly number[]>}
 closeReceipt(fenceId:string):Promise<import('@i-harness/core-session').DeliveryCloseReceipt>
 settle():Promise<void>
 revoke():void
}
export interface PrivateCodeRecipient extends PrivateExecRecipient {
 prepareCodeLaunch(input:{sessionId:string;callId:string;callSeq:number;cellId:string;sourceId:string}):Promise<PrivateCodePreparation>
 admitCode(evidence:import('@i-harness/core-session').CodeDeliveryEvidence):Promise<import('@i-harness/core-session').DeliveryAdmissionReceipt>
 reconcileCodeCandidates():Promise<void>
}
export type PrivateCodePreparation={kind:'unavailable';reason:'uncertified-call'|'no-own-human-origin'}|{kind:'bound';binding:Readonly<import('@i-harness/core-tools/model-origin').CodeSourceBinding>;isCurrent():boolean}
export interface PrivateWorkflowRecipient extends PrivateCodeRecipient {
 prepareWorkflowLaunch(input:{sessionId:string;callId:string;callSeq:number;sourceId:string}):Promise<PrivateWorkflowPreparation>
 reconcileWorkflowCandidates():Promise<void>
}
export type PrivateWorkflowPreparation={kind:'unavailable';reason:'uncertified-call'|'no-own-human-origin'}|{kind:'bound';binding:Readonly<import('@i-harness/core-tools/model-origin').WorkflowSourceBinding>;isCurrent():boolean}
export interface PrivateTaskRecipient extends PrivateWorkflowRecipient {
 prepareTaskLaunch(input:{sessionId:string;namespace:string;taskId:string;callSeq:number}):Promise<import('@i-harness/core-session').DeliveryLaunchPreparation>
 taskEvidence(namespace:string,taskId:string):{evidence:import('@i-harness/core-session').SubagentDeliveryEvidence;expectedInputId:string}|undefined
 admitTask(evidence:import('@i-harness/core-session').SubagentDeliveryEvidence,presentation:{text:string;description:string;display:import('@i-harness/core-session').InputDisplay}):Promise<import('@i-harness/core-session').DeliveryAdmissionReceipt>
}
type PrivateExecPreparation=Extract<import('@i-harness/core-session').DeliveryLaunchPreparation,{kind:'unavailable'}>|(Extract<import('@i-harness/core-session').DeliveryLaunchPreparation,{kind:'bound'}>&{isCurrent():boolean})
export function isOriginalPrivateExecRecipient(value:object,execution:ManagedExecutionAttachment,domain:ManagedExecutionDomain){const original=privateRecipients.get(value);return !!original&&original.execution===execution&&original.domain===domain}
export const isOriginalPrivateCodeRecipient=isOriginalPrivateExecRecipient
export const isOriginalPrivateTaskRecipient=isOriginalPrivateExecRecipient
export function receivedExecutionInputsFor(execution: ManagedExecutionAttachment) {
  if (!isManagedExecutionAttachment(execution)||!isManagedExecutionOwner(execution.identity, execution.owner)) throw new TypeError('Original execution owner required')
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
      const flight=(async()=>{let outcome:ProducerFactOutcome
        try { outcome = attempts.has(fact)?await fact.observe():await fact.admit() }
        catch (error) {
          // A rewind may close its settlement source while an admission is still
          // pending; the capture obligation is then already gone and there is
          // nothing left to settle for it.
          if (error instanceof TypeError && error.message === 'Original capture obligation released') { attempts.add(fact); return undefined }
          throw error
        }
        attempts.add(fact);if(outcome.kind!=='not-issued')everIssued.add(fact)
        if(outcome.kind==='unknown'||outcome.kind==='recovery-required'||outcome.kind==='not-issued'&&outcome.code==='FACT_RECOVERY_REQUIRED')outcome=await fact.reconcile()
        if(outcome.kind!=='not-issued')everIssued.add(fact)
        if(!everIssued.has(fact)&&outcome.kind==='not-issued'&&outcome.code==='FACT_PRECONDITION_STALE')return undefined
        return committedFactSeqs(outcome)})()
      flights.set(fact,flight);void flight.then(()=>flights.delete(fact),()=>flights.delete(fact));return flight
    }
    const current=()=>{domain.assertCurrent();if(retired)throw Error('Original recipient retired')}
    // Original captured facts retain their own source authorization. Their
    // predicates inspect existing committed state, without reopening admission.
    const capturedCurrent=()=>{
      if(retired)throw Error('Original recipient retired')
      execution.observe().assertCurrent()
    }
    const captureDeliveryAdmission:typeof source.captureDeliveryAdmission=(...args)=>{
      current()
      return source.captureDeliveryAdmission(...args)
    }
    const captureDeliveryOpen:typeof source.captureDeliveryOpen=(...args)=>{
      current()
      return source.captureDeliveryOpen(...args)
    }
    const captureTaskDeliveryOpen:NonNullable<typeof source.captureTaskDeliveryOpen>=(...args)=>{
      current()
      if(!source.captureTaskDeliveryOpen)throw new FactRecoveryRequiredError()
      return source.captureTaskDeliveryOpen(...args)
    }
    const settleReceived=async()=>{
      if(opening){const pending=opening;await settleCapture(pending);if(opening===pending)opening=undefined}
      // An earlier admission on this same source may own the pending native
      // writer. Reconcile its original capture before attempting the later
      // close; Stop's live fence is already installed by close capture.
      for(const [key,fact] of admissions){await settleCapture(fact);if(admissions.get(key)===fact)admissions.delete(key)}
    }
    const adapter={
      taskEvidence(namespace:string,taskId:string){if(this!==adapter)throw TypeError('Original Task recipient required');current();const evidence=readManagedSourceTaskCandidate(execution.identity,source,namespace,taskId);if(!evidence)return;const original=readManagedSourceTaskEvidence(execution.identity,source,evidence);if(!original)return;return {evidence,expectedInputId:deliveryInputId(original.key)}},
      async prepareTaskLaunch(input:{sessionId:string;namespace:string;taskId:string;callSeq:number}):Promise<import('@i-harness/core-session').DeliveryLaunchPreparation>{
        if(this!==adapter)throw TypeError('Original Task recipient required')
        if(!isStrictFactData(input)||Reflect.ownKeys(input).length!==4||!['sessionId','namespace','taskId','callSeq'].every(key=>Object.hasOwn(input,key)))throw TypeError('Closed Task launch identity required')
        input=Object.freeze({...input})
        current();if(input.sessionId!==domain.sessionId||typeof input.namespace!=='string'||!input.namespace||typeof input.taskId!=='string'||!input.taskId||!Number.isSafeInteger(input.callSeq)||input.callSeq<0)throw TypeError('Original Task launch identity required')
        if(opening){const pending=opening;if(!await settleCapture(pending))throw new FactRecoveryRequiredError();if(opening===pending)opening=undefined;current()}
        let observed=execution.observe(),member=await observed.delivery.dispatchedCall(input.callSeq);observed.assertCurrent()
        if(!member||member.call.name!=='spawn_agent')return {kind:'unavailable',reason:'uncertified-call'}
        observed=execution.observe();if(observed.delivery.source(input.namespace,input.taskId))throw new FactRecoveryRequiredError()
        const generation=observed.delivery.activeGeneration()
        if(!generation){const human=await observed.delivery.ownHuman();observed.assertCurrent();if(!human){if((observed.delivery.lastFenceSeq()??-1)>=0)throw new FactRecoveryRequiredError();return {kind:'unavailable',reason:'no-own-human-origin'}}
          if(opening){const pending=opening;if(!await settleCapture(pending))throw new FactRecoveryRequiredError();if(opening===pending)opening=undefined;return adapter.prepareTaskLaunch(input)}
          if(!source.captureTaskDeliveryOpen)throw new FactRecoveryRequiredError()
          const capturedObservation=observed,open=captureTaskDeliveryOpen({type:'agent/delivery-generation',version:1,op:'open',recipientSessionId:domain.sessionId,generationId:randomUUID(),originInputSeq:human.seq!},()=>{try{capturedCurrent();capturedObservation.assertCurrent();return true}catch{return false}},{recipientSessionId:domain.sessionId,sourceNamespace:input.namespace,sourceId:input.taskId,callSeq:input.callSeq})
          opening=open;if(!await settleCapture(open))throw new FactRecoveryRequiredError();if(opening===open)opening=undefined;current();return open.preparation()
        }
        current();return {kind:'bound',binding:{recipientSessionId:domain.sessionId,generationId:generation.generationId,sourceNamespace:input.namespace,sourceId:input.taskId,callSeq:input.callSeq}}
      },
      async admitTask(evidence:import('@i-harness/core-session').SubagentDeliveryEvidence,presentation:{text:string;description:string;display:import('@i-harness/core-session').InputDisplay}):Promise<import('@i-harness/core-session').DeliveryAdmissionReceipt>{
        if(this!==adapter)throw TypeError('Original Task recipient required')
        if(!isStrictFactData(evidence)||!isStrictFactData(presentation))throw TypeError('Closed Task delivery data required')
        evidence=Object.freeze({...evidence});presentation=structuredClone(presentation)
        await adapter.settle();const original=readManagedSourceTaskEvidence(execution.identity,source,evidence);if(!original)throw new FactRecoveryRequiredError()
        if(original.receipt)return {inputId:original.receipt.event.inputId,disposition:original.receipt.disposition,durability:'durable'}
        current();const {source:binding,key}=original,inputId=deliveryInputId(key)
        const assertGenerationEligible = () => {
          const observed = execution.observe()
          const generation = observed.delivery.activeGeneration()
          observed.assertCurrent()
          if (generation?.generationId !== binding.generationId) throw new DeliverySuppressedError(inputId)
        }
        assertGenerationEligible()
        const eligible=()=>{try{capturedCurrent();const next=readManagedSourceTaskEvidence(execution.identity,source,evidence);return !!next&&!next.receipt&&next.source.seq===binding.seq&&execution.observe().delivery.activeGeneration()?.generationId===binding.generationId}catch{return false}}
        if(!eligible())throw new FactRecoveryRequiredError()
        let fact=admissions.get(inputId)
        if(!fact){fact=captureDeliveryAdmission({type:'agent/delivery-received',version:1,key,sourceSeq:evidence.sourceSeq,terminalSeq:evidence.terminalSeq,inputId},{type:'agent/input/admitted',version:1,inputId,text:presentation.text,delivery:'steer',intent:'system',provenance:{kind:'child-report',authority:'observation',scope:'turn',producer:'session.delivery.subagent'},synthetic:{description:presentation.description,scope:'turn',display:presentation.display}},eligible);admissions.set(inputId,fact)}
        if (!await settleCapture(fact)) {
          capturedCurrent()
          const remaining = readManagedSourceTaskEvidence(execution.identity, source, evidence)
          if (!remaining || remaining.source.seq !== binding.seq) throw new FactRecoveryRequiredError()
          assertGenerationEligible()
          throw new FactRecoveryRequiredError()
        }
        admissions.delete(inputId)
        const receipt=readManagedSourceTaskEvidence(execution.identity,source,evidence)?.receipt;if(!receipt)throw new FactRecoveryRequiredError()
        return {inputId:receipt.event.inputId,disposition:receipt.disposition,durability:'durable'}
      },
      async prepareCodeLaunch(input:{sessionId:string;callId:string;callSeq:number;cellId:string;sourceId:string}):Promise<PrivateCodePreparation>{
        current();if(!isStrictFactData(input)||Reflect.ownKeys(input).length!==5||!['sessionId','callId','callSeq','cellId','sourceId'].every(key=>{const field=Object.getOwnPropertyDescriptor(input,key);return !!field&&'value'in field&&field.enumerable}))throw TypeError('Closed original Code launch input required')
        const captured=Object.freeze({sessionId:input.sessionId,callId:input.callId,callSeq:input.callSeq,cellId:input.cellId,sourceId:input.sourceId})
        if(captured.sessionId!==domain.sessionId||typeof captured.callId!=='string'||!captured.callId||typeof captured.sourceId!=='string'||!captured.sourceId||typeof captured.cellId!=='string'||!captured.cellId||!Number.isSafeInteger(captured.callSeq)||captured.callSeq<0)throw TypeError('Original Code launch identity required')
        if(opening){const pending=opening;if(!await settleCapture(pending))throw new FactRecoveryRequiredError();if(opening===pending)opening=undefined;current()}
        let observed=execution.observe(),member=await observed.delivery.dispatchedCall(captured.callSeq);observed.assertCurrent()
        if(!member||member.call.name!=='code_exec'||member.call.callId!==captured.callId)return {kind:'unavailable',reason:'uncertified-call'}
        observed=execution.observe();if(observed.delivery.source('code',captured.sourceId))throw new FactRecoveryRequiredError()
        let generation=observed.delivery.activeGeneration()
        if(!generation){const human=await observed.delivery.ownHuman();observed.assertCurrent();if(!human){if((observed.delivery.lastFenceSeq()??-1)>=0)throw new FactRecoveryRequiredError();return {kind:'unavailable',reason:'no-own-human-origin'}}
          if(opening){const pending=opening;if(!await settleCapture(pending))throw new FactRecoveryRequiredError();if(opening===pending)opening=undefined;return adapter.prepareCodeLaunch(captured)}
          const generationId=randomUUID(),capturedObservation=observed
          opening=captureDeliveryOpen({type:'agent/delivery-generation',version:1,op:'open',recipientSessionId:domain.sessionId,generationId,originInputSeq:human.seq!},()=>{try{capturedCurrent();capturedObservation.assertCurrent();return true}catch{return false}})
          if(!await settleCapture(opening))throw new FactRecoveryRequiredError();opening=undefined;current();generation=execution.observe().delivery.activeGeneration()
        }
        if(!generation)throw new FactRecoveryRequiredError()
        const binding=Object.freeze({recipientSessionId:domain.sessionId,generationId:generation.generationId,sourceNamespace:'code' as const,sourceId:captured.sourceId,callSeq:captured.callSeq,cellId:captured.cellId,delivery:'tool' as const})
        const isCurrent=()=>{try{capturedCurrent();assertManagedCodeDeliveryLifetimeCurrent(domain,{recipientSessionId:binding.recipientSessionId,generationId:binding.generationId,sourceId:binding.sourceId,callSeq:binding.callSeq,cellId:binding.cellId,delivery:binding.delivery});return true}catch{return false}}
        current();if(!isCurrent())throw new FactRecoveryRequiredError()
        return {kind:'bound',binding,isCurrent}
      },
      async prepareWorkflowLaunch(input:{sessionId:string;callId:string;callSeq:number;sourceId:string}):Promise<PrivateWorkflowPreparation>{
        current();if(!isStrictFactData(input)||Reflect.ownKeys(input).length!==4||!['sessionId','callId','callSeq','sourceId'].every(key=>{const field=Object.getOwnPropertyDescriptor(input,key);return !!field&&'value'in field&&field.enumerable}))throw TypeError('Closed original Workflow launch input required')
        const captured=Object.freeze({...input});if(captured.sessionId!==domain.sessionId||typeof captured.callId!=='string'||!captured.callId||typeof captured.sourceId!=='string'||!captured.sourceId||!Number.isSafeInteger(captured.callSeq)||captured.callSeq<0)throw TypeError('Original Workflow launch identity required')
        if(opening){const pending=opening;if(!await settleCapture(pending))throw new FactRecoveryRequiredError();if(opening===pending)opening=undefined;current()}
        let observed=execution.observe(),member=await observed.delivery.dispatchedCall(captured.callSeq)??await observed.delivery.dispatchedCodeCall(captured.callSeq);observed.assertCurrent()
        if(!member||member.call.name!=='workflow_run'||member.call.callId!==captured.callId)return {kind:'unavailable',reason:'uncertified-call'}
        observed=execution.observe();if(observed.delivery.source('workflow',captured.sourceId))throw new FactRecoveryRequiredError()
        let generation=observed.delivery.activeGeneration()
        if(!generation){const human=await observed.delivery.ownHuman();observed.assertCurrent();if(!human){if((observed.delivery.lastFenceSeq()??-1)>=0)throw new FactRecoveryRequiredError();return {kind:'unavailable',reason:'no-own-human-origin'}}
          if(opening){const pending=opening;if(!await settleCapture(pending))throw new FactRecoveryRequiredError();if(opening===pending)opening=undefined;return adapter.prepareWorkflowLaunch(captured)}
          const generationId=randomUUID(),capturedObservation=observed
          opening=captureDeliveryOpen({type:'agent/delivery-generation',version:1,op:'open',recipientSessionId:domain.sessionId,generationId,originInputSeq:human.seq!},()=>{try{capturedCurrent();capturedObservation.assertCurrent();return true}catch{return false}})
          if(!await settleCapture(opening))throw new FactRecoveryRequiredError();opening=undefined;current();generation=execution.observe().delivery.activeGeneration()
        }
        if(!generation)throw new FactRecoveryRequiredError()
        const binding=Object.freeze({recipientSessionId:domain.sessionId,generationId:generation.generationId,sourceNamespace:'workflow' as const,sourceId:captured.sourceId,callSeq:captured.callSeq,delivery:'tool' as const})
        const isCurrent=()=>{try{capturedCurrent();assertManagedWorkflowDeliveryLifetimeCurrent(domain,{recipientSessionId:binding.recipientSessionId,generationId:binding.generationId,sourceId:binding.sourceId,callSeq:binding.callSeq,delivery:binding.delivery});return true}catch{return false}}
        current();if(!isCurrent())throw new FactRecoveryRequiredError();return {kind:'bound',binding,isCurrent}
      },
      async prepareExecLaunch(input:{sessionId:string;callId:string;callSeq:number;sourceId:string}):Promise<PrivateExecPreparation>{
        current();if(input.sessionId!==domain.sessionId)throw TypeError('Original recipient identity required')
        if(opening){const pending=opening;if(!await settleCapture(pending))throw new FactRecoveryRequiredError();if(opening===pending)opening=undefined;current()}
        let observed=execution.observe(),member=await observed.delivery.dispatchedCall(input.callSeq)??await observed.delivery.dispatchedCodeCall(input.callSeq)
        if(!member||!['shell','bash','pwsh'].includes(member.call.name)||member.call.callId!==input.callId)return {kind:'unavailable' as const,reason:'uncertified-call' as const}
        observed=execution.observe();if(observed.delivery.source('exec',input.sourceId))throw Error('Original Exec source already exists')
        let generation=observed.delivery.activeGeneration()
        if(!generation){const human=await observed.delivery.ownHuman();observed.assertCurrent();if(!human){if((observed.delivery.lastFenceSeq()??-1)>=0)throw new FactRecoveryRequiredError();return {kind:'unavailable' as const,reason:'no-own-human-origin' as const}}
          if(opening){const pending=opening;if(!await settleCapture(pending))throw new FactRecoveryRequiredError();if(opening===pending)opening=undefined;return adapter.prepareExecLaunch(input)}
          const generationId=randomUUID(),capturedObservation=observed
          opening=captureDeliveryOpen({type:'agent/delivery-generation',version:1,op:'open',recipientSessionId:domain.sessionId,generationId,originInputSeq:human.seq!},()=>{try{capturedCurrent();capturedObservation.assertCurrent();return true}catch{return false}})
          if(!await settleCapture(opening))throw new FactRecoveryRequiredError();opening=undefined;current();generation=execution.observe().delivery.activeGeneration()
        }
        if(!generation)throw new FactRecoveryRequiredError()
        const binding={recipientSessionId:domain.sessionId,generationId:generation.generationId,sourceNamespace:'exec' as const,sourceId:input.sourceId,callSeq:input.callSeq}
        const isCurrent=()=>{try{capturedCurrent();assertManagedExecDeliveryLifetimeCurrent(domain,{recipientSessionId:binding.recipientSessionId,generationId:binding.generationId,sourceId:binding.sourceId,callSeq:binding.callSeq,delivery:'tool'});return true}catch{return false}}
        current();if(!isCurrent())throw new FactRecoveryRequiredError()
        return {kind:'bound' as const,binding,isCurrent}
      },
      requestClose(reason:'user-stop'|'rewind'){
        if(this!==adapter)throw TypeError('Original recipient receiver required')
        if(retired)throw Error('Original recipient retired')
        if(reason!=='user-stop'&&reason!=='rewind')throw TypeError('Original delivery close reason required')
        // Stop is settlement on this original held source, not admission of new
        // model work. Its capture installs the live fence before any await,
        // including while an older issued write still needs reconciliation.
        const fenceId=randomUUID(),fact=source.captureDeliveryClose({type:'agent/delivery-generation',version:1,op:'close',recipientSessionId:domain.sessionId,fenceId,reason});closes.set(fenceId,fact)
        const settled=settleCapture(fact).then(seqs=>{if(!seqs)throw new FactRecoveryRequiredError();return seqs});void settled.catch(()=>{});return {fenceId,settled}
      },
      async closeReceipt(fenceId:string):Promise<import('@i-harness/core-session').DeliveryCloseReceipt>{
        if(this!==adapter||typeof fenceId!=='string')throw TypeError('Original recipient close required')
        const fact=closes.get(fenceId);if(!fact)throw TypeError('Unknown original delivery close')
        await settleReceived()
        await settleCapture(fact)
        // Consult this exact capture even on repeated queries: source lifetime
        // still applies, and only its real durable ACK can certify the receipt.
        const outcome=await fact.observe()
        if(outcome.kind!=='committed')throw new FactRecoveryRequiredError()
        const seqs=committedFactSeqs(outcome);if(seqs.length!==1)throw new FactRecoveryRequiredError()
        return Object.freeze({fenceId,closeSeq:seqs[0]!,durability:'durable'})
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
            const eligible=()=>{try{capturedCurrent();assertManagedExecDeliveryLifetimeCurrent(domain,{recipientSessionId:domain.sessionId,generationId:binding.generationId,sourceId:binding.sourceId,callSeq:binding.callSeq,delivery:binding.delivery});return execution.observe().delivery.execPending().some(value=>value.source.seq===binding.seq&&value.terminal.seq===terminal.seq)}catch{return false}}
            fact=captureDeliveryAdmission({type:'agent/delivery-received',version:1,key,sourceSeq:binding.seq!,terminalSeq:terminal.seq!,inputId},{type:'agent/input/admitted',version:1,inputId,text,delivery:'steer',intent:'system',provenance:{kind:'child-report',authority:'observation',scope:'turn',producer:'session.delivery.exec'},synthetic:{description:`Exec ${binding.sourceId} ${terminal.execution.outcome}`,scope:'turn',display:{kind:'task',title:`Exec ${terminal.execution.outcome}`,body:text}}},eligible);admissions.set(inputId,fact)
          }
          if(!await settleCapture(fact))throw new FactRecoveryRequiredError();admissions.delete(inputId)
        }catch(cause){failures.push(cause)}
        if(failures.length)throw Object.assign(new FactRecoveryRequiredError(),{cause:new AggregateError(failures,'Original Exec recipient requires recovery')})
      },
      async admitCode(evidence:import('@i-harness/core-session').CodeDeliveryEvidence):Promise<import('@i-harness/core-session').DeliveryAdmissionReceipt>{
        if(!isStrictFactData(evidence)||Reflect.ownKeys(evidence).length!==3||!['kind','sourceSeq','terminalSeq'].every(key=>{const field=Object.getOwnPropertyDescriptor(evidence,key);return !!field&&'value'in field&&field.enumerable})||evidence.kind!=='code'||!Number.isSafeInteger(evidence.sourceSeq)||evidence.sourceSeq<0||!Number.isSafeInteger(evidence.terminalSeq)||evidence.terminalSeq<=evidence.sourceSeq)throw new FactRecoveryRequiredError()
        const captured=Object.freeze({sourceSeq:evidence.sourceSeq,terminalSeq:evidence.terminalSeq})
        await adapter.settle()
        const original=readManagedSourceCodeEvidence(execution.identity,source,captured)
        if(!original)throw new FactRecoveryRequiredError()
        if(original.receipt)return {inputId:original.receipt.event.inputId,disposition:original.receipt.disposition,durability:'durable'}
        current();const observation=execution.observe(),binding=original.source,terminal=original.terminal,ref=codeTerminalRef(terminal)
        if(binding.recipientSessionId!==domain.sessionId||binding.sourceNamespace!=='code'||binding.seq!==captured.sourceSeq||terminal.seq!==captured.terminalSeq||terminal.sourceSeq!==binding.seq||terminal.cellId!==binding.cellId||!eligibleCodeTerminal(terminal)||!ref||!('output'in terminal))throw new FactRecoveryRequiredError()
        const key=original.key,inputId=deliveryInputId(key)
        if(observation.delivery.source('code',binding.sourceId)?.seq!==binding.seq||!observation.delivery.codePending().some(value=>value.source.seq===binding.seq&&value.terminal.seq===terminal.seq))throw new FactRecoveryRequiredError()
        let fact=admissions.get(inputId)
        if(!fact){const text=`<code_result>\n${JSON.stringify({cellId:binding.cellId,execution:terminal.execution,ref,header:terminal.output.header,footer:terminal.output.footer})}\nReference only. Read using the authorized context_output_read result reader.\n</code_result>`
          if(Buffer.byteLength(text,'utf8')>8192)throw new FactRecoveryRequiredError()
          const eligible=()=>{try{capturedCurrent();assertManagedCodeDeliveryLifetimeCurrent(domain,{recipientSessionId:binding.recipientSessionId,generationId:binding.generationId,sourceId:binding.sourceId,callSeq:binding.callSeq,cellId:binding.cellId,delivery:'tool'});return execution.observe().delivery.codePending().some(value=>value.source.seq===binding.seq&&value.terminal.seq===terminal.seq)}catch{return false}}
          fact=captureDeliveryAdmission({type:'agent/delivery-received',version:1,key,sourceSeq:captured.sourceSeq,terminalSeq:captured.terminalSeq,inputId},{type:'agent/input/admitted',version:1,inputId,text,delivery:'steer',intent:'system',provenance:{kind:'child-report',authority:'observation',scope:'turn',producer:'session.delivery.code'},synthetic:{description:`Code ${terminal.execution.outcome}`,scope:'turn',display:{kind:'task',title:`Code ${terminal.execution.outcome}`,body:text}}},eligible);admissions.set(inputId,fact)
        }
        if(!await settleCapture(fact))throw new FactRecoveryRequiredError();admissions.delete(inputId)
        const receipt=execution.observe().delivery.receipt(key);if(!receipt)throw new FactRecoveryRequiredError()
        return {inputId:receipt.event.inputId,disposition:receipt.disposition,durability:'durable'}
      },
      async reconcileWorkflowCandidates(){
        await adapter.settle();current();const candidates=execution.observe().delivery.workflowPending(),failures:unknown[]=[]
        for(const candidate of candidates)try{
          const binding=candidate.source,terminal=candidate.terminal,ref='result'in terminal&&terminal.result.kind==='artifact'?terminal.result.ref:undefined
          if(binding.recipientSessionId!==domain.sessionId||binding.sourceNamespace!=='workflow'||terminal.sourceSeq!==binding.seq||terminal.invocationId!==binding.sourceId||!ref)throw new FactRecoveryRequiredError()
          const key={kind:'workflow' as const,recipientSessionId:domain.sessionId,sourceNamespace:'workflow' as const,sourceId:binding.sourceId,resultRevision:ref.revision},inputId=deliveryInputId(key)
          if(execution.observe().delivery.receipt(key))continue
          let fact=admissions.get(inputId)
          if(!fact){const text=`<workflow_result>\n${JSON.stringify({invocationId:binding.sourceId,execution:terminal.execution,ref})}\nReference only. Read using the authorized context_output_read result reader.\n</workflow_result>`
            const eligible=()=>{try{capturedCurrent();assertManagedWorkflowDeliveryLifetimeCurrent(domain,{recipientSessionId:binding.recipientSessionId,generationId:binding.generationId,sourceId:binding.sourceId,callSeq:binding.callSeq,delivery:'tool'});return execution.observe().delivery.workflowPending().some(value=>value.source.seq===binding.seq&&value.terminal.seq===terminal.seq)}catch{return false}}
            fact=captureDeliveryAdmission({type:'agent/delivery-received',version:1,key,sourceSeq:binding.seq!,terminalSeq:terminal.seq!,inputId},{type:'agent/input/admitted',version:1,inputId,text,delivery:'steer',intent:'system',provenance:{kind:'child-report',authority:'observation',scope:'turn',producer:'session.delivery.workflow'},synthetic:{description:`Workflow ${terminal.execution.outcome}`,scope:'turn',display:{kind:'task',title:`Workflow ${terminal.execution.outcome}`,body:text}}},eligible);admissions.set(inputId,fact)
          }
          if(!await settleCapture(fact))throw new FactRecoveryRequiredError();admissions.delete(inputId)
        }catch(cause){failures.push(cause)}
        if(failures.length)throw Object.assign(new FactRecoveryRequiredError(),{cause:new AggregateError(failures,'Original Workflow recipient requires recovery')})
      },
      async reconcileCodeCandidates(){
        await adapter.settle();current();const candidates=execution.observe().delivery.codePending(),failures:unknown[]=[]
        for(const candidate of candidates)try{await adapter.admitCode({kind:'code',sourceSeq:candidate.source.seq!,terminalSeq:candidate.terminal.seq!})}catch(cause){failures.push(cause)}
        if(failures.length)throw Object.assign(new FactRecoveryRequiredError(),{cause:new AggregateError(failures,'Original Code recipient requires recovery')})
      },
      async settle(){await settleReceived();for(const fact of closes.values())await settleCapture(fact)},
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
  const recipientFor=(domain:ManagedExecutionDomain)=>{if(delivery){if(domain!==deliveryDomain)throw TypeError('Original recipient already bound');return delivery}delivery=createExecDelivery(domain);deliveryDomain=domain;return delivery}
  return Object.freeze({ inbox:Object.freeze(inbox), facts, execDelivery:recipientFor,codeDelivery:recipientFor,workflowDelivery:recipientFor,taskDelivery:recipientFor, close: ()=>source.close() })
}
