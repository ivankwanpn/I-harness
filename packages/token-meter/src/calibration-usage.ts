export interface InputUsage {
  inputTokens?: number
  cacheReadTokens?: number
  cacheCreationTokens?: number
  inputTokenSemantics?: "includes-cache" | "excludes-cache"
}

/** Raw counters remain unchanged. This derived total is only for input sizing. */
export function normalizeInputUsage(usage: InputUsage): { totalInputTokens: number; cacheReadRatio?: number } | undefined {
  const valid = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0
  if (!valid(usage.inputTokens) || !["includes-cache", "excludes-cache"].includes(usage.inputTokenSemantics ?? "")) return
  for (const value of [usage.cacheReadTokens, usage.cacheCreationTokens]) if (value !== undefined && !valid(value)) return
  const totalInputTokens = usage.inputTokenSemantics === "includes-cache" ? usage.inputTokens
    : usage.inputTokens + (usage.cacheReadTokens ?? 0) + (usage.cacheCreationTokens ?? 0)
  if (!valid(totalInputTokens) || (usage.cacheReadTokens ?? 0) + (usage.cacheCreationTokens ?? 0) > totalInputTokens) return
  return { totalInputTokens, ...(usage.cacheReadTokens === undefined || totalInputTokens === 0 ? {} : { cacheReadRatio: usage.cacheReadTokens / totalInputTokens }) }
}
