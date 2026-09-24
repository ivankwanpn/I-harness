import { describe, expect, it } from "vitest"
import { TELEMETRY_MANIFEST } from "../src/manifest.ts"
import type { TelemetryEventType } from "../src/types.ts"

describe("telemetry event manifest", () => {
  it("is exhaustive: every union code has a manifest row", () => {
    // M77 (fix wave) correction, closed by M79. The M77 comment here deferred the
    // type-level assertion to M79; it is now this. It had to replace a runtime half
    // that was a tautology, measured: `TELEMETRY_EVENT_TYPES` IS
    // `TELEMETRY_MANIFEST.map((row) => row.code)` (../src/manifest.ts), so the old
    // `codes` set and the loop were the same list — `codes.has(row.code)` was true
    // by construction — and `const missing: Missing[] = []` typechecked for ANY
    // `Missing`, because an empty array needs no element. The direction WITH teeth
    // on the other side — a manifest row whose `code` is not a union member — stays
    // guarded by the manifest's own
    // `as const satisfies readonly TelemetryEventCodeDoc[]` (TS2820).
    type Missing = Exclude<TelemetryEventType, (typeof TELEMETRY_MANIFEST)[number]["code"]>
    // If a union member has no manifest row, `Missing` stops being `never`, this
    // annotation becomes `false`, and `true` is not assignable to it — a typecheck
    // failure at THIS line. (Measured: before M79 nothing failed; the runtime half
    // was true by construction.)
    const manifestIsExhaustive: Missing extends never ? true : false = true
    expect(manifestIsExhaustive).toBe(true)
  })

  it("every row docs a domain and a description", () => {
    for (const row of TELEMETRY_MANIFEST) {
      expect(row.domain.length).toBeGreaterThan(0)
      expect(row.description.length).toBeGreaterThan(10)
    }
  })
})
