import { committedFactSeqs, readDeliveries, FactRecoveryRequiredError } from '@i-harness/core-session'
import type { CapturedActionFact, CapturedSettlementFact, ProducerFactOutcome, DeliveryLaunchPreparation, SessionView } from '@i-harness/core-session'
import type { OriginalExecSourceIssuer } from '@i-harness/core-tools/model-origin'
import type { OriginalExecDeliveryOwner } from '../../../exec/src/direct-delivery.ts'
import type { Capture, CaptureAttempt } from '../../../exec/src/capture/contracts.ts'
import type { ExecFrameCapture, ExecFrameObservation } from '@i-harness/exec'
import { execResultOutcome } from '@i-harness/exec'
export type ExecPreparationInput = {view:SessionView;sessionId:string;callId:string;callSeq:number;sourceId:string}
export type PrepareExecDelivery = (input:ExecPreparationInput)=>Promise<DeliveryLaunchPreparation & {isCurrent?:()=>boolean}>

/** One original reservation/action source. Admission can expire; settlement cannot be reissued. */
export function createExecDeliveryOwner(issuer:OriginalExecSourceIssuer,input:ExecPreparationInput,delivery:'tool'|'parent',prepare:PrepareExecDelivery):OriginalExecDeliveryOwner {
  let sourceCapture:CapturedActionFact<ProducerFactOutcome>|undefined, sourceOutcome:ProducerFactOutcome|undefined, sourceSeq:number|undefined
  let sourceEverIssued=false,sourceRetired=false
  let sourceAttempted=false,handoffAttempted=false,terminalAttempted=false
  let terminalOutcome:ProducerFactOutcome|undefined
  let issued=false, completed=false, clean=false, unavailable=false, attempt:CaptureAttempt|undefined, capture:Capture|undefined
  let settleFrames:((frames:ExecFrameCapture)=>Promise<ExecFrameObservation|undefined>)|undefined
  let terminal:CapturedSettlementFact<ProducerFactOutcome>|undefined, handoff:CapturedSettlementFact<ProducerFactOutcome>|undefined
  let terminalDone=false,handoffDone=delivery==='parent',handoffRequested=false
  let handoffOutcome:ProducerFactOutcome|undefined,handoffEverIssued=false,handoffRetired=false
  let handoffFlight:Promise<boolean>|undefined
  let flight:Promise<void>|undefined
  let admissionCurrent=()=>true
  let retireReservation=()=>{}
  const available=Promise.withResolvers<void>()
  async function settleTerminal(){
    if(terminalAttempted)terminalOutcome=await terminal!.observe()
    else{terminalAttempted=true;terminalOutcome=await terminal!.admit()}
    if(terminalOutcome.kind==='unknown'||terminalOutcome.kind==='recovery-required')terminalOutcome=await terminal!.reconcile()
    committedFactSeqs(terminalOutcome)
  }
  async function settleSource(){
    if(!sourceCapture)return
    const prior=sourceOutcome
    if(sourceAttempted)sourceOutcome=await sourceCapture.observe()
    else{sourceAttempted=true;sourceOutcome=await sourceCapture.admit()}
    if(prior&&sourceOutcome.kind==='not-issued'&&sourceOutcome.code==='FACT_RECOVERY_REQUIRED')sourceOutcome=await sourceCapture.reconcile()
    if(sourceOutcome.kind!=='not-issued')sourceEverIssued=true
    if(sourceOutcome.kind==='unknown'||sourceOutcome.kind==='recovery-required')sourceOutcome=await sourceCapture.reconcile()
    if(!sourceEverIssued&&sourceOutcome.kind==='not-issued'&&['FACT_PRECONDITION_STALE','FACT_CANCELLED'].includes(sourceOutcome.code)){sourceRetired=true;return}
    const seqs=committedFactSeqs(sourceOutcome)
    const indexed=readDeliveries(input.view).source('exec',input.sourceId)
    if(!indexed||indexed.seq!==seqs[0]||indexed.kind!=='exec'||indexed.callSeq!==input.callSeq)throw new FactRecoveryRequiredError()
    sourceSeq=indexed.seq
  }
  async function settleHandoffWork(){
    if(handoffDone)return !handoffRetired
    if(sourceSeq===undefined)throw new FactRecoveryRequiredError()
    handoff??=source.delivery.capture({type:'agent/delivery-handoff',version:1,kind:'exec',sourceSeq})
    const prior=handoffOutcome
    if(handoffAttempted)handoffOutcome=await handoff.observe()
    else{handoffAttempted=true;handoffOutcome=await handoff.admit()}
    if(prior&&handoffOutcome.kind==='not-issued'&&handoffOutcome.code==='FACT_RECOVERY_REQUIRED')handoffOutcome=await handoff.reconcile()
    if(handoffOutcome.kind!=='not-issued')handoffEverIssued=true
    if(handoffOutcome.kind==='unknown'||handoffOutcome.kind==='recovery-required')handoffOutcome=await handoff.reconcile()
    if(!handoffEverIssued&&handoffOutcome.kind==='not-issued'&&handoffOutcome.code==='FACT_PRECONDITION_STALE'){handoffRetired=true;handoffDone=true;return false}
    committedFactSeqs(handoffOutcome);handoffDone=true;return true
  }
  function settleHandoff():Promise<boolean>{
    if(handoffDone)return Promise.resolve(!handoffRetired)
    if(handoffFlight)return handoffFlight
    const pending=Promise.resolve().then(settleHandoffWork);handoffFlight=pending
    void pending.then(()=>{handoffFlight=undefined},()=>{handoffFlight=undefined})
    return pending
  }
  async function settleCompletion(){
    await available.promise
    await settleSource()
    if(unavailable||sourceRetired||!sourceCapture)return
    if(sourceSeq===undefined)throw new FactRecoveryRequiredError()
    source.assertHeld()
    let result:Awaited<Capture['complete']>|undefined
    if(capture)try{result=await capture.complete}catch{/* Original failure is kept by caller and attempt. */}
    await attempt?.retryCleanup()
    if(attempt&&!attempt.isClean())throw new FactRecoveryRequiredError()
    if(handoffRequested&&!handoffDone){
      await settleHandoff()
    }
    if(!terminal){
      const original=attempt?.disposition()
      const frames=capture?.frames??original?.frames, outcome=result&&execResultOutcome(result)
      const retained=frames&&settleFrames?await settleFrames(frames):undefined
      if(frames&&retained?.kind!=='ready')throw new FactRecoveryRequiredError()
      if(original?.execution&&!frames)throw new FactRecoveryRequiredError()
      if(original?.execution&&original.settlement?.kind!=='settled')throw new FactRecoveryRequiredError()
      terminal=source.delivery.capture(original?.execution&&frames&&retained?.kind==='ready'
        ? {type:'exec/end',version:1,sourceSeq,instanceId:input.sourceId,execution:{dispatch:'dispatched',outcome:outcome??'unknown'},frameSourceId:frames.sourceId,dependency:retained.dependency,exitCode:original.settlement?.kind==='settled'?original.settlement.root.exitCode:null,timedOut:original.timedOut}
        : {type:'exec/end',version:1,sourceSeq,instanceId:input.sourceId,execution:{dispatch:issued?'unknown':'not-dispatched',outcome:'unknown'},reason:issued?'launch-unknown':'launch-refused'})
    }
    if(!terminalDone){await settleTerminal();terminalDone=true}
  }
  function settle(){if(flight)return flight;const pending=settleCompletion();flight=pending;void pending.then(()=>{flight=undefined},()=>{flight=undefined});return pending}
  const source=issuer.registerCompletion(async()=>{if(!unavailable&&!sourceRetired)await attempt?.retire();await settle()})
  const retainDebt=()=>{try{source.holdRecovery()}catch{/* The original owner retains a failed close. */}}
  const closeOriginal=source.close.bind(source)
  // The document's original checkpoint also calls this same source directly.
  // Retirement follows that owner's close acknowledgment, whichever caller joins.
  source.close=async function(){
    if(this!==source)throw new Error('Foreign Exec settlement receiver')
    try{await closeOriginal();completed=true;clean=true;retireReservation()}
    catch(cause){retainDebt();throw cause}
  }
  const owner:OriginalExecDeliveryOwner={
    prepareAttempt(original,settleOriginal,retire){if(attempt)throw new Error('Exec attempt already attached');attempt=original;settleFrames=settleOriginal;retireReservation=retire},
    async admit(){
      issuer.assertAdmissionCurrent()
      const prepared=await prepare(input)
      issuer.assertAdmissionCurrent()
      if(prepared.kind==='unavailable'){unavailable=true;return}
      const current=()=>prepared.isCurrent?.()!==false&&readDeliveries(input.view).activeGeneration()?.generationId===prepared.binding.generationId
      admissionCurrent=current
      if(!current())throw new FactRecoveryRequiredError()
      sourceCapture=issuer.captureSource({...prepared.binding,sourceNamespace:'exec',delivery},current)
      sourceAttempted=true;sourceOutcome=await sourceCapture.admit()
      if(sourceOutcome.kind!=='not-issued')sourceEverIssued=true
      committedFactSeqs(sourceOutcome)
      await settleSource()
      issuer.assertAdmissionCurrent()
      if(!current())throw new FactRecoveryRequiredError()
    },
    issued(){issuer.assertAdmissionCurrent();if(!admissionCurrent()||!unavailable&&sourceSeq===undefined)throw new FactRecoveryRequiredError();issued=true},
    assertAdmissionCurrent(){issuer.assertAdmissionCurrent();if(!admissionCurrent()||!unavailable&&sourceSeq===undefined)throw new FactRecoveryRequiredError()},
    bind(original,originalAttempt,settleOriginal){capture=original;attempt=originalAttempt;settleFrames=settleOriginal;available.resolve();void settle().then(()=>owner.close(),retainDebt).catch(retainDebt)},
    failed(originalAttempt){attempt??=originalAttempt;available.resolve();void owner.close().catch(retainDebt)},
    async promoted(){
      if(delivery==='parent'||unavailable)return
      handoffRequested=true
      await settleSource();source.assertHeld()
      if(sourceSeq===undefined)throw new FactRecoveryRequiredError()
      if(!await settleHandoff())throw Object.assign(new FactRecoveryRequiredError(),{cause:handoffOutcome})
    },
    async close(){await source.close()},
    isClean(){return clean&&completed},
  }
  return Object.freeze(owner)
}
