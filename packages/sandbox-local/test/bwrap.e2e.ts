import { describe, expect, it } from "vitest"
import { createLocalSandbox, probeBwrap } from "../src/index.ts"
import type { SandboxPolicy } from "@i-harness/sandbox"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { spawnSync } from "node:child_process"

// M16 final-review (I2): the guard must match the ACTUAL confinement gate in
// createLocalSandbox. `bwrap --version` alone passes on hosts where user
// namespaces are blocked — the real probe runs the full profile
// (--ro-bind / / --dev /dev --unshare-pid --proc /proc --die-with-parent --
// true) so a blocked-namespaces host SKIPs instead of running RED.
function hasBwrap(): boolean {
  if (process.platform !== "linux") return false
  return probeBwrap()
}

const skip = hasBwrap() ? it : it.skip

describe("bwrap e2e (Linux, requires bwrap)", () => {
  const provider = createLocalSandbox()
  const policy: SandboxPolicy = { mode: "read-only", workspaceRoot: "/" }

  skip("writes both project folders and denies a removed folder on the next shell call", () => {
    // Keep this fixture outside /tmp, which bwrap intentionally replaces with
    // a private writable tmpfs. The sibling escape must exercise a real deny.
    const cwd = realpathSync.native(process.cwd())
    const fixtureParent = cwd === "/tmp" || cwd.startsWith("/tmp/") ? "/var/tmp" : cwd
    const root = mkdtempSync(join(fixtureParent, ".ih-bwrap-project-"))
    const first = join(root, "first")
    const second = join(root, "second")
    mkdirSync(first)
    mkdirSync(second)
    writeFileSync(join(second, "seed.txt"), "second source")
    const targets = { FIRST: join(first, "created.txt"), SECOND: join(second, "created.txt"), OUTSIDE: join(root, "outside.txt") }
    const command = [process.execPath, "-e", `const fs=require('node:fs');console.log(fs.readFileSync(${JSON.stringify(join(second, "seed.txt"))},'utf8'));for(const [name,path] of Object.entries(${JSON.stringify(targets)})){try{fs.writeFileSync(path,'created');console.log(name+': OK')}catch{console.log(name+': DENIED')}}`]
    const multiple: SandboxPolicy = { mode: "workspace-write", workspaceRoot: first, workspaceRoots: [first, second] }
    const run = (policy: SandboxPolicy) => {
      const confined = provider.confine(command, policy)
      return spawnSync(confined.argv[0]!, confined.argv.slice(1), { encoding: "utf8", timeout: 10_000, cwd: first })
    }
    try {
      const initial = run(multiple)
      expect(initial.status, initial.stderr).toBe(0)
      expect(initial.stdout).toContain("second source")
      expect(initial.stdout).toContain("FIRST: OK")
      expect(initial.stdout).toContain("SECOND: OK")
      expect(initial.stdout).toContain("OUTSIDE: DENIED")
      expect(readFileSync(targets.SECOND, "utf8")).toBe("created")
      expect(existsSync(targets.OUTSIDE)).toBe(false)
      const revoked = run({ ...multiple, workspaceRoots: [first] })
      expect(revoked.status, revoked.stderr).toBe(0)
      expect(revoked.stdout).toContain("FIRST: OK")
      expect(revoked.stdout).toContain("SECOND: DENIED")
      const readOnly = run({ ...multiple, mode: "read-only" })
      expect(readOnly.status, readOnly.stderr).toBe(0)
      expect(readOnly.stdout).toContain("FIRST: DENIED")
      expect(readOnly.stdout).toContain("SECOND: DENIED")
    } finally { rmSync(root, { recursive: true, force: true }) }
  })

  skip("read-only denies writing to /tmp", async () => {
    const confined = provider.confine(["sh", "-c", "echo hi > /tmp/m16-e2e-$$.txt"], policy)
    expect(confined.argv[0]).toBe("bwrap")
    // Spawn the confined argv and check exit code + stderr deny marker.
    const { spawn } = await import("node:child_process")
    const result = await new Promise<{ code: number | null; stderr: string }>((resolve) => {
      const child = spawn(confined.argv[0]!, confined.argv.slice(1))
      let stderr = ""
      child.stderr?.on("data", (d: Buffer) => { stderr += d.toString() })
      child.on("close", (code) => resolve({ code, stderr }))
    })
    expect(result.code).not.toBe(0) // denied
    expect(result.stderr.toLowerCase()).toContain("read-only file system")
  })

  skip("workspace-write allows writing workspace root", async () => {
    const workspace = process.cwd()
    const wp: SandboxPolicy = { mode: "workspace-write", workspaceRoot: workspace }
    const confined = provider.confine(["sh", "-c", `echo hi > "${workspace}/.m16-e2e-write.txt"`], wp)
    const { spawn } = await import("node:child_process")
    const result = await new Promise<{ code: number | null }>((resolve) => {
      const child = spawn(confined.argv[0]!, confined.argv.slice(1))
      child.on("close", (code) => resolve({ code }))
    })
    expect(result.code).toBe(0)
    // cleanup
    const fs = await import("node:fs")
    fs.rmSync(`${workspace}/.m16-e2e-write.txt`, { force: true })
  })
})
