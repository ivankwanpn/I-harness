import type { AdmittedInput, PendingInput } from '../inbox.ts'
import { SYSTEM_INPUT_PLUGIN } from '../inbox.ts'
import { readInbox } from '../inbox-view.ts'
import { copyConversationData } from '../conversation/render.ts'
import type { SessionView } from './types.ts'
import type { InputFacts, ProducerFactOutcome } from './ports.ts'
import { committedFactSeqs } from './outcome.ts'

/** Managed mailbox mutates only through its injected input owner. Synchronous
 * Inbox remains the separate, explicitly nondurable memory API. */
export class AsyncInbox {
  constructor(private readonly session: SessionView,
    private readonly inputFacts: (signal?: AbortSignal) => InputFacts<ProducerFactOutcome>, private readonly fromSeq = 0) {}
  pending(): PendingInput[] { return copyConversationData(readInbox(this.session, this.fromSeq).pending()) }
  isPending(inputId: string): boolean { return readInbox(this.session, this.fromSeq).isPending(inputId) }
  async admit(input: AdmittedInput, signal?: AbortSignal): Promise<number> {
    const [seq] = committedFactSeqs(await this.inputFacts(signal).admit({ type: 'agent/input/admitted', version: 1, ...input }))
    return seq!
  }
  async cancel(inputId: string, reason?: string): Promise<boolean> {
    if (!this.isPending(inputId)) return false
    const outcome = await this.inputFacts().cancel({ type: 'agent/input/cancelled', version: 1, inputId, ...(reason !== undefined ? { reason } : {}) })
    if (outcome.kind === 'not-issued' && outcome.code === 'FACT_INVALID_GROUP' && !this.isPending(inputId)) return false
    committedFactSeqs(outcome)
    return true
  }
  async claimAtStepBoundary(facts?: InputFacts<ProducerFactOutcome>): Promise<void> {
    for (const input of this.pending().filter(candidate => candidate.delivery === 'steer')) {
      committedFactSeqs(await (facts ?? this.inputFacts()).claim({ type: 'agent/input/promoted', version: 1, inputId: input.inputId }, {
        type: 'user/message', text: input.text, ...(input.provenance ? { provenance: input.provenance } : {}),
        input: { inputId: input.inputId, intent: input.intent, ...(input.provenance ? { provenance: input.provenance } : {}), ...(input.synthetic ? { synthetic: input.synthetic } : {}) },
        ...(input.images?.length ? { imageInputId: input.inputId } : {}),
        ...(input.intent === 'system' ? { source: { kind: 'plugin', plugin: SYSTEM_INPUT_PLUGIN } as const } : {}),
      }))
    }
  }
}
