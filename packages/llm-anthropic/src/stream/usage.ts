import type { LLMUsage } from "@i-harness/llm-seam"

/**
 * M5 T2: the wire's usage, under the seam's names.
 *
 * Returns `undefined` when the object carries no recognisable number, so the
 * caller emits NO event rather than an empty one. That distinction is the whole
 * point: the cache fields are optional on the wire, and a fabricated
 * `cacheReadTokens: 0` would read as a measurement of zero rather than as
 * "not reported". Fields are copied verbatim and never derived — the
 * API's `input_tokens` does NOT include the cache counts, so summing them here
 * would invent a number the provider never stated.
 */
export function mapUsage(raw: unknown): LLMUsage | undefined {
  if (raw === null || typeof raw !== "object") return undefined
  const src = raw as Record<string, unknown>
  const out: LLMUsage = {}
  const take = (from: string, to: Exclude<keyof LLMUsage, "inputTokenSemantics">): void => {
    const v = src[from]
    if (typeof v === "number" && Number.isFinite(v)) out[to] = v
  }
  take("input_tokens", "inputTokens")
  take("output_tokens", "outputTokens")
  take("cache_read_input_tokens", "cacheReadTokens")
  take("cache_creation_input_tokens", "cacheCreationTokens")
  if (out.inputTokens !== undefined && Number.isSafeInteger(out.inputTokens) && out.inputTokens >= 0) out.inputTokenSemantics = "excludes-cache"
  return Object.keys(out).length > 0 ? out : undefined
}
