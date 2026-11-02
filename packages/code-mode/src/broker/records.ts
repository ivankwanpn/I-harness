import { retainAcknowledgedExecutionMembers } from '@i-harness/core-session/internal/execution'
import { committedFactSeqs, FactRecoveryRequiredError } from '@i-harness/core-session'
import type { Queued } from './types.ts'
import type { ResultEnvelope, ResultExecution } from '@i-harness/core-session'
import type { ResultFinalization } from '@i-harness/core-tools'
import { isOriginalResultFinalization, isOriginalSyntheticResultFinalization } from '@i-harness/core-tools'

export const message = (error: unknown) => error instanceof Error ? error.message : String(error)
export const fatal = (error: unknown) => Object.assign(new Error(message(error)), { policyRefusal: true as const })

export function createCodeModeRecords(complete: (item: Queued) => Promise<unknown>, captureSynthetic?: (item: Queued, output: unknown, execution: ResultExecution) => ResultFinalization | undefined, view?: import('@i-harness/core-session').SessionView, privateContext?:(item:Queued)=>import('@i-harness/core-tools').ManagedSyntheticResultContext) {
  return {
    async record(item: Queued, output: unknown, error = false, envelope?: ResultEnvelope, execution: ResultExecution = { outcome: 'failed', dispatch: 'not-dispatched' }) {
      if (item.recorded) return
      if (!envelope && !item.result) {
        item.syntheticFinalization ??= captureSynthetic?.(item, output, execution)
        const result = await item.syntheticFinalization?.settle()
        if (result && result.kind !== 'ready') {
          if ((view && isOriginalSyntheticResultFinalization({ view, source: item.source, callId: item.call.invocationId, name: item.call.name }, item.syntheticFinalization)) || (privateContext && isOriginalSyntheticResultFinalization(privateContext(item),item.syntheticFinalization))) item.source.holdRecovery()
          throw new FactRecoveryRequiredError()
        }
        if (result?.kind === 'ready') envelope = result.envelope
      }
      item.result ??= item.source.code.capture({ type: 'code/result', cellId: item.call.cellId, callId: item.call.invocationId, name: item.call.name, ...(envelope ? { envelope } : { output, ...(error ? { isError: true } : {}) }) })
      try { committedFactSeqs(await item.result.admit()) }
      catch (error) {
        if (item.prepared && isOriginalResultFinalization(item.prepared, item.finalization)
          || view && isOriginalSyntheticResultFinalization({ view, source: item.source, callId: item.call.invocationId, name: item.call.name }, item.syntheticFinalization) || privateContext && isOriginalSyntheticResultFinalization(privateContext(item),item.syntheticFinalization)) item.source.holdRecovery()
        throw error
      }
      item.recorded = true
    },
    async drain(item: Queued) {
      if(item.callCapture&&!item.callOutcome){let outcome=await item.callCapture.observe();if(outcome.kind==='unknown'||outcome.kind==='recovery-required'||outcome.kind==='conflict'||outcome.kind==='not-issued'&&outcome.code==='FACT_RECOVERY_REQUIRED')outcome=await item.callCapture.reconcile();if(outcome.kind==='committed'){item.callOutcome=outcome;item.eventSeq=committedFactSeqs(outcome)[0]!;item.callPin=retainAcknowledgedExecutionMembers(item.callCapture,outcome)}else if(outcome.kind==='not-issued'||outcome.kind==='absent')return;else throw new FactRecoveryRequiredError()}
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
        catch (error) { if (!item.result) { if (item.finalization) item.source.holdRecovery(); else item.source.requireRecovery() } throw error }
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
