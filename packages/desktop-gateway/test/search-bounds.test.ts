import { it, expect } from "vitest"
import { boundSearchHits } from "../src/search-bounds.ts"

it("bounds serialized search output with giant tokens and JSON escapes", () => {
  const hits = Array.from({ length: 100 }, (_, seq) => ({
    sessionId: "session", seq, eventType: "user/message" as const, bm25: -1,
    snippet: "needle " + ('字"\\\n').repeat(50000),
  }))
  const result = boundSearchHits(hits)
  expect(Buffer.byteLength(JSON.stringify(result), "utf8")).toBeLessThanOrEqual(16384)
  expect(result.truncated).toBe(true)
  expect(result.hits.length).toBeGreaterThan(0)
  expect(result.hits.every(hit => Buffer.byteLength(hit.snippet, "utf8") <= 512)).toBe(true)
  expect(result.hits[0]?.snippet).not.toContain("\ufffd")
})
