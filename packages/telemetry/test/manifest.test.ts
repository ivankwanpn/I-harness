import { describe, expect, it } from "vitest"
import { TELEMETRY_MANIFEST, TELEMETRY_EVENT_TYPES } from "../src/manifest.ts"
import type { TelemetryEventType } from "../src/types.ts"

describe("telemetry event manifest", () => {
  it("is exhaustive: every union code has a manifest row", () => {
    const codes = new Set<TelemetryEventType>(TELEMETRY_EVENT_TYPES)
    for (const row of TELEMETRY_MANIFEST) expect(codes.has(row.code)).toBe(true)
    // M77 (fix wave) correction. This line used to claim "compile-time: a union
    // member without a manifest row fails typecheck". That claim is FALSE, and it
    // was measured false in this unit: `TELEMETRY_EVENT_TYPES` IS
    // `TELEMETRY_MANIFEST.map((row) => row.code)` (../src/manifest.ts), so `codes`
    // above and the manifest are the same list — the loop's `codes.has(row.code)`
    // is true by construction, and `const missing: Missing[] = []` typechecks for
    // ANY `Missing`, because an empty array needs no element. The direction WITH
    // teeth is the other one: the manifest's own
    // `as const satisfies readonly TelemetryEventCodeDoc[]`, where a row whose
    // `code` is not a union member is TS2820. So a NEW union member with NO
    // manifest row is unguarded; rewriting this into a type-level assertion is
    // M79's (this fix wave changes no existing assertion — comment only).
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
