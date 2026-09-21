// M44: the global-command story — `i-harness` / `ih` bin names (both → the
// shim) and the top-level dispatch the shim must reach.
// Spawn-based tests only: the CLI decides in-process (argv dispatch, flag
// validation, exit codes), so the observable contract is the child's exit code
// and its two streams — an in-process `main()` call would observe neither.
// M65 T1: the grok-style bare launch and the `tui` subcommand are gone; the
// bare-launch contract itself is pinned in bare-launch.test.ts.
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

  it("help prints the usage for the surviving backend surface", async () => {
    const r = await runNode([SHIM, "help"])
    expect(r.code).toBe(0)
    expect(r.stderr).toContain("usage: i-harness")
    // M65 T1: the usage must name only the subcommands that exist, and must not
    // describe a bare-launch default — there is none (bare-launch.test.ts pins
    // the refusal). The old case asserted "launches the TUI" here; that
    // sentence described a deleted surface, so it went with it.
    // Extended for each tree added since: provider, models, roles, and now
    // plugins (the plugin registry's read-only report face).
    expect(r.stderr).toContain("[<run|sdk|acp|sessions|hooks|provider|models|roles|plugins> ...]")
    expect(r.stderr).toContain("roles <list|set|unset>")
    expect(r.stderr).toContain("plugins [list] [--json]")
    expect(r.stderr).not.toContain("tui")
    expect(r.stderr).not.toContain("web")
  }, 30_000)
})

// M62: `i-harness run` is the ONLY interface that executes shells and, until
// this flag existed, it always ran with HeadlessOptions.sandbox unset — i.e.
// unconfined — regardless of `settings.sandboxMode`. `web` was wired in
// 891db14 and the TUI had its own path (both are deleted as of M65 T1);
// headless was the last one. These are spawn tests because the decision lives
// in the CLI's argument handling, which `runHeadless` (driven directly by
// cli.test.ts) never sees.
describe("M62 headless --sandbox", () => {
  it("rejects an invalid mode instead of coercing it to a default", async () => {
    // The failure mode being prevented: `--sandbox readonly` silently meaning
    // workspace-write is the same false assurance the web fix removed.
    const r = await runNode([SHIM, "run", "hi", "--sandbox", "readonly"])
    expect(r.code).toBe(1)
    expect(r.stderr).toContain("--sandbox requires one of")
    expect(r.stderr).toContain("read-only")
  }, 60_000)

  it("rejects a missing value", async () => {
    const r = await runNode([SHIM, "run", "hi", "--sandbox"])
    expect(r.code).toBe(1)
    expect(r.stderr).toContain("--sandbox requires one of")
  }, 60_000)

  it("documents the flag in help", async () => {
    const r = await runNode([SHIM, "help"])
    expect(r.stderr).toContain("--sandbox read-only|workspace-write|danger-full-access")
  }, 30_000)

  it("accepts a valid mode and proceeds past validation", async () => {
    // This environment has no model configured, so the run itself stops at the
    // M49 required-model gate. What is asserted is that it got PAST the sandbox
    // branch — no usage error, no sandbox complaint.
    const r = await runNode([SHIM, "run", "hi", "--sandbox", "read-only"])
    expect(r.stderr).not.toContain("--sandbox requires one of")
    expect(r.stderr).not.toContain("usage: i-harness run")
  }, 60_000)
})

