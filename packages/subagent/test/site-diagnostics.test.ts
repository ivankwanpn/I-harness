// packages/subagent/test/site-diagnostics.test.ts — R15: the captured INSTANCE
// net over this package's real diagnostics sites.
//
// WHY THIS FILE EXISTS: `packages/diagnostics`' own cases install instances but
// drive SYNTHESIZED phases, so nothing asserted that a PACKAGE site routes to the
// phase/level it declares — measured, flipping one site's `warn`→`error` turned 0
// tests red. Only a package can drive its own site, so the net lives here.
//
// Covered: `src/child.ts:24`'s ambient handle (`diagnosticsFor("run")`), driven
// through the real `resolveRoleTools` (child.ts:85). NOT covered, and reported as
// such: `src/tools.ts:28`'s handle (`session`) — its one call site is the
// pending-inbox sweep's fire-and-forget `.catch` (tools.ts:787), which a real
// drive cannot reject through (see the report's remaining-list).
//
// Discipline is COPIED from `packages/diagnostics/test/diagnostics.test.ts:47-55`
// (the capture stream) and `:59-68` (the teardown): the ambient slot is MODULE
// state, so a leaked instance would choose the next case's mode.
import { afterEach, beforeEach, expect, it, vi } from "vitest"
import { createContext } from "@i-harness/core-plugin"
import { createToolRegistry, type Tool } from "@i-harness/core-tools"
import {
  createDiagnostics,
  currentDiagnostics,
  installDiagnostics,
  type DiagnosticRecord,
  type Redactor,
} from "@i-harness/diagnostics"
import { resolveRoleTools } from "../src/child.ts"

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

function makeTool(name: string): Tool {
  return { name, description: "", inputSchema: {}, execute: async () => ({}) }
}

const ENV = "I_HARNESS_LOG"

beforeEach(() => { delete process.env[ENV] })

afterEach(() => {
  vi.restoreAllMocks()
  delete process.env[ENV]
  currentDiagnostics()?.close()
})

it("resolveRoleTools' declared-but-unmounted report is the ambient handle's, at phase run / level warn", () => {
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
  const parent = createToolRegistry(createContext())
  parent.register(makeTool("read"))
  parent.register(makeTool("bash"))
  const child = createToolRegistry(createContext())
  const { stream, lines } = captureStream()
  installDiagnostics(createDiagnostics({ stream, runId: "r15", redactor: passthrough }))

  // The Claude-Code vocabulary against this repo's lowercase registry: two of
  // the four names resolve, two do not.
  const missing = resolveRoleTools("plugin-agent", ["read", "bash", "Read", "NotebookRead"], parent, child)

  expect(missing).toEqual(["Read", "NotebookRead"])
  expect(lines).toHaveLength(1)
  expect(parsed(lines)[0]).toMatchObject({ phase: "run", level: "warn", run: "r15" })
  expect(parsed(lines)[0]!.msg).toContain("plugin-agent")
  expect(parsed(lines)[0]!.msg).toContain("Read, NotebookRead")
  expect(warn).not.toHaveBeenCalled()
})
