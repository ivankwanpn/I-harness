import type { LLMUsage } from "@i-harness/llm-seam"

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
    if (typeof v !== "number" || !Number.isSafeInteger(v) || v < 0) out.measurementValidity = "invalid"
    if (typeof v === "number" && Number.isFinite(v)) out[to] = v
  }
  take("input_tokens", "inputTokens")
  take("output_tokens", "outputTokens")
  take("cache_read_input_tokens", "cacheReadTokens")
  take("cache_creation_input_tokens", "cacheCreationTokens")
  if (out.inputTokens !== undefined && Number.isSafeInteger(out.inputTokens) && out.inputTokens >= 0) out.inputTokenSemantics = "excludes-cache"
  return Object.keys(out).length > 0 ? out : undefined
}
