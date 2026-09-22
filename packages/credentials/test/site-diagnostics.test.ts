// packages/credentials/test/site-diagnostics.test.ts — R15: the captured INSTANCE
// net over this package's real diagnostics site.
//
// WHY THIS FILE EXISTS: `packages/diagnostics`' own cases install instances but
// drive SYNTHESIZED phases, so nothing asserted that a PACKAGE site routes to the
// phase/level it declares — measured, flipping one site's `warn`→`error` turned 0
// tests red. Only a package can drive its own site, so the net lives here.
//
// Covered: `src/index.ts:247` — the SEAM shape (`currentDiagnostics()` + an
// explicit `console.warn` fallback in `warnBad`), driven through the real store
// by handing it a document it must degrade to empty.
//
// Discipline is COPIED from `packages/diagnostics/test/diagnostics.test.ts:47-55`
// (the capture stream) and `:59-68` (the teardown): the ambient slot is MODULE
// state, so a leaked instance would choose the next case's mode.
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
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
import { createCredentialStore } from "../src/index.ts"

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

it("the document's degrade-to-empty report is the installed instance's, at phase config / level warn", () => {
  const dir = mkdtempSync(join(tmpdir(), "i-harness-cred-r15-"))
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
  try {
    const documentPath = join(dir, "credentials.json")
    writeFileSync(documentPath, "{not json", "utf8")
    const { stream, lines } = captureStream()
    installDiagnostics(createDiagnostics({ stream, runId: "r15", redactor: passthrough }))

    const store = createCredentialStore(documentPath)
    const described = store.describe(["R15_UNSET_REF"])

    // Degrade-to-empty, never throw: the ref simply reports unset.
    expect(described).toEqual({ R15_UNSET_REF: { configured: false, source: "file", writable: true } })
    expect(lines).toHaveLength(1)
    expect(parsed(lines)[0]).toMatchObject({ phase: "config", level: "warn", run: "r15" })
    expect(parsed(lines)[0]!.msg).toContain("credential file")
    expect(parsed(lines)[0]!.msg).toContain("unreadable or corrupt")
    expect(warn).not.toHaveBeenCalled()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
