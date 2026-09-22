// M65 T1: the bare-launch contract this task restores. Before it, a bare
// `i-harness` (or ANY first token that is not a subcommand) launched the TUI in
// cwd — M44's grok-style default — and `tui` / `web` were subcommands. Both
// frontends are deleted, so the fall-through is the recorded pre-M44 one
// (`db3d1e7^:apps/cli/src/index.ts`): print USAGE on stderr and exit 1.
//
// Spawn-based, because the decision lives in the CLI's argv dispatch — an
// in-process `main()` call cannot observe "the process launched nothing".
// Harness from bin.test.ts:17-27, with two changes this task requires:
//  - IH_CONFIG_DIR and the cwd are fresh empty temp dirs (e2e/helpers.ts:28-42).
//    In the RED state the CLI really does launch a UI, and it must neither read
//    a developer's own settings nor write session state into the repo while it
//    does.
//  - every spawn carries a TIMEOUT. The RED state is a UI that stays up, and a
//    non-TTY child (stdin is a pipe nobody writes to) does not have to exit on
//    its own — a hang is RECORDED and asserted against, never silently reported
//    as a pass or waved away as a slow test.
import { afterAll, describe, expect, it } from "vitest"
import { spawn, spawnSync } from "node:child_process"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"

const SHIM = fileURLToPath(new URL("../bin/i-harness.js", import.meta.url))
const CONFIG_DIR = mkdtempSync(join(tmpdir(), "ih-bare-launch-config-"))
const WORKSPACE = mkdtempSync(join(tmpdir(), "ih-bare-launch-ws-"))
// 15s: a tsx-booting CLI spawn measures ~1-3s here; the timeout exists for the
// red state (a live UI), not for the green one.
const TIMEOUT_MS = 15_000
const TEST_TIMEOUT_MS = 30_000

interface RunResult {
  /** true when the child had to be killed — the observed hang (plan ruling R-1). */
  timedOut: boolean
  code: number | null
  stdout: string
  stderr: string
}

/** Kill the child AND its tree: the shim spawns the real CLI with inherited
 * stdio (bin/i-harness.js:27), so a UI grandchild outlives a kill aimed at the
 * shim alone. */
function killTree(pid: number): void {
  if (process.platform === "win32") {
    spawnSync("taskkill", ["/pid", String(pid), "/T", "/F"], { stdio: "ignore" })
  } else {
    try { process.kill(-pid, "SIGKILL") } catch { /* already gone */ }
  }
}

function runNode(args: string[]): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, {
      cwd: WORKSPACE,
      env: { ...process.env, IH_CONFIG_DIR: CONFIG_DIR },
      // POSIX: own process group, so killTree reaches the grandchild.
      detached: process.platform !== "win32",
    })
    let stdout = ""
    let stderr = ""
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      if (child.pid !== undefined) killTree(child.pid)
      child.kill("SIGKILL")
    }, TIMEOUT_MS)
    child.stdout?.on("data", (d) => { stdout += String(d) })
    child.stderr?.on("data", (d) => { stderr += String(d) })
    child.on("error", (error) => { clearTimeout(timer); reject(error) })
    child.on("exit", (code) => { clearTimeout(timer); resolve({ timedOut, code, stdout, stderr }) })
  })
}

function expectExited(r: RunResult): void {
  expect(
    r.timedOut,
    `the child had to be killed after ${TIMEOUT_MS} ms — it never exited (stdout: ${JSON.stringify(r.stdout.slice(0, 200))}, stderr: ${JSON.stringify(r.stderr.slice(0, 200))})`,
  ).toBe(false)
}

afterAll(() => {
  rmSync(CONFIG_DIR, { recursive: true, force: true })
  rmSync(WORKSPACE, { recursive: true, force: true })
})

describe("bare launch", () => {
  it("prints usage and exits 1 instead of launching anything", async () => {
    const r = await runNode([SHIM])              // no subcommand at all
    expectExited(r)
    expect(r.code).toBe(1)
    expect(r.stderr).toContain("usage: i-harness")
    expect(r.stdout).toBe("")
  }, TEST_TIMEOUT_MS)

  it("refuses a non-subcommand first token rather than defaulting to a UI", async () => {
    const r = await runNode([SHIM, "notacommand"])
    expectExited(r)
    expect(r.code).toBe(1)
    expect(r.stderr).toContain("usage: i-harness")
  }, TEST_TIMEOUT_MS)

  it("refuses the removed tui subcommand", async () => {
    const r = await runNode([SHIM, "tui"])
    expectExited(r)
    expect(r.code).toBe(1)
    expect(r.stderr).toContain("usage: i-harness")
  }, TEST_TIMEOUT_MS)

  it("refuses the removed web subcommand", async () => {
    const r = await runNode([SHIM, "web"])
    expectExited(r)
    expect(r.code).toBe(1)
    expect(r.stderr).toContain("usage: i-harness")
  }, TEST_TIMEOUT_MS)
})
