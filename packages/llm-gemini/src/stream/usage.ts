import type { LLMUsage } from "@i-harness/llm-seam"

/** Counts in GenerateContentResponse are cumulative. Keep the two output
 * components for this response so a later partial report replaces only the
 * component it actually supplied. */
export function createGeminiUsageMapper() {
  let candidates: number | undefined
  let thoughts: number | undefined
  return (raw: unknown): LLMUsage | undefined => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined
    const fields = raw as Record<string, unknown>
    const usage: LLMUsage = {}
    function count(key: string, rawField?: 'inputTokens' | 'cacheReadTokens' | 'outputTokens'): number | undefined {
      const value = fields[key]
      if (value == null) return undefined
      if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) return value
      if (rawField && typeof value === "number" && Number.isFinite(value)) usage[rawField] = value
      usage.measurementValidity = "invalid"
      return undefined
    }
    const input = count("promptTokenCount", "inputTokens"), cache = count("cachedContentTokenCount", "cacheReadTokens")
    const visible = count("candidatesTokenCount", "outputTokens"), reasoning = count("thoughtsTokenCount")
    const total = count("totalTokenCount"), toolPrompt = count("toolUsePromptTokenCount")
    if (input !== undefined) {
      usage.inputTokens = input
      usage.inputTokenSemantics = "includes-cache"
    }
    if (cache !== undefined) usage.cacheReadTokens = cache
    if (input !== undefined && cache !== undefined && cache > input) usage.measurementValidity = "invalid"

    if (visible !== undefined) candidates = visible
    if (reasoning !== undefined) thoughts = reasoning
    if ((visible !== undefined || reasoning !== undefined) && candidates !== undefined) {
      const output = candidates + (thoughts ?? 0)
      if (Number.isSafeInteger(output)) usage.outputTokens = output
      else usage.measurementValidity = "invalid"
    } else if (reasoning !== undefined && input !== undefined && total !== undefined &&
      input + (toolPrompt ?? 0) + reasoning === total) {
      // A thinking-only completion may omit zero candidate tokens. Its
      // complete total leaves no tokens unaccounted for.
      usage.outputTokens = reasoning
    }
    // Cache is already included in input. A provider's internal tool prompt
    // belongs to neither the outgoing client prompt nor generated output.
    if (total !== undefined) {
      const components = (input ?? 0) + (toolPrompt ?? 0) + (visible ?? 0) + (reasoning ?? 0)
      if (components > total || input !== undefined && toolPrompt !== undefined && visible !== undefined && reasoning !== undefined && components !== total)
        usage.measurementValidity = "invalid"
    }
    return Object.keys(usage).length ? usage : undefined
  }
}
