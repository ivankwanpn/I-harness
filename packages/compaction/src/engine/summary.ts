import { deriveMessages, deriveMessagesUpTo, type Session } from "@i-harness/core-session"
import { projectionFingerprint } from "@i-harness/token-meter"
import type { CompactionRunOptions } from "../index.ts"
import { summarizeWithModel } from "../summarizer.ts"
import { activeEvents, activeSummary, renderShadowed } from "../projection/shadowed.ts"
import type { SummaryDependencies, CompactSettings } from "./contracts.ts"

/** Only the current binding supplies inherited metadata/effort/limits. */
export function prepareSummary(session: Session, shadowedSeqs: number[], config: CompactSettings, deps: SummaryDependencies) {
  const inherited = config.summarizationModel === undefined || config.summarizationModel === deps.model
  const model = config.summarizationModel ?? deps.model
  const validateOwner = deps.summaryInputGuard?.(inherited)
  const shape = inherited ? deps.requestShape?.() : undefined
  const anchor = activeSummary(session)
  const prefix = shape ? { ...shape, messages: deriveMessagesUpTo(session, Math.max(...shadowedSeqs)) } : undefined
  const historyNow = () => {
    try { return projectionFingerprint(deriveMessages(session)) }
    catch { return projectionFingerprint(renderShadowed(session, activeEvents(session).flatMap(event => event.seq === undefined ? [] : [event.seq]))) }
  }
  const ownBinding = (currentShape = shape) => ({
    budgetBinding: inherited ? deps.budgetBinding : config.summaryBudgetBinding ?? deps.summaryBudgetBinding,
    metadata: inherited ? deps.contextMetadata : config.summaryMetadata ?? deps.summaryMetadata,
    effort: inherited ? deps.reasoningEffort : config.summaryReasoningEffort ?? deps.summaryReasoningEffort,
    limits: inherited ? { contextWindow: config.contextWindow, maxOutputTokens: deps.maxOutputTokens } : config.summaryLimits,
    shape: currentShape,
  })
  const history = historyNow(), binding = projectionFingerprint(ownBinding())
  const validateBeforeTransport = () => {
    validateOwner?.()
    if ((config.summarizationModel ?? deps.model) !== model || historyNow() !== history || projectionFingerprint(ownBinding(inherited ? deps.requestShape?.() : undefined)) !== binding) {
      throw Object.assign(new Error("Summary input or binding changed during prepared admission"), { code: "CONTEXT_INPUT_STALE" })
    }
  }
  return { model, inherited, prefix, previousSummary: anchor?.text, anchorSeq: anchor?.seq, validateBeforeTransport }
}

export function requestSummary(
  session: Session, shadowedSeqs: number[], replayText: string,
  prepared: ReturnType<typeof prepareSummary>, config: CompactSettings,
  contextWindow: number, deps: SummaryDependencies,
  _overheadNow: () => number, attemptsTracker: { count: number }, instructions?: string, options?: CompactionRunOptions,
) {
  const { model, inherited, prefix, previousSummary } = prepared
  const binding = inherited ? deps.contextMetadata : config.summaryMetadata ?? deps.summaryMetadata
  const signal = options?.signal && deps.signal ? AbortSignal.any([options.signal, deps.signal]) : options?.signal ?? deps.signal
  return summarizeWithModel(model, replayText, config.maxTokens, previousSummary, instructions, config.minSummaryChars, attemptsTracker, prefix, {
    maxOutputTokens: config.summaryMaxOutputTokens, outputCapExplicit: config.summaryOutputCapExplicit,
    contextWindow: inherited ? binding?.contextWindow ?? contextWindow : config.summaryLimits?.contextWindow ?? binding?.contextWindow,
    modelMaxOutputTokens: inherited ? binding?.maxOutputTokens ?? deps.maxOutputTokens : config.summaryLimits?.maxOutputTokens ?? binding?.maxOutputTokens,
    metadata: binding, reasoningEffort: inherited ? deps.reasoningEffort : config.summaryReasoningEffort ?? deps.summaryReasoningEffort,
    signal, maxSummaryCalls: options?.maxSummaryCalls, beforeTransport: deps.flush ? () => deps.flush!() : undefined,
    validateBeforeTransport: prepared.validateBeforeTransport,
    onMeasurement: facts => deps.telemetry?.emit({ type: "provider/context", ts: Date.now(), data: { operation: "summary", providerId: binding?.providerId, modelId: binding?.modelId, ...facts } }),
    onUsage: usage => deps.telemetry?.emit({ type: "compaction/usage", ts: Date.now(), data: { ...usage } }),
  }, { session, shadowedSeqs })
}
