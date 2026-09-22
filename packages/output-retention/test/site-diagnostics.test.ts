// packages/output-retention/test/site-diagnostics.test.ts — R15: the captured
// INSTANCE net over this package's real diagnostics site.
//
// WHY THIS FILE EXISTS: `packages/diagnostics`' own cases install instances but
// drive SYNTHESIZED phases, so nothing asserted that a PACKAGE site routes to the
// phase/level it declares — measured, flipping one site's `warn`→`error` turned 0
// tests red. Only a package can drive its own site, so the net lives here.
//
// Covered: `src/spill-guard.ts:19`'s ambient handle (`diagnosticsFor("mount")`),
// driven through the real `createOutputSpillGuard` — its mount-time GC is
// best-effort and reports a failure rather than blocking the mount
// (spill-guard.ts:257), so an unusable spill root is the honest trigger.
//
// Discipline is COPIED from `packages/diagnostics/test/diagnostics.test.ts:47-55`
// (the capture stream) and `:59-68` (the teardown): the ambient slot is MODULE
// state, so a leaked instance would choose the next case's mode.
import { mkdtempSync, rmdirSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, expect, it, vi } from "vitest"
import { createContext } from "@i-harness/core-plugin"
import {
  createDiagnostics,
  currentDiagnostics,
  installDiagnostics,
  type DiagnosticRecord,
  type Redactor,
} from "@i-harness/diagnostics"
import { createOutputSpillGuard } from "../src/spill-guard.ts"

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

it("a failed spill GC is reported through the ambient handle at phase mount / level warn", async () => {
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
  const parent = mkdtempSync(join(tmpdir(), "r15-spill-"))
  try {
    // A spill root that cannot be listed. NOTE (measured): passing a root that
    // does NOT exist is NOT a trigger — `createSpillStore` mkdirs it (index.ts:174),
    // so the guard's own GC finds an empty directory and succeeds. The reachable
    // trigger is the root VANISHING between the mount and the GC's first async
    // step (`await import("node:fs/promises")` before its `readdir`): this
    // synchronous `rmdirSync` therefore lands before the promise resumes, and
    // `gcSpillStore` rejects with ENOENT — the race the mount-time catch exists
    // for (a /tmp clean-up, a removed volume).
    const root = join(parent, "spill-root")
    const { stream, lines } = captureStream()
    installDiagnostics(createDiagnostics({ stream, runId: "r15", redactor: passthrough }))

    createOutputSpillGuard(createContext(), { spillRoot: root })
    rmdirSync(root)

    // The GC is a `void … .catch(...)`: settle the real promise rather than
    // assuming a tick count.
    await vi.waitFor(() => { expect(lines).toHaveLength(1) })
    expect(parsed(lines)[0]).toMatchObject({ phase: "mount", level: "warn", run: "r15" })
    expect(parsed(lines)[0]!.msg).toContain("[i-harness] spill GC failed:")
    expect(warn).not.toHaveBeenCalled()
  } finally {
    rmSync(parent, { recursive: true, force: true })
  }
})
