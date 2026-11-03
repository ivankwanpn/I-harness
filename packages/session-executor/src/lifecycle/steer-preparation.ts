import type { AsyncInbox, SessionView } from '@i-harness/core-session'
import type { AgentDeps } from '@i-harness/core-agent'
import { generationError } from '@i-harness/llm-seam'
import { createInputPreparationOwner } from './input-preparation-owner.ts'
import { createExecutionInputPreparationOwner } from './execution-input-preparation.ts'
import type { ManagedExecutionAttachment } from '../../../session-persistence/src/execution-internal.ts'
import type { receivedExecutionInputsFor } from './execution-inputs.ts'

export function createExecutionSteerPreparationFactory(execution:ManagedExecutionAttachment,inbox:ReturnType<typeof receivedExecutionInputsFor>['inbox'],transform?:(text:string)=>Promise<string>) {
  return (action:import('@i-harness/core-session').ManagedAction<import('@i-harness/core-session').ProducerFactOutcome>)=>{
    const owner=createExecutionInputPreparationOwner(execution,action,{transform,cancel:id=>inbox.cancel(id,'steer preparation did not reach promotion')})
    return {close:()=>owner.close(),cancelUnpromoted:owner.cancelUnpromoted,async prepare(input:import('@i-harness/core-session').PendingInput,generation:Parameters<typeof owner.prepare>[1]){
      const original=execution.observe().inbox.pending().find(candidate=>candidate.inputId===input.inputId)
      if(!original||original.admittedSeq!==input.admittedSeq||original.text!==input.text)throw generationError('GENERATION_STALE')
      if(original.preparationPolicy!=='human-host')return undefined
      return owner.prepare(original.inputId,generation,'steer')
    }}
  }
}

/** A steer shares the actual response action. This never opens another pool. */
export function createSteerPreparationFactory(view: SessionView, inbox: AsyncInbox, transform?: (text: string) => Promise<string>): NonNullable<AgentDeps['inputPreparationFactory']> {
  return action => {
    const owner = createInputPreparationOwner(view, action, { transform, cancel: inputId => inbox.cancel(inputId, 'steer preparation did not reach promotion') })
    return { close: () => owner.close(), cancelUnpromoted: result => owner.cancelUnpromoted(result), async prepare(input, generation) {
      const admission = view.events[input.admittedSeq]
      if (admission?.type !== 'agent/input/admitted' || admission.inputId !== input.inputId || admission.text !== input.text) throw generationError('GENERATION_STALE')
      if (admission.preparationPolicy !== 'human-host') return undefined
      return owner.prepare(admission, generation, 'steer')
    } }
  }
}
