import { expect, it } from "vitest"
import { validateUsageRecord } from "../src/aggregate.js"
import { validateRequestMetrics } from "../src/request-metrics.js"

const metrics = { version: 1, coverage: "complete", capSupport: "unsupported", sizeKind: "http-json-body", bodyBytes: 1000,
  inlineBinaryBytes: 0, cacheMetadataBytes: 4, signatureBytes: 2, systemTokens: 12, schemaTokens: 34, reasoningTokens: 5, imageCount: 0, minimumOutputCap: 1 }
it("persists only the closed physical fact contract without changing raw billing/cache counters", () => {
  const record = validateUsageRecord({ id: "fixture", startedAt: 0, durationMs: 0, workspace: "w", providerId: "p", modelId: "m", billing: "api", status: "completed",
    inputTokens: 100, outputTokens: 7, cacheReadTokens: 80, cacheCreationTokens: 3, requestMetrics: { ...metrics, body: "private", units: ["private"], signature: "private" } })
  expect(record).toMatchObject({ inputTokens: 100, outputTokens: 7, cacheReadTokens: 80, cacheCreationTokens: 3, requestMetrics: metrics })
  expect(JSON.stringify(record)).not.toContain("private")
})
it.each([{ ...metrics, bodyBytes: Infinity }, { ...metrics, coverage: ["complete"] }, { ...metrics, capSupport: "pretend" }, { ...metrics, imageCount: -1 }])("rejects invalid numeric/category facts", value => {
  expect(() => validateRequestMetrics(value)).toThrow()
})
