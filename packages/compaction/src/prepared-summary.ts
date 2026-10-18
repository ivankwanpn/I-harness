import { assertPreparedValidation, prepareModelRequest, readPreparedTextOutput, readPreparedValidation, type LLMRequest, type LLMUsage, type ModelClient } from "@i-harness/llm-seam"
import { SummaryBlockedError, SummaryNativeSourceError } from "./summary-errors.ts"

export interface SummaryLimits {
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

/** Temporary owner of the existing summary formulas; R2E retires this policy.
 * Select one derivative, then measure and check only that candidate. */
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
  const price = (input: typeof prepared.measurement.input) => Object.values(input.components).reduce((sum, component) => sum + component.heuristicTokens, 0)
  const preferred = limits.maxOutputTokens ?? 4096
  const explicit = limits.outputCapExplicit ?? limits.maxOutputTokens !== undefined
  const requiredOutput = (output: typeof prepared.measurement.output) => output.minimumCap > preferred && output.reasoningBudget !== undefined ? Math.max(output.minimumCap, output.reasoningBudget + maxTokens) : output.minimumCap
  const roomFor = (tokens: number) => limits.contextWindow === undefined ? undefined : limits.contextWindow - tokens - Math.ceil(limits.contextWindow * .05)
  validate(prepared.measurement.input)
  const output = prepared.measurement.output, required = requiredOutput(output)
  let ceiling = explicit ? preferred : Math.max(preferred, required)
  if (limits.modelMaxOutputTokens !== undefined) ceiling = Math.min(ceiling, limits.modelMaxOutputTokens)
  if (ceiling < required) throw new SummaryBlockedError("output-floor", { output: ceiling, floor: required })
  const provisionalRoom = roomFor(price(prepared.measurement.input))
  const initialRequiredRoom = output.capSupport === "unsupported" ? ceiling : required
  const cap = output.capSupport === "unsupported" || provisionalRoom === undefined || provisionalRoom < initialRequiredRoom ? ceiling : Math.min(ceiling, provisionalRoom)
  const candidate = output.capSupport === "unsupported" || provisionalRoom !== undefined && provisionalRoom < initialRequiredRoom ? prepared : prepared.withOutputCap(cap)
  const { input, output: finalOutput } = candidate.measurement
  assertPreparedValidation(candidate)
  const textOutput = readPreparedTextOutput(candidate)
  if (textOutput.status !== 'allowed') throw new SummaryBlockedError(textOutput.status === 'blocked' ? 'output-incompatible' : 'output-unknown')
  validate(input)
  if (readPreparedValidation(candidate).native === 'unverified' && request.messages.some(message => message.role === 'assistant' && (message.providerContinuation !== undefined || !!message.thinkingBlocks?.length))) throw new SummaryNativeSourceError('Selected final native source fidelity is unverified')
  const inputTokens = price(input), room = roomFor(inputTokens)
  const finalRequired = requiredOutput(finalOutput)
  const reserve = finalOutput.capSupport === "supported" ? finalOutput.effectiveCap ?? cap : cap
  const requiredRoom = Math.max(finalRequired, reserve)
  if (ceiling < finalRequired || reserve < finalRequired) throw new SummaryBlockedError("output-floor", { output: reserve, floor: finalRequired })
  return { candidate, inputTokens, room, requiredRoom,
    facts: { inputTokens, contextWindow: limits.contextWindow, outputReserve: reserve,
      ...(finalOutput.capSupport === "supported" && finalOutput.effectiveCap !== undefined ? { effectiveCap: finalOutput.effectiveCap } : {}), capSupport: finalOutput.capSupport, minimumCap: finalOutput.minimumCap,
      reasoningBudget: finalOutput.reasoningBudget, defaultFloorAdjusted: !explicit && ceiling > preferred, coverage: input.coverage, estimateSource: "projected-heuristic" as const, uncertainties: input.uncertainties } }
}
