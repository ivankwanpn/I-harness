import type { AsyncInbox, SessionView } from '@i-harness/core-session'
import type { AgentDeps } from '@i-harness/core-agent'
import { generationError } from '@i-harness/llm-seam'
import { createInputPreparationOwner } from './input-preparation-owner.ts'

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
