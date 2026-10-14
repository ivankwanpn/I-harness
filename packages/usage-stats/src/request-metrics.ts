/** Physical prepared request facts, independent of raw provider billing. */
export interface RequestMetrics {
  version: 1
  coverage: "complete" | "neutral-only" | "incomplete"
  capSupport: "supported" | "unsupported" | "unknown"
  sizeKind: "http-json-body" | "sdk-command-estimate" | "neutral-envelope-estimate"
  bodyBytes?: number; sdkCommandBytesEstimate?: number
  inlineBinaryBytes: number; cacheMetadataBytes: number; signatureBytes: number
  systemTokens: number; schemaTokens: number; reasoningTokens: number; imageCount: number
  configuredOutputCap?: number; effectiveOutputCap?: number; minimumOutputCap: number; reasoningBudget?: number
}
export function validateRequestMetrics(value: unknown): RequestMetrics {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid request metrics")
  const r = value as Record<string, unknown>
  if (r.version !== 1 || typeof r.coverage !== "string" || typeof r.capSupport !== "string" || typeof r.sizeKind !== "string" || !["complete", "neutral-only", "incomplete"].includes(String(r.coverage))
    || !["supported", "unsupported", "unknown"].includes(String(r.capSupport))
    || !["http-json-body", "sdk-command-estimate", "neutral-envelope-estimate"].includes(String(r.sizeKind))) throw new Error("Invalid request metrics category")
  const result = { version: 1, coverage: r.coverage, capSupport: r.capSupport, sizeKind: r.sizeKind } as RequestMetrics
  const required = ["inlineBinaryBytes", "cacheMetadataBytes", "signatureBytes", "systemTokens", "schemaTokens", "reasoningTokens", "imageCount", "minimumOutputCap"] as const
  const optional = ["bodyBytes", "sdkCommandBytesEstimate", "configuredOutputCap", "effectiveOutputCap", "reasoningBudget"] as const
  for (const key of [...required, ...optional]) {
    const n = r[key]
    if (n === undefined && optional.includes(key as typeof optional[number])) continue
    if (typeof n !== "number" || !Number.isSafeInteger(n) || n < 0) throw new Error("Invalid numeric request metric")
    result[key] = n
  }
  return result
}
