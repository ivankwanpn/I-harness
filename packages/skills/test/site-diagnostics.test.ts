// packages/skills/test/site-diagnostics.test.ts — R15: the captured INSTANCE net
// over this package's real diagnostics site.
//
// WHY THIS FILE EXISTS: `packages/diagnostics`' own cases install instances but
// drive SYNTHESIZED phases, so nothing asserted that a PACKAGE site routes to the
// phase/level it declares — measured, flipping one site's `warn`→`error` turned 0
// tests red. Only a package can drive its own site, so the net lives here.
//
// Covered: `src/registry.ts:123` — the SEAM shape (`currentDiagnostics()` + an
// explicit `console.warn` fallback in `defaultWarn`), driven through the real
// scan by handing a skills root one SKILL.md the scan must skip.
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
import { createSkillRegistry } from "../src/registry.ts"

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
  const ws = mkdtempSync(join(tmpdir(), "i-harness-skills-r15-"))
  const global = mkdtempSync(join(tmpdir(), "i-harness-skills-global-r15-"))
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
  try {
    mkdirSync(join(ws, "skills/bad"), { recursive: true })
    // No closed front-matter fence: the scan's per-skill error path.
    writeFileSync(join(ws, "skills/bad/SKILL.md"), "no front-matter at all\n", "utf8")
    const { stream, lines } = captureStream()
    installDiagnostics(createDiagnostics({ stream, runId: "r15", redactor: passthrough }))

    // `globalDir` pinned to a temp dir: the isolation contract (global-home.test.ts)
    // — a case must never read the developer's real ~/.i-harness/skills.
    const registry = createSkillRegistry({ workspace: ws, globalDir: global })
    const skills = registry.list()

    expect(skills).toEqual([]) // one bad skill never breaks the registry
    expect(lines).toHaveLength(1)
    expect(parsed(lines)[0]).toMatchObject({ phase: "mount", level: "warn", run: "r15" })
    expect(parsed(lines)[0]!.msg).toContain("[skills]")
    expect(parsed(lines)[0]!.msg).toContain("SKILL.md")
    expect(warn).not.toHaveBeenCalled()
  } finally {
    rmSync(ws, { recursive: true, force: true })
    rmSync(global, { recursive: true, force: true })
  }
})
