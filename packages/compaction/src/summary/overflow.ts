import { modelFailureFacts } from '@i-harness/llm-seam'

/** Provider-confirmed context failures only. Text classification cannot authorize splitting. */
export function confirmedSummaryOverflow(error: unknown): boolean {
  if (error instanceof AggregateError || modelFailureFacts(error)?.code !== 'CONTEXT_WINDOW_EXCEEDED') return false
  let current = error
  for (let i = 0; i < 5 && current && typeof current === 'object'; i++) {
    const record = current as { code?: string; modelFailure?: { code?: string }; cause?: unknown }
    if (record.code === 'CONTEXT_WINDOW_EXCEEDED' || record.modelFailure?.code === 'CONTEXT_WINDOW_EXCEEDED') return true
    current = record.cause
  }
  return false
}
