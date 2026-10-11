import type { UsageTotals } from "@i-harness/usage-stats"

export type UsageRange = "today" | "7" | "30" | "custom"
export function localDate(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`
}
function parseLocalDate(value: string): Date | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return null
  const date = new Date(`${value}T00:00:00`)
  return Number.isFinite(date.getTime()) && localDate(date) === value ? date : null
}
/** End is exclusive; date arithmetic preserves local midnight through DST changes. */
export function usageDateRange(preset: UsageRange, start: string, end: string, now = new Date()): { start: number; end: number } | null {
  const first = preset === "custom" ? parseLocalDate(start) : new Date(now.getFullYear(), now.getMonth(), now.getDate())
  const last = preset === "custom" ? parseLocalDate(end) : new Date(now.getFullYear(), now.getMonth(), now.getDate())
  if (!first || !last || first > last) return null
  if (preset !== "custom") first.setDate(first.getDate() - (preset === "today" ? 0 : Number(preset) - 1))
  last.setDate(last.getDate() + 1)
  if (first.getTime() < 0 || last.getTime() - first.getTime() > 366 * 86_400_000) return null
  return { start: first.getTime(), end: last.getTime() }
}
export function usageCalendar(start: number, end: number): string[] {
  const result: string[] = []
  for (const date = new Date(start); date.getTime() < end && result.length < 367; date.setDate(date.getDate() + 1)) result.push(localDate(date))
  return result
}
export type UsageText = (zh: string, en: string) => string

/** Plot disjoint buckets from the same complete-total request cohort. */
export function usageTokenSegments(day: UsageTotals): Array<number | null> {
  if (day.chartTokens) {
    const tokens = day.chartTokens
    return [tokens.uncachedInputTokens, tokens.cacheReadTokens, tokens.cacheCreationTokens, tokens.outputTokens, tokens.unclassifiedTokens]
  }
  // Older snapshots have no trustworthy bucket cohort. Preserve the known total
  // without inventing a breakdown from fields that may cover different calls.
  return day.totalTokens === null ? [null, null, null, null, null] : [0, 0, 0, 0, day.totalTokens]
}

/** Separate measured runs so lines/areas never connect across unknown days. */
export function usageTrendRuns(values: Array<number | null>): Array<Array<{ index: number; value: number }>> {
  const runs: Array<Array<{ index: number; value: number }>> = []
  let current: Array<{ index: number; value: number }> = []
  values.forEach((value, index) => {
    if (value === null) { current = []; return }
    if (!current.length) runs.push(current)
    current.push({ index, value })
  })
  return runs
}
