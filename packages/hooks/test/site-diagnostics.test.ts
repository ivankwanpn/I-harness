// packages/hooks/test/site-diagnostics.test.ts — R15: the captured INSTANCE net
// over this package's real diagnostics site.
//
// WHY THIS FILE EXISTS: `packages/diagnostics`' own cases install instances but
// drive SYNTHESIZED phases, so nothing asserted that a PACKAGE site routes to the
// phase/level it declares — measured, flipping one site's `warn`→`error` turned 0
// tests red. Only a package can drive its own site, so the net lives here.
//
// Covered, both from `src/`:
//   - `index.ts:363` — the SEAM shape (`currentDiagnostics()` + an explicit
//     `console.warn` fallback in `defaultReport`), driven through the real
//     registry: another tree's config whose handler is not the user's policy yet is
//     reported ONCE (the case hooks.test.ts:187 drives with an injected `report`, so
//     the DEFAULT body is what had no coverage).
//   - `trust.ts:87` — the AMBIENT-HANDLE shape (`const d = diagnosticsFor("config")`),
//     driven by handing the trust store a file that exists but is not JSON
//     (M79 Task 4).
//
// Discipline is COPIED from `packages/diagnostics/test/diagnostics.test.ts:47-55`
// (the capture stream) and `:59-68` (the teardown): the ambient slot is MODULE
// state, so a leaked instance would choose the next case's mode.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
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
import { createHookRegistry } from "../src/index.ts"
import { createHookTrustStore, sha256File } from "../src/trust.ts"

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
  delete process.env.IH_CONFIG_DIR
  currentDiagnostics()?.close()
})

it("an ungranted declaration's report is the installed instance's, at phase mount / level warn", async () => {
  const dirs: string[] = []
  const mk = (prefix: string): string => {
    const dir = mkdtempSync(join(tmpdir(), prefix))
    dirs.push(dir)
    return dir
  }
  try {
    // The harness home: NOT the config below, which is what makes that config
    // another tree's and its declaration unapproved (hook-trust.test.ts's D1).
    process.env.IH_CONFIG_DIR = mk("i-harness-hooks-home-r15-")
    const plugin = mk("i-harness-plugin-r15-")
    const script = join(plugin, "deny.js")
    writeFileSync(script, "process.stdout.write('{}')\n", "utf8")
    mkdirSync(join(plugin, "hooks"), { recursive: true })
    const configPath = join(plugin, "hooks", "hooks.json")
    writeFileSync(configPath, JSON.stringify({
      version: 1,
      handlers: [{
        id: "notice-once", event: "pre-tool", type: "command", matcher: { tool: "read" },
        command: { cmd: process.execPath, args: [script] },
        trust: { script, sha256: await sha256File(script) },
      }],
    }), "utf8")

    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    const { stream, lines } = captureStream()
    installDiagnostics(createDiagnostics({ stream, runId: "r15", redactor: passthrough }))

    const ctx = createContext()
    // NO `report` option and NO approvals: the DEFAULT body is the site.
    await createHookRegistry(ctx, { configPath, configDir: plugin })
    const tools = createToolRegistry(ctx)
    tools.register({
      name: "read",
      description: "read a file",
      inputSchema: { type: "object", properties: { path: { type: "string" } } },
      execute: async () => "content",
      isReadOnly: true,
    } as Tool)
    await tools.execute({ name: "read", args: { path: "a.txt" } })

    expect(lines).toHaveLength(1)
    expect(parsed(lines)[0]).toMatchObject({ phase: "mount", level: "warn", run: "r15" })
    expect(parsed(lines)[0]!.msg).toContain("[hooks]")
    expect(parsed(lines)[0]!.msg).toContain("notice-once")
    expect(parsed(lines)[0]!.msg).toContain("not approved")
    expect(warn).not.toHaveBeenCalled()
  } finally {
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true })
  }
})

it("the trust store's unreadable-store report is the ambient handle's, at phase config / level warn", () => {
  const dir = mkdtempSync(join(tmpdir(), "i-harness-hooks-r15-"))
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
  try {
    // A store that EXISTS but is not JSON: the arm the absent-file and
    // well-shaped cases never reach. It approves nothing, and says so.
    const storePath = join(dir, "approvals.json")
    writeFileSync(storePath, "{not json", "utf8")
    const { stream, lines } = captureStream()
    installDiagnostics(createDiagnostics({ stream, runId: "r15", redactor: passthrough }))

    const store = createHookTrustStore(storePath)

    expect(store.list()).toEqual([]) // degrade-to-empty, never throw
    expect(lines).toHaveLength(1)
    expect(parsed(lines)[0]).toMatchObject({ phase: "config", level: "warn", run: "r15" })
    expect(parsed(lines)[0]!.msg).toContain("is not valid JSON")
    expect(warn).not.toHaveBeenCalled()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
