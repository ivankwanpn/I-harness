// packages/schedule/test/site-diagnostics.test.ts — R15: the captured INSTANCE
// net over this package's real diagnostics site.
//
// WHY THIS FILE EXISTS: `packages/diagnostics`' own cases install instances but
// drive SYNTHESIZED phases, so nothing asserted that a PACKAGE site routes to the
// phase/level it declares — measured, flipping one site's `warn`→`error` turned 0
// tests red. Only a package can drive its own site, so the net lives here.
//
// Covered: `src/driver.ts:112` — the SEAM shape: `currentDiagnostics()` + an
// explicit `console.warn` fallback in `defaultLogWarn`. That default body had NO
// test exercising it at all (W6 §2.5 point 7); both of its arms are driven below
// through the real driver:
//   - a session whose schedule stream is corrupt (the fold throws), and
//   - a host `deliver` that throws (the delivery failure report).
//
// Discipline is COPIED from `packages/diagnostics/test/diagnostics.test.ts:47-55`
// (the capture stream) and `:59-68` (the teardown): the ambient slot is MODULE
// state, so a leaked instance would choose the next case's mode.
import { afterEach, beforeEach, expect, it, vi } from "vitest"
import type { SessionEvent } from "@i-harness/core-session"
import {
  createDiagnostics,
  currentDiagnostics,
  installDiagnostics,
  type DiagnosticRecord,
  type Redactor,
} from "@i-harness/diagnostics"
import { createAfterScheduleRecord } from "../src/index.ts"
import { createScheduleDriver, type ScheduleDelivery } from "../src/driver.ts"

/** The identity redactor: these cases are about the ROUTING (phase/level), and
 *  the real scans are their own task. */
const passthrough: Redactor = {
  redact: (value) => value,
  registerSecret: () => {},
  size: () => ({ rules: 0, secrets: 0 }),
}

function captureStream(): { stream: NodeJS.WritableStream; lines: string[] } {
  const lines: string[] = []
  const stream = { write: (s: string) => { lines.push(s); return true } } as unknown as NodeJS.WritableStream
  return { stream, lines }
}

function parsed(lines: string[]): DiagnosticRecord[] {
  return lines.map((l) => JSON.parse(l) as DiagnosticRecord)
}

const NOW = Date.parse("2026-08-31T10:00:00.000Z")

const ENV = "I_HARNESS_LOG"

beforeEach(() => { delete process.env[ENV] })

afterEach(() => {
  vi.restoreAllMocks()
  delete process.env[ENV]
  currentDiagnostics()?.close()
})

it("the driver's corrupt-stream report is the installed instance's, at phase session / level warn", async () => {
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
  // A `schedule/change` event the fold cannot decode: the driver's per-session
  // failure path. The DRIVER never writes the log — this is the host's stream.
  const corrupt = [{ type: "schedule/change", version: 1, operation: "create", schedule: { kind: "nope" } } as unknown as SessionEvent]
  const { stream, lines } = captureStream()
  installDiagnostics(createDiagnostics({ stream, runId: "r15", redactor: passthrough }))

  const driver = createScheduleDriver({
    sessions: () => ["sess-1"],
    events: () => corrupt,
    deliver: async () => {},
    now: () => NOW,
    pollMs: 60_000,
  })
  const result = await driver.tick()
  driver.stop()

  expect(result.delivered).toBe(0)
  expect(result.deliveryErrors).toHaveLength(1)
  expect(lines).toHaveLength(1)
  expect(parsed(lines)[0]).toMatchObject({ phase: "session", level: "warn", run: "r15" })
  expect(parsed(lines)[0]!.msg).toContain("[schedule] schedule state of sess-1 is corrupt:")
  expect(warn).not.toHaveBeenCalled()
})

it("the driver's delivery-failure report reaches the same seam at phase session / level warn", async () => {
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
  const record = createAfterScheduleRecord("schedule-1", "remind me", 1, NOW)
  const { stream, lines } = captureStream()
  installDiagnostics(createDiagnostics({ stream, runId: "r15", redactor: passthrough }))

  const driver = createScheduleDriver({
    sessions: () => ["sess-1"],
    events: () => [{ type: "schedule/change", version: 1, operation: "create", schedule: record } as unknown as SessionEvent],
    // The host did NOT accept: a throw is the contract for that (spec §3.4).
    deliver: async (_delivery: ScheduleDelivery) => { throw new Error("flush failed") },
    now: () => NOW + 2_000,
    pollMs: 60_000,
  })
  const result = await driver.tick()
  driver.stop()

  expect(result.delivered).toBe(0)
  expect(result.deliveryErrors).toEqual(["sess-1: flush failed"])
  expect(lines).toHaveLength(1)
  expect(parsed(lines)[0]).toMatchObject({ phase: "session", level: "warn" })
  expect(parsed(lines)[0]!.msg).toContain("[schedule] schedule delivery of schedule-1 in sess-1 failed: flush failed")
  expect(warn).not.toHaveBeenCalled()
})
