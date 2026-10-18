import type { UsageDetail, UsageGroup, UsagePrice, UsageQuery, UsageRecord, UsageSnapshot, UsageTotals } from "./types.js"
import { validateRequestMetrics } from "./request-metrics.js"

const DAY = 86_400_000
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Expected an object")
  return value as Record<string, unknown>
}
function text(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim() || value.length > 4096) throw new Error(`Invalid ${field}`)
  return value
}
function number(value: unknown, field: string, integer = false): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || (integer && !Number.isSafeInteger(value))) throw new Error(`Invalid ${field}`)
  return value
}
function choice<const T extends string>(value: unknown, choices: readonly T[], field: string): T {
  if (!choices.includes(value as T)) throw new Error(`Invalid ${field}`)
  return value as T
}

/** Returns only the allowlisted data contract; unknown content never reaches disk. */
export function validateUsageRecord(value: unknown): UsageRecord {
  const r = object(value)
  const result: UsageRecord = {
    id: text(r.id, "id"), startedAt: number(r.startedAt, "startedAt", true), durationMs: number(r.durationMs, "durationMs"),
    workspace: text(r.workspace, "workspace"), providerId: text(r.providerId, "providerId"), modelId: text(r.modelId, "modelId"),
    billing: choice(r.billing, ["api", "subscription", "unknown"], "billing"), status: choice(r.status, ["completed", "failed", "cancelled"], "status"),
  }
  if (!Number.isFinite(new Date(result.startedAt).getTime())) throw new Error("Invalid startedAt")
  if (r.requestMetrics !== undefined) result.requestMetrics = validateRequestMetrics(r.requestMetrics)
  if (r.sessionId !== undefined) result.sessionId = text(r.sessionId, "sessionId")
  if (r.projectId !== undefined) result.projectId = text(r.projectId, "projectId")
  if (r.firstTokenMs !== undefined) result.firstTokenMs = number(r.firstTokenMs, "firstTokenMs")
  for (const key of ["inputTokens", "outputTokens", "cacheReadTokens", "cacheCreationTokens"] as const) {
    if (r[key] !== undefined) result[key] = number(r[key], key, true)
  }
  if (r.inputTokenSemantics !== undefined) result.inputTokenSemantics = choice(r.inputTokenSemantics, ["includes-cache", "excludes-cache"], "inputTokenSemantics")
  if (result.inputTokenSemantics === "includes-cache" && result.inputTokens !== undefined &&
    (result.cacheReadTokens ?? 0) + (result.cacheCreationTokens ?? 0) > result.inputTokens) throw new Error("Cache tokens exceed total input")
  return result
}

export function validateUsagePrice(value: unknown): UsagePrice {
  const p = object(value)
  const result: UsagePrice = {
    providerId: text(p.providerId, "providerId"), modelId: text(p.modelId, "modelId"),
    inputPerMillion: number(p.inputPerMillion, "inputPerMillion"), outputPerMillion: number(p.outputPerMillion, "outputPerMillion"),
    source: text(p.source, "source"), updatedAt: number(p.updatedAt, "updatedAt", true),
  }
  for (const key of ["cacheReadPerMillion", "cacheCreationPerMillion"] as const) if (p[key] !== undefined) result[key] = number(p[key], key)
  return result
}

export function validateUsageQuery(value: unknown): UsageQuery {
  const q = object(value)
  const result: UsageQuery = { start: number(q.start, "start", true), end: number(q.end, "end", true), timeZone: text(q.timeZone, "timeZone") }
  if (result.end <= result.start || result.end - result.start > 366 * DAY || !Number.isFinite(new Date(result.end).getTime())) throw new Error("Usage range must be between 1 millisecond and 366 days")
  if (/^[+-]/.test(result.timeZone)) throw new Error("Invalid timeZone: use an IANA time zone")
  try { new Intl.DateTimeFormat("en", { timeZone: result.timeZone }).format(result.start) } catch { throw new Error("Invalid timeZone") }
  for (const key of ["workspace", "projectId", "providerId", "modelId"] as const) if (q[key] !== undefined) result[key] = text(q[key], key)
  result.page = q.page === undefined ? 1 : number(q.page, "page", true)
  result.pageSize = q.pageSize === undefined ? 50 : number(q.pageSize, "pageSize", true)
  if (result.page < 1 || result.page > 1_000_000 || result.pageSize < 1 || result.pageSize > 200) throw new Error("Invalid pagination")
  result.sort = q.sort === undefined ? "newest" : choice(q.sort, ["newest", "oldest", "tokens"], "sort")
  return result
}

function safeNumber(value: number | null, warnings: string[], integer = true): number | null {
  if (value === null || (Number.isFinite(value) && (!integer || Number.isSafeInteger(value)))) return value
  if (!warnings.includes("Some usage values exceeded the supported numeric range and are unavailable.")) warnings.push("Some usage values exceeded the supported numeric range and are unavailable.")
  return null
}

function detail(r: UsageRecord, prices: UsagePrice[], warnings: string[]): UsageDetail {
  const input = r.inputTokens ?? null
  const read = r.cacheReadTokens ?? null
  const creation = r.cacheCreationTokens ?? null
  const bucketsKnown = input !== null && read !== null && creation !== null
  const totalInputTokens = safeNumber(r.inputTokenSemantics === "includes-cache" ? input :
    r.inputTokenSemantics === "excludes-cache" && bucketsKnown ? input + read + creation : null, warnings)
  const uncachedInputTokens = r.inputTokenSemantics === "excludes-cache" ? input :
    r.inputTokenSemantics === "includes-cache" && bucketsKnown ? input - read - creation : null
  const totalTokens = safeNumber(totalInputTokens !== null && r.outputTokens !== undefined ? totalInputTokens + r.outputTokens : null, warnings)
  const price = prices.find(p => p.providerId === r.providerId && p.modelId === r.modelId)
  let estimatedCostUsd: number | null = null
  if (r.billing === "api" && price && uncachedInputTokens !== null && r.outputTokens !== undefined && read !== null && creation !== null &&
      (read === 0 || price.cacheReadPerMillion !== undefined) && (creation === 0 || price.cacheCreationPerMillion !== undefined)) {
    estimatedCostUsd = safeNumber((uncachedInputTokens * price.inputPerMillion + r.outputTokens * price.outputPerMillion + read * (price.cacheReadPerMillion ?? 0) + creation * (price.cacheCreationPerMillion ?? 0)) / 1_000_000, warnings, false)
  }
  return { ...r, totalInputTokens, uncachedInputTokens, totalTokens, estimatedCostUsd, ...(price ? { price } : {}) }
}

function chartBuckets(records: UsageDetail[], totalTokens: number | null, warnings: string[]): UsageTotals["chartTokens"] {
  if (totalTokens === null) return null
  const buckets = { uncachedInputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, outputTokens: 0, unclassifiedTokens: 0 }
  for (const record of records) {
    if (record.totalTokens === null) continue
    const uncached = record.uncachedInputTokens ?? 0
    const read = record.cacheReadTokens ?? 0
    const creation = record.cacheCreationTokens ?? 0
    buckets.uncachedInputTokens += uncached
    buckets.cacheReadTokens += read
    buckets.cacheCreationTokens += creation
    buckets.outputTokens += record.outputTokens!
    // A missing breakdown stays explicitly unclassified, rather than silently
    // becoming uncached input. These buckets share totalTokens' exact coverage.
    buckets.unclassifiedTokens += record.totalInputTokens! - uncached - read - creation
  }
  return Object.values(buckets).every(value => safeNumber(value, warnings) !== null) ? buckets : null
}

function totals(records: UsageDetail[], warnings: string[]): UsageTotals {
  const sum = (key: keyof UsageDetail): number | null => {
    const values = records.map(r => r[key]).filter((n): n is number => typeof n === "number")
    return values.length ? safeNumber(values.reduce((a, b) => a + b, 0), warnings, key !== "estimatedCostUsd") : records.length ? null : 0
  }
  const cache = records.filter(r => r.totalInputTokens !== null && r.cacheReadTokens !== undefined)
  const denominator = safeNumber(cache.reduce((n, r) => n + r.totalInputTokens!, 0), warnings)
  const totalTokens = sum("totalTokens")
  return {
    requests: records.length, completed: records.filter(r => r.status === "completed").length,
    failed: records.filter(r => r.status === "failed").length, cancelled: records.filter(r => r.status === "cancelled").length,
    inputTokens: sum("totalInputTokens"), uncachedInputTokens: sum("uncachedInputTokens"), outputTokens: sum("outputTokens"),
    cacheReadTokens: sum("cacheReadTokens"), cacheCreationTokens: sum("cacheCreationTokens"), totalTokens,
    chartTokens: chartBuckets(records, totalTokens, warnings),
    cacheHitRate: denominator !== null && denominator > 0 ? cache.reduce((n, r) => n + r.cacheReadTokens!, 0) / denominator : null,
    measuredRequests: records.filter(r => r.totalTokens !== null).length, cacheMeasuredRequests: cache.length,
    estimatedCostUsd: sum("estimatedCostUsd"), pricedRequests: records.filter(r => r.estimatedCostUsd !== null).length,
    subscriptionRequests: records.filter(r => r.billing === "subscription").length,
  }
}

/** Pure aggregation; totals with partial coverage sum only reported observations. */
export function aggregateUsage(records: UsageRecord[], input: UsageQuery, prices: UsagePrice[] = [], warnings: string[] = []): UsageSnapshot {
  warnings = [...warnings]
  const query = validateUsageQuery(input)
  const valid = records.map(validateUsageRecord)
  const validPrices = prices.map(validateUsagePrice).sort((a, b) => b.updatedAt - a.updatedAt)
  const filtered = valid.filter(r => r.startedAt >= query.start && r.startedAt < query.end &&
    (!query.workspace || r.workspace === query.workspace) && (!query.projectId || r.projectId === query.projectId) && (!query.providerId || r.providerId === query.providerId) && (!query.modelId || r.modelId === query.modelId)).map(r => detail(r, validPrices, warnings))
  const groups = (key: "providerId" | "modelId"): UsageGroup[] => {
    const map = new Map<string, UsageDetail[]>()
    for (const r of filtered) { const group = map.get(r[key]) ?? []; group.push(r); map.set(r[key], group) }
    return [...map].map(([key, values]) => ({ key, label: key, ...totals(values, warnings) })).sort((a, b) => (b.totalTokens ?? -1) - (a.totalTokens ?? -1) || a.key.localeCompare(b.key))
  }
  const formatter = new Intl.DateTimeFormat("en-CA", { timeZone: query.timeZone, year: "numeric", month: "2-digit", day: "2-digit" })
  const localDate = (timestamp: number): string => {
    const parts = formatter.formatToParts(timestamp)
    return ["year", "month", "day"].map(type => parts.find(p => p.type === type)!.value).join("-")
  }
  const buckets = new Map<string, UsageDetail[]>()
  const first = localDate(query.start), last = localDate(query.end - 1)
  for (let day = Date.parse(`${first}T00:00:00Z`); day <= Date.parse(`${last}T00:00:00Z`); day += DAY) buckets.set(new Date(day).toISOString().slice(0, 10), [])
  for (const r of filtered) buckets.get(localDate(r.startedAt))?.push(r)
  filtered.sort((a, b) => (query.sort === "tokens" ? (b.totalTokens ?? -1) - (a.totalTokens ?? -1) : 0) ||
    (query.sort === "oldest" ? a.startedAt - b.startedAt : b.startedAt - a.startedAt) || a.id.localeCompare(b.id))
  const options = (key: "workspace" | "projectId" | "providerId" | "modelId") => [...new Set(valid.map(r => r[key]).filter((value): value is string => value !== undefined))].sort()
  const page = query.page!, pageSize = query.pageSize!
  return {
    generatedAt: Date.now(), summary: totals(filtered, warnings), daily: [...buckets].map(([date, rows]) => ({ date, ...totals(rows, warnings) })),
    models: groups("modelId"), providers: groups("providerId"), records: filtered.slice((page - 1) * pageSize, page * pageSize),
    totalRecords: filtered.length, page, pageSize, options: { workspaces: options("workspace"), projects: options("projectId"), providers: options("providerId"), models: options("modelId") },
    prices: validPrices, warnings: [...warnings], ...(valid.length ? { recordingSince: valid.reduce((earliest, r) => Math.min(earliest, r.startedAt), Infinity) } : {}),
  }
}
