import { spawnSync } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { createWindowsAclSandbox, tempWriteSid, workspaceWriteSid } from "../src/index.ts"

// Real-backend end-to-end on a Windows host: the provider (confine) → the
// runner (tsx source launch) → the WRITE_RESTRICTED token → real confined
// spawns. This is the M16w behavior gate — on non-win32 hosts koffi cannot
// load, so the suite skips itself (vitest only collects *.e2e.ts because
// vitest.config.ts includes it — without that include this file would
// silently never run).
//
// The confinement contract (mirrors dsh's windows-acl runner suites):
//  - read-only denies EVERY write — including inside the workspace, even when
//    a standing workspace capability ACE is present (the read-only token
//    carries no capability SID, so the standing ACE is inert);
//  - workspace-write allows writes in the workspace and the private temp
//    directory (the per-session standing grants) and denies writes anywhere
//    else.
// The tests assert the OUTCOME (exit code + file existence + stdout markers),
// not a precise denial string: the Win32 denial text varies by API layer
// (Node surfaces EPERM, .NET surfaces "access is denied", etc.).
describe.skipIf(process.platform !== "win32")("windows-acl e2e (Windows only)", () => {
  let scratchRoot: string
  let workspace: string
  let escapeTarget: string

  beforeAll(() => {
    scratchRoot = mkdtempSync(join(tmpdir(), "i-harness-windows-acl-e2e-"))
    workspace = join(scratchRoot, "workspace")
    mkdirSync(workspace)
    // Outside the workspace and outside the provider's private temp dir; a
    // sibling of the workspace under the same scratch root.
    escapeTarget = join(scratchRoot, "escaped.txt")
  })

  afterAll(() => {
    rmSync(scratchRoot, { recursive: true, force: true })
  })

  function runConfined(confinedArgv: string[]) {
    return spawnSync(confinedArgv[0]!, confinedArgv.slice(1), { encoding: "utf8", timeout: 60_000 })
  }

  it("workspace-write (sessionId standing grants): workspace + private temp writable, escape denied", () => {
    // A policy sessionId selects the seam-managed flow: the provider
    // materializes a standing workspace ACE + a revocable private-temp ACE and
    // passes --write-sid/--temp-write-sid so the runner grants nothing.
    const provider = createWindowsAclSandbox({ writableDirs: [workspace], mode: "workspace-write" })
    try {
      const confined = provider.confine(
        ["node", "-e", [
          "const fs = require('node:fs');",
          "const { join } = require('node:path');",
          "const t = (name, target) => { try { fs.writeFileSync(target, 'x'); console.log(name + ': OK'); } catch { console.log(name + ': DENIED'); } };",
          `t('WORKSPACE', ${JSON.stringify(join(workspace, "child-wrote.txt"))});`,
          `t('ESCAPE', ${JSON.stringify(escapeTarget)});`,
          "t('TEMPTREE', join(process.env.TEMP, 'child-wrote.txt'));",
          "console.log('TEMP-PATH: ' + process.env.TEMP);",
        ].join("")],
        { mode: "workspace-write", workspaceRoot: workspace, sessionId: "win32-e2e-session" },
      )
      const result = runConfined(confined.argv)
      expect(result.status, `stderr: ${result.stderr}`).toBe(0)
      expect(result.stdout).toContain("WORKSPACE: OK")
      expect(result.stdout).toContain("TEMPTREE: OK")
      expect(result.stdout).toContain("ESCAPE: DENIED")
      // The standing grant reached the workspace; the escape never landed.
      expect(existsSync(join(workspace, "child-wrote.txt"))).toBe(true)
      expect(existsSync(escapeTarget)).toBe(false)
      // The child's private temp is the provider-created dir under the
      // ambient temp root; after dispose() it is revoked and removed.
      const privateTemp = result.stdout.match(/^TEMP-PATH: (.+)$/mu)?.[1]?.trim()
      expect(privateTemp).toBeDefined()
      expect(privateTemp?.startsWith(tmpdir())).toBe(true)
      expect(existsSync(privateTemp ?? "")).toBe(true)
    } finally {
      // dispose() revokes the private-temp ACE and removes its directory; the
      // standing workspace ACE deliberately stays (the reuse cache).
      provider.dispose()
    }
  })
  // The temp-grant lifecycle is only observable cross-test after dispose():
  // dispose() runs in the finally above, so the provider-created private temp
  // directory must be gone (the revocable ACE backed by an OI|CI grant must
  // never outlive it), while the standing workspace grant/session SID reuse
  // cache stays behind by design.
  it("dispose() removes the provider-created private temp dir (revocable ACE lifecycle)", () => {
    const provider = createWindowsAclSandbox({ writableDirs: [workspace], mode: "workspace-write" })
    let privateTemp: string | undefined
    try {
      const confined = provider.confine(
        ["node", "-e", "console.log('TEMP-PATH: ' + process.env.TEMP)"],
        { mode: "workspace-write", workspaceRoot: workspace, sessionId: "win32-e2e-session" },
      )
      const result = runConfined(confined.argv)
      expect(result.status, `stderr: ${result.stderr}`).toBe(0)
      privateTemp = result.stdout.match(/^TEMP-PATH: (.+)$/mu)?.[1]?.trim()
      expect(privateTemp).toBeDefined()
      expect(existsSync(privateTemp ?? "")).toBe(true)
    } finally {
      provider.dispose()
    }
    expect(existsSync(privateTemp ?? "")).toBe(false)
  })

  it("read-only: ALL writes denied — workspace included, even with the standing grant present", () => {
    // Runs on the SAME workspace after the workspace-write test above, whose
    // standing workspace capability ACE is present and never revoked. The
    // read-only restricted token carries NO capability SID in its restricting
    // list, so the standing ACE is inert: dsh's mode-downgrade leak pin. The
    // plan's original read-only "workspace write allowed" expectation was
    // WRONG for this runner contract — a read-only write anywhere is DENIED.
    const provider = createWindowsAclSandbox({ writableDirs: [workspace], mode: "read-only" })
    try {
      const confined = provider.confine(
        ["node", "-e", [
          "const fs = require('node:fs');",
          "const t = (name, target) => { try { fs.writeFileSync(target, 'x'); console.log(name + ': OK'); } catch { console.log(name + ': DENIED'); } };",
          `t('WORKSPACE', ${JSON.stringify(join(workspace, "readonly-wrote.txt"))});`,
          `t('ESCAPE', ${JSON.stringify(escapeTarget)});`,
        ].join("")],
        { mode: "read-only", workspaceRoot: workspace },
      )
      const result = runConfined(confined.argv)
      expect(result.status, `stderr: ${result.stderr}`).toBe(0)
      expect(result.stdout).toContain("WORKSPACE: DENIED")
      expect(result.stdout).toContain("ESCAPE: DENIED")
      expect(existsSync(join(workspace, "readonly-wrote.txt"))).toBe(false)
      expect(existsSync(escapeTarget)).toBe(false)
      // A RAW (uncaught) write must fail the child itself: nonzero exit +
      // a denial signature — the real confinement, not only the caught case.
      const raw = runConfined(provider.confine(
        ["node", "-e",
          `require('node:fs').writeFileSync(${JSON.stringify(escapeTarget)}, 'x')`],
        { mode: "read-only", workspaceRoot: workspace },
      ).argv)
      expect(raw.status).not.toBe(0)
      expect(raw.stderr.toLowerCase()).toMatch(/denied|permission|eperm/)
      expect(existsSync(escapeTarget)).toBe(false)
    } finally {
      provider.dispose()
    }
  })

  it("headless smoke: workspace-write confined command runs", () => {
    // M25 headless-e2e precursor: one trivial confined command through the
    // real provider → runner → restricted token pipeline must simply succeed.
    const provider = createWindowsAclSandbox({ writableDirs: [workspace], mode: "workspace-write" })
    try {
      const confined = provider.confine(
        ["node", "-e", "console.log('M22-OK')"],
        { mode: "workspace-write", workspaceRoot: workspace, sessionId: "headless-e2e" },
      )
      const result = runConfined(confined.argv)
      expect(result.status, `stderr: ${result.stderr}`).toBe(0)
      expect(result.stdout).toContain("M22-OK")
    } finally {
      provider.dispose()
    }
  })

  it("SID derivation is deterministic with the distinct workspace/temp domain separation (plan pin)", () => {
    expect(workspaceWriteSid("C:\\work\\proj")).toMatch(/^S-1-4-\d+-\d+$/)
    expect(tempWriteSid("C:\\temp\\x")).toMatch(/^S-1-4-\d+-\d+-1$/)
  })
})
