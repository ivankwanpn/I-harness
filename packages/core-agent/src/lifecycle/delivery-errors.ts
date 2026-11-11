import type { ProducerFactOutcome } from '@i-harness/core-session'
import { originalTaskAcknowledgmentRecovery } from '@i-harness/session-persistence/internal/task-persistence'

/** No receiver input was committed. This is an actual adapter's scoped
 * pre-admission refusal, separate from an acknowledged receipt disposition. */
export class DeliverySuppressedError extends Error {
  readonly code = 'DELIVERY_SUPPRESSED'
  readonly reason = 'generation-closed'
  constructor(readonly inputId: string) { super('Original delivery generation is closed'); this.name = 'DeliverySuppressedError' }
}
/** Nominal original-capture classification. A raw recovery code or an
 * arbitrary aggregate never grants an automatic retry. */
export class OriginalTerminalRecoveryError extends Error {
  readonly code = 'FACT_RECOVERY_REQUIRED'
  constructor(readonly outcome: Extract<ProducerFactOutcome, { kind: 'unknown' | 'absent' | 'conflict' | 'recovery-required' }>, cause?: unknown) {
    super('Original terminal capture requires reconciliation', { cause })
    if (outcome.kind !== 'unknown' && outcome.kind !== 'recovery-required') throw new TypeError('Terminal outcome is not automatically retryable')
  }
}
export class DeliverySourcesError extends AggregateError {
  readonly retryable: boolean
  constructor(errors: readonly unknown[]) {
    const original = errors.flatMap(error => error instanceof DeliverySourcesError ? error.errors : [error])
    super(original, 'Original delivery sources require settlement')
    this.retryable = original.some(error => error instanceof OriginalTerminalRecoveryError||originalTaskAcknowledgmentRecovery(error)!==undefined)
  }
}
