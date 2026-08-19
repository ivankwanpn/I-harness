import type { Session } from "@i-harness/core-session"
import { deriveMessages } from "@i-harness/core-session"

export function approxTokens(text: string): number {
  return Math.ceil(text.length / 4)
}

export function activeTokens(session: Session): number {
  let total = 0
  for (const m of deriveMessages(session)) total += approxTokens(m.content)
  return total
}
