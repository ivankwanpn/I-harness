/**
 * M3's last deliverable: the in-process diagnostic metrics registry — and M5's
 * precondition, in the roadmap's own words: *"T2 受益於 M3（沒有 token 會計就無法
 * 展示快取連續性）"*.
 *
 * WHY IT IS A SINK. Measured before building: `token/usage` is already DECLARED
 * (`manifest.ts:29`) and already emitted (`core-agent`), and **nothing accumulates
 * it**. So the missing piece is not an event, it is the accumulator — and the
 * stream already carries every fact this needs. A sink costs **zero emit sites**
 * and cannot drift from the events it counts, which a parallel set of counters
 * maintained by hand would.
 *
 * WHAT IT IS NOT. It is not a second event vocabulary and it does not decide
 * anything; it counts what arrives and hands back a copy.
 */

import type { TelemetryEvent, TelemetrySink } from "./types.ts"

/** A read-only view. Every field is a COPY — a reader cannot mutate the counters
 * it is reading, which would make two readers disagree with no way to tell. */
export interface MetricsSnapshot {
  /** Event type → count. Keyed on whatever ARRIVES, not on the declared union:
   * an event added later must not be silently invisible, because "no metric"
   * reads exactly like "no problem". */
  events: Record<string, number>
  /** Accumulated `token/usage` fields, summed across events — OUR estimate. */
  tokens: Record<string, number>
  /** Accumulated `provider/usage` fields — what the provider SAID. The
   * denominator for every number here is `events["provider/usage"]`, so "the
   * provider reported zero" stays distinguishable from "nobody reported"; an
   * unreported field is ABSENT, never a fabricated 0. */
  reported: Record<string, number>
  /** Tool outcomes by tool name (`tool/end` vs `tool/error`). */
  tools: Record<string, { ok: number; error: number }>
}

export interface MetricsSink extends TelemetrySink {
  snapshot(): MetricsSnapshot
}

export function createMetricsSink(): MetricsSink {
  const events = new Map<string, number>()
  const tokens = new Map<string, number>()
  const reported = new Map<string, number>()
  const tools = new Map<string, { ok: number; error: number }>()

  return {
    onEvent(ev: TelemetryEvent): void {
      events.set(ev.type, (events.get(ev.type) ?? 0) + 1)

      // Two bags, deliberately: `tokens` is OUR estimate (activeTokens over the
      // derived surface) and `reported` is what the provider SAID. T2 exists to
      // separate the two, so sharing one bag would erase the distinction the
      // milestone is made of.
      if (ev.type === "token/usage" || ev.type === "provider/usage") {
        const bag = ev.type === "provider/usage" ? reported : tokens
        for (const [field, value] of Object.entries(ev.data)) {
          // A number that is not a number poisons every later sum, and NaN reads
          // as a measurement. Dropping it is the honest failure.
          if (typeof value === "number" && Number.isFinite(value)) {
            bag.set(field, (bag.get(field) ?? 0) + value)
          }
        }
        return
      }

      if (ev.type === "tool/end" || ev.type === "tool/error") {
        const name = typeof ev.data.tool === "string" ? ev.data.tool : "unknown"
        const row = tools.get(name) ?? { ok: 0, error: 0 }
        if (ev.type === "tool/end") row.ok += 1
        else row.error += 1
        tools.set(name, row)
      }
    },

    snapshot(): MetricsSnapshot {
      return {
        events: Object.fromEntries(events),
        tokens: Object.fromEntries(tokens),
        reported: Object.fromEntries(reported),
        tools: Object.fromEntries([...tools].map(([name, row]) => [name, { ...row }])),
      }
    },
  }
}
