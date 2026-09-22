// packages/workflow/test/site-diagnostics.test.ts — R15: the captured INSTANCE
// net over this package's real diagnostics site.
//
// WHY THIS FILE EXISTS: `packages/diagnostics`' own cases install instances but
// drive SYNTHESIZED phases, so nothing asserted that a PACKAGE site routes to the
// phase/level it declares — measured, flipping one site's `warn`→`error` turned 0
// tests red. Only a package can drive its own site, so the net lives here.
//
// Covered: `src/registry.ts:37` — the SEAM shape (`currentDiagnostics()` + an
// explicit `console.warn` fallback in `defaultOnWarn`), driven through the real
// scan by handing the registry one `.yml` the scan must skip. The W6 record
// (§2.5 point 7) called this default body unexercised; this drives it.
//
// Discipline is COPIED from `packages/diagnostics/test/diagnostics.test.ts:47-55`
// (the capture stream) and `:59-68` (the teardown): the ambient slot is MODULE
// state, so a leaked instance would choose the next case's mode.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, expect, it, vi } from "vitest"
import {
  createDiagnostics,
  currentDiagnostics,
  installDiagnostics,
  type DiagnosticRecord,
  type Redactor,
} from "@i-harness/diagnostics"
import { createWorkflowRegistry } from "../src/registry.ts"

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

it("the scan's warn+skip is the installed instance's, at phase mount / level warn", () => {
  const ws = mkdtempSync(join(tmpdir(), "i-harness-wf-r15-"))
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
  try {
    mkdirSync(join(ws, "workflow"), { recursive: true })
    // A mapping with no `steps`: the scan's per-file parse error path.
    writeFileSync(join(ws, "workflow", "bad.yml"), "name: bad\ndescription: no steps here\n", "utf8")
    const { stream, lines } = captureStream()
    installDiagnostics(createDiagnostics({ stream, runId: "r15", redactor: passthrough }))

    const registry = createWorkflowRegistry({ workspace: ws })
    const defs = registry.list()

    expect(defs).toEqual([]) // one invalid file warns and skips, never breaks the registry
    expect(lines).toHaveLength(1)
    expect(parsed(lines)[0]).toMatchObject({ phase: "mount", level: "warn", run: "r15" })
    expect(parsed(lines)[0]!.msg).toContain("[workflow] skipping bad.yml:")
    expect(warn).not.toHaveBeenCalled()
  } finally {
    rmSync(ws, { recursive: true, force: true })
  }
})
