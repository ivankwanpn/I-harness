import type { Session } from "@i-harness/core-session"
import { activeTokens } from "./breakdown.ts"

export interface BudgetResult {
  state: "ok" | "overflow"
  tokens: number
  budget: number
}

// reserveRatio: 保留給輸出的比例（budget = contextWindow * reserveRatio；預設 0.9）
export function checkBudget(session: Session, contextWindow: number, reserveRatio = 0.9): BudgetResult {
  if (!(reserveRatio > 0 && reserveRatio <= 1)) throw new Error(`reserveRatio must be in (0, 1] (got ${reserveRatio})`)
  const tokens = activeTokens(session)
  const budget = Math.floor(contextWindow * reserveRatio)
  return { state: tokens > budget ? "overflow" : "ok", tokens, budget }
}
