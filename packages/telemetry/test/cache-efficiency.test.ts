import { expect, it } from "vitest"
import { createMetricsSink } from "../src/metrics.ts"
import type { TelemetryEvent } from "../src/types.ts"

it("weights measured cache hits by their input totals without treating unknown measurements as misses", () => {
  const sink = createMetricsSink()
  const emit = (data: Record<string, unknown>) => sink.onEvent({ type: "provider/cache", ts: 1, data } as unknown as TelemetryEvent)
  emit({ cacheReadReported: false, totalInputTokens: 10000 })
  emit({ cacheReadReported: true, totalInputTokens: 1000, cacheReadTokens: 900, cacheReadRatio: .9 })
  emit({ cacheReadReported: true, totalInputTokens: 2000, cacheReadTokens: 0, cacheReadRatio: 0 })
  expect((sink.snapshot() as unknown as { cache: unknown }).cache).toEqual({ requests: 3, inputMeasured: 3, cacheMeasured: 2, totalInputTokens: 3000, cacheReadTokens: 900, cacheReadRatio: .3 })
})

it("does not fabricate totals or ratios without a measured valid cache sample", () => {
  const sink = createMetricsSink()
  sink.onEvent({ type: "provider/cache", ts: 1, data: { cacheReadReported: false } } as unknown as TelemetryEvent)
  expect((sink.snapshot() as unknown as { cache: unknown }).cache).toEqual({ requests: 1, inputMeasured: 0, cacheMeasured: 0 })
})
