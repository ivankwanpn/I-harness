import { randomUUID } from 'node:crypto'
import type { ResultExecution } from '@i-harness/core-session'
import type { CodeModeRuntimeOptions, CodeModeStatus, CodeModeTextRetentionResult } from '@i-harness/code-mode'
import { createResultCapture } from '@i-harness/output-retention'
import type { ContextCapture, ContextOutputService, ResultArtifactScope } from '@i-harness/context-output'

export interface CodeTextRetentionOptions {
  service?: ContextOutputService
  sourceFor?(sessionId: string): Promise<ContextCapture['source']>
  sessionId?: string
}

/** Emitted Code Mode text retention. The complete accepted text is written once
 * through the existing managed result store; the returned envelope is the
 * bounded model/archive descriptor and its artifact ref is the only durable
 * handle. No spill file, no second full-text copy in the observation. */
export function createCodeTextRetention(options: CodeTextRetentionOptions): NonNullable<CodeModeRuntimeOptions['retainText']> {
  return async input => {
    const service = options.service, sessionId = input.origin.sessionId ?? options.sessionId
    // No durable owner: explicit unsupported, never an unbounded spill or an
    // inline huge value that would silently become the model window.
    if (!service || !sessionId) return { kind: 'unavailable', reason: 'unsupported-owner' }
    let source: ContextCapture['source']
    if (options.sourceFor) {
      try { source = await options.sourceFor(sessionId) }
      catch { return { kind: 'unavailable', reason: 'unsupported-owner' } }
    }
    const execution: ResultExecution = { outcome: outcomeFor(input.status), dispatch: 'not-dispatched' }
    const operationId = randomUUID()
    let scope: ResultArtifactScope | undefined, active = true, issued = false
    const capture = createResultCapture(input.index ?? input.text, execution, {
      forceArtifact: true,
      completeness: input.complete ? 'complete' : 'source-limited',
      async openArtifact() {
        input.assertHeld?.()
        scope ??= service.registerResultScope({ operationId, sessionId, callId: input.cellId, ...(source ? { source } : {}) },
          () => { input.assertHeld?.(); return active })
        // Issuance precedes awaiting the store. A lost initialization receipt
        // is not evidence that no original operation exists.
        issued = true
        const sink = await service.beginResult(scope, 'json-utf8-v1')
        return sink
      },
    })
    let settled: Promise<CodeModeTextRetentionResult> | undefined
    const settle = (): Promise<CodeModeTextRetentionResult> => {
      if (settled) return settled
      const work = (async (): Promise<CodeModeTextRetentionResult> => {
        // Cancellation before any artifact operation is a known refusal, never
        // an uncertain write and never a successful retained value.
        if (!input.assertHeld && input.origin.abortSignal?.aborted && !issued) return { kind: 'unavailable', reason: 'capture-canceled' }
        const result = await capture.settle()
        // Unknown storage keeps the original operation retriable; it is never
        // reported as a successful retained value.
        if (result.kind !== 'ready') return { kind: 'recovery-required' }
        const retention = result.envelope.retention
        if (retention.kind === 'unavailable') return { kind: 'unavailable', reason: retention.reason }
        if (retention.kind !== 'artifact') return { kind: 'unavailable', reason: 'unsupported-owner' }
        if (scope) {
          try { await service.confirmResultOwner(scope, retention.ref) }
          catch (cause) {
            if ((cause as { code?: string }).code === 'ARTIFACT_QUOTA') active = false
            else return { kind: 'recovery-required' }
            return { kind: 'unavailable', reason: 'quota' }
          }
        }
        active = false
        // The observation's own bounded text is the model view; do not repeat it.
        return { kind: 'ready', envelope: { ...result.envelope, preview: '' } }
      })().catch(() => ({ kind: 'recovery-required' as const }))
      // Only a known disposition is cached; an unknown finish stays retriable
      // through this same original operation until it reaches a known outcome.
      const tracked = work.then(result => {
        if (result.kind === 'recovery-required' && settled === tracked) settled = undefined
        return result
      })
      settled = tracked
      return tracked
    }
    input.retainOutcome?.(settle)
    return settle()
  }
}

function outcomeFor(status: CodeModeStatus): ResultExecution['outcome'] {
  return status === 'completed' ? 'succeeded' : status === 'failed' ? 'failed' : status === 'terminated' ? 'canceled' : 'unknown'
}
