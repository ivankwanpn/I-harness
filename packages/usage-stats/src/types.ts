/** Public data-only contract. No prompts, response content or credentials. */
export interface UsageRecord {
  id: string
  startedAt: number
  durationMs: number
  firstTokenMs?: number
  workspace: string
  projectId?: string
  sessionId?: string
  providerId: string
  modelId: string
  billing: "api" | "subscription" | "unknown"
  status: "completed" | "failed" | "cancelled"
  inputTokens?: number
  outputTokens?: number
  cacheReadTokens?: number
  cacheCreationTokens?: number
  inputTokenSemantics?: "includes-cache" | "excludes-cache"
}
export interface UsagePrice {
  providerId: string
  modelId: string
  inputPerMillion: number
  outputPerMillion: number
  cacheReadPerMillion?: number
  cacheCreationPerMillion?: number
  source: string
  updatedAt: number
}
export interface UsageQuery {
  start: number
  end: number
  timeZone: string
  workspace?: string
  projectId?: string
  providerId?: string
  modelId?: string
  page?: number
  pageSize?: number
  sort?: "newest" | "oldest" | "tokens"
}
export interface UsageTotals {
  /** Disjoint chart buckets over the same measured requests as totalTokens. */
  chartTokens?: { uncachedInputTokens: number; cacheReadTokens: number; cacheCreationTokens: number; outputTokens: number; unclassifiedTokens: number } | null
  requests: number
  completed: number
  failed: number
  cancelled: number
  inputTokens: number | null
  uncachedInputTokens: number | null
  outputTokens: number | null
  cacheReadTokens: number | null
  cacheCreationTokens: number | null
  totalTokens: number | null
  cacheHitRate: number | null
  measuredRequests: number
  cacheMeasuredRequests: number
  estimatedCostUsd: number | null
  pricedRequests: number
  subscriptionRequests: number
}
export interface UsageDetail extends UsageRecord {
  totalInputTokens: number | null
  uncachedInputTokens: number | null
  totalTokens: number | null
  estimatedCostUsd: number | null
  price?: UsagePrice
}
export interface UsageGroup extends UsageTotals { key: string; label: string }
export interface UsageSnapshot {
  generatedAt: number
  summary: UsageTotals
  daily: Array<UsageTotals & { date: string }>
  models: UsageGroup[]
  providers: UsageGroup[]
  records: UsageDetail[]
  totalRecords: number
  page: number
  pageSize: number
  options: { workspaces: string[]; projects: string[]; providers: string[]; models: string[] }
  prices: UsagePrice[]
  warnings: string[]
  recordingSince?: number
}
