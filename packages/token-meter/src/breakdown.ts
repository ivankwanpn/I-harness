import type { Session } from "@i-harness/core-session"
import { deriveMessages } from "@i-harness/core-session"
import { estimateContent, estimateMessage } from "./estimate.ts"

export interface TokenBreakdown {
  total: number
  perMessage: { index: number; role: "user" | "assistant" | "tool"; tokens: number }[]
}

// M15: the single projection rule — the model only ever sees
// deriveMessages(session), so tokens are counted on that exact output
// (audit seam F01-3). The meter never touches raw events.
export function activeTokens(session: Session): number {
  return estimateContent(deriveMessages(session))
}

export function breakdown(session: Session): TokenBreakdown {
  const perMessage = deriveMessages(session).map((m, index) => ({
    index,
    role: m.role,
    tokens: estimateMessage(m),
  }))
  return { total: perMessage.reduce((sum, p) => sum + p.tokens, 0), perMessage }
}
