import type { LLMContentPart, Session } from "@i-harness/core-session"
import { activeTokens as meterActiveTokens, IMAGE_TOKEN_ESTIMATE } from "@i-harness/token-meter"

// M15: single source of truth moved to @i-harness/token-meter; kept here as a
// re-export so the M14 public surface is unchanged.
export { IMAGE_TOKEN_ESTIMATE }

// M15: content-only single-blob estimate — string → ceil(chars/4); parts →
// Σ (text: ceil/4, image: IMAGE_TOKEN_ESTIMATE). NO block/role overhead.
// Consumers (region.ts shadow selection, summarizer.ts trimming) price single
// blobs, not full messages; estimateContent (token-meter) is the full-message
// price used by activeTokens.
export function approxTokens(content: string | LLMContentPart[]): number {
  if (typeof content === "string") return Math.ceil(content.length / 4)
  let total = 0
  for (const part of content) {
    total += part.type === "text" ? Math.ceil(part.text.length / 4) : IMAGE_TOKEN_ESTIMATE
  }
  return total
}

// M15: full-message pricing (block/role overhead included). The single
// projection rule: deriveMessages(session) is what the model sees, so the
// meter prices exactly that. Delegates to @i-harness/token-meter.
export function activeTokens(session: Session): number {
  return meterActiveTokens(session)
}
