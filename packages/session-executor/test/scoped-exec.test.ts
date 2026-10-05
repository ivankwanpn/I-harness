import { expect, it } from "vitest"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import type { ExecService } from "@i-harness/exec"
import { createSessionAssembly } from "../src/assembly.ts"
import { createScopedExec } from "../src/scoped-exec.ts"
import { rmWorkspaceSync } from "./helpers.ts"
import { createContext } from "@i-harness/core-plugin"
import { registerExec } from "@i-harness/exec"
import type { SandboxExecutionPolicy, SandboxProvider } from "@i-harness/sandbox"
import { createFsSearchTools } from "@i-harness/fs-search"
import { append } from "@i-harness/core-session"

it("confines raw background calls and preserves an explicitly approved command policy", async () => {
  const parent = process.cwd() // NOT tmpdir(): the fixtures must sit outside the platform temp grant
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

it("applies the current scoped policy to streaming helpers and refuses missing confinement", async () => {
  const parent = process.cwd() // NOT tmpdir(): the fixtures must sit outside the platform temp grant
  const root = mkdtempSync(join(parent, "scoped-search-"))
  let policy: SandboxExecutionPolicy = { mode: "danger-full-access", workspaceRoot: root }
  const exec = createScopedExec(registerExec(createContext()), root, () => policy)
  try {
    const chunks: Buffer[] = []
    const ran = await exec.run({ argv: [process.execPath, "-e", "process.stdout.write(process.cwd())"] }, { stream: { maxBytes: 1024, onStdout: (b) => { chunks.push(Buffer.from(b)) } } })
    expect(ran.exitCode).toBe(0)
    expect(Buffer.concat(chunks).toString()).toBe(root)
    policy = { mode: "read-only", workspaceRoot: root }
    const [, grep] = createFsSearchTools({ exec, workspace: root })
    const denied = await grep!.execute({ pattern: "needle" }, {})
    expect(denied).toMatchObject({ status: "error", partial: true, matches: [], error: expect.stringMatching(/sandbox|provider/), stats: { inputBytes: 0 } })
    await expect(exec.run({ argv: [process.execPath, "-e", "process.stdout.write('escaped')"] }, { stream: { maxBytes: 1024, onStdout: () => {} } })).rejects.toThrow(/provider/)
  } finally { rmWorkspaceSync(root) }
})

it("streams the provider replacement argv rather than the original executable", async () => {
  const provider: SandboxProvider = {
    confine() { return { argv: [process.execPath, "-e", "process.stdout.write('confined')"], enforcement: "full", denialSignatures: [], runnerFailureRules: [] } },
  }
  const exec = createScopedExec(registerExec(createContext(), { sandbox: provider }), process.cwd(), () => ({ mode: "read-only", workspaceRoot: process.cwd() }))
  const chunks: Buffer[] = []
  const result = await exec.run({ argv: [process.execPath, "-e", "process.stdout.write('escaped')"] }, { stream: { maxBytes: 1024, onStdout: (b) => { chunks.push(Buffer.from(b)) } } })
  expect(Buffer.concat(chunks).toString()).toBe("confined")
  expect(result.exitCode).toBe(0)
})

it.skipIf(process.platform !== "win32")("searches with first-generation siblings under current Windows read-only and workspace-write policy", async () => {
  const root = mkdtempSync(join(process.cwd(), "scoped-rg-policy-"))
  writeFileSync(join(root, "one.txt"), "needle\n")
  const assembly = await createSessionAssembly({ workspace: root, sandbox: "read-only", modelPolicy: "test-mock", approveAll: true })
  try {
    const readonly = await assembly.tools.execute({ name: "grep", args: { pattern: "needle" } })
    expect(readonly.output).toMatchObject({ status: "completed", matches: [expect.objectContaining({ path: "one.txt", text: "needle" })], stats: { candidateFiles: 1, attemptedFiles: 1, readFiles: 1, inputBytes: 7 } })
    append(assembly.session, { type: "sandbox/mode", mode: "workspace-write" })
    const allowed = await assembly.tools.execute({ name: "grep", args: { pattern: "needle" } })
    expect(allowed.output).toMatchObject({ status: "completed", matches: [expect.objectContaining({ path: "one.txt", text: "needle" })] })
  } finally { await assembly.dispose(); rmWorkspaceSync(root) }
}, 30_000)
