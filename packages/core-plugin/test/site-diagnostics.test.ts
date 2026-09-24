// packages/core-plugin/test/site-diagnostics.test.ts — R15: the captured
// INSTANCE net over this package's real diagnostics site.
//
// WHY THIS FILE EXISTS: `packages/diagnostics`' own cases install instances but
// drive SYNTHESIZED phases, so nothing asserted that a PACKAGE site routes to the
// phase/level it declares — measured, flipping one site's `warn`→`error` turned 0
// tests red. Only a package can drive its own site, so the net lives here.
//
// WHY A NEW FILE: `plugin.test.ts:250-286` already traverses the timed-out
// disposer path, but what it asserts is that `console.error` was called WITH the
// exact message — true only while NO instance is installed. The installed slot is
// MODULE state, so putting this case there would let the file's own order decide
// which assertion holds. A new file is a new worker, and that file stays untouched.
//
// Covered: `src/index.ts:458` — the AMBIENT-HANDLE shape (`const d = diagnosticsFor("shutdown")`),
// driven by an unmount disposer that never settles, so the `UNMOUNT_TIMEOUT_MS`
// race is the only thing that can end the unmount. This is the FIRST asserting
// observer phase `shutdown` has, and the only site in the five whose level is
// `error` (M79 Task 4).
//
// The clock is FAKE (measured: `advanceTimersByTimeAsync(5_000)` drives the real
// `setTimeout` the site races against, and the case costs ~0ms of wall clock);
// `plugin.test.ts:250-286` pays the real 5s for its console-spy form.
//
// Discipline is COPIED from `packages/diagnostics/test/diagnostics.test.ts:47-55`
// (the capture stream) and `:59-68` (the teardown): the ambient slot is MODULE
// state, so a leaked instance would choose the next case's mode.
import { afterEach, beforeEach, expect, it, vi } from "vitest"
import {
  createDiagnostics,
  currentDiagnostics,
  installDiagnostics,
  type DiagnosticRecord,
  type Redactor,
} from "@i-harness/diagnostics"
import { createContext } from "../src/index.ts"

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

const ENV = "I_HARNESS_LOG"

beforeEach(() => { delete process.env[ENV] })

afterEach(() => {
  vi.restoreAllMocks()
  delete process.env[ENV]
  currentDiagnostics()?.close()
})

it("a timed-out unmount disposer is the ambient handle's, at phase shutdown / level error", async () => {
  // Only the 5s race can end this unmount, so the CLOCK is the fixture: advancing
  // it is what makes the timeout path observable without waiting 5 real seconds.
  vi.useFakeTimers()
  const error = vi.spyOn(console, "error").mockImplementation(() => {})
  const { stream, lines } = captureStream()
  installDiagnostics(createDiagnostics({ stream, runId: "r15", redactor: passthrough }))
  try {
    const ctx = createContext()
    ctx.mount({ name: "hang", mount() {}, unmount: () => new Promise<void>(() => {}) })

    const unmounting = ctx.unmount("hang")
    await vi.advanceTimersByTimeAsync(5_000)
    await unmounting

    expect(lines).toHaveLength(1)
    expect(parsed(lines)[0]).toMatchObject({ phase: "shutdown", level: "error", run: "r15" })
    expect(parsed(lines)[0]!.msg).toContain("timed out after 5s")
    expect(error).not.toHaveBeenCalled()
  } finally {
    vi.useRealTimers()
  }
})
