import { describe, expect, it } from "vitest"
import * as usage from "../src/aggregate.js"
import type { UsagePrice, UsageQuery, UsageRecord } from "../src/types.js"

const start = Date.parse("2026-10-09T00:00:00Z")
const query: UsageQuery = { start, end: start + 3 * 86_400_000, timeZone: "UTC" }
function record(id: string, fields: Partial<UsageRecord> = {}): UsageRecord {
  return { id, startedAt: start, durationMs: 5, workspace: "w", providerId: "p", modelId: "m", billing: "api", status: "completed", ...fields }
}
const measured = { inputTokens: 100, outputTokens: 20, cacheReadTokens: 80, cacheCreationTokens: 0, inputTokenSemantics: "includes-cache" as const }
const price: UsagePrice = { providerId: "p", modelId: "m", inputPerMillion: 10, outputPerMillion: 20, cacheReadPerMillion: 1, source: "user", updatedAt: start }

describe("usage aggregation", () => {
  it("normalizes includes/excludes cache without counting cache twice", () => {
    expect(usage.aggregateUsage).toBeTypeOf("function")
    for (const fields of [measured, { ...measured, inputTokens: 20, inputTokenSemantics: "excludes-cache" as const }]) {
      const value = usage.aggregateUsage([record("r", fields)], query)
      expect(value.summary).toMatchObject({ inputTokens: 100, uncachedInputTokens: 20, outputTokens: 20, totalTokens: 120, cacheHitRate: 0.8, measuredRequests: 1, cacheMeasuredRequests: 1 })
    }
  })
  it("preserves absent measurements and excludes incomplete records from weighted hit denominators", () => {
    const value = usage.aggregateUsage([record("a", measured), record("b", { inputTokens: 900, outputTokens: 10, inputTokenSemantics: "includes-cache" }), record("c")], query)
    expect(value.summary).toMatchObject({ requests: 3, totalTokens: 1030, measuredRequests: 2, cacheHitRate: 0.8, cacheMeasuredRequests: 1 })
    expect(value.records.find(r => r.id === "c")).toMatchObject({ totalInputTokens: null, totalTokens: null, estimatedCostUsd: null })
    expect(usage.aggregateUsage([record("x", { inputTokens: 20, outputTokens: 5 })], query).summary.totalTokens).toBeNull()
  })
  it("requires known buckets/prices and never prices subscription requests", () => {
    const value = usage.aggregateUsage([record("a", measured), record("s", { ...measured, billing: "subscription" }), record("partial", { ...measured, cacheCreationTokens: undefined })], query, [price])
    expect(value.summary).toMatchObject({ pricedRequests: 1, subscriptionRequests: 1 })
    expect(value.summary.estimatedCostUsd).toBeCloseTo(0.00068)
    expect(value.records.find(r => r.id === "s")?.estimatedCostUsd).toBeNull()
    expect(value.records.find(r => r.id === "partial")?.estimatedCostUsd).toBeNull()
    expect(usage.aggregateUsage([record("x", { ...measured, cacheReadTokens: 0 })], query, [{ ...price, cacheReadPerMillion: undefined }]).summary.pricedRequests).toBe(1)
  })
  it("uses half-open boundaries, local calendar buckets, stable pages and all-history filter options", () => {
    const records = [record("before", { startedAt: start - 1, workspace: "old" }), record("a", measured), record("b", { ...measured, startedAt: start + 60_000 }), record("end", { startedAt: query.end })]
    const value = usage.aggregateUsage(records, { ...query, timeZone: "America/Los_Angeles", pageSize: 1, page: 2 })
    expect(value.totalRecords).toBe(2)
    expect(value.records.map(r => r.id)).toEqual(["a"])
    expect(value.daily.map(d => [d.date, d.requests])).toEqual([["2026-10-08", 2], ["2026-10-09", 0], ["2026-10-10", 0], ["2026-10-11", 0]])
    expect(value.options.workspaces).toEqual(["old", "w"])
    expect(usage.aggregateUsage(records, { ...query, workspace: "old" }).summary.requests).toBe(0)
    expect(value.models[0]).toMatchObject({ key: "m", requests: 2, totalTokens: 240 })
  })
  it("rejects invalid ranges, zones, paging and invalid token data", () => {
    for (const invalid of [{ end: start }, { timeZone: "Invalid" }, { pageSize: 1001 }, { page: -1 }, { end: start + 367 * 86_400_000 }]) {
      expect(() => usage.aggregateUsage([], { ...query, ...invalid })).toThrow()
    }
    expect(() => usage.aggregateUsage([record("a", { inputTokens: -1 })], query)).toThrow()
    expect(() => usage.aggregateUsage([record("a", { ...measured, cacheReadTokens: 101 })], query)).toThrow()
  })
  it("never returns nonfinite estimates or unsafe token totals", () => {
    const value = usage.aggregateUsage([record("a", measured)], query, [{ ...price, inputPerMillion: Number.MAX_VALUE }])
    expect(value.summary.estimatedCostUsd).toBeNull()
    expect(value.summary.pricedRequests).toBe(0)
    expect(value.warnings.length).toBeGreaterThan(0)
    const huge = usage.aggregateUsage([record("a", { ...measured, inputTokens: Number.MAX_SAFE_INTEGER }), record("b", measured)], query)
    expect(huge.summary.totalTokens).toBe(120)
    expect(huge.records.find(r => r.id === "a")?.totalTokens).toBeNull()
    expect(huge.summary.inputTokens).toBeNull()
    expect(huge.warnings.length).toBeGreaterThan(0)
  })
  it("weights hit rates by tokens rather than averaging request percentages", () => {
    const value = usage.aggregateUsage([record("a", measured), record("b", { ...measured, inputTokens: 900, cacheReadTokens: 0 })], query)
    expect(value.summary.cacheHitRate).toBe(0.08)
  })
  it("buckets the repeated DST hour on one local day and fills an empty calendar day", () => {
    const value = usage.aggregateUsage([
      record("a", { startedAt: Date.parse("2026-11-01T08:30:00Z") }),
      record("b", { startedAt: Date.parse("2026-11-01T09:30:00Z") }),
    ], { start: Date.parse("2026-11-01T07:00:00Z"), end: Date.parse("2026-11-03T08:00:00Z"), timeZone: "America/Los_Angeles" })
    expect(value.daily.map(d => [d.date, d.requests, d.totalTokens])).toEqual([["2026-11-01", 2, null], ["2026-11-02", 0, 0]])
  })
  it("validates source provenance and requires an IANA zone instead of an offset", () => {
    expect(() => usage.validateUsagePrice({ ...price, source: "   " })).toThrow(/source/)
    expect(() => usage.validateUsageQuery({ ...query, timeZone: "+01:00" })).toThrow(/timeZone/)
    expect(() => usage.validateUsageRecord(record("a", { outputTokens: 1.5 }))).toThrow(/outputTokens/)
  })
  it("filters project scope without losing available projects from other history", () => {
    const records = [record("a", { projectId: "alpha" }), record("b", { projectId: "beta" }), record("c")]
    const value = usage.aggregateUsage(records, { ...query, projectId: "alpha" })
    expect(value.totalRecords).toBe(1)
    expect(value.records[0].projectId).toBe("alpha")
    expect(value.options.projects).toEqual(["alpha", "beta"])
  })
  it("uses the measured total coverage for chart buckets instead of adding output-only requests", () => {
    const value = usage.aggregateUsage([record("full", measured), record("output-only", { outputTokens: 100 })], query)
    expect(value.summary.totalTokens).toBe(120)
    expect(value.summary.outputTokens).toBe(120)
    const buckets = { uncachedInputTokens: 20, cacheReadTokens: 80, cacheCreationTokens: 0, outputTokens: 20, unclassifiedTokens: 0 }
    expect(value.summary.chartTokens).toEqual(buckets)
    expect(value.daily[0].chartTokens).toEqual(buckets)
    expect(value.models[0].chartTokens).toEqual(buckets)
    expect(value.providers[0].chartTokens).toEqual(buckets)
  })
  it("retains known cache buckets and labels the remaining input as unclassified", () => {
    const value = usage.aggregateUsage([record("partial-breakdown", { inputTokens: 100, cacheReadTokens: 80, outputTokens: 20, inputTokenSemantics: "includes-cache" })], query)
    expect(value.summary.totalTokens).toBe(120)
    expect(value.summary.chartTokens).toEqual({ uncachedInputTokens: 0, cacheReadTokens: 80, cacheCreationTokens: 0, outputTokens: 20, unclassifiedTokens: 20 })
    expect(usage.aggregateUsage([record("unknown", { outputTokens: 10 })], query).summary.chartTokens).toBeNull()
    expect(usage.aggregateUsage([], query).summary.chartTokens).toEqual({ uncachedInputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, outputTokens: 0, unclassifiedTokens: 0 })
  })
  it("makes the whole chart unavailable when measured total aggregation overflows", () => {
    const value = usage.aggregateUsage([record("a", { ...measured, inputTokens: Number.MAX_SAFE_INTEGER - 100 }), record("b", measured)], query)
    expect(value.summary.totalTokens).toBeNull()
    expect(value.summary.chartTokens).toBeNull()
    expect(value.warnings.length).toBeGreaterThan(0)
  })
})
