import { describe, expect, it } from "vitest"
import { TELEMETRY_MANIFEST, TELEMETRY_EVENT_TYPES } from "../src/manifest.ts"
import type { TelemetryEventType } from "../src/types.ts"

describe("telemetry event manifest", () => {
  it("is exhaustive: every union code has a manifest row", () => {
    const codes = new Set<TelemetryEventType>(TELEMETRY_EVENT_TYPES)
    for (const row of TELEMETRY_MANIFEST) expect(codes.has(row.code)).toBe(true)
    // compile-time: a union member without a manifest row fails typecheck
    type Missing = Exclude<TelemetryEventType, (typeof TELEMETRY_MANIFEST)[number]["code"]>
    const missing: Missing[] = []
    expect(missing).toEqual([])
  })

  it("every row docs a domain and a description", () => {
    for (const row of TELEMETRY_MANIFEST) {
      expect(row.domain.length).toBeGreaterThan(0)
      expect(row.description.length).toBeGreaterThan(10)
    }
  })
})
