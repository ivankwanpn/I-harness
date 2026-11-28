import { createSummaryPort, type CompactionConfig, type CompactionRequest } from '@i-harness/compaction'
import type { Diagnostics } from '@i-harness/diagnostics'
import { inputCapacityCeiling, type ModelLimits } from '@i-harness/token-meter'

/** Composition supplies an unbound port factory; child owners select their own model. */
export const summaryFactory = createSummaryPort
export function composeCompactConfig(compact: CompactionRequest | undefined, contextWindow: number | undefined, overheadTokens: number | undefined, diagnostics: Pick<Diagnostics, 'warn'>, limits?: ModelLimits): CompactionConfig | undefined {
  if (!compact) return undefined
  const window = contextWindow ?? limits?.contextTokens?.value ?? (limits?.inputTokens ? undefined : compact.contextWindow)
  if (inputCapacityCeiling(window, limits) === undefined) {
    diagnostics.warn('[i-harness] compaction was requested without a known context window or input limit, so auto-compaction is DISABLED for this session.')
    return undefined
  }
  return { ...compact, contextWindow: window, ...(compact.overheadTokens === undefined && overheadTokens !== undefined ? { overheadTokens } : {}) }
}
