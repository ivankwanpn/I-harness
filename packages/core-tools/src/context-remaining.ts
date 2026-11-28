import type { SessionView as Session, BudgetRead } from "@i-harness/core-session"
import { contextStateFromBudget, validProviderReportedUsage } from "@i-harness/core-session"
import type { PluginContext } from "@i-harness/core-plugin"
import { activeTokens } from "@i-harness/token-meter"
import type { ToolRegistry } from "./index.ts"

// M27-R-A8 (codex get_context_remaining parity): the model can ask how much
// context it has left. Shipping assemblies supply their actual budget owner.
// Direct legacy embedders retain a marked neutral-only history estimate.

export interface ContextRemainingOptions {
  budgetRead?: () => BudgetRead
  /** Finite model window for embedders without a live budget reader. */
  contextWindow?: number
  /** Live session to price. Absent → documented estimator: the empty history
   * (used = 0) until the caller attaches the session. */
  session?: Session
}

/** Return only the input capacity evidence a model can use in its next step.
 * Binding fingerprints and journal coordinates stay on the operator/SDK surface. */
function modelBudget(read: BudgetRead) {
  const { observation, snapshot, ...reading } = contextStateFromBudget(read)
  if (observation) {
    const { modelId, estimate, disposition, pressure, output, freshness, components, dimensions } = observation
    const facts = {
      modelId, freshness, disposition, estimate, pressure, output, components,
      dimensions: dimensions.filter(d => d.limit !== undefined || d.actual !== undefined || d.state === 'fail')
        .map(({ dimension, state, actual, limit }) => ({ dimension, state, actual, limit })),
      ...(observation.recoveryRequired ? { recoveryRequired: true } : {}),
      ...(observation.fullByProvider ? { fullByProvider: true } : {}),
    }
    if (reading.kind === 'ready') return { ...reading, observation: facts, window: reading.contextWindow,
      used: reading.estimatedTokens, remaining: Math.max(0, reading.contextWindow - reading.estimatedTokens),
      percentage: Math.round(reading.estimatedTokens / reading.contextWindow * 100) }

    const usage = read.kind === 'ready' ? read.lastReportedUsage : undefined
    const measured = observation.purpose === 'main' && freshness === 'awaiting-projection' &&
      observation.identityCoverage === 'complete' && observation.bindingConfigFingerprint &&
      observation.selectedSemanticId && observation.selectedPayloadId && !observation.recoveryRequired &&
      !observation.fullByProvider && usage && validProviderReportedUsage(usage, usage.inputTokens)
    return { ...reading, observation: facts,
      ...(measured ? { lastReportedInputTokens: usage.inputTokens, lastReportedUsage: { ...usage } } : {}) }
  }
  if (!snapshot) return reading
  const { estimatedInputTokens, admissionInputTokens, contextWindow, roleTokens, systemTokens, schemaTokens,
    reasoningTokens, safetyMargin, outputReserve, effectiveOutputCap, remainingInputBudget, admission } = snapshot
  const facts = { window: contextWindow, source: snapshot.estimateSource, confidence: snapshot.confidence, coverage: snapshot.coverage,
    outputReserve, capSupport: snapshot.capSupport, effectiveOutputCap,
    recoveryRequired: snapshot.recoveryRequired, fullByProvider: snapshot.fullByProvider,
    snapshot: { estimatedInputTokens, admissionInputTokens, contextWindow, roleTokens, systemTokens, schemaTokens,
      reasoningTokens, safetyMargin, outputReserve, effectiveOutputCap, remainingInputBudget, admission } }
  if (reading.kind === 'unavailable') return { ...reading, ...facts }
  return { ...reading, ...facts, window: reading.contextWindow, used: reading.estimatedTokens, remaining: snapshot.remainingInputBudget,
    percentage: Math.round(reading.estimatedTokens / reading.contextWindow * 100) }
}

export function registerContextRemaining(_ctx: PluginContext, tools: ToolRegistry, opts: ContextRemainingOptions = {}): void {
  const window = opts.contextWindow
  if (!opts.budgetRead && (window === undefined || !Number.isSafeInteger(window) || window <= 0)) return
  const session = opts.session
  tools.register({
    name: "get_context_remaining",
    description: "查詢目前請求的輸入預算，以及供應商上一次實際回報的用量。若下一次請求尚未估算，剩餘量會標示為未知。",
    inputSchema: { type: "object" as const, properties: {}, additionalProperties: false },
    // Pure read (session pricing) — auto-allow under the approval policy.
    isReadOnly: true,
    execute: async () => {
      if (opts.budgetRead) return modelBudget(opts.budgetRead())
      const used = session === undefined ? 0 : activeTokens(session)
      const remaining = Math.max(0, window! - used)
      return {
        source: "neutral-only", confidence: "estimated", coverage: "neutral-only",
        window,
        used,
        remaining,
        percentage: Math.round((used / window!) * 100),
      }
    },
  })
}
