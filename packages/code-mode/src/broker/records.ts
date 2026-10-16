import { committedFactSeqs, FactRecoveryRequiredError } from '@i-harness/core-session'
import type { Queued } from './types.ts'

export const message = (error: unknown) => error instanceof Error ? error.message : String(error)
export const fatal = (error: unknown) => Object.assign(new Error(message(error)), { policyRefusal: true as const })

export function createCodeModeRecords(complete: (item: Queued) => Promise<unknown>) {
  return {
    async record(item: Queued, output: unknown, error = false) {
      if (item.recorded) return
      item.result ??= item.source.code.capture({ type: 'code/result', cellId: item.call.cellId, callId: item.call.invocationId, name: item.call.name, output, ...(error ? { isError: true } : {}) })
      committedFactSeqs(await item.result.admit())
      item.recorded = true
    },
    async drain(item: Queued) {
      if (item.retained) {
        await item.retained.drainReferences()
        if (!item.hasOutput) {
          const outcome = await item.retained.take()
          if (outcome.kind !== 'ready') throw Object.assign(new FactRecoveryRequiredError(), { cause: item.recoveryCause })
          item.bodyOutput = outcome.output
          item.hasOutput = true
        }
      }
      if (item.recorded) return
      if (item.result) { committedFactSeqs(await item.result.admit()); item.recorded = true; return }
      if (item.hasOutput) {
        try { await complete(item) }
        catch (error) { if (!item.result) item.source.requireRecovery(); throw error }
      }
    },
    settle(item: Queued, outcome: { value: unknown } | { error: unknown }) {
      if (item.finished) return
      item.finished = true; item.unsubscribe()
      if ('error' in outcome) item.reject(outcome.error)
      else item.resolve(outcome.value)
    },
  }
}
