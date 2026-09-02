import type { Session } from "@i-harness/core-session"
import { activeTokens } from "./breakdown.ts"

export interface BudgetResult {
  state: "ok" | "overflow"
  tokens: number
  budget: number
}

// reserveRatio: 保留給輸出的比例（budget = contextWindow * reserveRatio；預設 0.9）
// overheadTokens (M33 §3.1): the host-known charge the session log does NOT
// carry (system prompt + tool schemas) — added to the measured tokens. 0
// (default) keeps the pre-M33 measurement.
export function checkBudget(session: Session, contextWindow: number, reserveRatio = 0.9, overheadTokens = 0): BudgetResult {
  if (!(reserveRatio > 0 && reserveRatio <= 1)) throw new Error(`reserveRatio must be in (0, 1] (got ${reserveRatio})`)
  if (!Number.isInteger(overheadTokens) || overheadTokens < 0) throw new Error(`overheadTokens must be a non-negative integer (got ${overheadTokens})`)
  const tokens = activeTokens(session) + overheadTokens
  const budget = Math.floor(contextWindow * reserveRatio)
  return { state: tokens > budget ? "overflow" : "ok", tokens, budget }
}
