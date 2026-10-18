import type { ReductionBlockedReason, SummaryPort } from '@i-harness/context-engine'
import { SummaryBlockedError, SummaryCheckpointError, SummaryNativeSourceError } from '../summary-errors.ts'
import { generateSelectedSummary } from './generate.ts'
import type { SummaryFactory } from './contracts.ts'
import type { SummaryLimits } from '../prepared-summary.ts'
import { diagnosticsFor } from '@i-harness/diagnostics'
import { isGenerationError, modelFailureFacts } from '@i-harness/llm-seam'

const publicBlock = (error: unknown): ReductionBlockedReason => {
  if (!(error instanceof SummaryBlockedError)) return 'summary-failed'
  const reason = error.kind
  return ['fixed-input', 'call-limit', 'opaque', 'source-unrepresentable', 'output-incompatible', 'output-unknown', 'output-floor', 'retention-output', 'checkpoint-format', 'retention-policy', 'call-policy', 'binding', 'shrink-limit'].includes(reason) ? reason as ReductionBlockedReason : 'summary-failed'
}

function summaryOutcome(error: unknown): Exclude<Awaited<ReturnType<SummaryPort>>, { kind: 'complete' }> {
  const facts = modelFailureFacts(error)
  if (error instanceof SummaryNativeSourceError || facts?.code === 'INVALID_ARGUMENT' && facts.validation?.status === 'invalid')
    return { kind: 'blocked', reason: facts?.reason === 'binding' ? 'binding' : 'source-unrepresentable' }
  const reason = publicBlock(error)
  return error instanceof SummaryBlockedError && error.outcome === 'blocked' ? { kind: 'blocked', reason } : { kind: 'failed', reason }
}

export const createSummaryPort: SummaryFactory = input => async source => {
  const config = input.config, model = config.summarizationModel ?? input.model, inherited = model === input.model
  const binding = inherited ? input.budgetBinding : config.summaryBudgetBinding
  const metadata = inherited ? input.contextMetadata ?? binding?.metadata : config.summaryMetadata ?? binding?.metadata
  const limits: SummaryLimits = {
    budgetBinding: binding,
    generation: input.generation,
    bindGeneration: input.bindGeneration,
    maxOutputTokens: config.summaryMaxOutputTokens, outputCapExplicit: config.summaryOutputCapExplicit,
    contextWindow: inherited ? metadata?.contextWindow ?? binding?.limits.contextTokens?.value ?? config.contextWindow : config.summaryLimits?.contextWindow ?? metadata?.contextWindow ?? binding?.limits.contextTokens?.value,
    modelMaxOutputTokens: inherited ? binding?.limits.outputTokens?.value : config.summaryLimits?.maxOutputTokens ?? binding?.limits.outputTokens?.value,
    reasoningEffort: inherited ? input.reasoningEffort : config.summaryReasoningEffort, metadata,
    signal: source.signal, beforeTransport: input.flush,
    onUsage: (usage: import('@i-harness/llm-seam').LLMUsage) => input.telemetry?.emit({ type: 'compaction/usage', ts: Date.now(), data: { ...usage } }),
    onMeasurement: facts => input.telemetry?.emit({ type: 'provider/context', ts: Date.now(), data: { operation: 'summary', ...facts } }),
    onPieceAccepted: observation => input.telemetry?.emit({ type: 'provider/context', ts: Date.now(), data: { operation: observation.kind, purpose: observation.purpose, origin: observation.origin, candidateId: observation.receipt.candidateId, sendId: observation.receipt.sendId } }),
  }
  try {
    const result = await generateSelectedSummary(model, source, { maxTokens: config.maxTokens, minSummaryChars: config.minSummaryChars, inherited }, limits)
    return { kind: 'complete', ...result }
  } catch (error) {
    if (error instanceof SummaryCheckpointError) throw error.failure
    if (isGenerationError(error) || source.signal?.aborted || (error as { code?: string }).code === 'CONTEXT_INPUT_STALE' || error instanceof AggregateError) throw error
    const outcome = summaryOutcome(error)
    diagnosticsFor('turn').warn(`[i-harness] compaction summarizer ${outcome.kind}: ${outcome.reason}`)
    return outcome
  }
}
