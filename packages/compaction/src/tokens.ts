import type { LLMContentPart, Session } from "@i-harness/core-session"
import { deriveMessages } from "@i-harness/core-session"

// M14: fixed per-image estimate (no re-encode/pixel math in v0)
export const IMAGE_TOKEN_ESTIMATE = 1024

export function approxTokens(content: string | LLMContentPart[]): number {
  if (typeof content === "string") return Math.ceil(content.length / 4)
  let total = 0
  for (const part of content) {
    total += part.type === "text" ? Math.ceil(part.text.length / 4) : IMAGE_TOKEN_ESTIMATE
  }
  return total
}

export function activeTokens(session: Session): number {
  let total = 0
  for (const m of deriveMessages(session)) {
    // M14: content may be a parts array (image-bearing); approxTokens now
    // counts text parts as ceil(chars/4) and each image part at the fixed
    // IMAGE_TOKEN_ESTIMATE. Behavior for text-only messages is unchanged.
    total += approxTokens(m.content)
  }
  return total
}
