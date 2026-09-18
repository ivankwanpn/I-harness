import { describe, expect, it } from "vitest"
import { createMetricsSink } from "../src/index.ts"
import type { TelemetryEvent } from "../src/index.ts"

// M3's last deliverable — the in-process diagnostic metrics registry — and it is
// also **M5's precondition**, in the roadmap's own words: "T2 受益於 M3（沒有 token
// 會計就無法展示快取連續性）".
//
// Measured before building: `token/usage` is already DECLARED in the manifest
// (manifest.ts:29) and already emitted (core-agent), and **nothing accumulates
// it**. So the missing piece is not an event, it is the ACCUMULATOR.
//
// It is a TelemetrySink rather than a new call site everywhere: the stream
// already carries every fact this needs, so a sink costs zero emit sites and
// cannot drift from the events it counts.

const ev = (type: string, data: Record<string, unknown> = {}): TelemetryEvent =>
  ({ type, ts: 0, data }) as TelemetryEvent

describe("createMetricsSink", () => {
  it("counts events by type", () => {
    const m = createMetricsSink()
    m.onEvent(ev("turn/start"))
    m.onEvent(ev("turn/start"))
    m.onEvent(ev("tool/start"))
    expect(m.snapshot().events).toEqual({ "turn/start": 2, "tool/start": 1 })
  })

  it("accumulates token/usage by field — the accounting M5 needs", () => {
    const m = createMetricsSink()
    m.onEvent(ev("token/usage", { input: 100, output: 20 }))
    m.onEvent(ev("token/usage", { input: 50, output: 5 }))
    expect(m.snapshot().tokens).toEqual({ input: 150, output: 25 })
  })

  it("tracks tool outcomes per tool, and a failure is not an 'ok'", () => {
    const m = createMetricsSink()
    m.onEvent(ev("tool/end", { tool: "read" }))
    m.onEvent(ev("tool/end", { tool: "read" }))
    m.onEvent(ev("tool/error", { tool: "read" }))
    m.onEvent(ev("tool/error", { tool: "bash" }))
    expect(m.snapshot().tools).toEqual({ read: { ok: 2, error: 1 }, bash: { ok: 0, error: 1 } })
  })

  it("an UNKNOWN event type still counts — a new event must not be invisible", () => {
    // The failure this pins: a sink that switches on the declared union would
    // silently drop any event added later, and "no metric" reads exactly like
    // "no problem". The counter is keyed on whatever arrives.
    const m = createMetricsSink()
    m.onEvent(ev("something/added-next-year"))
    expect(m.snapshot().events["something/added-next-year"]).toBe(1)
  })

  it("the snapshot is a COPY — a reader cannot mutate the accumulator", () => {
    const m = createMetricsSink()
    m.onEvent(ev("turn/start"))
    const first = m.snapshot()
    first.events["turn/start"] = 999
    expect(m.snapshot().events["turn/start"]).toBe(1)
  })

  it("a non-numeric token field is ignored, never accumulated as NaN", () => {
    // A number that is not a number poisons every later sum, and NaN reads as a
    // measurement. Dropping it is the honest failure.
    const m = createMetricsSink()
    m.onEvent(ev("token/usage", { input: 100 }))
    m.onEvent(ev("token/usage", { input: "not-a-number", output: null }))
    expect(m.snapshot().tokens).toEqual({ input: 100 })
  })

  // T2 (M5): the provider's REPORT and our own ESTIMATE are two different facts.
  // `token/usage` carries `activeTokens` — a heuristic over the derived surface.
  // `provider/usage` carries what the wire actually said. Putting them in one bag
  // would erase the only distinction the milestone exists to make.
  it("accumulates provider-REPORTED usage in its own section, never with our estimate", () => {
    const m = createMetricsSink()
    m.onEvent(ev("token/usage", { tokens: 1000 }))
    m.onEvent(ev("provider/usage", { inputTokens: 100, cacheReadTokens: 900 }))
    m.onEvent(ev("provider/usage", { inputTokens: 50, cacheReadTokens: 300 }))
    const s = m.snapshot()
    expect(s.tokens).toEqual({ tokens: 1000 })
    expect(s.reported).toEqual({ inputTokens: 150, cacheReadTokens: 1200 })
  })

  it("'0 cached' and 'nobody reported' are distinguishable — the count is the denominator", () => {
    // The failure this pins: a summary showing `cacheReadTokens: 0` reads as
    // "the cache did nothing" when the truth may be "no provider ever told us".
    // That is the vacuous-detector shape — a check that passes because it never
    // ran. The denominator is the event count, and an unreported field is ABSENT
    // rather than zero.
    const reportedZero = createMetricsSink()
    reportedZero.onEvent(ev("provider/usage", { cacheReadTokens: 0 }))
    const a = reportedZero.snapshot()
    expect(a.events["provider/usage"]).toBe(1)
    expect(a.reported.cacheReadTokens).toBe(0)

    const nobodyReported = createMetricsSink()
    const b = nobodyReported.snapshot()
    expect(b.events["provider/usage"] ?? 0).toBe(0)
    expect("cacheReadTokens" in b.reported).toBe(false)
  })
})
