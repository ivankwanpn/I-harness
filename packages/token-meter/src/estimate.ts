import { stringifyJsonData } from "@i-harness/core-session"
import type { LLMMessage } from "@i-harness/core-session"

// M15: dsh-style fixed-density heuristics. `estimateMessage` prices one
// message (block/role overhead included); `estimateContent` sums them.
export const CHARS_PER_TOKEN = 4
export const BLOCK_OVERHEAD = 4
export const ROLE_OVERHEAD = 4
// M14: fixed per-image estimate (no re-encode/pixel math in v0). Moved here
// from compaction so the meter is the single source of truth.
export const IMAGE_TOKEN_ESTIMATE = 1024

/** UTF-16 length is the wrong unit: one CJK character is one code unit but
 * ~1-3 BPE tokens. ASCII keeps the 4-chars-per-token rule; non-ASCII counts
 * its UTF-8 bytes, matching the conservative admission projection instead of
 * undercounting CJK text by an order of magnitude. */
export function estimateTextTokens(text: string): number {
  const bytes = Buffer.byteLength(text)
  if (bytes === text.length) return Math.ceil(bytes / CHARS_PER_TOKEN)
  let ascii = 0
  for (let index = 0; index < text.length; index++) {
    if (text.charCodeAt(index) < 128) ascii++
  }
  return Math.ceil(ascii / CHARS_PER_TOKEN) + bytes - ascii
}
export function estimateMessage(m: LLMMessage): number {
  if (m.role === "assistant") {
    if ((m.toolCalls?.length ?? 0) === 0) {
      // Plain assistant string message: ceil(len/4) + ROLE_OVERHEAD (content
      // is the single text block; no extra BLOCK_OVERHEAD — see M15 spec §3.1).
      return estimateTextTokens(m.content) + ROLE_OVERHEAD
    }
    let total = ROLE_OVERHEAD
    // Content is always a string (see LLMMessage union) and is an extra text
    // block when non-empty (e.g. preamble before tool calls).
    if (m.content.length > 0) {
      total += estimateTextTokens(m.content) + BLOCK_OVERHEAD
    }
    for (const call of m.toolCalls ?? []) {
      // stringifyJsonData(undefined) returns undefined, not a string — normalize
      // so the "as the wire would send it" pricing never sees NaN.
      const argsJson = stringifyJsonData(call.args) ?? ""
      total += estimateTextTokens(call.name)
        + estimateTextTokens(argsJson)
        + BLOCK_OVERHEAD
    }
    return total
  }
  // user | tool
  if (typeof m.content === "string") {
    return estimateTextTokens(m.content) + ROLE_OVERHEAD
  }
  let total = ROLE_OVERHEAD
  for (const part of m.content) {
    total += part.type === "text"
      ? estimateTextTokens(part.text) + BLOCK_OVERHEAD
      : IMAGE_TOKEN_ESTIMATE + BLOCK_OVERHEAD
  }
  return total
}

export function estimateContent(messages: LLMMessage[]): number {
  let total = 0
  for (const m of messages) total += estimateMessage(m)
  return total
}
