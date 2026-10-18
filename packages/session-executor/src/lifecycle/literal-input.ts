import { isNondurableSession, type PendingInput } from '@i-harness/core-session'
import type { ModelClient } from '@i-harness/llm-seam'
import { generationError } from '@i-harness/llm-seam'
import type { openExecutorDocument } from './managed-document.ts'
import { createGenerationLifecycle } from './generation-actions.ts'
import { createInputPreparationOwner } from './input-preparation-owner.ts'

/** Host composition for an already committed literal input. The actual input
 * owner and original source survive resolution and the borrowed first turn. */
export async function openLiteralInputExecution(options: {
  attachment: Awaited<ReturnType<typeof openExecutorDocument>>; ownerSessionId: string
  input: PendingInput; signal: AbortSignal; start: { wall: number; monotonic: number }
  selectedClient(): ModelClient | undefined; localTestEnabled: boolean
  timeoutMs?: number; maxAttempts?: number
}) {
  const { attachment, input, signal } = options, owner = attachment.factOwner
  if (isNondurableSession(owner.view)) return { generation: undefined, preparation: undefined, delegatedOrigin: undefined, close: async () => {} }
  const action = owner.beginAction(signal), lifecycle = createGenerationLifecycle(owner.view, options.ownerSessionId, action, { enabled: options.localTestEnabled, selectedClient: options.selectedClient })
  const preparations = createInputPreparationOwner(owner.view, action, { cancel: id => attachment.inbox.cancel(id, 'literal input did not reach promotion') })
  let generation: Awaited<ReturnType<typeof lifecycle.open>> | undefined
  let closing: Promise<void> | undefined
  const close = () => closing ??= (async () => {
    try {
      await generation?.close(signal.aborted ? 'stopped' : 'failed')
      if (attachment.inbox.isPending(input.inputId)) await attachment.inbox.cancel(input.inputId, 'generation ended before promotion')
    } finally { try { await lifecycle.drain(); await preparations.close() } finally { action.finish() } }
  })()
  try {
    const admission = owner.view.events.findLast(event => event.type === 'agent/input/admitted' && event.inputId === input.inputId)
    if (admission?.type !== 'agent/input/admitted' || admission.text !== input.text || !attachment.inbox.isPending(input.inputId)) throw generationError('GENERATION_STALE')
    const origin = admission.intent === 'system' ? { kind: 'observation-input' as const, seq: admission.seq!, inputId: admission.inputId } : admission.provenance?.kind === 'inherited' ? { kind: 'delegated-input' as const, ref: 'admitted' as const, seq: admission.seq!, inputId: admission.inputId } : { kind: 'input' as const, seq: admission.seq! }
    generation = await lifecycle.open('main', origin, { signal, start: options.start, timeoutMs: options.timeoutMs, maxAttempts: options.maxAttempts })
    if (origin.kind === 'delegated-input') return { generation, preparation: undefined, delegatedOrigin: origin, close }
    const preparation = await preparations.prepare(admission, generation)
    return { generation, preparation, delegatedOrigin: undefined, close }
  } catch (error) { try { await close() } catch (saving) { throw new AggregateError([error, saving], 'Literal input requires recovery', { cause: error }) }; throw error }
}
