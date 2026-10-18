import type { LLMUsage } from "@i-harness/llm-seam"

/**
 * M72 Ⅲ: the wire's usage, under the seam's names.
 *
 * Returns `undefined` when the object carries no recognisable number, so the
 * caller emits NO event rather than an empty one. The documented shape delivers
 * usage on the trailing `choices: []` chunk the `stream_options` ask buys, and
 * `handleFrame` reads `usage` on every frame, so a gateway that reports it
 * elsewhere is still covered. A gateway reports only the counters it counted
 * (`prompt_cache_hit_tokens` is a cache extension the others do not have), and
 * a fabricated `0` for a counter nobody sent would read as a measurement of
 * zero rather than as "not reported". Fields are copied verbatim and never
 * derived.
 */
export function mapUsage(raw: unknown): LLMUsage | undefined {
  if (raw === null || typeof raw !== "object") return undefined
  const src = raw as Record<string, unknown>
  const out: LLMUsage = {}
  const take = (from: string, to: Exclude<keyof LLMUsage, "inputTokenSemantics">): void => {
    const v = src[from]
    if (typeof v === "number" && Number.isFinite(v)) out[to] = v
  }
  take("prompt_tokens", "inputTokens")
  take("completion_tokens", "outputTokens")
  take("prompt_cache_hit_tokens", "cacheReadTokens")
  const details = src.prompt_tokens_details
  if (out.cacheReadTokens === undefined && details !== null && typeof details === "object") {
    const cached = (details as Record<string, unknown>).cached_tokens
    if (typeof cached === "number" && Number.isFinite(cached)) out.cacheReadTokens = cached
  }
  if (out.inputTokens !== undefined && Number.isSafeInteger(out.inputTokens) && out.inputTokens >= 0) out.inputTokenSemantics = "includes-cache"
  return Object.keys(out).length > 0 ? out : undefined
}
