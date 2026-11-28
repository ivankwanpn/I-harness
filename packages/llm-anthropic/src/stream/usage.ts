import type { LLMUsage } from "@i-harness/llm-seam"

const count = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0

/** Both cache lifetimes are components of the same creation total. */
function reconcileCacheCreation(breakdown: unknown, usage: LLMUsage): void {
  if (breakdown == null) return
  if (typeof breakdown !== "object" || Array.isArray(breakdown)) {
    usage.measurementValidity = "invalid"
    return
  }
  const parts = breakdown as Record<string, unknown>
  const short = parts.ephemeral_5m_input_tokens, long = parts.ephemeral_1h_input_tokens
  if (short !== undefined && !count(short) || long !== undefined && !count(long)) {
    usage.measurementValidity = "invalid"
    return
  }
  const sum = (short ?? 0) + (long ?? 0)
  // Other providers may report a subset or a new lifetime. A subtotal
  // still cannot exceed a reported aggregate; only a complete pair replaces it.
  const complete = short !== undefined && long !== undefined && Object.keys(parts).length === 2
  const total = usage.cacheCreationTokens
  if (!count(sum) || (total === undefined ? !complete : sum > total || complete && sum !== total)) {
    usage.measurementValidity = "invalid"
  } else if (total === undefined) usage.cacheCreationTokens = sum
}

/**
 * M5 T2: the wire's usage, under the seam's names.
 *
 * Cache and input counters can be null in a partial report. Keep them absent
 * so a later partial event can merge with the original input report. A
 * malformed counter invalidates the measurement while preserving raw numbers.
 */
export function mapUsage(raw: unknown): LLMUsage | undefined {
  if (raw === null || typeof raw !== "object") return undefined
  const src = raw as Record<string, unknown>
  const out: LLMUsage = {}
  const take = (from: string, to: Exclude<keyof LLMUsage, "inputTokenSemantics" | "measurementValidity">): void => {
    const v = src[from]
    if (v === undefined || (v === null && to !== "outputTokens")) return
    if (!count(v)) out.measurementValidity = "invalid"
    if (typeof v === "number" && Number.isFinite(v)) out[to] = v
  }
  take("input_tokens", "inputTokens")
  take("output_tokens", "outputTokens")
  take("cache_read_input_tokens", "cacheReadTokens")
  take("cache_creation_input_tokens", "cacheCreationTokens")
  reconcileCacheCreation(src.cache_creation, out)
  if (out.inputTokens !== undefined && Number.isSafeInteger(out.inputTokens) && out.inputTokens >= 0) out.inputTokenSemantics = "excludes-cache"
  return Object.keys(out).length > 0 ? out : undefined
}
