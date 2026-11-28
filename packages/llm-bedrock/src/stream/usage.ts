import type { LLMUsage } from "@i-harness/llm-seam"

const count = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0

/** Converse cacheDetails is the breakdown of cache writes by TTL.
 * A valid list can supply an omitted aggregate; it is never added to it. */
function cacheWrites(details: unknown): number | undefined {
  if (!Array.isArray(details)) return
  let sum = 0
  for (const detail of details) {
    if (!detail || (detail.ttl !== '5m' && detail.ttl !== '1h') || !count(detail.inputTokens)) return
    sum += detail.inputTokens
  }
  return count(sum) ? sum : undefined
}

/** Map the SDK's final TokenUsage, preserving zero and missing counters. */
export function mapUsage(raw: unknown): LLMUsage | undefined {
  if (raw === null || typeof raw !== "object") return undefined
  const src = raw as Record<string, unknown>
  const out: LLMUsage = {}
  let invalid = false
  const take = (from: string, to: Exclude<keyof LLMUsage, "inputTokenSemantics" | "measurementValidity">): void => {
    const v = src[from]
    if (v === undefined) return
    if (typeof v !== "number" || !Number.isSafeInteger(v) || v < 0) invalid = true
    if (typeof v === "number" && Number.isFinite(v)) out[to] = v
  }
  take("inputTokens", "inputTokens")
  take("outputTokens", "outputTokens")
  take("cacheReadInputTokens", "cacheReadTokens")
  take("cacheWriteInputTokens", "cacheCreationTokens")
  if (src.cacheDetails !== undefined) {
    const sum = cacheWrites(src.cacheDetails)
    if (sum === undefined || (src.cacheWriteInputTokens !== undefined && sum !== src.cacheWriteInputTokens)) invalid = true
    else if (src.cacheWriteInputTokens === undefined) out.cacheCreationTokens = sum
  }
  // Uncached input plus generated output is a lower bound regardless of
  // whether the reported total also includes cache tokens.
  if (src.totalTokens !== undefined && (!count(src.totalTokens) ||
    (out.inputTokens ?? 0) + (out.outputTokens ?? 0) > src.totalTokens)) invalid = true
  // Converse inputTokens excludes both cache reads and cache writes (AWS
  // prompt-caching guide); preserve raw counters and declare that accounting.
  if (out.inputTokens !== undefined && Number.isSafeInteger(out.inputTokens) && out.inputTokens >= 0) out.inputTokenSemantics = "excludes-cache"
  if (invalid) out.measurementValidity = "invalid"
  return Object.keys(out).length ? out : undefined
}
