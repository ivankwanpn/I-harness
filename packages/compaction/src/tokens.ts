import type { Session } from "@i-harness/core-session"
import { deriveMessages } from "@i-harness/core-session"

export function approxTokens(text: string): number {
  return Math.ceil(text.length / 4)
}

export function activeTokens(session: Session): number {
  let total = 0
  for (const m of deriveMessages(session)) {
    // M14: content may be a parts array (image-bearing); count text parts only
    // (image payload bytes use a separate budget and never reach the token
    // estimate). Behavior is identical to today for text-only messages.
    const text = typeof m.content === "string"
      ? m.content
      : m.content.filter((p) => p.type === "text").map((p) => p.text).join("")
    total += approxTokens(text)
  }
  return total
}
