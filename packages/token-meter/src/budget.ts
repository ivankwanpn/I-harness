export interface BudgetResult {
  state: "ok" | "overflow"
  tokens: number
  budget: number
}

/** Scalar comparison for complete prepared totals, including actual output reserve. */
export function compareBudgetTotal(tokens: number, contextWindow: number, reserveRatio = 0.9): BudgetResult {
  if (!(reserveRatio > 0 && reserveRatio <= 1)) throw new Error(`reserveRatio must be in (0, 1] (got ${reserveRatio})`)
  if (!Number.isSafeInteger(tokens) || tokens < 0) throw new Error('tokens must be a non-negative integer')
  const budget = Math.floor(contextWindow * reserveRatio)
  return { state: tokens > budget ? 'overflow' : 'ok', tokens, budget }
}
