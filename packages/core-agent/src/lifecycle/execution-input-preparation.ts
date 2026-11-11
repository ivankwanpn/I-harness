import { randomUUID } from 'node:crypto'
import { committedFactSeqs, type ManagedAction, type ProducerFactOutcome, type CapturedActionFact, type PreparedInputResult, type PreparedInputObservation } from '@i-harness/core-session'
import { isManagedExecutionOwner, readAcknowledgedExecutionMembers, retainAcknowledgedExecutionMembers } from '@i-harness/core-session/internal/execution'
import type { ManagedExecutionAttachment } from '../../../session-persistence/src/execution-internal.ts'
import type { AgentGenerationAction } from '../agent/generation.ts'
import { generationError } from '@i-harness/llm-seam'
import { createExecutionGenerationLifecycle } from './generation-actions.ts'
type Pin = ReturnType<typeof retainAcknowledgedExecutionMembers>
const proofs = new WeakMap<object, { execution: ManagedExecutionAttachment; inputId: string; actionId: string; pin: Pin }>()
export function assertExecutionPreparation(execution: ManagedExecutionAttachment, result: PreparedInputResult, actionId: string, inputId: string) {
  const proof=proofs.get(result)
  if(!proof||proof.execution.identity!==execution.identity||proof.execution.owner!==execution.owner||proof.inputId!==inputId||proof.actionId!==actionId)throw generationError('GENERATION_STALE')
  proof.pin.assertCurrent()
}
/** Captures only through this original action/source; no incoming receipt enrollment. */
export function createExecutionInputPreparationOwner(execution: ManagedExecutionAttachment, action: ManagedAction<ProducerFactOutcome>, options: {ready?():Promise<void>;transform?(text:string):Promise<string>;cancel(id:string):Promise<unknown>}) {
  if(!isManagedExecutionOwner(execution.identity,execution.owner)||!execution.owner.ownsAction(action))throw generationError('GENERATION_UNSUPPORTED')
  const retained=new Set<CapturedActionFact<ProducerFactOutcome>>(),pins=new Set<Pin>(),running=new Set<Promise<PreparedInputResult>>()
  const receipt=async(capture:CapturedActionFact<ProducerFactOutcome>)=>{
    retained.add(capture);let outcome=await capture.admit()
    if(outcome.kind==='unknown'||outcome.kind==='recovery-required')outcome=await capture.reconcile()
    committedFactSeqs(outcome);retained.delete(capture);return outcome
  }
  const source=action.registerSettlementSource(async()=>{await Promise.allSettled([...running]);for(const capture of retained)await receipt(capture)})
  const states=new Map<string,{actionId:string;flight?:Promise<PreparedInputResult>;failure?:{cause:unknown};started?:boolean;result?:PreparedInputResult;start?:CapturedActionFact<ProducerFactOutcome>;complete?:CapturedActionFact<ProducerFactOutcome>;observations?:PreparedInputObservation[];envelope?:{type:'agent/input/preparation';version:1;preparationId:string;actionId:string;actionSeq:number;admissionSeq:number;inputId:string;claim?:'steer'}}> ()
  return {
    async prepare(inputId:string,generation:Pick<AgentGenerationAction,'actionId'|'openedSeq'|'assertOpen'>,claim?:'steer'):Promise<PreparedInputResult>{
      action.assertOpen();source.assertHeld();generation.assertOpen()
      const observation=execution.observe(),originalGeneration=observation.generations().find(state=>state.opened.actionId===generation.actionId&&state.opened.seq===generation.openedSeq)
      if(!observation.inbox.isPending(inputId)||!originalGeneration||originalGeneration.closed)throw generationError('GENERATION_STALE')
      const existing=states.get(inputId)
      if(existing?.envelope&&existing.envelope.claim!==claim)throw generationError('GENERATION_STALE')
      if(existing){if(existing.actionId!==generation.actionId)throw generationError('GENERATION_STALE');if(existing.failure)throw existing.failure.cause;if(existing.result){assertExecutionPreparation(execution,existing.result,generation.actionId,inputId);return existing.result};if(existing.flight)return existing.flight}
      const state=existing??{actionId:generation.actionId};states.set(inputId,state)
      const work=(async()=>{
        const current=()=>{action.assertOpen();source.assertHeld();generation.assertOpen();const input=execution.observe().inbox.pending().find(i=>i.inputId===inputId);if(!input||claim==='steer'&&(input.delivery!=='steer'||input.preparationPolicy!=='human-host'))throw generationError('GENERATION_STALE');return input}
        const input=current()
        state.envelope??={type:'agent/input/preparation',version:1,preparationId:randomUUID(),actionId:generation.actionId,actionSeq:generation.openedSeq,admissionSeq:input.admittedSeq,inputId,...(claim?{claim}:{})}
        state.start??=action.captureInputPreparation({...state.envelope,op:'started',startedAt:Date.now()},()=>{try{current();return true}catch{return false}})
        await receipt(state.start);state.started=true;await options.ready?.();current()
        if(!state.observations){const text=input.preparationPolicy==='human-host'&&options.transform?await options.transform(input.text):input.text;if(typeof text!=='string')throw TypeError('Host input preparation returned invalid text');state.observations=[];if(text!==input.text)state.observations.push({producer:'host-preparation',text});if(input.supplementalContext)state.observations.push({producer:'supplemental-context',text:input.supplementalContext})}
        current();state.complete??=source.inputPreparation.capture({...state.envelope,op:'completed',observations:state.observations})
        const outcome=await receipt(state.complete)
        if(outcome.kind!=='committed')throw generationError('GENERATION_UNSUPPORTED')
        const members=readAcknowledgedExecutionMembers(state.complete,outcome),result=members.find((e):e is PreparedInputResult=>e.type==='agent/input/preparation'&&e.op==='completed')
        if(!result)throw generationError('GENERATION_UNCERTAIN')
        const pin=retainAcknowledgedExecutionMembers(state.complete,outcome);pins.add(pin);proofs.set(result,{execution,inputId,actionId:generation.actionId,pin});current();return state.result=result
      })()
      const pending=work.catch(async primary=>{const failures:unknown[]=[];if(state.started&&!state.complete&&state.envelope)try{await receipt(source.inputPreparation.capture({...state.envelope,op:'failed',code:'PREPARATION_FAILED'}));state.failure={cause:primary}}catch(cause){failures.push(cause)};try{await options.cancel(inputId)}catch(cause){failures.push(cause)};if(failures.length)throw new AggregateError([primary,...failures],'Private input preparation cleanup incomplete');throw primary})
      running.add(pending);state.flight=pending;void pending.finally(()=>{running.delete(pending);state.flight=undefined}).catch(()=>{})
      return pending
    },
    async cancelUnpromoted(result:PreparedInputResult){const proof=proofs.get(result);if(!proof)throw generationError('GENERATION_STALE');assertExecutionPreparation(execution,result,proof.actionId,proof.inputId);if(result.claim!=='steer')throw generationError('GENERATION_STALE');if(execution.observe().inbox.isPending(result.inputId))await options.cancel(result.inputId)},
    async close(){await source.close();for(const pin of pins)pin.release();pins.clear();states.clear()},
  }
}

/** The initial queued input keeps its original action and source alive until
 * the lane and its model producers have settled. */
export async function prepareExecutionInput(options:{execution:ManagedExecutionAttachment;sessionId:string;inputId:string;signal:AbortSignal;start:{wall:number;monotonic:number};ready():Promise<void>;retain(close:()=>Promise<void>):void;cancel(id:string):Promise<unknown>;transform?(text:string):Promise<string>;timeoutMs?:number;maxAttempts?:number;passiveGeneration?:import('@i-harness/llm-seam/internal/passive-observation').OriginalPassiveObserver}) {
  const action=options.execution.owner.beginAction(options.signal), decision=Promise.withResolvers<void>()
  let generation:Awaited<ReturnType<ReturnType<typeof createExecutionGenerationLifecycle>['open']>>|undefined
  let generations:ReturnType<typeof createExecutionGenerationLifecycle>|undefined
  let preparations:ReturnType<typeof createExecutionInputPreparationOwner>|undefined
  let generationClosed=false,finished=false,drained=false,preparationClosed=false
  const close=async()=>{
    if(!generationClosed){let closing:Promise<void>|undefined;try{closing=generation?.close(options.signal.aborted?'stopped':'failed')}finally{decision.resolve()}await closing;generationClosed=true}
    if(!finished){action.finish();finished=true}
    if(!drained){await generations?.drain();drained=true}
    if(!preparationClosed){await preparations?.close();preparationClosed=true}
  }
  options.retain(close)
  try{
    generations=createExecutionGenerationLifecycle(options.execution,options.sessionId,action,undefined,{beforeDrain:()=>decision.promise,...(options.passiveGeneration?{passiveGeneration:options.passiveGeneration}:{})})
    preparations=createExecutionInputPreparationOwner(options.execution,action,{transform:options.transform,cancel:options.cancel})
    const input=options.execution.observe().inbox.pending().find(value=>value.inputId===options.inputId)
    if(!input)throw generationError('GENERATION_STALE')
    await options.ready()
    options.signal.throwIfAborted();action.assertOpen()
    const origin=input.intent==='system'?{kind:'observation-input' as const,seq:input.admittedSeq,inputId:input.inputId}:{kind:'input' as const,seq:input.admittedSeq}
    generation=await generations.open('main',origin,{signal:options.signal,start:options.start,timeoutMs:options.timeoutMs,maxAttempts:options.maxAttempts})
    const preparation=await preparations.prepare(input.inputId,generation)
    return {generation,preparation,close}
  }catch(error){try{await close()}catch(saving){throw new AggregateError([error,saving],'Private input preparation requires recovery',{cause:error})}throw error}
}
