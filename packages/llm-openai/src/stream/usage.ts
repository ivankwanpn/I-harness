import type { LLMUsage } from "@i-harness/llm-seam"

/** M72 Ⅲ: the Responses shape → the seam's `LLMUsage`. Field names differ from
 * message-start's, so the mapper lives per wire (the seam owns the vocabulary,
 * each adapter owns its spelling). */
export function mapUsage(raw: unknown): LLMUsage | undefined {
  if (raw === null || typeof raw !== "object") return undefined
  const r = raw as Record<string, unknown>
  const details = (r.input_tokens_details ?? {}) as Record<string, unknown>
  const out: LLMUsage = {}
  const take = (from: unknown, to: Exclude<keyof LLMUsage, "inputTokenSemantics">): void => {
    if (typeof from === "number" && Number.isFinite(from)) out[to] = from
  }
  take(r.input_tokens, "inputTokens")
  take(r.output_tokens, "outputTokens")
  take(details.cached_tokens, "cacheReadTokens")
  if (out.inputTokens !== undefined && Number.isSafeInteger(out.inputTokens) && out.inputTokens >= 0) out.inputTokenSemantics = "includes-cache"
  return Object.keys(out).length > 0 ? out : undefined
}
