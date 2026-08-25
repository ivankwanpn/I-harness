import { describe, expect, it } from "vitest"
import { createLocalSandbox, probeBwrap } from "../src/index.ts"
import type { SandboxPolicy } from "@i-harness/sandbox"

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
