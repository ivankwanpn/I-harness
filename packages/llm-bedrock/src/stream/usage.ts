import type { LLMUsage } from "@i-harness/llm-seam"

/**
 * M72 Ⅲ: the wire's usage snapshot, under the seam's names.
 *
 * Returns `undefined` when the object carries no recognisable number, so the
 * caller emits NO event rather than an empty one: a fabricated `0` would read
 * as a measurement nobody made, and the SDK's `TokenUsage` declares the two
 * cache counts optional. Fields are copied verbatim and never derived —
 * `totalTokens` is the wire's own sum of the two counts, not a new measurement,
 * so it is not mapped (`LLMUsage` has no home for it). The two cache counts take
 * the names anthropic's cache read/creation counts take. The field list is
 * MEASURED from the installed SDK's `TokenUsage`, not assumed.
 */
export function mapUsage(raw: unknown): LLMUsage | undefined {
  if (raw === null || typeof raw !== "object") return undefined
  const src = raw as Record<string, unknown>
  const out: LLMUsage = {}
  const take = (from: string, to: Exclude<keyof LLMUsage, "inputTokenSemantics">): void => {
    const v = src[from]
    if (typeof v === "number" && Number.isFinite(v)) out[to] = v
  }
  take("inputTokens", "inputTokens")
  take("outputTokens", "outputTokens")
  take("cacheReadInputTokens", "cacheReadTokens")
  take("cacheWriteInputTokens", "cacheCreationTokens")
  // Converse inputTokens excludes both cache reads and cache writes (AWS
  // prompt-caching guide); preserve raw counters and declare that accounting.
  if (out.inputTokens !== undefined && Number.isSafeInteger(out.inputTokens) && out.inputTokens >= 0) out.inputTokenSemantics = "excludes-cache"
  return Object.keys(out).length > 0 ? out : undefined
}

