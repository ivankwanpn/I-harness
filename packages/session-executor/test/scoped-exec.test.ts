import { expect, it } from "vitest"
import { existsSync, mkdirSync, mkdtempSync, readFileSync } from "node:fs"
import { join } from "node:path"
import type { ExecService } from "@i-harness/exec"
import { createSessionAssembly } from "../src/assembly.ts"
import { createScopedExec } from "../src/scoped-exec.ts"
import { rmWorkspaceSync } from "./helpers.ts"

it("confines raw background calls and preserves an explicitly approved command policy", async () => {
  const parent = process.platform === "win32" ? "D:/agent-complete/playground" : process.cwd()
  const root = mkdtempSync(join(parent, "scoped-exec-")), a = join(root, "a"), outside = join(root, "outside")
  mkdirSync(a); mkdirSync(outside)
  const assembly = await createSessionAssembly({ workspace: a, modelPolicy: "test-mock", sandbox: "workspace-write" })
  try {
    const raw = assembly.ctx.services.get<ExecService>("exec/service")
    const exec = createScopedExec(raw, a, () => ({ mode: "workspace-write", workspaceRoot: a }))
    const target = join(outside, "target.txt")
    const argv = [process.execPath, "-e", `require("node:fs").writeFileSync(${JSON.stringify(target)}, "approved")`]
    const { jobId } = exec.runBackground({ argv })
    const until = Date.now() + 5_000
    while (exec.getOutput(jobId).status === "running") { if (Date.now() >= until) throw new Error("background run did not finish"); await new Promise((resolve) => setTimeout(resolve, 20)) }
    expect(exec.getOutput(jobId).status).toBe("error")
    expect(existsSync(target)).toBe(false)
    expect(await exec.run({ argv, sandbox: { mode: "danger-full-access", workspaceRoot: a } })).toMatchObject({ exitCode: 0 })
    expect(readFileSync(target, "utf8")).toBe("approved")
  } finally { await assembly.dispose(); rmWorkspaceSync(root) }
})
