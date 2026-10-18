import { createSummaryPort, type CompactionConfig, type CompactionRequest } from '@i-harness/compaction'
import type { Diagnostics } from '@i-harness/diagnostics'

/** Composition supplies an unbound port factory; child owners select their own model. */
export const summaryFactory = createSummaryPort
export function composeCompactConfig(compact: CompactionRequest | undefined, contextWindow: number | undefined, overheadTokens: number | undefined, diagnostics: Pick<Diagnostics, 'warn'>): CompactionConfig | undefined {
  if (!compact) return undefined
  const window = contextWindow ?? compact.contextWindow
  if (window === undefined) {
    diagnostics.warn('[i-harness] compaction was requested but no context window could be resolved, so auto-compaction is DISABLED for this session. Supply contextWindow or a model binding that carries one.')
    return undefined
  }
  return { ...compact, contextWindow: window, ...(compact.overheadTokens === undefined && overheadTokens !== undefined ? { overheadTokens } : {}) }
}
