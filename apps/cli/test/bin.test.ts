// M44: the global-command story — `i-harness` / `ih` bin names (both → the
// shim) and the grok-style bare-launch default (BARE == TUI in cwd).
// Spawn-based tests only: the CLI's tui path calls parseFlags whose --help
// exits the process — a child is required for every path here.
import { describe, expect, it } from "vitest"
import { spawn } from "node:child_process"
import { fileURLToPath } from "node:url"
import { join } from "node:path"

const ROOT = fileURLToPath(new URL("../../../", import.meta.url))
const SHIM = join(ROOT, "apps", "cli", "bin", "i-harness.js")


function runNode(args: string[]): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, { cwd: ROOT })
    let stdout = ""
    let stderr = ""
    child.stdout.on("data", (d) => { stdout += String(d) })
    child.stderr.on("data", (d) => { stderr += String(d) })
    child.on("error", reject)
    child.on("exit", (code) => resolve({ code, stdout, stderr }))
  })
}

describe("M44 global command shim (i-harness / ih)", () => {
  it("--version prints the CLI version through the shim", async () => {
    const r = await runNode([SHIM, "--version"])
    expect(r.code).toBe(0)
    expect(r.stdout.trim()).toBe("0.1.0")
  }, 30_000)

  it("help prints the full usage (tui subcommand + bare default noted)", async () => {
    const r = await runNode([SHIM, "help"])
    expect(r.code).toBe(0)
    expect(r.stderr).toContain("usage: i-harness")
    expect(r.stderr).toContain("launches the TUI")
  }, 30_000)

  it("the tui subcommand reaches the TUI app (--help path, via the shim)", async () => {
    // Via the shim — the real installed-command path (a direct
    // node --import spawn mis-slots argv under the forks worker; the shim
    // owns its own argv and is what users actually run).
    const r = await runNode([SHIM, "tui", "--help"])
    expect(r.code, `stderr: ${r.stderr}\nstdout: ${r.stdout}`).toBe(0)
    expect(r.stdout).toContain("usage: tui")
  }, 30_000)
})
