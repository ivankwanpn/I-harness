/** Content-free allowlist shared by the gateway producer and desktop journal. */
export interface CompactionDiagnostic {
  blockedReason?: string
  operation: "summary" | "attempt"
  providerId?: string; modelId?: string
  reason?: "auto" | "manual" | "recovery"
  outcome?: "skipped" | "prune-only" | "failure" | "success"
  inputTokens?: number; contextWindow?: number; outputReserve?: number; effectiveCap?: number
  minimumCap?: number; reasoningBudget?: number; defaultFloorAdjusted?: boolean
  capSupport?: "supported" | "unsupported" | "unknown"
  coverage?: "complete" | "neutral-only" | "incomplete"
  estimateSource?: "projected-heuristic"
  tokensBefore?: number; tokensAfter?: number; durationMs?: number; attempts?: number; shadowed?: number; pruned?: number
}
/** Only engine-derived explanations; never arbitrary summarizer/provider text. */
export function safeCompactionBlockedReason(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length > 256) return
  const numeric = "(?:[0-9]{1,16}|unknown)"
  const templates = [
    `retained checkpoint ceiling ${numeric} chars is below quality floor ${numeric}`,
    `summary output ceiling ${numeric} cannot provide reasoning/retention allowance ${numeric}`,
    `indivisible/fixed summary input cannot fit \\(${numeric} input tokens; ${numeric} required output; window ${numeric}\\)`,
    `shared summary call limit exhausted \\(${numeric}\\)`,
    `retained summary outside quality/size limits \\(${numeric} chars; floor ${numeric}; ceiling ${numeric}\\)`,
    "maxSummaryCalls must be an integer in \\[1, 8\\]", "summary overflow shrink limit exhausted \\(2\\)",
    "summary binding does not match prepared model", "summary fixed input contains unpriced provider references",
    "the provider refused to produce a summary", "provider truncated the summary; checkpoint was not committed", "incomplete summary stream; checkpoint was not committed",
  ]
  return templates.some(template => new RegExp(`^compaction: ${template}$`).test(value)) ? value : undefined
}
export function safeCompactionDiagnostic(value: unknown): CompactionDiagnostic | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return
  const r = value as Record<string, unknown>
  if (r.operation !== "summary" && r.operation !== "attempt") return
  const result: CompactionDiagnostic = { operation: r.operation }
  for (const key of ["providerId", "modelId"] as const)
    if (typeof r[key] === "string" && /^[a-zA-Z0-9._:/-]{1,128}$/.test(r[key])) result[key] = r[key]
  for (const key of ["inputTokens", "contextWindow", "outputReserve", "effectiveCap", "minimumCap", "reasoningBudget", "tokensBefore", "tokensAfter", "durationMs", "attempts", "shadowed", "pruned"] as const) {
    if (r[key] !== undefined) {
      if (typeof r[key] !== "number" || !Number.isSafeInteger(r[key]) || r[key] < 0) return
      result[key] = r[key]
    }
  }
  const enums = { reason: ["auto", "manual", "recovery"], outcome: ["skipped", "prune-only", "failure", "success"],
    capSupport: ["supported", "unsupported", "unknown"], coverage: ["complete", "neutral-only", "incomplete"], estimateSource: ["projected-heuristic"] }
  for (const key of Object.keys(enums) as (keyof typeof enums)[]) {
    if (r[key] === undefined) continue
    if (typeof r[key] !== "string" || !enums[key].includes(r[key])) return
    Object.assign(result, { [key]: r[key] })
  }
  if (typeof r.defaultFloorAdjusted === "boolean") result.defaultFloorAdjusted = r.defaultFloorAdjusted
  const blockedReason = safeCompactionBlockedReason(r.blockedReason)
  if (blockedReason) result.blockedReason = blockedReason
  return result
}
