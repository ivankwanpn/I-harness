import { spawn } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { createWindowsAclSandbox } from "../src/index.ts"

/**
 * Kill-on-close / descendant-process boundaries, verified against the REAL
 * backend instead of the plan's assumption.
 *
 * PLAN DEVIATION (verified empirically, see pin below): the M22 sketch assumed
 * a confined target CAN spawn a long-running grandchild, then asserts
 * job-close kills it. Reality: a confined target CANNOT create ANY child
 * process — CreateProcess fails with EPERM for cmd.exe, node.exe, sync and
 * async alike (stronger isolation than planned: nothing is ever born inside,
 * so no orphan can exist either). The tests therefore pin BOTH facts through
 * the public API only (provider.confine → runner → restricted token):
 *
 *  1. descendant-creation DENIAL pin (living doc — flips if this ever opens);
 *  2. kill-on-close semantics proven without descendants: the RUNNER dies
 *     violently while its confined target is still alive → the target dies
 *     too (the runner's job handle closes with its process teardown;
 *     JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE fires on the last handle).
 */
describe.skipIf(process.platform !== "win32")("kill-on-close job (Windows only)", () => {
  let root: string
  let workspace: string

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "i-harness-kill-"))
    workspace = join(root, "ws")
    mkdirSync(workspace)
  })

  afterAll(() => {
    rmSync(root, { recursive: true, force: true })
  })

  function until(predicate: () => boolean, timeoutMs: number): Promise<boolean> {
    return new Promise((resolve) => {
      const tick = (): void => {
        if (predicate()) return resolve(true)
        if (Date.now() > deadline) return resolve(false)
        setTimeout(tick, 100)
      }
      const deadline = Date.now() + timeoutMs
      tick()
    })
  }

  it("pins descendant-creation DENIAL: confined target cannot spawn any child (EPERM)", async () => {
    // Living documentation, same idiom as the read-visibility pin: the
    // sandbox currently forbids ALL second-generation processes. If a future
    // change re-enables spawning inside, this pin fails loudly and the M22
    // plan's original grandchild-based kill-on-close test becomes viable.
    const provider = createWindowsAclSandbox({ writableDirs: [workspace], mode: "workspace-write" })
    try {
      const script = [
        "const cp = require('node:child_process');",
        "const s = (name, fn) => { try { const r = fn(); console.log(name + ':' + (r.error ? r.error.code : 'status-' + r.status)); } catch (e) { console.log(name + ':THROW-' + e.code); } };",
        "s('CMD', () => cp.spawnSync('cmd.exe', ['/c', 'echo hi']));",
        "s('NODE', () => cp.spawnSync(process.execPath, ['-v']));",
        "try { cp.spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)']); console.log('ASYNC:no-error'); } catch (e) { console.log('ASYNC:THROW-' + e.code); }",
      ].join("")
      const confined = provider.confine(
        ["node", "-e", script],
        { mode: "workspace-write", workspaceRoot: workspace, sessionId: "kill-e2e-pin" },
      )
      const result = spawn(confined.argv[0]!, confined.argv.slice(1))
      let stdout = ""
      result.stdout!.on("data", (chunk: Buffer) => { stdout += chunk.toString() })
      let stderr = ""
      result.stderr!.on("data", (chunk: Buffer) => { stderr += chunk.toString() })
      const code = await new Promise<number>((resolve, reject) => {
        result.once("error", reject)
        result.once("close", (exitCode) => resolve(exitCode ?? -1))
      })
      expect(code, `stderr: ${stderr}`).toBe(0)
      expect(stdout).toContain("CMD:EPERM")
      expect(stdout).toContain("NODE:EPERM")
      expect(stdout).toContain("ASYNC:THROW-EPERM")
    } finally {
      provider.dispose()
    }
  }, 60_000)

  it("kills the confined target when the runner dies (job closes on runner teardown)", async () => {
    const pidFile = join(workspace, "target.pid")
    const provider = createWindowsAclSandbox({ writableDirs: [workspace], mode: "workspace-write" })
    try {
      // Confined target: record its own PID then idle — long-lived by design
      // so the runner is still holding the kill-on-close job when we shoot it.
      const confined = provider.confine(
        ["node", "-e", `require('node:fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); setInterval(() => {}, 1000)`],
        { mode: "workspace-write", workspaceRoot: workspace, sessionId: "kill-e2e" },
      )
      const runnerChild = spawn(confined.argv[0]!, confined.argv.slice(1), { stdio: ["ignore", "ignore", "ignore"] })
      // Wait until the target has recorded its PID (⇒ it exists AND is inside
      // the job: assignment precedes any user code via CREATE_SUSPENDED).
      const started = await until(() => existsSync(pidFile), 20_000)
      expect(started, `target never wrote ${pidFile}`).toBe(true)
      const targetPid = Number(readFileSync(pidFile, "utf-8").trim())
      expect(Number.isInteger(targetPid)).toBe(true)
      let targetAlive = false
      try { process.kill(targetPid, 0); targetAlive = true } catch { targetAlive = false }
      expect(targetAlive, `target pid ${targetPid} should be alive before the runner is killed`).toBe(true)

      let runnerExited = false
      runnerChild.once("exit", () => { runnerExited = true })

      // Kill the RUNNER violently: its handle table (holding the sole job
      // handle) is torn down by termination → kill-on-close fires.
      runnerChild.kill()
      expect(await until(() => runnerExited, 15_000), "runner never exited after kill()").toBe(true)

      // The confined target must die with it. Poll up to 30s so slow kernel
      // teardown cannot flake the suite.
      const survived = await until(() => {
        try {
          process.kill(targetPid, 0)
          return false
        } catch {
          return true // gone
        }
      }, 30_000)
      if (!survived) {
        // Last-resort hygiene before failing: never leave an orphan behind.
        try { process.kill(targetPid) } catch { /* already gone */ }
      }
      expect(survived, `confined target ${targetPid} survived the runner's kill-on-close`).toBe(true)
    } finally {
      provider.dispose()
      rmSync(pidFile, { force: true })
    }
  }, 60_000)
})
