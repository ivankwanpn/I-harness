import type { LLMContentPart, SessionView as Session } from "@i-harness/core-session"
import { activeTokens as meterActiveTokens, estimateTextTokens, IMAGE_TOKEN_ESTIMATE } from "@i-harness/token-meter"

// M15: single source of truth moved to @i-harness/token-meter; kept here as a
// re-export so the M14 public surface is unchanged.
export { IMAGE_TOKEN_ESTIMATE }

// Content-only single-blob estimate — string → estimateTextTokens; parts →
// Σ (text: estimateTextTokens, image: IMAGE_TOKEN_ESTIMATE). NO block/role
// overhead. A-02: it must use the same density as every other estimate (ASCII
// /4, non-ASCII by UTF-8 bytes); the old ceil(length/4) counted UTF-16 units
// and undercounted CJK content by ~3x.
export function approxTokens(content: string | LLMContentPart[]): number {
  if (typeof content === "string") return estimateTextTokens(content)
  let total = 0
  for (const part of content) {
    total += part.type === "text" ? estimateTextTokens(part.text) : IMAGE_TOKEN_ESTIMATE
  }
  return total
}

// M15: full-message pricing (block/role overhead included). The single
// projection rule: deriveMessages(session) is what the model sees, so the
// meter prices exactly that. Delegates to @i-harness/token-meter.
export function activeTokens(session: Session): number {
  return meterActiveTokens(session)
}
