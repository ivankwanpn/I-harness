// e2e/sandbox.e2e.ts — M25 §2.1: REAL --sandbox enforcement on Windows.
//
// Windows-only (same skipIf gate as the M16w/M22/M23 win32 suites): the ACL
// fabric backend requires koffi, which cannot load off Windows.
//
// Host reality (verified while writing this suite): through the runHeadless
// TOOL surface the shell tools are bash/pwsh only, and on this host confined
// git-bash cannot start its MSYS service instance under the restricted token
// (Bash/Service/CreateInstance E_ACCESSDENIED) while pwsh may be absent — the
// M16w cli.test documents exactly this ("the confined command may fail on THIS
// host"). The win32 ACL package therefore e2e's the deny itself with node
// children (win32.e2e.ts). This suite keeps BOTH honest halves:
//   1. the runHeadless composition e2e (the real composed backend + policy,
//      the M16w contract — the run completes and the denial is carried in the
//      tool result, never crashing the harness);
//   2. the REAL isolation deny (inside the workspace allowed / outside
//      DENIED) driven through the EXACT composed provider runHeadless builds
//      for the shell tools (createLocalSandbox({ windowsAclBackend })), with
//      the policy shape the CLI produces — the spec's "寫出阻擋（真實隔離）".
import { describe, expect, it } from "vitest"
import { existsSync } from "node:fs"
import { spawnSync } from "node:child_process"
import { join } from "node:path"
import { runHeadless } from "../apps/cli/src/run.ts"
import { createLocalSandbox } from "../packages/sandbox-local/src/index.ts"
import { createWindowsAclSandbox } from "../packages/sandbox-windows-acl/src/index.ts"
import { makeWorkspace, removeWorkspace } from "./helpers.ts"

describe.skipIf(process.platform !== "win32")("e2e sandbox (win32 ACL fabric)", () => {
  it("runHeadless composes the REAL fabric: a confined shell dispatch flows through the run", async () => {
    const dir = makeWorkspace("i-harness-e2e-sbx-")
    try {
      const result = await runHeadless("write in the workspace", {
        workspace: dir,
        sandbox: "workspace-write",
        approveAll: true,
        mockScript: [
          { role: "assistant", toolCalls: [{ name: "bash", args: { command: `echo hi > "${join(dir, "c1.txt").replace(/\\/g, "/")}"` } }] },
          { role: "assistant", text: "done" },
        ],
      })
      // The composition never turns confinement into a run failure: whether
      // the confined shell itself succeeds is HOST-dependent (git-bash's
      // service instance creation is token-denied on some hosts — the denial
      // is carried in the tool result, not thrown).
      expect(result.exitCode, result.error).toBe(0)
      expect(result.error ?? "").not.toContain("sandbox")
      expect(result.finalText).toBe("done")
      const bash = result.session?.events.find((e) => e.type === "tool/result" && e.name === "bash") as
        | { output: { exitCode?: number } }
        | undefined
      expect(bash).toBeDefined()
      expect(typeof bash?.output.exitCode).toBe("number")
    } finally {
      removeWorkspace(dir)
    }
  }, 60_000)

  it("REAL isolation: a confined child writes INSIDE the workspace; a write outside is DENIED", () => {
    const dir = makeWorkspace("i-harness-e2e-sbx2-")
    const escapeDir = makeWorkspace("i-harness-e2e-esc2-")
    // The EXACT compose runHeadless performs for the shell tools (run.ts:
    // createWindowsAclSandbox + createLocalSandbox({ windowsAclBackend })).
    const backend = createWindowsAclSandbox({ writableDirs: [dir], mode: "workspace-write" })
    try {
      const provider = createLocalSandbox({ windowsAclBackend: backend })
      const child = [
        "const fs = require('node:fs');",
        "const t = (name, target) => { try { fs.writeFileSync(target, 'x'); console.log(name + ': OK'); } catch { console.log(name + ': DENIED'); } };",
        `t('WORKSPACE', ${JSON.stringify(join(dir, "child-wrote.txt"))});`,
        `t('ESCAPE', ${JSON.stringify(join(escapeDir, "escape.txt"))});`,
      ].join("")
      // Same policy shape the CLI produces (mode + workspaceRoot; no host
      // session id → the runner's standalone grant flow).
      const confined = provider.confine(["node", "-e", child], { mode: "workspace-write", workspaceRoot: dir })
      const res = spawnSync(confined.argv[0]!, confined.argv.slice(1), { encoding: "utf8", timeout: 60_000 })
      expect(res.status, `stderr: ${res.stderr}`).toBe(0)
      // The in-workspace write LANDED; the outside write was DENIED and NEVER
      // landed on real disk.
      expect(res.stdout).toContain("WORKSPACE: OK")
      expect(res.stdout).toContain("ESCAPE: DENIED")
      expect(existsSync(join(dir, "child-wrote.txt"))).toBe(true)
      expect(existsSync(join(escapeDir, "escape.txt"))).toBe(false)
    } finally {
      // dispose() revokes the revocable grants (standing workspace ACE stays
      // as the reuse cache by design — same as runHeadless's teardown).
      backend.dispose()
      removeWorkspace(dir)
      removeWorkspace(escapeDir)
    }
  }, 60_000)
})
