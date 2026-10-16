import type { LLMUsage } from "@i-harness/llm-seam"

/** M72 Ⅲ: Gemini's `usageMetadata` → the seam's `LLMUsage` (finite numbers
 * only; nothing recognisable ⇒ no event, never a fabricated zero). The seam
 * owns the vocabulary, each wire owns its spelling — hence a mapper per
 * adapter, next to the fields it spells. */
export function mapUsage(raw: unknown): LLMUsage | undefined {
  if (raw === null || typeof raw !== "object") return undefined
  const r = raw as Record<string, unknown>
  const out: LLMUsage = {}
  const take = (from: unknown, to: Exclude<keyof LLMUsage, "inputTokenSemantics">): void => {
    if (typeof from === "number" && Number.isFinite(from)) out[to] = from
  }
  take(r.promptTokenCount, "inputTokens")
  take(r.candidatesTokenCount, "outputTokens")
  take(r.cachedContentTokenCount, "cacheReadTokens")
  if (out.inputTokens !== undefined && Number.isSafeInteger(out.inputTokens) && out.inputTokens >= 0) out.inputTokenSemantics = "includes-cache"
  return Object.keys(out).length > 0 ? out : undefined
}
