// packages/plugin-registry/test/site-diagnostics.test.ts — R15: the captured
// INSTANCE net over this package's real diagnostics sites.
//
// WHY THIS FILE EXISTS: `packages/diagnostics`' own cases install instances but
// drive SYNTHESIZED phases (`diagnosticsFor("cli")`), so nothing asserted that a
// PACKAGE site routes to the phase/level it declares — measured, flipping one
// site's `warn`→`error` turned 0 tests red. Only a package can drive its own
// site, so the net lives here.
//
// The three shapes this file covers, all from `src/`:
//   - `state.ts:78` — the SEAM shape: `currentDiagnostics()` + an explicit
//     `console.warn` fallback, driven by handing the loader a state document it
//     must rebuild.
//   - `agents.ts:112` — the AMBIENT-HANDLE shape (`const d = diagnosticsFor("mount")`),
//     driven by handing the scan a `*.md` entry it cannot read.
//   - `commands.ts:76` — the same AMBIENT-HANDLE shape, driven by handing the
//     commands scan its own `*.md` entry it cannot read (M79 Task 4).
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
import { loadState, loadStateSync } from "../src/state.ts"
import { describeAgents } from "../src/agents.ts"
import { describeCommands } from "../src/commands.ts"

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

function workspace(): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "pg-r15-"))
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

it("loadState's rebuild report is the installed instance's, at phase mount / level warn", async () => {
  const { dir, cleanup } = workspace()
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
  try {
    // A document that parses but does not have the state shape: the `rebuilt`
    // seam's "invalid shape" arm.
    writeFileSync(join(dir, "state.json"), JSON.stringify({ version: 99, sources: [], plugins: [] }), "utf8")
    const { stream, lines } = captureStream()
    installDiagnostics(createDiagnostics({ stream, runId: "r15", redactor: passthrough }))

    const state = await loadState(dir)

    expect(state).toEqual({ version: 1, sources: [], plugins: [] })
    expect(lines).toHaveLength(1)
    expect(parsed(lines)[0]).toMatchObject({ phase: "mount", level: "warn", run: "r15" })
    expect(parsed(lines)[0]!.msg).toContain("state file has an invalid shape")
    expect(parsed(lines)[0]!.msg).toContain(join(dir, "state.json"))
    // The record REPLACED the console line for this call: the seam branches, it
    // does not do both.
    expect(warn).not.toHaveBeenCalled()
  } finally {
    cleanup()
  }
})

it("loadStateSync's rebuild report reaches the same seam at phase mount / level warn", () => {
  const { dir, cleanup } = workspace()
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
  try {
    // No file at all: the sync variant's catch arm ("missing or unreadable").
    const { stream, lines } = captureStream()
    installDiagnostics(createDiagnostics({ stream, runId: "r15", redactor: passthrough }))

    const state = loadStateSync(dir)

    expect(state).toEqual({ version: 1, sources: [], plugins: [] })
    expect(lines).toHaveLength(1)
    expect(parsed(lines)[0]).toMatchObject({ phase: "mount", level: "warn" })
    expect(parsed(lines)[0]!.msg).toContain("state file is missing or unreadable")
    expect(warn).not.toHaveBeenCalled()
  } finally {
    cleanup()
  }
})

it("describeAgents' unreadable-file skip is the ambient handle's, at phase mount / level warn", () => {
  const { dir, cleanup } = workspace()
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
  try {
    writeFileSync(join(dir, "good.md"), ["---", "name: good", "---", "prompt"].join("\n"), "utf8")
    // A DIRECTORY named `*.md`: `readdirSync` lists it, `readFileSync` cannot
    // read it — the fixture agent-frontmatter.test.ts:100-113 already uses.
    mkdirSync(join(dir, "broken.md"), { recursive: true })
    const { stream, lines } = captureStream()
    installDiagnostics(createDiagnostics({ stream, runId: "r15", redactor: passthrough }))

    const agents = describeAgents(dir)

    expect(agents.map((a) => a.name)).toEqual(["good"]) // one bad file never costs the host every agent
    expect(lines).toHaveLength(1)
    expect(parsed(lines)[0]).toMatchObject({ phase: "mount", level: "warn", run: "r15" })
    expect(parsed(lines)[0]!.msg).toContain("skipping unreadable agent file")
    expect(parsed(lines)[0]!.msg).toContain("broken.md")
    expect(warn).not.toHaveBeenCalled()
  } finally {
    cleanup()
  }
})

it("describeCommands' unreadable-file skip is the ambient handle's, at phase mount / level warn", () => {
  const { dir, cleanup } = workspace()
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
  try {
    writeFileSync(join(dir, "good.md"), "---\ndescription: Good\n---\nA body", "utf8")
    // The SAME unreadable-entry fixture as the agents case above: a DIRECTORY
    // named `*.md` — `readdirSync` lists it, `readFileSync` cannot read it.
    mkdirSync(join(dir, "broken.md"), { recursive: true })
    const { stream, lines } = captureStream()
    installDiagnostics(createDiagnostics({ stream, runId: "r15", redactor: passthrough }))

    const commands = describeCommands(dir)

    expect(commands.map((c) => c.name)).toEqual(["good"]) // one bad file never costs the host every command
    expect(lines).toHaveLength(1)
    expect(parsed(lines)[0]).toMatchObject({ phase: "mount", level: "warn", run: "r15" })
    expect(parsed(lines)[0]!.msg).toContain("skipping unreadable command file")
    expect(parsed(lines)[0]!.msg).toContain("broken.md")
    expect(warn).not.toHaveBeenCalled()
  } finally {
    cleanup()
  }
})
