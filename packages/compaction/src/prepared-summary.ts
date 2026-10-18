import { assertPreparedValidation, prepareModelRequest, readPreparedTextOutput, readPreparedValidation, type LLMRequest, type LLMUsage, type ModelClient } from "@i-harness/llm-seam"
import { SummaryBlockedError, SummaryNativeSourceError } from "./summary-errors.ts"
import { assessPreparedCapacity } from '@i-harness/context-engine'

export interface SummaryLimits {
  budgetBinding?: import('@i-harness/llm-seam').ModelBudgetBinding
  generation?: import('@i-harness/llm-seam').GenerationControl
  bindGeneration?: (prepared: import('@i-harness/llm-seam').PreparedModelRequest) => Promise<void>
  expectedImages?: number
  maxOutputTokens?: number
  outputCapExplicit?: boolean
  contextWindow?: number
  modelMaxOutputTokens?: number
  overheadTokens?: number
  reasoningEffort?: LLMRequest["reasoningEffort"]
  metadata?: import("@i-harness/core-session").ContextBindingMetadata
  signal?: AbortSignal
  maxSummaryCalls?: number
  beforeTransport?: () => Promise<void>
  validateBeforeTransport?: () => void
  onMeasurement?: (facts: { inputTokens: number; contextWindow?: number; outputReserve: number; effectiveCap?: number; capSupport: string; minimumCap: number; reasoningBudget?: number; defaultFloorAdjusted: boolean; coverage: string; estimateSource: "projected-heuristic"; uncertainties: readonly string[] }) => void
  onPieceAccepted?: (observation: import("./summary-observation.ts").SummaryPieceObservation) => void
  onUsage?: (usage: LLMUsage) => void
}

/** Summary fidelity stays local; capacity and one exact derivative share the main owner. */
export async function prepareSummary(model: ModelClient, request: LLMRequest, maxTokens: number, limits: SummaryLimits, check: () => void) {
  const prepared = await prepareModelRequest(model, request)
  assertPreparedValidation(prepared)
  check()
  const validate = (input: typeof prepared.measurement.input) => {
    if (input.overriddenInputFields.includes('messages')) throw new SummaryBlockedError('opaque')
    if (limits.expectedImages !== undefined && input.components.images.imageCount !== limits.expectedImages) throw new SummaryBlockedError('opaque')
    if (limits.metadata && input.coverage !== "neutral-only" && (input.modelId !== limits.metadata.modelId || input.protocol !== limits.metadata.protocol)) throw new SummaryBlockedError("binding")
    if (input.coverage === "incomplete") throw new SummaryBlockedError("opaque")
  }
  const preferred = limits.maxOutputTokens ?? 4096
  const explicit = limits.outputCapExplicit ?? limits.maxOutputTokens !== undefined
  const requiredOutput = (output: typeof prepared.measurement.output) => output.minimumCap > preferred && output.reasoningBudget !== undefined ? Math.max(output.minimumCap, output.reasoningBudget + maxTokens) : output.minimumCap
  validate(prepared.measurement.input)
  const output = prepared.measurement.output, required = requiredOutput(output)
  const ceiling = explicit ? preferred : Math.max(preferred, required)
  const assessed = assessPreparedCapacity(prepared, { purpose: 'summary', binding: limits.budgetBinding, contextWindow: limits.contextWindow,
    outputCeiling: limits.modelMaxOutputTokens, outputPreference: ceiling, preferOutputPolicy: true, minimumOutput: requiredOutput })
  const candidate = assessed.prepared
  const { input, output: finalOutput } = candidate.measurement
  assertPreparedValidation(candidate)
  const textOutput = readPreparedTextOutput(candidate)
  if (textOutput.status !== 'allowed') throw new SummaryBlockedError(textOutput.status === 'blocked' ? 'output-incompatible' : 'output-unknown')
  validate(input)
  if (readPreparedValidation(candidate).native === 'unverified' && request.messages.some(message => message.role === 'assistant' && (message.providerContinuation !== undefined || !!message.thinkingBlocks?.length))) throw new SummaryNativeSourceError('Selected final native source fidelity is unverified')
  const inputTokens = assessed.priced.tokens
  const reserve = assessed.capacityInput.output.effectiveCap ?? assessed.capacityInput.output.explicitUnsupportedAllowance ?? 0
  if (assessed.decision.disposition === 'blocked') throw new SummaryBlockedError(assessed.decision.reason === 'output-floor' ? 'output-floor' : 'opaque')
  await limits.bindGeneration?.(candidate)
  check()
  return { candidate, inputTokens, decision: assessed.decision,
    facts: { inputTokens, contextWindow: limits.contextWindow, outputReserve: reserve,
      ...(finalOutput.capSupport === "supported" && finalOutput.effectiveCap !== undefined ? { effectiveCap: finalOutput.effectiveCap } : {}), capSupport: finalOutput.capSupport, minimumCap: finalOutput.minimumCap,
      reasoningBudget: finalOutput.reasoningBudget, defaultFloorAdjusted: !explicit && ceiling > preferred, coverage: input.coverage, estimateSource: "projected-heuristic" as const, uncertainties: input.uncertainties } }
}
