import { FactRecoveryRequiredError, type ResultEnvelope } from '@i-harness/core-session'
import type { CodeModeMountOptions, CodeModeRuntimeEvent, CodeModeTextRetentionResult } from './types.ts'
import type { createCodeModeEventFacts } from './event-facts.ts'
import { textSlice } from './runtime/limits.ts'
import { originalPreparationFailure } from './event-facts/state.ts'

/** The existing event source owns both original storage and its later F1 fact.
 * Recovery revisits the captured handle; it cannot call the guest/host capture
 * again or publish raw text while an artifact receipt remains uncertain. */
export function createCodeOutputPublisher(facts: ReturnType<typeof createCodeModeEventFacts>, retainText: CodeModeMountOptions['retainText']) {
  return (event: Extract<CodeModeRuntimeEvent, { type: 'output' }>) => {
    if (event.item.type !== 'text') return facts.requiredPrepared(event.cellId, async () => ({ type: 'code/output', cellId: event.cellId, content: event.item }), event.committed)
    const text = event.item.text
    let original: Promise<CodeModeTextRetentionResult | undefined> | undefined
    let invoked = false
    let resume: (() => Promise<CodeModeTextRetentionResult>) | undefined
    let retained: CodeModeTextRetentionResult | undefined
    return facts.requiredPrepared(event.cellId, async assertHeld => {
      if (!invoked) {
        const invocation = Promise.withResolvers<CodeModeTextRetentionResult | undefined>()
        // Publish the original promise and latch before evaluating user code.
        // A synchronous throw or reentry must retain this exact invocation.
        original = invocation.promise.catch(reason => { throw originalPreparationFailure(reason) })
        invoked = true
        try {
          invocation.resolve(retainText ? retainText({
            text, cellId: event.cellId, origin: event.origin, status: 'running', complete: true,
            assertHeld, retainOutcome(settle) { resume = settle },
            retentionRecovery: facts.requireRecovery,
          }) : { kind: 'unavailable', reason: 'no-owner' })
        } catch (reason) { invocation.reject(reason) }
      }
      const result = retained?.kind === 'recovery-required' && resume ? await resume() : await original!
      retained = result ?? { kind: 'unavailable', reason: 'no-owner' }
      if (retained.kind === 'recovery-required') throw new FactRecoveryRequiredError()
      const envelope: ResultEnvelope = retained.kind === 'ready' ? { ...retained.envelope, preview: textSlice(text, 2048) } : {
        version: 1, execution: { outcome: 'succeeded', dispatch: 'not-dispatched' },
        preview: textSlice(text, 2048), media: [], retention: { kind: 'unavailable', reason: retained.reason === 'no-owner' ? 'unsupported-owner' : retained.reason },
      }
      // History has a small display preview and the original immutable ref.
      // The committed callback keeps the ref-only observer descriptor.
      return { type: 'code/output', cellId: event.cellId, envelope }
    }, () => event.committed?.(retained))
  }
}
