import type { LLMMessage } from "@i-harness/core-session"

// M15: dsh-style fixed-density heuristics. `estimateMessage` prices one
// message (block/role overhead included); `estimateContent` sums them.
export const CHARS_PER_TOKEN = 4
export const BLOCK_OVERHEAD = 4
export const ROLE_OVERHEAD = 4
// M14: fixed per-image estimate (no re-encode/pixel math in v0). Moved here
// from compaction so the meter is the single source of truth.
export const IMAGE_TOKEN_ESTIMATE = 1024

export function estimateMessage(m: LLMMessage): number {
  if (m.role === "assistant") {
    if ((m.toolCalls?.length ?? 0) === 0) {
      // Plain assistant string message: ceil(len/4) + ROLE_OVERHEAD (content
      // is the single text block; no extra BLOCK_OVERHEAD — see M15 spec §3.1).
      return Math.ceil(m.content.length / CHARS_PER_TOKEN) + ROLE_OVERHEAD
    }
    let total = ROLE_OVERHEAD
    // Content is always a string (see LLMMessage union) and is an extra text
    // block when non-empty (e.g. preamble before tool calls).
    if (m.content.length > 0) {
      total += Math.ceil(m.content.length / CHARS_PER_TOKEN) + BLOCK_OVERHEAD
    }
    for (const call of m.toolCalls ?? []) {
      // JSON.stringify(undefined) returns undefined, not a string — normalize
      // so the "as the wire would send it" pricing never sees NaN.
      const argsJson = JSON.stringify(call.args) ?? ""
      total += Math.ceil(call.name.length / CHARS_PER_TOKEN)
        + Math.ceil(argsJson.length / CHARS_PER_TOKEN)
        + BLOCK_OVERHEAD
    }
    return total
  }
  // user | tool
  if (typeof m.content === "string") {
    return Math.ceil(m.content.length / CHARS_PER_TOKEN) + ROLE_OVERHEAD
  }
  let total = ROLE_OVERHEAD
  for (const part of m.content) {
    total += part.type === "text"
      ? Math.ceil(part.text.length / CHARS_PER_TOKEN) + BLOCK_OVERHEAD
      : IMAGE_TOKEN_ESTIMATE + BLOCK_OVERHEAD
  }
  return total
}

export function estimateContent(messages: LLMMessage[]): number {
  let total = 0
  for (const m of messages) total += estimateMessage(m)
  return total
}
