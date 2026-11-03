import { FactRecoveryRequiredError } from '@i-harness/core-session'
import type { ContextResultRef } from '@i-harness/context-output'

interface ReferenceStage {
  grant?(): Promise<void>
  capture?(): () => Promise<void>
}

/** Own the acquired ref before any later grant await. Passive settlement only
 * drains captured facts; an uncertain grant is never invoked a second time. */
export function createReferenceRetention(ref: ContextResultRef, stages: readonly ReferenceStage[], failed: (cause: unknown) => void) {
  const records = stages.map(stage => ({
    stage, grant: stage.grant ? 'unissued' : 'committed', settle: undefined as (() => Promise<void>) | undefined,
  }))
  let failure: unknown, started = false
  const settle = async () => {
    // Preserve the original actor-then-parent publication order. Each handle
    // keeps its own disposition when an earlier stage remains unresolved.
    const errors: unknown[] = []
    for (const record of records) {
      if (!record.settle) continue
      try { await record.settle() }
      catch (cause) { errors.push(cause); break }
    }
    if (failure || records.some(record => record.grant !== 'committed') || errors.length) {
      throw Object.assign(new FactRecoveryRequiredError(), { cause: failure ?? new AggregateError(errors, 'Original reference facts need recovery') })
    }
    return ref
  }
  return {
    settle,
    async initial() {
      if (started) throw new FactRecoveryRequiredError()
      started = true
      for (const record of records) {
        try {
          if (record.stage.grant) {
            record.grant = 'issued'
            await record.stage.grant()
            record.grant = 'committed'
          }
          record.settle = record.stage.capture?.()
        } catch (cause) {
          record.grant = 'failed'
          failure = cause
          failed(cause)
          break
        }
      }
      return settle()
    },
  }
}
